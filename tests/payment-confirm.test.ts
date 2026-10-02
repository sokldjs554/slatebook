import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPayment } from '../src/server/payments/confirm';
import { createRetryPayment } from '../src/server/payments/retry';
import {
  AmountMismatchError,
  BookingNotPayableError,
  HoldExpiredError,
  NotFoundError,
  PaymentConflictError,
  PaymentDeclinedError,
  PaymentVerificationFailedError,
  ValidationError,
} from '../src/server/errors';
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
  listing = await makeListing(db.pool, { hourlyPrice: 50_000, bufferMinutes: 30, commissionRateBp: 1000 });
});
afterAll(() => db.drop());

const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];
const bookingStatus = async (id: string) => (await q('SELECT status FROM bookings WHERE id = $1', [id]))[0].status as string;
const payment = async (orderId: string) => (await q('SELECT * FROM payments WHERE order_id = $1', [orderId]))[0];
const outbox = async (topic: string) => q('SELECT payload FROM outbox WHERE topic = $1 ORDER BY id', [topic]);
const ledgerOf = async (paymentId: string) =>
  q(`SELECT a.code, e.amount::int AS amount FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.ref_id = $1 ORDER BY e.amount`, [paymentId]);

/** 결제 승인 분개 + 그 결제의 환불 분개 */
const ledgerWithRefunds = async (paymentId: string) =>
  q(`SELECT a.code, e.amount::int AS amount FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.ref_id = $1 OR t.ref_id IN (SELECT id FROM refunds WHERE payment_id = $1) ORDER BY t.id, e.amount`, [paymentId]);

