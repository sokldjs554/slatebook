import { loadConfig } from '../src/server/config';
import type { AppContext } from '../src/server/context';
import { createPool } from '../src/server/db';
import { startJobLoop } from '../src/server/jobs';
import { createLogger } from '../src/server/logger';
import { TossGateway } from '../src/server/payments/toss';
import { FakeGateway } from '../src/server/payments/fake';

/**
 * 백그라운드 워커 (별도 프로세스): 만료 정리 · 미확정 결제 대사 · 이용 완료 분개 · outbox 발행.
 * 여러 개를 띄워도 안전하다 (SKIP LOCKED 와 대사 선점 덕분에 같은 일을 두 번 하지 않는다).
 */
async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const gateway = config.gateway === 'toss' ? new TossGateway({ secretKey: config.tossSecretKey! }) : new FakeGateway();
  const ctx: AppContext = { pool: createPool(config.databaseUrl), gateway, config, log, clock: () => new Date() };

  // 가짜 PG 의 상태는 웹 프로세스 메모리에 있다. 이 프로세스의 빈 가짜 PG 로 대사하면 멀쩡한 결제를 "PG 가 모름"으로 오판한다.
  const reconcile = config.gateway !== 'fake';
  if (!reconcile) {
    log.warn('PAYMENT_GATEWAY=fake: 결제 대사는 이 워커에서 건너뜁니다. 웹 프로세스에서 RUN_JOBS_IN_PROCESS=1 로 실행하세요.');
  }
  const loop = startJobLoop(ctx, { intervalMs: 5_000, reconcile });
  log.info('worker started', { gateway: config.gateway, reconcile });

  const shutdown = async (signal: string) => {
    log.info('worker stopping', { signal });
    await loop.stop();
    await ctx.pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
