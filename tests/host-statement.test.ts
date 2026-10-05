import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPayment } from '../src/server/payments/confirm';
import { getHostStatement } from '../src/server/host/statement';
import { updateListingPrice } from '../src/server/host/pricing';
import { NotFoundError, ValidationError } from '../src/server/errors';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, makeHost, makeListing, makeUser } from './helpers/fixtures';
import { book, completedBooking, payAtPg } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

/**
 * 호스트(공급자) 화면의 두 가지 약속:
 *  1) 정산 내역은 예약 화면의 숫자가 아니라 원장에서 읽는다 — 이용 완료된 예약만, 결제액 = 수수료 + 정산액, 지급 예정 = 원장 잔액
 *  2) 호스트가 가격을 바꿔도 이미 잡힌 예약과 그 정산은 그대로다 (예약 시점 스냅샷)
 */
let db: TestDb;
let t: TestCtx;
let day = 20;
const nextDay = () => day++;

beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool);
});
afterAll(() => db.drop());

const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];

describe('정산 내역은 원장에서 읽는다', () => {
  it('이용 완료된 예약만 나오고, 결제액 = 수수료 + 정산액, 지급 예정 = 원장 HOST_PAYABLE 잔액, 이용 전 결제는 예수금으로 따로', async () => {
    const hostId = await makeHost(db.pool, 1000); // 수수료 10%
    const listing = await makeListing(db.pool, { hostId, hourlyPrice: 50_000, bufferMinutes: 30 });
    const user = await makeUser(db.pool);
    await completedBooking(t.ctx, t.gateway, db.pool, user, listing, futureWindow(nextDay(), 1, 2)); // 100,000원
    await completedBooking(t.ctx, t.gateway, db.pool, user, listing, futureWindow(nextDay(), 1, 2)); // 100,000원
    const confirmedOnly = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    await confirmPayment(t.ctx, user, payAtPg(t.gateway, confirmedOnly.payment)); // 결제만 끝남 (이용 전)
    await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2)); // 결제 전 홀드

    const s = (await getHostStatement(db.pool, hostId))!;
    expect(s.rows).toHaveLength(2);
    for (const r of s.rows) expect(r).toMatchObject({ gross: 100_000, fee: 10_000, net: 90_000, listingTitle: 'A홀' });
    expect(s.payable).toBe(180_000);
    expect(s.feeTotal).toBe(20_000);
    expect(s.escrow).toBe(100_000);

    // 원장에서 읽은 정산액이 예약 시점 스냅샷(hostNet)과 같다 — 두 경로가 독립적으로 같은 답을 낸다
    const snapRows = await q<{ snap: string }>(
      `SELECT COALESCE(SUM((price_snapshot->>'hostNet')::bigint), 0) AS snap FROM bookings WHERE listing_id = $1 AND status = 'COMPLETED'`,
      [listing.id],
    );
    expect(Number(snapRows[0]!.snap)).toBe(s.payable);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('다른 호스트의 돈은 보이지 않는다', async () => {
    const a = await makeHost(db.pool);
    const b = await makeHost(db.pool);
    const la = await makeListing(db.pool, { hostId: a, hourlyPrice: 50_000 });
    const lb = await makeListing(db.pool, { hostId: b, hourlyPrice: 20_000 });
    const user = await makeUser(db.pool);
    await completedBooking(t.ctx, t.gateway, db.pool, user, la, futureWindow(nextDay(), 1, 2)); // 100,000
    await completedBooking(t.ctx, t.gateway, db.pool, user, lb, futureWindow(nextDay(), 1, 2)); // 40,000

    const sa = (await getHostStatement(db.pool, a))!;
    const sb = (await getHostStatement(db.pool, b))!;
    expect(sa.rows.map((r) => r.gross)).toEqual([100_000]);
    expect(sa.payable).toBe(90_000);
    expect(sb.rows.map((r) => r.gross)).toEqual([40_000]);
    expect(sb.payable).toBe(36_000);
    expect(sa.listings.map((l) => l.id)).toEqual([la.id]);
  });

  it('호스트가 아닌 사용자에게는 정산 화면이 없다', async () => {
    expect(await getHostStatement(db.pool, await makeUser(db.pool))).toBeNull();
  });
});

describe('호스트가 가격을 정한다', () => {
  it('소유자만 바꿀 수 있고, 값은 검증되며, 이미 잡힌 예약·정산 내역은 그대로이고, 새 예약부터 새 가격이다', async () => {
    const hostId = await makeHost(db.pool);
    const listing = await makeListing(db.pool, { hostId, hourlyPrice: 50_000 });
    const user = await makeUser(db.pool);
    await completedBooking(t.ctx, t.gateway, db.pool, user, listing, futureWindow(nextDay(), 1, 2)); // 정산 100,000 / 90,000
    const held = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2)); // 결제 대기 100,000

    // 남의 상품: 존재 여부를 알려주지 않는다
    await expect(updateListingPrice(t.ctx, await makeHost(db.pool), listing.id, { hourlyPrice: 80_000 })).rejects.toBeInstanceOf(NotFoundError);
    // 검증
    for (const bad of [0, 500, 1.5, 20_000_000, -1, '80000', null]) {
      await expect(updateListingPrice(t.ctx, hostId, listing.id, { hourlyPrice: bad })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(updateListingPrice(t.ctx, hostId, listing.id, { hourlyPrice: 80_000, extra: 1 })).rejects.toBeInstanceOf(ValidationError);
    expect((await q('SELECT hourly_price FROM listings WHERE id = $1', [listing.id]))[0].hourly_price).toBe('50000');

    expect(await updateListingPrice(t.ctx, hostId, listing.id, { hourlyPrice: 80_000 })).toMatchObject({ id: listing.id, hourlyPrice: 80_000 });

    // 이미 잡힌 예약: 금액도, 결제할 금액도, 정산 내역도 그대로
    const [heldRow] = await q('SELECT total_amount, price_snapshot FROM bookings WHERE id = $1', [held.booking.id]);
    expect(heldRow.total_amount).toBe('100000');
    expect(heldRow.price_snapshot.hourlyPrice).toBe(50_000);
    expect((await q('SELECT amount FROM payments WHERE order_id = $1', [held.payment.orderId]))[0].amount).toBe('100000');
    const r = await confirmPayment(t.ctx, user, payAtPg(t.gateway, held.payment));
    expect(r.status).toBe('CONFIRMED');
    const s = (await getHostStatement(db.pool, hostId))!;
    expect(s.rows.map((x) => x.gross)).toEqual([100_000]);
    expect(s.escrow).toBe(100_000);
    expect(s.listings[0]).toMatchObject({ id: listing.id, hourlyPrice: 80_000 });

    // 새 예약부터 새 가격
    const fresh = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 2));
    expect(fresh.booking.totalAmount).toBe(160_000);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});
