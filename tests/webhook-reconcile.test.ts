import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { expireHolds } from '../src/server/bookings/expire';
import { confirmPayment } from '../src/server/payments/confirm';
import { createRetryPayment } from '../src/server/payments/retry';
import { PaymentDeclinedError } from '../src/server/errors';
import { reconcilePayment, reconcileStuckPayments, refreshBookingPayment } from '../src/server/payments/reconcile';
import { handlePgWebhook } from '../src/server/payments/webhook';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, makeListing, makeUser, type Listing } from './helpers/fixtures';
import { book, payAtPg } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

let db: TestDb;
let t: TestCtx;
let listing: Listing;
let day = 5;
const nextDay = () => day++;

beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool);
  listing = await makeListing(db.pool, { hourlyPrice: 50_000, bufferMinutes: 30 });
});
afterAll(() => db.drop());

const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];
const bookingStatus = async (id: string) => (await q('SELECT status FROM bookings WHERE id = $1', [id]))[0].status as string;
const payRow = async (orderId: string) => (await q('SELECT * FROM payments WHERE order_id = $1', [orderId]))[0];
const outbox = async (topic: string) => q('SELECT payload FROM outbox WHERE topic = $1 ORDER BY id', [topic]);

/** 토스 웹훅과 같은 모양의 본문. eventKey 는 본문 해시 */
const webhook = (orderId: string, extra: Record<string, unknown> = {}, createdAt = '2026-10-02T10:00:00+09:00') => {
  const payload = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt, data: { orderId, status: 'DONE', ...extra } };
  return { provider: 'fake', eventKey: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload };
};

