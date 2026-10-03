import type { Pool } from 'pg';
import { loadConfig, type AppConfig } from './config';
import { createPool } from './db';
import { createLogger, type Logger } from './logger';
import { FakeGateway } from './payments/fake';
import type { PaymentGateway } from './payments/gateway';
import { PortOneGateway } from './payments/portone';
import { TossGateway } from './payments/toss';

/** 서비스 함수들이 받는 의존성 묶음 — 테스트는 가짜 PG·고정 시계를 주입한다 */
export interface AppContext {
  pool: Pool;
  gateway: PaymentGateway;
  clock: () => Date;
  config: AppConfig;
  log: Logger;
}

const KEY = Symbol.for('slatebook.context');
type GlobalWithCtx = typeof globalThis & { [KEY]?: AppContext };

/** Next.js 서버 프로세스용 싱글턴 (dev 의 HMR 로 풀이 계속 늘어나지 않게 globalThis 에 둔다) */
export function getContext(): AppContext {
  const g = globalThis as GlobalWithCtx;
  if (g[KEY]) return g[KEY];
  const config = loadConfig();
  const gateway: PaymentGateway =
    config.gateway === 'toss'
      ? new TossGateway({ secretKey: config.tossSecretKey! })
      : config.gateway === 'portone'
        ? new PortOneGateway({ apiSecret: config.portone!.apiSecret, storeId: config.portone!.storeId })
        : new FakeGateway();
  g[KEY] = {
    pool: createPool(config.databaseUrl),
    gateway,
    clock: () => new Date(),
    config,
    log: createLogger(config.logLevel),
  };
  return g[KEY];
}

/** 데모 모드에서 가짜 PG 결제창 API 가 접근하는 FakeGateway (그 밖에서는 null) */
export function getFakeGateway(ctx: AppContext): FakeGateway | null {
  // instanceof 는 번들이 달라 클래스 복사본이 다르면 거짓이 된다 → 이름으로 판별한다
  return ctx.gateway.name === 'fake' ? (ctx.gateway as FakeGateway) : null;
}
