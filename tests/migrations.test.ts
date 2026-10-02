import { describe, expect, it } from 'vitest';
import { migrate } from '../src/server/migrate';
import { createTestDb } from './helpers/db';

describe('마이그레이션', () => {
  it('모두 적용되어 있고, 다시 실행해도 아무것도 하지 않는다. 시스템 원장 계정이 미리 만들어져 있다', async () => {
    const db = await createTestDb();
    try {
      const versions = (await db.pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
      expect(versions).toEqual(['001_init.sql', '002_system_ledger_accounts.sql']);
      expect(await migrate(db.pool)).toEqual([]);
      const accounts = (await db.pool.query('SELECT code FROM ledger_accounts WHERE owner_id IS NULL ORDER BY code')).rows.map((r) => r.code);
      expect(accounts).toEqual(['CUSTOMER_ESCROW', 'PG_RECEIVABLE', 'PLATFORM_FEE_REVENUE']);
    } finally {
      await db.drop();
    }
  });

  it('동시에 두 곳에서 마이그레이션을 돌려도 한 번만 적용된다 (advisory lock)', async () => {
    const db = await createTestDb();
    try {
      await db.pool.query('DROP TABLE schema_migrations'); // 적용 이력만 지워 "아직 안 한 것처럼" 만들되…
      await db.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); // 스키마도 비워 완전히 새 DB 로
      const results = await Promise.all([migrate(db.pool), migrate(db.pool), migrate(db.pool)]);
      expect(results.flat().sort()).toEqual(['001_init.sql', '002_system_ledger_accounts.sql']); // 셋 중 한 곳만 적용
    } finally {
      await db.drop();
    }
  });
});
