import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import type { TestProject } from 'vitest/node';
import { createPool } from '../../src/server/db';
import { migrate } from '../../src/server/migrate';

declare module 'vitest' {
  export interface ProvidedContext {
    adminUrl: string;
    templateDb: string;
  }
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * 통합 테스트는 실제 PostgreSQL 을 쓴다 (동시성·제약·잠금은 가짜 DB 로는 검증할 수 없다).
 * 마이그레이션을 한 번만 적용한 템플릿 DB 를 만들고, 각 테스트 파일은 그 복제본을 받는다.
 */
export async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      'TEST_DATABASE_URL 이 필요합니다. 예) postgres://slatebook:slatebook@localhost:5432/postgres (docker compose up -d db)',
    );
  }
  const templateDb = `sb_tpl_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${templateDb}`);
  } finally {
    await admin.end();
  }
  const pool = createPool(withDatabase(adminUrl, templateDb), { max: 2 });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
  project.provide('adminUrl', adminUrl);
  project.provide('templateDb', templateDb);

  return async () => {
    const c = new Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query(`DROP DATABASE IF EXISTS ${templateDb} WITH (FORCE)`);
    } finally {
      await c.end();
    }
  };
}
