import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeEndedBookings } from '../src/server/bookings/complete';
import { confirmPayment } from '../src/server/payments/confirm';
import { drainOutbox, enqueue } from '../src/server/outbox';
import { silentLogger } from '../src/server/logger';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, makeListing, makeUser } from './helpers/fixtures';
import { book, payAtPg } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

let db: TestDb;
let t: TestCtx;
let day = 5;
const nextDay = () => day++;

beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool);
});
afterAll(() => db.drop());

const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];

async function confirmedBooking(opts: { commissionRateBp?: number; hourlyPrice?: number } = {}) {
  const listing = await makeListing(db.pool, { hourlyPrice: opts.hourlyPrice ?? 50_000, commissionRateBp: opts.commissionRateBp ?? 1000, bufferMinutes: 0 });
  const user = await makeUser(db.pool);
  const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
  await confirmPayment(t.ctx, user, payAtPg(t.gateway, b.payment));
  return { listing, user, b };
}
/** 이용 시간이 이미 지난 것처럼 만든다 (예약은 과거로 만들 수 없으므로 시간을 되감는다) */
const endIt = (bookingId: string) =>
  q(`UPDATE bookings SET period = tstzrange(now() - interval '3 hours', now() - interval '1 hour', '[)') WHERE id = $1`, [bookingId]);
const balances = async (bookingId: string) =>
  q<{ code: string; owner_id: string | null; sum: number }>(
    `SELECT a.code, a.owner_id, sum(e.amount)::int AS sum FROM ledger_entries e
       JOIN ledger_accounts a ON a.id = e.account_id JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.ref_id = $1 OR t.ref_id = (SELECT id FROM payments WHERE booking_id = $1)
      GROUP BY a.code, a.owner_id ORDER BY a.code`,
    [bookingId],
  );

