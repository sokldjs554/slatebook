import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, makeListing, makeUser, type Listing } from './helpers/fixtures';
import { book } from './helpers/flow';

/**
 * 앱 코드가 틀려도 DB 가 막아야 하는 규칙들. 일부러 앱을 거치지 않고 SQL 로 직접 어긴다.
 * 에러 코드: 23P01 제외, SB001 예약 전이 / SB002 결제 전이 / SB003 원장 불균형 / SB004 추가 전용 / SB005 슬롯 규칙
 */
let db: TestDb;
let t: TestCtx;
let pool: Pool;
let listing: Listing;
let guest: string;
let dayCounter = 10;
const nextDay = () => dayCounter++; // 180일 한도 안에서 테스트마다 다른 날짜

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  t = makeCtx(pool);
  listing = await makeListing(pool, { bufferMinutes: 0 });
  guest = await makeUser(pool, 'guest');
});
afterAll(() => db.drop());

const sqlstate = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

async function newBooking(day: number, startHour = 1, hours = 2) {
  const b = await book(t.ctx, guest, listing, futureWindow(day, startHour, hours));
  const slot = (await pool.query('SELECT id, resource_id, blocked FROM booking_slots WHERE booking_id = $1', [b.booking.id])).rows[0];
  return { ...b, slot };
}

describe('겹침 방지 (EXCLUDE)', () => {
  it('앱을 거치지 않은 직접 INSERT 도 겹치면 23P01 로 거부된다', async () => {
    const a = await newBooking(nextDay());
    const code = await sqlstate(
      pool.query(`INSERT INTO booking_slots(booking_id, resource_id, blocked, state) VALUES ($1, $2, $3::tstzrange, 'HELD')`, [
        a.booking.id,
        a.slot.resource_id,
        a.slot.blocked,
      ]),
    );
    expect(code).toBe('23P01');
  });

  it('맞닿은 구간([)은 겹치지 않는다: 10–12시 뒤에 12–14시', async () => {
    const d = nextDay();
    const a = await newBooking(d, 1, 2);
    const next = await book(t.ctx, await makeUser(pool), listing, futureWindow(d, 3, 2)); // 03–05, 버퍼 0
    expect(next.booking.status).toBe('PENDING_PAYMENT');
    expect(a.booking.id).not.toBe(next.booking.id);
  });

  it('RELEASED 슬롯은 같은 구간을 다시 점유할 수 있다', async () => {
    const d = nextDay();
    const a = await newBooking(d);
    await pool.query(`UPDATE booking_slots SET state = 'RELEASED' WHERE booking_id = $1`, [a.booking.id]);
    await pool.query(`UPDATE bookings SET status = 'EXPIRED' WHERE id = $1`, [a.booking.id]);
    const again = await book(t.ctx, await makeUser(pool), listing, futureWindow(d, 1, 2));
    expect(again.booking.status).toBe('PENDING_PAYMENT');
  });

  it('닫힌 구간 [] 이나 빈 구간은 예약 기간으로 저장할 수 없다', async () => {
    const base = [guest, listing.id];
    const insert = (period: string, key: string) =>
      pool.query(
        `INSERT INTO bookings(consumer_id, listing_id, period, total_amount, price_snapshot, cancel_policy_snapshot, hold_expires_at, idempotency_key, request_hash)
         VALUES ($1, $2, $3::tstzrange, 1000, '{}', '{}', now() + interval '10 min', $4, 'h')`,
        [...base, period, key],
      );
    expect(await sqlstate(insert('[2030-01-01 10:00+00,2030-01-01 12:00+00]', 'k1'))).toBe('23514');
    expect(await sqlstate(insert('(2030-01-01 10:00+00,2030-01-01 12:00+00)', 'k2'))).toBe('23514');
    expect(await sqlstate(insert('empty', 'k3'))).toBe('23514');
  });
});

