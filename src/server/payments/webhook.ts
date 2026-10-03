import { z } from 'zod';
import type { AppContext } from '../context';
import { applyGatewayResult } from './apply';

export interface WebhookInput {
  provider: string;
  /** 같은 이벤트의 재전송을 알아보는 키 (본문 해시 등) */
  eventKey: string;
  payload: unknown;
}

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

// 어느 주문을 다시 확인해야 하는지만 꺼낸다 — 토스는 data.orderId, 포트원은 data.paymentId (= 우리 주문번호)
const payloadSchema = z.union([
  z.object({ data: z.object({ orderId: z.string().min(1) }).loose() }).loose().transform((p) => p.data.orderId),
  z.object({ data: z.object({ paymentId: z.string().min(1) }).loose() }).loose().transform((p) => p.data.paymentId),
]);

/**
 * PG 웹훅 처리.
 *
 * 웹훅 본문은 **믿지 않는다.** 누구든 URL 을 알면 아무 본문이나 보낼 수 있으므로, 본문에서는 orderId 만 꺼내
 * "어느 주문을 다시 확인해야 하는지"를 알아내고, 상태·금액은 PG 조회 API(우리 비밀키로 인증)로 직접 가져온다.
 * 위조된 웹훅이 할 수 있는 일은 정상적인 재확인을 한 번 유발하는 것뿐이다.
 *
 * 중복 전송: 수신함의 (provider, event_key) UNIQUE 로 알아보고, 이미 처리된 이벤트는 건너뛴다.
 * 처리 도중 실패하면 예외를 그대로 던진다 → 라우트가 5xx 로 응답 → PG 가 재전송한다.
 * 동시에 같은 이벤트가 두 번 들어와도 applyGatewayResult 가 멱등이므로 결과는 같다.
 */
export async function handlePgWebhook(ctx: AppContext, input: WebhookInput): Promise<WebhookOutcome> {
  const { pool, gateway, log } = ctx;

  const inserted = await pool.query(
    `INSERT INTO pg_webhook_inbox(provider, event_key, payload) VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (provider, event_key) DO NOTHING RETURNING id`,
    [input.provider, input.eventKey, JSON.stringify(input.payload ?? null)],
  );
  if (inserted.rowCount === 0) {
    const prior = await pool.query<{ processed_at: Date | null }>(
      'SELECT processed_at FROM pg_webhook_inbox WHERE provider = $1 AND event_key = $2',
      [input.provider, input.eventKey],
    );
    if (prior.rows[0]?.processed_at) return 'duplicate';
    // 이전 시도가 처리 도중 죽었다 → 이번에 이어서 처리한다
  }

  const markProcessed = () =>
    pool.query('UPDATE pg_webhook_inbox SET processed_at = now() WHERE provider = $1 AND event_key = $2', [
      input.provider,
      input.eventKey,
    ]);

  const parsed = payloadSchema.safeParse(input.payload);
  if (!parsed.success) {
    log.warn('webhook without an orderId; ignored', { provider: input.provider });
    await markProcessed();
    return 'ignored';
  }
  const orderId = parsed.data;

  const payment = await pool.query<{ id: string }>('SELECT id FROM payments WHERE order_id = $1', [orderId]);
  const paymentId = payment.rows[0]?.id;
  if (!paymentId) {
    log.warn('webhook for an unknown order; ignored', { orderId });
    await markProcessed();
    return 'ignored';
  }

  const view = await gateway.getByOrderId(orderId, { timeoutMs: 10_000 });
  if (!view) {
    log.warn('webhook for an order the PG does not know; ignored', { orderId });
    await markProcessed();
    return 'ignored';
  }

  await applyGatewayResult(ctx, paymentId, view, 'webhook');
  await markProcessed();
  return 'processed';
}