describe('이용 완료와 수익 인식', () => {
  it('이용이 끝나면 COMPLETED, 예수금은 호스트 미지급금 9만원과 수수료 매출 1만원으로 나뉜다', async () => {
    const { listing, b } = await confirmedBooking();
    await endIt(b.booking.id);
    expect(await completeEndedBookings(t.ctx)).toBeGreaterThanOrEqual(1);

    expect((await q('SELECT status, completed_at FROM bookings WHERE id = $1', [b.booking.id]))[0]).toMatchObject({ status: 'COMPLETED' });
    expect(await balances(b.booking.id)).toEqual([
      { code: 'CUSTOMER_ESCROW', owner_id: null, sum: 0 }, // 맡아 둔 돈이 전부 정리됐다
      { code: 'HOST_PAYABLE', owner_id: listing.hostId, sum: -90_000 },
      { code: 'PG_RECEIVABLE', owner_id: null, sum: 100_000 },
      { code: 'PLATFORM_FEE_REVENUE', owner_id: null, sum: -10_000 },
    ]);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('두 번 돌려도 두 번 분개되지 않는다 — 두 워커가 동시에 돌아도 마찬가지다', async () => {
    const { b } = await confirmedBooking();
    await endIt(b.booking.id);
    const done = await Promise.all([completeEndedBookings(t.ctx), completeEndedBookings(t.ctx)]);
    expect(done.reduce((a, c) => a + c, 0)).toBeGreaterThanOrEqual(1);
    expect(await completeEndedBookings(t.ctx)).toBe(0);
    expect(await q(`SELECT 1 FROM ledger_transactions WHERE kind = 'REVENUE_RECOGNIZED' AND ref_id = $1`, [b.booking.id])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM outbox WHERE topic = 'booking.completed' AND payload->>'bookingId' = $1`, [b.booking.id])).toHaveLength(1);
  });

  it('아직 끝나지 않은 확정 예약과 결제 대기 예약은 건드리지 않는다', async () => {
    const { b } = await confirmedBooking(); // 미래의 예약
    const pending = await book(t.ctx, await makeUser(db.pool), await makeListing(db.pool), futureWindow(nextDay(), 1, 1));
    await completeEndedBookings(t.ctx);
    expect((await q('SELECT status FROM bookings WHERE id = $1', [b.booking.id]))[0].status).toBe('CONFIRMED');
    expect((await q('SELECT status FROM bookings WHERE id = $1', [pending.booking.id]))[0].status).toBe('PENDING_PAYMENT');
  });

  it('수수료는 예약 시점의 스냅샷으로 계산한다 — 그 뒤 호스트 수수료율이 바뀌어도 이 예약은 그대로', async () => {
    const { listing, b } = await confirmedBooking({ commissionRateBp: 1000 });
    await q('UPDATE host_profiles SET commission_rate_bp = 5000 WHERE user_id = $1', [listing.hostId]);
    await endIt(b.booking.id);
    await completeEndedBookings(t.ctx);
    const bal = await balances(b.booking.id);
    expect(bal.find((r) => r.code === 'PLATFORM_FEE_REVENUE')!.sum).toBe(-10_000);
    expect(bal.find((r) => r.code === 'HOST_PAYABLE')!.sum).toBe(-90_000);
  });

  it('수수료 0% 도 정상 처리된다 (0원 줄은 기록하지 않는다)', async () => {
    const { listing, b } = await confirmedBooking({ commissionRateBp: 0 });
    await endIt(b.booking.id);
    await completeEndedBookings(t.ctx);
    const bal = await balances(b.booking.id);
    expect(bal.find((r) => r.code === 'HOST_PAYABLE')).toMatchObject({ owner_id: listing.hostId, sum: -100_000 });
    expect(bal.find((r) => r.code === 'PLATFORM_FEE_REVENUE')).toBeUndefined();
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('원 단위가 딱 떨어지지 않는 금액도 합계가 정확하다 (3,333원 수수료 + 30,000원 호스트 = 33,333원)', async () => {
    const { listing, b } = await confirmedBooking({ hourlyPrice: 66_666, commissionRateBp: 1000 });
    // 2시간 = 133,332원 → 수수료 13,333, 호스트 119,999
    await endIt(b.booking.id);
    await completeEndedBookings(t.ctx);
    const bal = await balances(b.booking.id);
    expect(bal.find((r) => r.code === 'PLATFORM_FEE_REVENUE')!.sum).toBe(-13_333);
    expect(bal.find((r) => r.code === 'HOST_PAYABLE')).toMatchObject({ owner_id: listing.hostId, sum: -119_999 });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('outbox', () => {
  it('발행에 성공한 이벤트만 발행 완료로 표시되고, 실패한 이벤트는 다음 주기에 다시 시도된다', async () => {
    await enqueue(db.pool, 'test.topic', { n: 1 });
    await enqueue(db.pool, 'test.topic', { n: 2 });
    const delivered: number[] = [];
    const flaky = (e: { topic: string; payload: Record<string, unknown> }) => {
      if (e.topic !== 'test.topic') return;
      if (e.payload.n === 2 && !delivered.includes(2) && flakyOnce.v) {
        flakyOnce.v = false;
        throw new Error('downstream is down');
      }
      delivered.push(e.payload.n as number);
    };
    const flakyOnce = { v: true };
    await drainOutbox(db.pool, silentLogger, flaky, 1000);
    expect(delivered).toEqual([1]);
    await drainOutbox(db.pool, silentLogger, flaky, 1000);
    expect(delivered).toEqual([1, 2]);
    await drainOutbox(db.pool, silentLogger, flaky, 1000);
    expect(delivered).toEqual([1, 2]); // 세 번째에는 보낼 것이 없다
  });

  it('워커가 둘이어도 같은 이벤트를 두 번 가져가지 않는다 (SKIP LOCKED)', async () => {
    for (let i = 0; i < 20; i++) await enqueue(db.pool, 'dedupe.topic', { i });
    const got: number[] = [];
    const handler = async (e: { topic: string; payload: Record<string, unknown> }) => {
      if (e.topic !== 'dedupe.topic') return;
      await new Promise((r) => setTimeout(r, 5));
      got.push(e.payload.i as number);
    };
    await Promise.all([drainOutbox(db.pool, silentLogger, handler, 1000), drainOutbox(db.pool, silentLogger, handler, 1000)]);
    expect(got.sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
