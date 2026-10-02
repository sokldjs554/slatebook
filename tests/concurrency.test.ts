import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBooking } from '../src/server/bookings/create';
import { expireHolds } from '../src/server/bookings/expire';
import { confirmPayment } from '../src/server/payments/confirm';
import { HoldExpiredError, SlotTakenError } from '../src/server/errors';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, idemKey, makeListing, makeUser } from './helpers/fixtures';
import { book, payAtPg } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

let db: TestDb;
let t: TestCtx;

beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool);
});
afterAll(() => db.drop());

const rejections = (rs: PromiseSettledResult<unknown>[]) =>
  rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason);
const fulfilled = <T>(rs: PromiseSettledResult<T>[]) =>
  rs.filter((r): r is PromiseFulfilledResult<T> => r.status === 'fulfilled').map((r) => r.value);

describe('동시 예약 — 같은 시간대에 몰려도 중복 예약은 없다', () => {
  it('같은 1초에 두 명이 같은 스튜디오·같은 시간을 눌러도 정확히 한 명만 성공한다 (30회 반복)', async () => {
    const listing = await makeListing(db.pool, { bufferMinutes: 30 });
    const [u1, u2] = [await makeUser(db.pool, 'a'), await makeUser(db.pool, 'b')];
    for (let round = 0; round < 30; round++) {
      const win = futureWindow(20 + round, 1, 2);
      const rs = await Promise.allSettled([book(t.ctx, u1, listing, win), book(t.ctx, u2, listing, win)]);
      expect(fulfilled(rs), `round ${round}`).toHaveLength(1);
      const losers = rejections(rs);
      expect(losers).toHaveLength(1);
      expect(losers[0]).toBeInstanceOf(SlotTakenError);
    }
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('50명이 같은 시간을 동시에 노리면 1명만 성공하고, 나머지는 데드락 없이 모두 SLOT_TAKEN 이다', async () => {
    const listing = await makeListing(db.pool, { bufferMinutes: 30 });
    const users = await Promise.all(Array.from({ length: 50 }, (_, i) => makeUser(db.pool, `u${i}`)));
    const win = futureWindow(60, 1, 2);
    const rs = await Promise.allSettled(users.map((u) => book(t.ctx, u, listing, win)));
    expect(fulfilled(rs)).toHaveLength(1);
    for (const r of rejections(rs)) expect(r).toBeInstanceOf(SlotTakenError); // BusyError·데드락이 섞이면 실패
    const held = await db.pool.query(`SELECT count(*)::int AS n FROM booking_slots WHERE resource_id = $1 AND state <> 'RELEASED'`, [listing.resourceIds[0]]);
    expect(held.rows[0].n).toBe(1);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('겹치는 시간대와 겹치지 않는 시간대가 섞여 있어도 겹침은 0 이고, 가능한 예약은 허용된다', async () => {
    const listing = await makeListing(db.pool, { bufferMinutes: 0 }); // 09–11, 10–12, 11–13
    const users = await Promise.all(Array.from({ length: 30 }, (_, i) => makeUser(db.pool, `m${i}`)));
    const hours = [9, 10, 11];
    const wins = users.map((_, i) => futureWindow(70, hours[i % 3]!, 2));
    const rs = await Promise.allSettled(users.map((u, i) => book(t.ctx, u, listing, wins[i]!)));
    const won = fulfilled(rs);
    expect(won.length).toBeGreaterThanOrEqual(1);
    expect(won.length).toBeLessThanOrEqual(2); // 09–11 과 11–13 은 공존 가능하지만 10–12 는 둘 다와 겹친다
    for (const r of rejections(rs)) expect(r).toBeInstanceOf(SlotTakenError);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('장비 3대: 10명이 동시에 같은 시간을 노리면 정확히 3명이 서로 다른 장비를 받는다', async () => {
    const gear = await makeListing(db.pool, { kind: 'EQUIPMENT', units: 3, bufferMinutes: 0, hourlyPrice: 10_000 });
    const users = await Promise.all(Array.from({ length: 10 }, (_, i) => makeUser(db.pool, `g${i}`)));
    const win = futureWindow(80, 1, 3);
    const rs = await Promise.allSettled(users.map((u) => book(t.ctx, u, gear, win)));
    expect(fulfilled(rs)).toHaveLength(3);
    for (const r of rejections(rs)) expect(r).toBeInstanceOf(SlotTakenError);
    const { rows } = await db.pool.query(`SELECT DISTINCT resource_id FROM booking_slots WHERE state = 'HELD' AND resource_id = ANY($1)`, [gear.resourceIds]);
    expect(rows).toHaveLength(3);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('같은 Idempotency-Key 로 10번 동시에 보내도 예약은 1건이고 모두 같은 예약을 돌려받는다', async () => {
    const listing = await makeListing(db.pool);
    const user = await makeUser(db.pool, 'dbl');
    const key = idemKey();
    const win = futureWindow(90, 1, 1);
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => createBooking(t.ctx, user, key, { listingId: listing.id, start: win.start, end: win.end })),
    );
    expect(new Set(rs.map((r) => r.response.booking.id)).size).toBe(1);
    expect(rs.filter((r) => !r.replayed)).toHaveLength(1);
    const n = await db.pool.query('SELECT count(*)::int AS n FROM bookings WHERE consumer_id = $1', [user]);
    expect(n.rows[0].n).toBe(1);
    const payments = await db.pool.query('SELECT count(*)::int AS n FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE b.consumer_id = $1', [user]);
    expect(payments.rows[0].n).toBe(1);
  });
});

describe('결제 확정이 동시에 몰려도', () => {
  it('서로 다른 20개 예약의 확정이 동시에 들어와도 모두 확정되고, 원장은 정확히 20건이다 (데드락·중복 분개 없음)', async () => {
    const listing = await makeListing(db.pool, { bufferMinutes: 0 });
    const users = await Promise.all(Array.from({ length: 20 }, (_, i) => makeUser(db.pool, `p${i}`)));
    const bookings = await Promise.all(users.map((u, i) => book(t.ctx, u, listing, futureWindow(140 + i, 1, 2))));
    const redirects = bookings.map((b) => payAtPg(t.gateway, b.payment));
    t.gateway.latencyMs = 20;
    const ledgerBefore = (await db.pool.query('SELECT count(*)::int AS n FROM ledger_transactions')).rows[0].n;
    try {
      const rs = await Promise.allSettled(users.map((u, i) => confirmPayment(t.ctx, u, redirects[i]!)));
      expect(rejections(rs)).toEqual([]);
      for (const r of fulfilled(rs)) expect(r.status).toBe('CONFIRMED');
    } finally {
      t.gateway.latencyMs = 0;
    }
    const ledgerAfter = (await db.pool.query('SELECT count(*)::int AS n FROM ledger_transactions')).rows[0].n;
    expect(ledgerAfter - ledgerBefore).toBe(20);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('홀드 만료와 경쟁', () => {
  it('홀드가 만료됐지만 워커가 아직 안 돌았어도, 동시에 두 명이 노리면 한 명만 가져가고 이전 예약은 EXPIRED 가 된다', async () => {
    const listing = await makeListing(db.pool);
    const [a, b, c] = [await makeUser(db.pool, 'a'), await makeUser(db.pool, 'b'), await makeUser(db.pool, 'c')];
    const win = futureWindow(100, 1, 2);
    const first = await book(t.ctx, a, listing, win);
    await db.pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [first.booking.id]);

    const rs = await Promise.allSettled([book(t.ctx, b, listing, win), book(t.ctx, c, listing, win)]);
    expect(fulfilled(rs)).toHaveLength(1);
    expect(rejections(rs)[0]).toBeInstanceOf(SlotTakenError);

    const old = await db.pool.query('SELECT status FROM bookings WHERE id = $1', [first.booking.id]);
    expect(old.rows[0].status).toBe('EXPIRED');
    const oldPay = await db.pool.query('SELECT status, failure_reason FROM payments WHERE booking_id = $1', [first.booking.id]);
    expect(oldPay.rows[0]).toMatchObject({ status: 'FAILED', failure_reason: 'HOLD_EXPIRED' });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('결제 확정 중(PAYMENT_CONFIRMING)인 예약은 홀드가 지나도 슬롯을 내주지 않는다 — 승인된 뒤에는 확정된다', async () => {
    const listing = await makeListing(db.pool);
    const [a, b] = [await makeUser(db.pool, 'a'), await makeUser(db.pool, 'b')];
    const win = futureWindow(110, 1, 2);
    const first = await book(t.ctx, a, listing, win);
    const redirect = payAtPg(t.gateway, first.payment);

    const gate = t.gateway.pauseConfirms(); // PG 가 응답을 늦추는 중
    const inflight = confirmPayment(t.ctx, a, redirect);
    await vi_waitFor(async () => {
      const s = await db.pool.query('SELECT status FROM bookings WHERE id = $1', [first.booking.id]);
      return s.rows[0].status === 'PAYMENT_CONFIRMING';
    });
    // 승인 대기 중에 홀드 시간이 지나 버렸다
    await db.pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [first.booking.id]);

    // 다른 사람의 예약도, 워커의 만료 청소도 이 슬롯을 건드리지 못한다
    await expect(book(t.ctx, b, listing, win)).rejects.toBeInstanceOf(SlotTakenError);
    expect(await expireHolds(t.ctx)).toBe(0);

    gate.release();
    expect(await inflight).toEqual({ status: 'CONFIRMED', bookingId: first.booking.id });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('홀드가 막 만료된 순간 A 가 결제하고 B 가 예약해도: A 는 PG 호출 없이 거절되고, 둘 다 성공하는 일은 없다 (20회)', async () => {
    const listing = await makeListing(db.pool);
    for (let round = 0; round < 20; round++) {
      const [a, b] = [await makeUser(db.pool, 'a'), await makeUser(db.pool, 'b')];
      const win = futureWindow(120 + round, 1, 2);
      const first = await book(t.ctx, a, listing, win);
      const redirect = payAtPg(t.gateway, first.payment);
      await db.pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [first.booking.id]);
      const callsBefore = t.gateway.confirmCalls.length;

      const [aRes, bRes] = await Promise.allSettled([confirmPayment(t.ctx, a, redirect), book(t.ctx, b, listing, win)]);
      expect(aRes.status).toBe('rejected');
      expect((aRes as PromiseRejectedResult).reason).toBeInstanceOf(HoldExpiredError);
      expect(t.gateway.confirmCalls.length, `round ${round}: 만료된 결제는 PG 를 호출하지 않는다`).toBe(callsBefore);
      if (bRes.status === 'rejected') expect(bRes.reason).toBeInstanceOf(SlotTakenError); // A 의 정리가 끝나기 전이면 한 번 거절될 수 있다
    }
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

async function vi_waitFor(pred: () => Promise<boolean>, timeoutMs = 5_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition not met in time');
}
