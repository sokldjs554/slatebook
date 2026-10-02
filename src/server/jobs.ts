import type { AppContext } from './context';
import { completeEndedBookings } from './bookings/complete';
import { expireHolds } from './bookings/expire';
import { drainOutbox, type OutboxEvent } from './outbox';
import { reconcileStuckPayments } from './payments/reconcile';

export interface JobReport {
  expired: number;
  reconciled: { examined: number; resolved: number } | null;
  completed: number;
  outbox: number;
}

const ALERT_TOPICS = new Set(['payment.anomaly', 'payment.stuck', 'payment.refund_rejected']);

/** 기본 outbox 소비자: 운영 알림은 warn 으로 눈에 띄게, 나머지는 info 로 남긴다. (실서비스에서는 Slack·메일 등으로 교체) */
export function logOutboxEvent(ctx: AppContext) {
  return (e: OutboxEvent) => {
    if (ALERT_TOPICS.has(e.topic)) ctx.log.warn(`ALERT ${e.topic}`, { outboxId: e.id, ...e.payload });
    else ctx.log.info(`event ${e.topic}`, { outboxId: e.id, ...e.payload });
  };
}

/**
 * 백그라운드 작업 한 바퀴. 작업끼리 서로 실패에 영향을 주지 않도록 따로 감싼다.
 * reconcile: PG 와 같은 프로세스에 있어야 하는 가짜 PG 데모에서는 웹 프로세스 안에서만 켠다.
 */
export async function runJobsOnce(ctx: AppContext, opts: { reconcile?: boolean } = {}): Promise<JobReport> {
  const report: JobReport = { expired: 0, reconciled: null, completed: 0, outbox: 0 };
  const guard = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      ctx.log.error(`job failed: ${name}`, { err });
      return undefined;
    }
  };
  report.expired = (await guard('expireHolds', () => expireHolds(ctx))) ?? 0;
  if (opts.reconcile !== false) {
    report.reconciled = (await guard('reconcileStuckPayments', () => reconcileStuckPayments(ctx))) ?? null;
  }
  report.completed = (await guard('completeEndedBookings', () => completeEndedBookings(ctx))) ?? 0;
  report.outbox = (await guard('drainOutbox', () => drainOutbox(ctx.pool, ctx.log, logOutboxEvent(ctx)))) ?? 0;
  return report;
}

export interface JobLoop {
  /** 진행 중인 한 바퀴가 끝나길 기다린 뒤 멈춘다 */
  stop(): Promise<void>;
}

/** 주기 실행. 이전 바퀴가 끝나기 전에는 다음 바퀴를 시작하지 않는다 (겹쳐 실행되지 않는다). */
export function startJobLoop(
  ctx: AppContext,
  opts: { intervalMs: number; reconcile?: boolean; run?: () => Promise<unknown> },
): JobLoop {
  let running: Promise<unknown> | null = null;
  let stopped = false;
  const run = opts.run ?? (() => runJobsOnce(ctx, { reconcile: opts.reconcile }));

  const timer = setInterval(() => {
    if (running || stopped) return;
    running = run()
      .catch((err) => ctx.log.error('job loop iteration failed', { err }))
      .finally(() => {
        running = null;
      });
  }, opts.intervalMs);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (running) await running;
    },
  };
}
