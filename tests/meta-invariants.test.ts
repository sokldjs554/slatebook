import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { createBooking } from '../src/server/bookings/create';
import { createTestDb } from './helpers/db';
import { makeCtx } from './helpers/ctx';
import { futureWindow, idemKey, makeListing, makeUser, type Listing } from './helpers/fixtures';
import { book } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

/**
 * "테스트가 통과한다"는 "테스트가 잘못을 잡아낼 수 있다"가 증명되기 전에는 아무것도 아니다.
 * 이 파일은 (1) 불변식 검사기가 실제로 위반을 잡아내는지, (2) 방어 계층을 하나씩 걷어냈을 때 무슨 일이 생기는지를 확인한다.
 */
async function withDb<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const db = await createTestDb();
  try {
    return await fn(db.pool);
  } finally {
    await db.drop();
  }
}

/** 트리거·FK 를 우회하는 슈퍼유저 세션으로 일부러 DB 를 망가뜨린다 */
async function corrupt(pool: Pool, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query(`SET session_replication_role = replica`);
    await c.query(sql, params);
  } finally {
    await c.query(`RESET session_replication_role`).catch(() => {});
    c.release();
  }
}

const labels = (v: string[]) => v.map((s) => s.split(' — ')[0]);

describe('불변식 검사기는 위반을 실제로 잡아낸다', () => {
  it('깨끗한 DB 에서는 아무것도 보고하지 않는다', async () => {
    await withDb(async (pool) => {
      expect(await findInvariantViolations(pool)).toEqual([]);
    });
  });

  it('겹치는 활성 슬롯 (OVERLAP)', async () => {
    await withDb(async (pool) => {
      const t = makeCtx(pool);
      const listing = await makeListing(pool, { bufferMinutes: 0 });
      const a = await book(t.ctx, await makeUser(pool), listing, futureWindow(10, 1, 2));
      const b = await book(t.ctx, await makeUser(pool), listing, futureWindow(10, 5, 2));
      await pool.query('ALTER TABLE booking_slots DROP CONSTRAINT no_overbooking');
      await corrupt(pool, `UPDATE booking_slots SET blocked = (SELECT blocked FROM booking_slots WHERE booking_id = $1) WHERE booking_id = $2`, [a.booking.id, b.booking.id]);
      expect(labels(await findInvariantViolations(pool))).toContain('OVERLAP');
    });
  });

  it('합계가 0 이 아닌 원장 / 환불 대기 표시가 남은 채 취소된 결제', async () => {
    await withDb(async (pool) => {
      const acc = (await pool.query(`INSERT INTO ledger_accounts(code) VALUES ('A') RETURNING id`)).rows[0].id;
      const tx = (await pool.query(`INSERT INTO ledger_transactions(kind, ref_type, ref_id, idempotency_key) VALUES ('T','t',$1,'k') RETURNING id`, [randomUUID()])).rows[0].id;
      await corrupt(pool, `INSERT INTO ledger_entries(transaction_id, account_id, amount) VALUES ($1, $2, 500)`, [tx, acc]);
      expect(labels(await findInvariantViolations(pool))).toContain('LEDGER_UNBALANCED');
    });
  });

  it('확정 예약의 결제·슬롯·분개가 빠졌을 때 / 승인 결제의 예약이 확정이 아닐 때 / PG 미수금 불일치', async () => {
    await withDb(async (pool) => {
      const t = makeCtx(pool);
      const listing = await makeListing(pool);
      const b = await book(t.ctx, await makeUser(pool), listing, futureWindow(11, 1, 2));
      // 예약만 확정으로 바꾸고 결제·슬롯·원장은 그대로 → "겉으로만 확정"
      await corrupt(pool, `UPDATE bookings SET status = 'CONFIRMED', hold_expires_at = NULL WHERE id = $1`, [b.booking.id]);
      let v = labels(await findInvariantViolations(pool));
      expect(v).toContain('CONFIRMED_BOOKING_BROKEN');
      expect(v).not.toContain('DEAD_BOOKING_HOLDS_SLOT'); // 확정 예약이 CONFIRMED 가 아닌 슬롯을 쥔 것은 이 검사의 대상이 아니다

      // 결제만 승인으로 바꾸고 원장은 비움 → PG 미수금 불일치
      await corrupt(pool, `UPDATE bookings SET status = 'PENDING_PAYMENT', hold_expires_at = now() + interval '5 min' WHERE id = $1`, [b.booking.id]);
      await corrupt(pool, `UPDATE payments SET status = 'APPROVED' WHERE booking_id = $1`, [b.booking.id]);
      v = labels(await findInvariantViolations(pool));
      expect(v).toContain('APPROVED_PAYMENT_WITHOUT_CONFIRMED_BOOKING');
      expect(v).toContain('PG_RECEIVABLE_MISMATCH');
    });
  });

  it('끝난 예약이 슬롯을 쥐고 있을 때 / 진행 중 예약에 슬롯이 없을 때', async () => {
    await withDb(async (pool) => {
      const t = makeCtx(pool);
      const listing = await makeListing(pool);
      const [u1, u2] = [await makeUser(pool), await makeUser(pool)];
      const dead = await book(t.ctx, u1, listing, futureWindow(12, 1, 2));
      const live = await book(t.ctx, u2, listing, futureWindow(13, 1, 2));
      await corrupt(pool, `UPDATE bookings SET status = 'EXPIRED' WHERE id = $1`, [dead.booking.id]); // 슬롯은 HELD 로 남김
      await corrupt(pool, `UPDATE booking_slots SET state = 'RELEASED' WHERE booking_id = $1`, [live.booking.id]); // 진행 중인데 슬롯을 풀어버림
      const v = labels(await findInvariantViolations(pool));
      expect(v).toContain('DEAD_BOOKING_HOLDS_SLOT');
      expect(v).toContain('LIVE_BOOKING_WITHOUT_SLOT');
    });
  });

  it('환불 완료 표시인데 환불 분개가 없을 때 / 환불 대기 표시가 남은 채 취소됐을 때', async () => {
    await withDb(async (pool) => {
      const t = makeCtx(pool);
      const listing = await makeListing(pool);
      const b = await book(t.ctx, await makeUser(pool), listing, futureWindow(14, 1, 2));
      await corrupt(pool, `UPDATE payments SET status = 'CANCELED', canceled_amount = amount, refund_pending = true WHERE booking_id = $1`, [b.booking.id]);
      const v = labels(await findInvariantViolations(pool));
      expect(v).toContain('CANCELED_PAYMENT_NOT_REFUNDED_IN_LEDGER');
      expect(v).toContain('REFUND_PENDING_ON_FINISHED_PAYMENT');
    });
  });
});

