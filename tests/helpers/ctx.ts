import type { Pool } from 'pg';
import { loadConfig, type AppConfig } from '../../src/server/config';
import type { AppContext } from '../../src/server/context';
import { silentLogger } from '../../src/server/logger';
import { FakeGateway } from '../../src/server/payments/fake';

export interface TestCtx {
  ctx: AppContext;
  gateway: FakeGateway;
}

/** 테스트용 컨텍스트: 가짜 PG, 조용한 로거, 빠른 대사 설정. overrides 로 설정을 덮어쓴다. */
export function makeCtx(pool: Pool, overrides: Partial<AppConfig> = {}): TestCtx {
  const base = loadConfig({ DATABASE_URL: 'unused', PAYMENT_GATEWAY: 'fake', LOG_LEVEL: 'silent' });
  const gateway = new FakeGateway();
  const config: AppConfig = {
    ...base,
    confirmTimeoutMs: 5_000,
    notFoundGraceMs: 0,
    reconcileThrottleMs: 0,
    ...overrides,
  };
  return { gateway, ctx: { pool, gateway, config, log: silentLogger, clock: () => new Date() } };
}