describe('상태 전이는 DB 가 강제한다', () => {
  it.each([
    ['EXPIRED', 'CONFIRMED'],
    ['EXPIRED', 'PENDING_PAYMENT'],
    ['PENDING_PAYMENT', 'CONFIRMED'], // 반드시 PAYMENT_CONFIRMING 을 거쳐야 한다
    ['PENDING_PAYMENT', 'COMPLETED'],
  ])('예약 %s → %s 는 SB001 로 거부', async (from, to) => {
    const b = await newBooking(nextDay());
    if (from === 'EXPIRED') {
      await pool.query(`UPDATE booking_slots SET state = 'RELEASED' WHERE booking_id = $1`, [b.booking.id]);
      await pool.query(`UPDATE bookings SET status = 'EXPIRED' WHERE id = $1`, [b.booking.id]);
    }
    const code = await sqlstate(pool.query(`UPDATE bookings SET status = $2, hold_expires_at = now() + interval '1 min' WHERE id = $1`, [b.booking.id, to]));
    expect(code).toBe('SB001');
  });

  it('결제 CANCELED → APPROVED, FAILED → APPROVED 는 SB002 로 거부', async () => {
    const b = await newBooking(nextDay());
    await pool.query(`UPDATE payments SET status = 'FAILED' WHERE booking_id = $1`, [b.booking.id]);
    expect(await sqlstate(pool.query(`UPDATE payments SET status = 'APPROVED' WHERE booking_id = $1`, [b.booking.id]))).toBe('SB002');
    await pool.query(`UPDATE payments SET status = 'CANCELED', canceled_amount = amount WHERE booking_id = $1`, [b.booking.id]);
    expect(await sqlstate(pool.query(`UPDATE payments SET status = 'APPROVED' WHERE booking_id = $1`, [b.booking.id]))).toBe('SB002');
  });

  it('RELEASED 슬롯은 되살릴 수 없고, 슬롯의 자원·시간·예약은 바꿀 수 없다', async () => {
    const b = await newBooking(nextDay());
    expect(
      await sqlstate(pool.query(`UPDATE booking_slots SET blocked = tstzrange(lower(blocked), upper(blocked) + interval '1 hour') WHERE booking_id = $1`, [b.booking.id])),
    ).toBe('SB005');
    await pool.query(`UPDATE booking_slots SET state = 'RELEASED' WHERE booking_id = $1`, [b.booking.id]);
    expect(await sqlstate(pool.query(`UPDATE booking_slots SET state = 'HELD' WHERE booking_id = $1`, [b.booking.id]))).toBe('SB005');
  });

  it('PENDING_PAYMENT · PAYMENT_CONFIRMING 예약은 hold_expires_at 이 반드시 있어야 한다', async () => {
    const b = await newBooking(nextDay());
    expect(await sqlstate(pool.query(`UPDATE bookings SET hold_expires_at = NULL WHERE id = $1`, [b.booking.id]))).toBe('23514');
  });
});

describe('원장', () => {
  it('합계가 0 이 아닌 거래는 COMMIT 시점에 거부된다', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO ledger_accounts(code) VALUES ('X_ACC') ON CONFLICT DO NOTHING`);
      const tx = await c.query(`INSERT INTO ledger_transactions(kind, ref_type, ref_id, idempotency_key) VALUES ('T','t',gen_random_uuid(),'unbalanced-1') RETURNING id`);
      await c.query(`INSERT INTO ledger_entries(transaction_id, account_id, amount) SELECT $1, id, 100 FROM ledger_accounts WHERE code='X_ACC'`, [tx.rows[0].id]);
      expect(await sqlstate(c.query('COMMIT'))).toBe('SB003');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });

  it('원장 줄은 수정·삭제할 수 없다 (SB004), 0원 줄도 넣을 수 없다', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO ledger_accounts(code) VALUES ('Y_ACC'), ('Z_ACC') ON CONFLICT DO NOTHING`);
      const tx = await c.query(`INSERT INTO ledger_transactions(kind, ref_type, ref_id, idempotency_key) VALUES ('T','t',gen_random_uuid(),'balanced-1') RETURNING id`);
      await c.query(`INSERT INTO ledger_entries(transaction_id, account_id, amount) SELECT $1, id, CASE code WHEN 'Y_ACC' THEN 5 ELSE -5 END FROM ledger_accounts WHERE code IN ('Y_ACC','Z_ACC')`, [tx.rows[0].id]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    expect(await sqlstate(pool.query(`UPDATE ledger_entries SET amount = 1`))).toBe('SB004');
    expect(await sqlstate(pool.query(`DELETE FROM ledger_entries`))).toBe('SB004');
    expect(await sqlstate(pool.query(`UPDATE ledger_transactions SET kind = 'X'`))).toBe('SB004');
    expect(await sqlstate(pool.query(`DELETE FROM ledger_transactions`))).toBe('SB004');
    const acc = (await pool.query(`SELECT id FROM ledger_accounts WHERE code = 'Y_ACC'`)).rows[0].id;
    const tx = (await pool.query(`SELECT id FROM ledger_transactions LIMIT 1`)).rows[0].id;
    expect(await sqlstate(pool.query(`INSERT INTO ledger_entries(transaction_id, account_id, amount) VALUES ($1, $2, 0)`, [tx, acc]))).toBe('23514');
  });

  it('같은 idempotency_key 의 거래는 두 번 기록되지 않는다', async () => {
    const q = () => pool.query(`INSERT INTO ledger_transactions(kind, ref_type, ref_id, idempotency_key) VALUES ('T','t',gen_random_uuid(),'dup-key')`);
    await q();
    expect(await sqlstate(q())).toBe('23505');
  });
});