describe('정상 흐름', () => {
  it('예약 → PG 인증 → 확정: 예약·슬롯·결제·원장·outbox 가 한꺼번에 맞아떨어진다', async () => {
    const guest = await makeUser(db.pool, 'guest');
    const b = await book(t.ctx, guest, listing, futureWindow(nextDay(), 1, 2)); // 100,000원
    const redirect = payAtPg(t.gateway, b.payment);

    expect(await confirmPayment(t.ctx, guest, redirect)).toEqual({ status: 'CONFIRMED', bookingId: b.booking.id });

    const booking = (await q('SELECT status, hold_expires_at FROM bookings WHERE id = $1', [b.booking.id]))[0];
    expect(booking).toMatchObject({ status: 'CONFIRMED', hold_expires_at: null });
    expect((await q('SELECT state FROM booking_slots WHERE booking_id = $1', [b.booking.id])).map((r) => r.state)).toEqual(['CONFIRMED']);
    const pay = await payment(b.payment.orderId);
    expect(pay).toMatchObject({ status: 'APPROVED', payment_key: redirect.paymentKey, method: '카드' });
    expect(pay.approved_at).toBeInstanceOf(Date);
    expect(t.gateway.confirmCalls.at(-1)).toMatchObject({ orderId: b.payment.orderId, amount: 100_000, idempotencyKey: `confirm:${pay.id}` });
    expect(await ledgerOf(pay.id)).toEqual([
      { code: 'CUSTOMER_ESCROW', amount: -100_000 },
      { code: 'PG_RECEIVABLE', amount: 100_000 },
    ]);
    expect((await outbox('booking.confirmed')).some((o) => o.payload.bookingId === b.booking.id)).toBe(true);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('성공 URL 을 새로고침하거나 두 번 눌러도(같은 paymentKey) PG 를 다시 호출하지 않고 같은 결과를 돌려준다', async () => {
    const guest = await makeUser(db.pool);
    const b = await book(t.ctx, guest, listing, futureWindow(nextDay(), 1, 1));
    const redirect = payAtPg(t.gateway, b.payment);
    await confirmPayment(t.ctx, guest, redirect);
    const calls = t.gateway.confirmCalls.length;
    expect(await confirmPayment(t.ctx, guest, redirect)).toEqual({ status: 'CONFIRMED', bookingId: b.booking.id });
    expect(t.gateway.confirmCalls.length).toBe(calls);
    expect(await q(`SELECT 1 FROM ledger_transactions WHERE ref_id = $1`, [(await payment(b.payment.orderId)).id])).toHaveLength(1);
  });
});

describe('위변조 방어', () => {
  it('브라우저가 보낸 금액이 다르면 PG 를 호출하지 않고 거절한다 — 정상 금액으로는 이후에도 결제할 수 있다', async () => {
    const guest = await makeUser(db.pool);
    const b = await book(t.ctx, guest, listing, futureWindow(nextDay(), 1, 2)); // 100,000원
    const redirect = payAtPg(t.gateway, b.payment);
    const calls = t.gateway.confirmCalls.length;

    for (const amount of [1_000, 99_999, 100_001, 1]) {
      await expect(confirmPayment(t.ctx, guest, { ...redirect, amount })).rejects.toBeInstanceOf(AmountMismatchError);
    }
    expect(t.gateway.confirmCalls.length).toBe(calls); // PG 에 한 번도 가지 않았다
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT');
    expect((await payment(b.payment.orderId)).status).toBe('READY');
    const alerts = (await outbox('payment.anomaly')).filter((o) => o.payload.type === 'CLIENT_AMOUNT_MISMATCH' && o.payload.orderId === b.payment.orderId);
    expect(alerts).toHaveLength(4);
    expect(alerts[0]!.payload).toMatchObject({ expectedAmount: 100_000, reportedAmount: 1_000 });

    expect(await confirmPayment(t.ctx, guest, redirect)).toEqual({ status: 'CONFIRMED', bookingId: b.booking.id });
  });

  it('PG 가 주문과 다른 금액을 보고하면: 예약을 확정하지 않고 슬롯을 풀고, PG 결제를 자동 취소하고, 원장은 순효과 0', async () => {
    const guest = await makeUser(db.pool);
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(t.ctx, guest, listing, win);
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.forceReportedTotal(b.payment.orderId, 1_000); // 5천 원어치만 승인된 척 (사고·위조 시뮬레이션)

    await expect(confirmPayment(t.ctx, guest, redirect)).rejects.toBeInstanceOf(PaymentVerificationFailedError);

    const pay = await payment(b.payment.orderId);
    expect(pay).toMatchObject({ status: 'CANCELED', refund_pending: false, failure_reason: 'AMOUNT_OR_IDENTITY_MISMATCH' });
    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_FAILED');
    expect((await q('SELECT state FROM booking_slots WHERE booking_id = $1', [b.booking.id]))[0].state).toBe('RELEASED');
    expect(t.gateway.cancelCalls.at(-1)).toMatchObject({ paymentKey: redirect.paymentKey, idempotencyKey: `capture-refund:${pay.id}` });
    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('CANCELED');
    expect((await outbox('payment.anomaly')).some((o) => o.payload.type === 'AMOUNT_OR_IDENTITY_MISMATCH' && o.payload.reportedAmount === 1_000)).toBe(true);
    // 승인 분개와 환불 분개가 모두 남아 PG 내역과 대조할 수 있고, 계정별 순효과는 0 이다
    const entries = await ledgerWithRefunds(pay.id);
    expect(entries).toHaveLength(4);
    const net = (code: string) => entries.filter((e) => e.code === code).reduce((s, e) => s + e.amount, 0);
    expect(net('PG_RECEIVABLE')).toBe(0);
    expect(net('CUSTOMER_ESCROW')).toBe(0);
    expect((await q('SELECT status, amount::int AS amount FROM refunds WHERE payment_id = $1', [pay.id]))).toEqual([{ status: 'DONE', amount: 100_000 }]);

    // 슬롯은 풀렸으므로 다른 사람이 같은 시간을 예약할 수 있다
    const other = await book(t.ctx, await makeUser(db.pool), listing, win);
    expect(other.booking.status).toBe('PENDING_PAYMENT');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('PG 가 우리가 아는 것과 다른 결제키로 승인했다고 보고하면: 예약을 확정하지 않고, 어느 결제를 취소할지 자동으로 추측하지 않고 운영 알림만 남긴다', async () => {
    const guest = await makeUser(db.pool);
    const b = await book(t.ctx, guest, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.forceReportedKey(b.payment.orderId, 'pk_reported_by_pg_is_different');
    const cancelsBefore = t.gateway.cancelCalls.length;

    await expect(confirmPayment(t.ctx, guest, redirect)).rejects.toBeInstanceOf(PaymentVerificationFailedError);

    expect(await payment(b.payment.orderId)).toMatchObject({ status: 'FAILED', failure_reason: 'PAYMENT_KEY_MISMATCH', refund_pending: false });
    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_FAILED');
    expect((await q('SELECT state FROM booking_slots WHERE booking_id = $1', [b.booking.id]))[0].state).toBe('RELEASED');
    expect(t.gateway.cancelCalls.length).toBe(cancelsBefore); // 틀린 결제를 취소할 위험이 있으므로 자동 환불하지 않는다
    const alert = (await outbox('payment.anomaly')).find((o) => o.payload.type === 'PAYMENT_KEY_MISMATCH' && o.payload.orderId === b.payment.orderId);
    expect(alert!.payload).toMatchObject({ needsManualRefund: true, expectedPaymentKey: redirect.paymentKey, reportedPaymentKey: 'pk_reported_by_pg_is_different' });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('다른 사람의 주문번호로 결제 확정을 시도하면 "없는 주문"과 똑같이 404 이고, PG 도 호출하지 않는다', async () => {
    const [owner, intruder] = [await makeUser(db.pool), await makeUser(db.pool)];
    const b = await book(t.ctx, owner, listing, futureWindow(nextDay(), 1, 1));
    const redirect = payAtPg(t.gateway, b.payment);
    const calls = t.gateway.confirmCalls.length;
    const e1 = await confirmPayment(t.ctx, intruder, redirect).catch((e) => e);
    const e2 = await confirmPayment(t.ctx, intruder, { ...redirect, orderId: 'sb_does_not_exist_000000' }).catch((e) => e);
    expect(e1).toBeInstanceOf(NotFoundError);
    expect(e2).toBeInstanceOf(NotFoundError);
    expect(e1.message).toBe(e2.message);
    expect(t.gateway.confirmCalls.length).toBe(calls);
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT');
  });

  it('이미 연결된 주문에 다른 paymentKey 를 들이밀면 거부하고, 다른 주문에서 쓴 paymentKey 의 재사용도 막는다', async () => {
    const guest = await makeUser(db.pool);
    const d = nextDay();
    const [b1, b2] = [await book(t.ctx, guest, listing, futureWindow(d, 1, 1)), await book(t.ctx, guest, listing, futureWindow(d, 6, 1))];
    const r1 = payAtPg(t.gateway, b1.payment);
    await confirmPayment(t.ctx, guest, r1);

    await expect(confirmPayment(t.ctx, guest, { ...r1, paymentKey: 'another-key' })).rejects.toMatchObject({ code: 'PAYMENT_KEY_MISMATCH' });

    // b2 의 PG 인증에 b1 의 paymentKey 를 억지로 쓰는 경우
    const calls = t.gateway.confirmCalls.length;
    t.gateway.authenticate({ orderId: b2.payment.orderId, amount: b2.payment.amount, paymentKey: r1.paymentKey });
    await expect(confirmPayment(t.ctx, guest, { paymentKey: r1.paymentKey, orderId: b2.payment.orderId, amount: b2.payment.amount })).rejects.toMatchObject({
      code: 'PAYMENT_KEY_ALREADY_USED',
    });
    expect(t.gateway.confirmCalls.length).toBe(calls);
    expect(await bookingStatus(b2.booking.id)).toBe('PENDING_PAYMENT'); // 선점이 롤백됐다
    expect((await payment(b2.payment.orderId)).status).toBe('READY');
  });

  it.each([
    ['paymentKey 없음', { orderId: 'sb_abcdef', amount: 1000 }],
    ['금액이 문자열', { paymentKey: 'k', orderId: 'sb_abcdef', amount: '1000' }],
    ['금액이 음수', { paymentKey: 'k', orderId: 'sb_abcdef', amount: -1 }],
    ['금액이 소수', { paymentKey: 'k', orderId: 'sb_abcdef', amount: 10.5 }],
    ['금액이 0', { paymentKey: 'k', orderId: 'sb_abcdef', amount: 0 }],
    ['주문번호에 특수문자', { paymentKey: 'k', orderId: "x'; DROP TABLE payments;--", amount: 1000 }],
    ['여분의 필드', { paymentKey: 'k', orderId: 'sb_abcdef', amount: 1000, approved: true }],
    ['본문이 null', null],
  ])('잘못된 요청 본문(%s)은 400 이고 PG 를 호출하지 않는다', async (_n, bad) => {
    const calls = t.gateway.confirmCalls.length;
    await expect(confirmPayment(t.ctx, await makeUser(db.pool), bad)).rejects.toBeInstanceOf(ValidationError);
    expect(t.gateway.confirmCalls.length).toBe(calls);
  });
});

describe('카드 거절과 재결제', () => {
  it('거절되면 결제는 FAILED, 예약은 홀드가 남아 있는 동안 PENDING_PAYMENT 로 돌아가 다른 카드로 다시 결제할 수 있다', async () => {
    const guest = await makeUser(db.pool);
    const b = await book(t.ctx, guest, listing, futureWindow(nextDay(), 1, 2));
    const first = payAtPg(t.gateway, b.payment);
    t.gateway.script('decline', b.payment.orderId);

    const err = await confirmPayment(t.ctx, guest, first).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentDeclinedError);
    expect(err.pgCode).toBe('REJECT_CARD_COMPANY');
    expect(await payment(b.payment.orderId)).toMatchObject({ status: 'FAILED', failure_reason: 'DECLINED:REJECT_CARD_COMPANY' });
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT');
    expect((await q('SELECT state FROM booking_slots WHERE booking_id = $1', [b.booking.id]))[0].state).toBe('HELD');

    // 같은 주문번호로는 다시 결제할 수 없다 — 새 주문을 받아야 한다
    await expect(confirmPayment(t.ctx, guest, first)).rejects.toMatchObject({ code: 'PAYMENT_NOT_PAYABLE' });

    const retry = await createRetryPayment(t.ctx, guest, b.booking.id);
    expect(retry.payment!.orderId).not.toBe(b.payment.orderId);
    expect(retry.payment!.amount).toBe(100_000);
    // 재시도 버튼을 연타해도 주문이 늘어나지 않는다
    expect((await createRetryPayment(t.ctx, guest, b.booking.id)).payment!.orderId).toBe(retry.payment!.orderId);

    const second = payAtPg(t.gateway, retry.payment!);
    expect(await confirmPayment(t.ctx, guest, second)).toEqual({ status: 'CONFIRMED', bookingId: b.booking.id });
    expect(await q('SELECT status FROM payments WHERE booking_id = $1 ORDER BY created_at', [b.booking.id])).toEqual([{ status: 'FAILED' }, { status: 'APPROVED' }]);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('재결제는 본인의 예약에서, 홀드가 살아 있고, 진행 중인 결제가 없을 때만 가능하다', async () => {
    const [guest, other] = [await makeUser(db.pool), await makeUser(db.pool)];
    const b = await book(t.ctx, guest, listing, futureWindow(nextDay(), 1, 1));
    await expect(createRetryPayment(t.ctx, other, b.booking.id)).rejects.toBeInstanceOf(NotFoundError);

    const r = payAtPg(t.gateway, b.payment);
    const gate = t.gateway.pauseConfirms();
    const inflight = confirmPayment(t.ctx, guest, r);
    await new Promise((res) => setTimeout(res, 100));
    await expect(createRetryPayment(t.ctx, guest, b.booking.id)).rejects.toBeInstanceOf(BookingNotPayableError); // 승인 중
    gate.release();
    await inflight;
    await expect(createRetryPayment(t.ctx, guest, b.booking.id)).rejects.toBeInstanceOf(BookingNotPayableError); // 이미 확정

    const b2 = await book(t.ctx, guest, listing, futureWindow(nextDay(), 1, 1));
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [b2.booking.id]);
    await expect(createRetryPayment(t.ctx, guest, b2.booking.id)).rejects.toBeInstanceOf(HoldExpiredError);
  });
});

describe('더블클릭 · 중복 요청', () => {
  it('같은 결제 확정이 5번 동시에 들어와도 PG 승인은 정확히 1번, 확정도 1번이다', async () => {
    const guest = await makeUser(db.pool);
    const b = await book(t.ctx, guest, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.latencyMs = 80; // 요청들이 겹치도록 PG 를 느리게
    const before = t.gateway.confirmCalls.length;
    try {
      const rs = await Promise.allSettled(Array.from({ length: 5 }, () => confirmPayment(t.ctx, guest, redirect)));
      for (const r of rs) {
        expect(r.status, '더블클릭에 오류 응답이 나가면 안 된다').toBe('fulfilled');
        expect(['CONFIRMED', 'PROCESSING']).toContain((r as PromiseFulfilledResult<{ status: string }>).value.status);
      }
    } finally {
      t.gateway.latencyMs = 0;
    }
    expect(t.gateway.confirmCalls.length - before).toBe(1);
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    const pay = await payment(b.payment.orderId);
    expect(await q('SELECT 1 FROM ledger_transactions WHERE ref_id = $1', [pay.id])).toHaveLength(1);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('홀드 만료', () => {
  it('홀드가 지난 뒤의 결제 확정은 PG 를 호출하지 않고 410 — 예약은 즉시 만료되고 슬롯이 풀린다', async () => {
    const guest = await makeUser(db.pool);
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(t.ctx, guest, listing, win);
    const redirect = payAtPg(t.gateway, b.payment); // 사용자는 PG 창에서 인증을 마쳤지만 너무 오래 걸렸다
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [b.booking.id]);
    const calls = t.gateway.confirmCalls.length;

    await expect(confirmPayment(t.ctx, guest, redirect)).rejects.toBeInstanceOf(HoldExpiredError);
    expect(t.gateway.confirmCalls.length).toBe(calls);
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');
    expect((await payment(b.payment.orderId)).status).toBe('FAILED');
    expect((await q('SELECT state FROM booking_slots WHERE booking_id = $1', [b.booking.id]))[0].state).toBe('RELEASED');
    await expect(confirmPayment(t.ctx, guest, redirect)).rejects.toBeInstanceOf(HoldExpiredError); // 다시 눌러도 같은 응답

    expect((await book(t.ctx, await makeUser(db.pool), listing, win)).booking.status).toBe('PENDING_PAYMENT');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});