describe('방어 계층을 하나씩 걷어내 보면 — 각 계층이 왜 필요한지', () => {
  const N = 20;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** 흔한 구현: 겹치는 예약이 있는지 조회하고, 없으면 INSERT (잠금 없음). 조회와 쓰기 사이에 틈이 있다. */
  async function naiveBook(pool: Pool, userId: string, listing: Listing, win: { start: string; end: string }) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const seen = await c.query(
        `SELECT 1 FROM booking_slots WHERE resource_id = $1 AND state <> 'RELEASED' AND blocked && tstzrange($2::timestamptz, $3::timestamptz, '[)')`,
        [listing.resourceIds[0], win.start, win.end],
      );
      if (seen.rowCount) {
        await c.query('ROLLBACK');
        return 'taken';
      }
      await sleep(15); // 가격 계산·쿠폰 확인 같은 다른 일을 하는 동안
      const b = await c.query(
        `INSERT INTO bookings(consumer_id, listing_id, period, total_amount, price_snapshot, cancel_policy_snapshot, hold_expires_at, idempotency_key, request_hash)
         VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 1000, '{}', '{}', now() + interval '10 min', $5, 'h') RETURNING id`,
        [userId, listing.id, win.start, win.end, idemKey()],
      );
      await c.query(`INSERT INTO booking_slots(booking_id, resource_id, blocked, state) VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), 'HELD')`, [
        b.rows[0].id,
        listing.resourceIds[0],
        win.start,
        win.end,
      ]);
      await c.query('COMMIT');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      return `error:${(e as { code?: string }).code}`;
    } finally {
      c.release();
    }
  }

  it('① 조회 후 INSERT 만 있고 DB 제약이 없으면 → 같은 시간이 여러 명에게 팔린다 (이 테스트의 검사기가 그것을 잡아낸다)', async () => {
    await withDb(async (pool) => {
      await pool.query('ALTER TABLE booking_slots DROP CONSTRAINT no_overbooking');
      const listing = await makeListing(pool, { bufferMinutes: 0 });
      const users = await Promise.all(Array.from({ length: N }, () => makeUser(pool)));
      const win = futureWindow(20, 1, 2);
      const results = await Promise.all(users.map((u) => naiveBook(pool, u, listing, win)));
      expect(results.filter((r) => r === 'ok').length).toBeGreaterThan(1);
      expect(labels(await findInvariantViolations(pool))).toContain('OVERLAP');
    });
  });

  it('② 같은 구현이라도 EXCLUDE 제약이 있으면 → 겹침은 0 (실패는 제약 위반 또는 데드락으로 나타난다)', async () => {
    await withDb(async (pool) => {
      const listing = await makeListing(pool, { bufferMinutes: 0 });
      const users = await Promise.all(Array.from({ length: N }, () => makeUser(pool)));
      const win = futureWindow(20, 1, 2);
      const results = await Promise.all(users.map((u) => naiveBook(pool, u, listing, win)));
      expect(results.filter((r) => r === 'ok')).toHaveLength(1);
      for (const r of results) expect(['ok', 'taken', 'error:23P01', 'error:40P01']).toContain(r);
      expect(await findInvariantViolations(pool)).toEqual([]);
    });
  });

  it('③ 실제 구현은 제약 없이도 겹침이 없다 — 자원 행 잠금 + 빈 자원 선택이 제약과 독립된 두 번째 방어선이다', async () => {
    await withDb(async (pool) => {
      await pool.query('ALTER TABLE booking_slots DROP CONSTRAINT no_overbooking');
      const t = makeCtx(pool);
      const listing = await makeListing(pool, { bufferMinutes: 0 });
      const users = await Promise.all(Array.from({ length: N }, () => makeUser(pool)));
      const win = futureWindow(20, 1, 2);
      const rs = await Promise.allSettled(users.map((u) => createBooking(t.ctx, u, idemKey(), { listingId: listing.id, start: win.start, end: win.end })));
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await findInvariantViolations(pool)).toEqual([]);
    });
  });
});