describe('웹훅', () => {
  it('승인 호출 중이던 결제에 DONE 웹훅이 오면 확정된다. 같은 웹훅이 다시 와도 한 번만 처리된다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.script('timeout_after_capture', b.payment.orderId);
    await confirmPayment(t.ctx, user, redirect); // 응답 유실 → UNKNOWN

    const hook = webhook(b.payment.orderId);
    expect(await handlePgWebhook(t.ctx, hook)).toBe('processed');
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(await handlePgWebhook(t.ctx, hook)).toBe('duplicate');
    expect(await q('SELECT 1 FROM ledger_transactions WHERE ref_id = $1', [(await payRow(b.payment.orderId)).id])).toHaveLength(1);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('같은 웹훅 5개와 사용자의 확정 요청이 동시에 와도: 확정 1번, 원장 1건, PG 승인 호출 1번', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.latencyMs = 40;
    const before = t.gateway.confirmCalls.length;
    try {
      const hook = webhook(b.payment.orderId, {}, '2026-10-02T11:00:00+09:00');
      const rs = await Promise.allSettled([
        confirmPayment(t.ctx, user, redirect),
        ...Array.from({ length: 5 }, () => handlePgWebhook(t.ctx, hook)),
      ]);
      expect(rs.filter((r) => r.status === 'rejected')).toEqual([]);
    } finally {
      t.gateway.latencyMs = 0;
    }
    expect(t.gateway.confirmCalls.length - before).toBe(1);
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(await q('SELECT 1 FROM ledger_transactions WHERE ref_id = $1', [(await payRow(b.payment.orderId)).id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM outbox WHERE topic = 'booking.confirmed' AND payload->>'bookingId' = $1`, [b.booking.id])).toHaveLength(1);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('위조 웹훅: 본문이 "DONE·10만원"이라고 주장해도, PG 에 조회한 결과가 진행 중이면 아무것도 바뀌지 않는다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    payAtPg(t.gateway, b.payment); // PG 에는 인증만 된 상태 (IN_PROGRESS)
    const forged = webhook(b.payment.orderId, { status: 'DONE', paymentKey: 'attacker-key', totalAmount: 100_000 }, '2026-10-02T12:00:00+09:00');
    const ledgerBefore = await countLedger();

    expect(await handlePgWebhook(t.ctx, forged)).toBe('processed');
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT');
    expect(await payRow(b.payment.orderId)).toMatchObject({ status: 'READY', payment_key: null });
    expect(await countLedger()).toBe(ledgerBefore); // 원장 변동 없음
  });

  it('PG 가 모르는 주문·주문번호 없는 본문·알 수 없는 주문은 무시한다', async () => {
    const before = await countLedger();
    expect(await handlePgWebhook(t.ctx, webhook('sb_totally_unknown_order'))).toBe('ignored');
    expect(await handlePgWebhook(t.ctx, { provider: 'fake', eventKey: 'no-order-1', payload: { hello: 'world' } })).toBe('ignored');
    expect(await handlePgWebhook(t.ctx, { provider: 'fake', eventKey: 'no-order-2', payload: null })).toBe('ignored');
    // 우리 DB 에는 있지만 PG 가 모르는 주문 (위조)
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 1));
    expect(await handlePgWebhook(t.ctx, webhook(b.payment.orderId, {}, '2026-10-02T13:00:00+09:00'))).toBe('ignored');
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT');
    expect(await countLedger()).toBe(before);
  });

  it('PG 조회가 일시 실패하면 예외를 던져 PG 가 재전송하게 하고, 재전송분은 이어서 처리된다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    payAtPg(t.gateway, b.payment);
    t.gateway.capture(b.payment.orderId); // PG 는 이미 승인했다 (사용자는 브라우저를 닫음)
    const hook = webhook(b.payment.orderId, {}, '2026-10-02T14:00:00+09:00');

    t.gateway.failNextLookups(1);
    await expect(handlePgWebhook(t.ctx, hook)).rejects.toThrow();
    expect(await q('SELECT processed_at FROM pg_webhook_inbox WHERE event_key = $1', [hook.eventKey])).toEqual([{ processed_at: null }]);
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT');

    expect(await handlePgWebhook(t.ctx, hook)).toBe('processed'); // PG 의 재전송
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
  });

  it('브라우저가 닫혀 확정 요청이 없었어도(자동 승인 PG), 홀드가 살아 있으면 웹훅이 예약을 확정한다 — 결제키도 이때 기록된다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const paymentKey = t.gateway.authenticate({ orderId: b.payment.orderId, amount: b.payment.amount });
    t.gateway.capture(b.payment.orderId);

    expect(await handlePgWebhook(t.ctx, webhook(b.payment.orderId, {}, '2026-10-02T15:00:00+09:00'))).toBe('processed');
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(await payRow(b.payment.orderId)).toMatchObject({ status: 'APPROVED', payment_key: paymentKey });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('PG 에서 취소·중단된 미승인 결제: 결제는 FAILED, 예약은 홀드 동안 유지(재결제 가능)', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    payAtPg(t.gateway, b.payment);
    t.gateway.abort(b.payment.orderId);
    await handlePgWebhook(t.ctx, webhook(b.payment.orderId, { status: 'ABORTED' }, '2026-10-02T16:00:00+09:00'));
    expect((await payRow(b.payment.orderId)).status).toBe('FAILED');
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT');
  });

  it('우리는 승인으로 기록했는데 PG 에서 취소됐다면(대시보드 수동 취소 등) 상태는 건드리지 않고 운영 알림만 남긴다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    await confirmPayment(t.ctx, user, payAtPg(t.gateway, b.payment));
    t.gateway.records.get(b.payment.orderId)!.status = 'CANCELED';
    await handlePgWebhook(t.ctx, webhook(b.payment.orderId, { status: 'CANCELED' }, '2026-10-02T17:00:00+09:00'));
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect((await payRow(b.payment.orderId)).status).toBe('APPROVED');
    expect((await outbox('payment.anomaly')).some((o) => o.payload.type === 'CANCELED_AT_PG' && o.payload.orderId === b.payment.orderId)).toBe(true);
  });
});

async function countLedger() {
  return (await q('SELECT 1 FROM ledger_transactions')).length;
}

describe('뒤늦은 승인(LATE_CAPTURE) — 돈은 받았는데 자리는 이미 남의 것', () => {
  async function lateCaptureSetup() {
    const [late, winner] = [await makeUser(db.pool, 'late'), await makeUser(db.pool, 'winner')];
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(t.ctx, late, listing, win);
    const paymentKey = t.gateway.authenticate({ orderId: b.payment.orderId, amount: b.payment.amount });
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [b.booking.id]);
    await expireHolds(t.ctx);
    const taker = await book(t.ctx, winner, listing, win); // 다른 사람이 그 자리를 가져갔다
    t.gateway.capture(b.payment.orderId); // 그 뒤에야 PG 가 승인했다 (결제창을 오래 열어 둔 사용자)
    return { b, taker, paymentKey };
  }

  it('웹훅으로 알게 되면: 예약을 확정하지 않고 PG 결제를 자동 취소·환불하며, 남의 예약은 그대로다', async () => {
    const { b, taker } = await lateCaptureSetup();
    expect(await handlePgWebhook(t.ctx, webhook(b.payment.orderId, {}, '2026-10-02T18:00:00+09:00'))).toBe('processed');

    const pay = await payRow(b.payment.orderId);
    expect(pay).toMatchObject({ status: 'CANCELED', refund_pending: false, failure_reason: 'LATE_CAPTURE' });
    expect(Number(pay.canceled_amount)).toBe(100_000);
    expect(t.gateway.cancelCalls.filter((c) => c.idempotencyKey === `capture-refund:${pay.id}`)).toHaveLength(1);
    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('CANCELED');
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');
    expect(await bookingStatus(taker.booking.id)).toBe('PENDING_PAYMENT');
    expect((await outbox('payment.anomaly')).some((o) => o.payload.type === 'LATE_CAPTURE' && o.payload.orderId === b.payment.orderId)).toBe(true);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('환불 호출이 실패해도 "환불 해야 함"이 DB 에 남고, 대사 워커가 같은 멱등키로 재시도해 끝낸다', async () => {
    const { b } = await lateCaptureSetup();
    t.gateway.failNextCancels(1);
    await handlePgWebhook(t.ctx, webhook(b.payment.orderId, {}, '2026-10-02T19:00:00+09:00'));

    const stuck = await payRow(b.payment.orderId);
    expect(stuck).toMatchObject({ status: 'FAILED', refund_pending: true });
    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('DONE'); // 아직 돈이 PG 에 묶여 있다

    const r = await reconcileStuckPayments(t.ctx);
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect(await payRow(b.payment.orderId)).toMatchObject({ status: 'CANCELED', refund_pending: false });
    const cancels = t.gateway.cancelCalls.filter((c) => c.paymentKey === stuck.payment_key);
    expect(cancels).toHaveLength(2);
    expect(cancels[1]!.idempotencyKey).toBe(cancels[0]!.idempotencyKey);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('웹훅이 같은 건을 두 번 더 알려도 환불은 한 번만, 원장도 한 번만 기록된다', async () => {
    const { b } = await lateCaptureSetup();
    await handlePgWebhook(t.ctx, webhook(b.payment.orderId, {}, '2026-10-02T20:00:00+09:00'));
    await handlePgWebhook(t.ctx, webhook(b.payment.orderId, {}, '2026-10-02T20:00:01+09:00'));
    await handlePgWebhook(t.ctx, webhook(b.payment.orderId, {}, '2026-10-02T20:00:02+09:00'));
    const pay = await payRow(b.payment.orderId);
    expect(t.gateway.cancelCalls.filter((c) => c.idempotencyKey === `capture-refund:${pay.id}`)).toHaveLength(1);
    expect(await q(`SELECT 1 FROM refunds WHERE payment_id = $1`, [pay.id])).toHaveLength(1);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('이미 실패 처리한 결제에 뒤늦게 승인이 보고될 때', () => {
  it('승인 건은 환불하고, 다른 카드로 재결제를 기다리는 예약은 건드리지 않는다 (웹훅이 예외로 무한 재시도되지 않는다)', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.script('decline', b.payment.orderId);
    await expect(confirmPayment(t.ctx, user, redirect)).rejects.toBeInstanceOf(PaymentDeclinedError);
    expect((await payRow(b.payment.orderId)).status).toBe('FAILED');
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT'); // 재결제 대기

    t.gateway.records.get(b.payment.orderId)!.status = 'DONE'; // PG 가 (비정상적으로) 승인으로 보고한다
    expect(await handlePgWebhook(t.ctx, webhook(b.payment.orderId, {}, '2026-10-02T21:00:00+09:00'))).toBe('processed');

    const pay = await payRow(b.payment.orderId);
    expect(pay).toMatchObject({ status: 'CANCELED', refund_pending: false, failure_reason: 'LATE_CAPTURE' });
    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('CANCELED');
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT'); // 예약은 그대로
    expect((await q('SELECT state FROM booking_slots WHERE booking_id = $1', [b.booking.id]))[0].state).toBe('HELD');

    const retry = await createRetryPayment(t.ctx, user, b.booking.id);
    expect(await confirmPayment(t.ctx, user, payAtPg(t.gateway, retry.payment!))).toMatchObject({ status: 'CONFIRMED' });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('대사(reconcile) 규칙', () => {
  it('PG 가 주문을 모른다고 해도 유예 시간 안에는 실패로 단정하지 않고, 지나면 실패 처리한다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.script('timeout_before_capture', b.payment.orderId);
    await confirmPayment(t.ctx, user, redirect);
    const id = (await payRow(b.payment.orderId)).id;
    t.gateway.records.delete(b.payment.orderId); // 조회가 "없음"을 돌려주는 상황

    const patient = makeCtx(db.pool, { notFoundGraceMs: 60_000 });
    expect(await reconcilePayment({ ...patient.ctx, gateway: t.gateway }, id)).toMatchObject({ kind: 'pending' });
    expect((await payRow(b.payment.orderId)).status).toBe('UNKNOWN');

    expect(await reconcilePayment(t.ctx, id)).toMatchObject({ kind: 'failed', reason: 'NOT_FOUND_AT_PG' });
    expect((await payRow(b.payment.orderId)).status).toBe('FAILED');
  });

  it('승인 재시도 한도(8분)를 넘기고도 PG 가 인증 상태에 머물면 포기하고 실패 처리한다 — 승인된 적이 없으므로 슬롯을 돌려준다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    t.gateway.script('timeout_before_capture', b.payment.orderId);
    await confirmPayment(t.ctx, user, payAtPg(t.gateway, b.payment));
    await q(`UPDATE payments SET confirm_started_at = now() - interval '9 minutes' WHERE order_id = $1`, [b.payment.orderId]);
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [b.booking.id]);

    expect(await reconcilePayment(t.ctx, (await payRow(b.payment.orderId)).id)).toMatchObject({ kind: 'failed', reason: 'PG_SESSION_NOT_CAPTURED' });
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('PG 조회가 계속 실패해도 상태를 망가뜨리지 않고 다음 주기에 이어간다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    t.gateway.script('timeout_after_capture', b.payment.orderId);
    await confirmPayment(t.ctx, user, payAtPg(t.gateway, b.payment));
    const id = (await payRow(b.payment.orderId)).id;

    t.gateway.failNextLookups(2);
    expect(await reconcilePayment(t.ctx, id)).toMatchObject({ kind: 'pending' });
    expect(await reconcilePayment(t.ctx, id)).toMatchObject({ kind: 'pending' });
    expect((await payRow(b.payment.orderId)).status).toBe('UNKNOWN');
    expect(await reconcilePayment(t.ctx, id)).toMatchObject({ kind: 'confirmed' });
    expect((await payRow(b.payment.orderId)).reconcile_attempts).toBe(3);
  });

  it('오래 풀리지 않는 결제는 20번째 시도마다 운영 알림(payment.stuck)을 남긴다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    t.gateway.script('timeout_after_capture', b.payment.orderId);
    await confirmPayment(t.ctx, user, payAtPg(t.gateway, b.payment));
    await q(`UPDATE payments SET confirm_started_at = now() - interval '3 hours', reconcile_attempts = 19 WHERE order_id = $1`, [b.payment.orderId]);
    t.gateway.failNextLookups(1);
    await reconcilePayment(t.ctx, (await payRow(b.payment.orderId)).id);
    const alerts = (await outbox('payment.stuck')).filter((o) => o.payload.orderId === b.payment.orderId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload).toMatchObject({ attempts: 20 });
  });

  it('상태 조회 폴링이 PG 를 두드리지 않도록 같은 결제의 조회는 간격 제한이 있다', async () => {
    const throttled = makeCtx(db.pool, { reconcileThrottleMs: 60_000 });
    const user = await makeUser(db.pool);
    const b = await book(throttled.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    throttled.gateway.script('timeout_after_capture', b.payment.orderId);
    await confirmPayment(throttled.ctx, user, payAtPg(throttled.gateway, b.payment));
    throttled.gateway.failNextLookups(10);
    for (let i = 0; i < 5; i++) await refreshBookingPayment(throttled.ctx, b.booking.id);
    expect(throttled.gateway.lookupCalls).toHaveLength(1);
  });

  it('이 파일의 모든 시나리오 뒤에도 시스템 불변식이 깨지지 않았다', async () => {
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});
