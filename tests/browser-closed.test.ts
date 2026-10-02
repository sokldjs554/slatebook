import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireHolds } from '../src/server/bookings/expire';
import { confirmPayment } from '../src/server/payments/confirm';
import { reconcilePayment } from '../src/server/payments/reconcile';
import { createRetryPayment } from '../src/server/payments/retry';
import { HoldExpiredError, SlotTakenError } from '../src/server/errors';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { injectFault } from './helpers/fault';
import { futureWindow, makeListing, makeUser, type Listing } from './helpers/fixtures';
import { book, payAtPg } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';
import { waitFor } from './helpers/wait';

/**
 * 결제 도중 사용자가 브라우저를 닫거나 네트워크가 끊기는 상황들.
 * 공통 원칙: ① 돈이 움직였을 수 있으면 슬롯을 놓지 않는다 ② 돈이 안 움직였으면 슬롯을 놓는다 ③ 결국 한쪽으로 수렴한다.
 */
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
const slotStates = async (bookingId: string) => (await q('SELECT state FROM booking_slots WHERE booking_id = $1', [bookingId])).map((r) => r.state);
const expireHold = (bookingId: string) => q(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [bookingId]);
const backdateConfirm = (orderId: string, interval = '1 hour') =>
  q(`UPDATE payments SET confirm_started_at = now() - $2::interval WHERE order_id = $1`, [orderId, interval]);
const ledgerCount = async (paymentId: string) => (await q('SELECT 1 FROM ledger_transactions WHERE ref_id = $1', [paymentId])).length;

