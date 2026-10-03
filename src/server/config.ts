import { z } from 'zod';

const flag = z
  .enum(['0', '1', 'true', 'false', ''])
  .optional()
  .transform((v) => v === '1' || v === 'true');

const envSchema = z.object({
  NODE_ENV: z.string().optional(),
  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1, 'DATABASE_URL is required'),
  PAYMENT_GATEWAY: z.enum(['fake', 'toss']).default('fake'),
  TOSS_SECRET_KEY: z.string().optional(),
  WEBHOOK_TOKEN: z.string().optional(),
  DEMO_AUTH: flag,
  ALLOW_DEMO_AUTH: flag,
  ALLOW_FAKE_GATEWAY: flag,
  HOLD_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
  CONFIRM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export interface AppConfig {
  databaseUrl: string;
  gateway: 'fake' | 'toss';
  tossSecretKey: string | undefined;
  webhookToken: string | undefined;
  demoAuth: boolean;
  /** 결제 대기 홀드 시간. PG 의 결제 인증 유효시간(토스는 10분)보다 길게 잡지 않는다. */
  holdMinutes: number;
  /** PG 승인 호출 타임아웃. 넘기면 "알 수 없음"으로 처리하고 대사가 결론을 낸다. */
  confirmTimeoutMs: number;
  /** PG 가 주문을 모른다고 답해도 이 시간 안에는 실패로 단정하지 않는다 (복제 지연 대비) */
  notFoundGraceMs: number;
  /** 승인 선점 후 이 시간이 지나도록 PG 가 IN_PROGRESS 라면 재시도를 포기하고 실패 처리 (PG 세션 만료보다 짧게) */
  confirmRetryWindowMs: number;
  /** 미확정 결제가 이 시간 넘게 남아 있으면 운영 알림 */
  stuckAlertAfterMs: number;
  /** 같은 결제를 PG 에 조회하는 최소 간격 (상태 폴링이 PG 를 두드리지 않게) */
  reconcileThrottleMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // ZodError 의 JSON 덩어리 대신, 로그 한 줄만 봐도 무엇을 고쳐야 하는지 알 수 있게 한다
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`환경변수가 올바르지 않습니다:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';

  if (production && e.PAYMENT_GATEWAY === 'fake' && !e.ALLOW_FAKE_GATEWAY) {
    throw new Error('PAYMENT_GATEWAY=fake 는 프로덕션에서 기동할 수 없습니다 (데모 배포라면 ALLOW_FAKE_GATEWAY=1)');
  }
  if (production && e.DEMO_AUTH && !e.ALLOW_DEMO_AUTH) {
    throw new Error('DEMO_AUTH 는 프로덕션에서 기동할 수 없습니다 (데모 배포라면 ALLOW_DEMO_AUTH=1)');
  }
  if (e.PAYMENT_GATEWAY === 'toss') {
    if (!e.TOSS_SECRET_KEY) throw new Error('PAYMENT_GATEWAY=toss 에는 TOSS_SECRET_KEY 가 필요합니다');
    if (!e.WEBHOOK_TOKEN || e.WEBHOOK_TOKEN.length < 24) {
      throw new Error('PAYMENT_GATEWAY=toss 에는 24자 이상의 WEBHOOK_TOKEN 이 필요합니다');
    }
  }

  return {
    databaseUrl: e.DATABASE_URL,
    gateway: e.PAYMENT_GATEWAY,
    tossSecretKey: e.TOSS_SECRET_KEY,
    webhookToken: e.WEBHOOK_TOKEN,
    demoAuth: e.DEMO_AUTH,
    holdMinutes: e.HOLD_MINUTES,
    confirmTimeoutMs: e.CONFIRM_TIMEOUT_MS,
    notFoundGraceMs: 60_000,
    confirmRetryWindowMs: 8 * 60_000,
    stuckAlertAfterMs: 60 * 60_000,
    reconcileThrottleMs: 5_000,
    logLevel: e.LOG_LEVEL,
  };
}
