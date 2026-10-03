import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemoData } from '../src/server/seed';
import { createTestDb, type TestDb } from './helpers/db';
import { findInvariantViolations } from './helpers/invariants';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.drop());

const count = async (sql: string) => (await db.pool.query(sql)).rows[0].n as number;

describe('데모 시드', () => {
  it('상품·사용자·과거 이용 내역과 후기를 만들고, 만든 데이터는 시스템 불변식을 모두 지킨다', async () => {
    const r = await seedDemoData(db.pool);
    expect(r).toMatchObject({ users: 4, listings: 3, reviews: 12 }); // 호스트 + 데모 사용자 3
    expect(await count(`SELECT count(*)::int AS n FROM listings`)).toBe(3);
    expect(await count(`SELECT count(*)::int AS n FROM bookings WHERE status = 'COMPLETED'`)).toBe(12);
    expect(await count(`SELECT count(*)::int AS n FROM reviews`)).toBe(12);
    // 이용 완료 예약마다 승인 분개와 수익 인식 분개가 있고, 호스트 몫과 수수료가 맞는다
    expect(await count(`SELECT count(*)::int AS n FROM ledger_transactions WHERE kind = 'REVENUE_RECOGNIZED'`)).toBe(12);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('여러 번 실행해도 중복되지 않는다', async () => {
    const again = await seedDemoData(db.pool);
    expect(again.reviews).toBe(0);
    expect(await count(`SELECT count(*)::int AS n FROM reviews`)).toBe(12);
    expect(await count(`SELECT count(*)::int AS n FROM listings`)).toBe(3);
    expect(await count(`SELECT count(*)::int AS n FROM users`)).toBe(4 + 7); // 후기 작성자 7명 (두 상품에 쓴 사람은 한 명으로 센다)
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('데모 사용자 선택기에는 데모 사용자만 나오고 후기 작성자는 나오지 않는다', async () => {
    const names = (await db.pool.query(`SELECT name FROM users WHERE email LIKE '%@demo.slatebook.local' ORDER BY name`)).rows.map((r) => r.name);
    expect(names).toEqual(['밥', '앨리스', '크리스', '호스트(스튜디오 사장님)']);
  });

  it('상품별 평점 집계가 후기와 맞는다 (A홀 7개 평균 4.6)', async () => {
    const { rows } = await db.pool.query(`SELECT title, rating_count, rating_sum FROM listings ORDER BY title`);
    expect(rows.find((r) => r.title.startsWith('A홀'))).toMatchObject({ rating_count: 7, rating_sum: 31 });
  });
});