describe('결제창에서 닫음 — 아직 아무것도 승인되지 않았다', () => {
  it('PG 인증도 하기 전에 닫았다: 홀드가 지나면 워커가 슬롯을 풀고, 다른 사람이 예약할 수 있다. 옛 링크로 돌아와도 PG 는 호출되지 않는다', async () => {
    const user = await makeUser(db.pool);
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(t.ctx, user, listing, win);
    // …사용자가 사라졌다…
    expect(await expireHolds(t.ctx)).toBe(0); // 홀드가 남아 있는 동안은 건드리지 않는다
    await expireHold(b.booking.id);
    expect(await expireHolds(t.ctx)).toBe(1);
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');
    expect(await slotStates(b.booking.id)).toEqual(['RELEASED']);
    expect((await payRow(b.payment.orderId)).status).toBe('FAILED');

    const other = await book(t.ctx, await makeUser(db.pool), listing, win);
    expect(other.booking.status).toBe('PENDING_PAYMENT');

    // 한참 뒤 사용자가 옛 성공 링크를 다시 열었다 (PG 쪽에는 인증 기록도 없다)
    const calls = t.gateway.confirmCalls.length;
    await expect(confirmPayment(t.ctx, user, { paymentKey: 'stale', orderId: b.payment.orderId, amount: b.payment.amount })).rejects.toBeInstanceOf(HoldExpiredError);
    expect(t.gateway.confirmCalls.length).toBe(calls);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('PG 인증은 끝냈는데 성공 URL 로 돌아오기 전에 닫았다: 승인(capture)이 없었으니 돈은 안 움직였고, 홀드가 지나면 슬롯이 풀린다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment); // PG 에는 IN_PROGRESS 로 남아 있다
    await expireHold(b.booking.id);
    await expireHolds(t.ctx);

    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('IN_PROGRESS'); // 승인 호출이 없었으므로 그대로
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');
    await expect(confirmPayment(t.ctx, user, redirect)).rejects.toBeInstanceOf(HoldExpiredError); // 늦게 돌아와도 승인하지 않는다
    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('IN_PROGRESS');
    expect(await ledgerCount((await payRow(b.payment.orderId)).id)).toBe(0); // 돈이 안 움직였으니 분개도 없다
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('승인 요청이 진행되는 중에 닫음', () => {
  it('응답을 받을 브라우저가 사라져도 서버는 끝까지 처리해서 예약을 확정한다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);

    const gate = t.gateway.pauseConfirms(); // PG 가 느리다
    void confirmPayment(t.ctx, user, redirect).catch(() => {}); // 요청을 보내 놓고 브라우저를 닫는다 — 아무도 기다리지 않는다
    await waitFor(async () => (await bookingStatus(b.booking.id)) === 'PAYMENT_CONFIRMING', 5_000, 'claim');
    expect((await payRow(b.payment.orderId)).status).toBe('CONFIRMING');

    gate.release();
    await waitFor(async () => (await bookingStatus(b.booking.id)) === 'CONFIRMED', 5_000, 'confirmation');
    expect((await payRow(b.payment.orderId)).status).toBe('APPROVED');
    expect(await ledgerCount((await payRow(b.payment.orderId)).id)).toBe(1);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('PG 는 승인했는데 응답이 유실됐다(타임아웃): "실패"로 응답하지 않고 PROCESSING, 슬롯은 홀드가 지나도 유지, 대사가 확정한다', async () => {
    const user = await makeUser(db.pool);
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(t.ctx, user, listing, win);
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.script('timeout_after_capture', b.payment.orderId);

    expect(await confirmPayment(t.ctx, user, redirect)).toEqual({ status: 'PROCESSING', bookingId: b.booking.id });
    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_CONFIRMING');
    expect((await payRow(b.payment.orderId)).status).toBe('UNKNOWN');
    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('DONE'); // 실제로는 돈이 빠져나갔다

    // 사용자가 포기하고 떠난 채 홀드 시간이 한참 지났다 — 그래도 슬롯은 내주지 않는다
    await expireHold(b.booking.id);
    expect(await expireHolds(t.ctx)).toBe(0);
    await expect(book(t.ctx, await makeUser(db.pool), listing, win)).rejects.toBeInstanceOf(SlotTakenError);

    // 대사 워커가 PG 에 물어보고 확정한다
    const r = await reconcilePayment(t.ctx, (await payRow(b.payment.orderId)).id);
    expect(r).toMatchObject({ kind: 'confirmed', bookingId: b.booking.id });
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(await slotStates(b.booking.id)).toEqual(['CONFIRMED']);
    expect(await ledgerCount((await payRow(b.payment.orderId)).id)).toBe(1);

    // 사용자가 나중에 성공 링크를 다시 열면 확정 결과를 돌려받는다 (PG 재호출 없음)
    const calls = t.gateway.confirmCalls.length;
    expect(await confirmPayment(t.ctx, user, redirect)).toEqual({ status: 'CONFIRMED', bookingId: b.booking.id });
    expect(t.gateway.confirmCalls.length).toBe(calls);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('타임아웃인데 PG 는 처리하지 않았다: 대사가 같은 멱등키로 승인을 다시 요청해 확정한다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.script(['timeout_before_capture', 'ok'], b.payment.orderId);

    expect(await confirmPayment(t.ctx, user, redirect)).toEqual({ status: 'PROCESSING', bookingId: b.booking.id });
    const pay = await payRow(b.payment.orderId);
    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('IN_PROGRESS');

    expect(await reconcilePayment(t.ctx, pay.id)).toMatchObject({ kind: 'confirmed' });
    const calls = t.gateway.confirmCalls.filter((c) => c.orderId === b.payment.orderId);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).toBe(calls[0]!.idempotencyKey); // PG 가 같은 요청으로 알아본다
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('PG 가 5xx 를 돌려줘도 실패로 단정하지 않는다 (PROCESSING → 대사 → 확정)', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.script(['server_error', 'ok'], b.payment.orderId);
    expect(await confirmPayment(t.ctx, user, redirect)).toMatchObject({ status: 'PROCESSING' });
    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_CONFIRMING');
    await reconcilePayment(t.ctx, (await payRow(b.payment.orderId)).id);
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
  });

  it('타임아웃 뒤 PG 가 세션을 중단(ABORTED)했다: 결제는 실패, 홀드가 남았으면 다른 카드로 재결제할 수 있다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.script('timeout_before_capture', b.payment.orderId);
    await confirmPayment(t.ctx, user, redirect);
    t.gateway.abort(b.payment.orderId);

    expect(await reconcilePayment(t.ctx, (await payRow(b.payment.orderId)).id)).toMatchObject({ kind: 'failed', reason: 'PG_FAILED' });
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT'); // 홀드가 남아 있으니 되돌린다
    expect(await slotStates(b.booking.id)).toEqual(['HELD']);

    const retry = await createRetryPayment(t.ctx, user, b.booking.id);
    expect(await confirmPayment(t.ctx, user, payAtPg(t.gateway, retry.payment!))).toMatchObject({ status: 'CONFIRMED' });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('같은 상황이지만 그 사이 홀드가 지났다면: 예약은 만료되고 슬롯이 풀린다', async () => {
    const user = await makeUser(db.pool);
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(t.ctx, user, listing, win);
    const redirect = payAtPg(t.gateway, b.payment);
    t.gateway.script('timeout_before_capture', b.payment.orderId);
    await confirmPayment(t.ctx, user, redirect);
    await expireHold(b.booking.id);
    t.gateway.abort(b.payment.orderId);

    await reconcilePayment(t.ctx, (await payRow(b.payment.orderId)).id);
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');
    expect(await slotStates(b.booking.id)).toEqual(['RELEASED']);
    expect((await book(t.ctx, await makeUser(db.pool), listing, win)).booking.status).toBe('PENDING_PAYMENT');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('서버가 승인 직후에 죽음', () => {
  it('PG 는 승인했고 DB 반영이 실패했다: PROCESSING 으로 응답하고, 워커가 PG 를 조회해 확정한다 (PG 재승인 호출 없이)', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    const crashing = { ...t.ctx, pool: injectFault(db.pool, /status = 'APPROVED'/, 1) };

    expect(await confirmPayment(crashing, user, redirect)).toEqual({ status: 'PROCESSING', bookingId: b.booking.id });
    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_CONFIRMING'); // 반쪽 상태가 아니라 통째로 롤백됐다
    expect((await payRow(b.payment.orderId)).status).toBe('CONFIRMING');
    expect(t.gateway.records.get(b.payment.orderId)!.status).toBe('DONE');
    expect(await ledgerCount((await payRow(b.payment.orderId)).id)).toBe(0);

    const id = (await payRow(b.payment.orderId)).id;
    // 진행 중일 수 있는 원래 호출과 겹치지 않게, 방금 시작된 결제는 건드리지 않는다
    expect(await reconcilePayment(t.ctx, id)).toEqual({ kind: 'skipped' });
    // 서버가 죽은 지 한참 지난 뒤 워커가 돈다
    await backdateConfirm(b.payment.orderId);
    const callsBefore = t.gateway.confirmCalls.length;
    expect(await reconcilePayment(t.ctx, id)).toMatchObject({ kind: 'confirmed' });
    expect(t.gateway.confirmCalls.length).toBe(callsBefore); // 이미 DONE 이므로 승인을 또 부르지 않는다
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(await ledgerCount(id)).toBe(1);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('진행 중인 정상 승인 호출과 대사가 겹치지 않는다: 승인 대기 중에는 PG 조회조차 하지 않는다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const redirect = payAtPg(t.gateway, b.payment);
    const gate = t.gateway.pauseConfirms();
    const inflight = confirmPayment(t.ctx, user, redirect);
    await waitFor(async () => (await payRow(b.payment.orderId)).status === 'CONFIRMING', 5_000, 'claim');

    const lookups = t.gateway.lookupCalls.length;
    expect(await reconcilePayment(t.ctx, (await payRow(b.payment.orderId)).id)).toEqual({ kind: 'skipped' });
    expect(t.gateway.lookupCalls.length).toBe(lookups);

    gate.release();
    expect(await inflight).toMatchObject({ status: 'CONFIRMED' });
    expect(t.gateway.confirmCalls.filter((c) => c.orderId === b.payment.orderId)).toHaveLength(1);
  });
});
