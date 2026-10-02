import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { Client } from 'pg';
import { inject } from 'vitest';
import { createPool } from '../../src/server/db';

export interface TestDb {
  name: string;
  pool: Pool;
  url: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** 마이그레이션이 끝난 템플릿에서 이 테스트 파일 전용 DB 를 복제한다 → 파일끼리 완전히 격리 */
export async function createTestDb(poolMax = 40): Promise<TestDb> {
  const adminUrl = inject('adminUrl');
  const template = inject('templateDb');
  const name = `sb_t_${randomBytes(5).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(adminUrl, name);
  const pool = createPool(url, { max: poolMax });
  return {
    name,
    pool,
    url,
    async drop() {
      await pool.end();
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