describe('결제·정산 중복 방지', () => {
  it('예약 하나에 살아 있는 결제는 1건만: 실패한 결제 뒤에는 새 결제가 가능하다', async () => {
    const b = await newBooking(nextDay());
    const insert = (order: string) =>
      pool.query(`INSERT INTO payments(booking_id, order_id, provider, amount, status) VALUES ($1, $2, 'fake', 1000, 'READY')`, [b.booking.id, order]);
    expect(await sqlstate(insert('second-live-order'))).toBe('23505');
    await pool.query(`UPDATE payments SET status = 'FAILED' WHERE booking_id = $1`, [b.booking.id]);
    expect(await sqlstate(insert('after-failed-order'))).toBeUndefined();
  });

  it('payment_key · order_id 는 유일하다', async () => {
    const [x, y] = [await newBooking(nextDay()), await newBooking(nextDay())];
    await pool.query(`UPDATE payments SET payment_key = 'pk-shared' WHERE booking_id = $1`, [x.booking.id]);
    expect(await sqlstate(pool.query(`UPDATE payments SET payment_key = 'pk-shared' WHERE booking_id = $1`, [y.booking.id]))).toBe('23505');
  });

  it('같은 결제가 두 번 정산 항목에 들어갈 수 없고, 정산 합계식이 어긋나면 거부된다', async () => {
    const b = await newBooking(nextDay());
    const mk = async (start: string, end: string, net = 90_000) =>
      pool.query(
        `INSERT INTO settlements(host_id, period_start, period_end, gross_amount, fee_amount, net_amount, status)
         VALUES ($1, $2, $3, 100000, 10000, $4, 'DRAFT') RETURNING id`,
        [listing.hostId, start, end, net],
      );
    expect(await sqlstate(mk('2031-01-01', '2031-01-07', 1))).toBe('23514'); // net != gross - fee
    const s1 = (await mk('2031-01-01', '2031-01-07')).rows[0].id;
    const s2 = (await mk('2031-01-08', '2031-01-14')).rows[0].id;
    const item = (sid: string) =>
      pool.query(`INSERT INTO settlement_items(settlement_id, booking_id, kind, source_id, gross, fee, net) VALUES ($1, $2, 'SALE', $3, 100000, 10000, 90000)`, [sid, b.booking.id, b.booking.id]);
    await item(s1);
    expect(await sqlstate(item(s2))).toBe('23505');
    expect(await sqlstate(mk('2031-01-01', '2031-01-07'))).toBe('23505'); // 같은 호스트·기간의 정산은 하나
  });

  it('후기는 예약당 1건, 평점은 1~5', async () => {
    const b = await newBooking(nextDay());
    const review = (rating: number) =>
      pool.query(`INSERT INTO reviews(booking_id, author_id, listing_id, rating) VALUES ($1, $2, $3, $4)`, [b.booking.id, guest, listing.id, rating]);
    expect(await sqlstate(review(6))).toBe('23514');
    expect(await sqlstate(review(5))).toBeUndefined();
    expect(await sqlstate(review(4))).toBe('23505');
  });
});
