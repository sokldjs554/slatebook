import { num } from '../db';
import type { AppContext } from '../context';
import { enqueue } from '../outbox';
import { applyGatewayResult, type ApplyResult } from './apply';
import { failPayment } from './fail';
import { isGatewayDeclined, isGatewayIndeterminate, type GatewayPayment } from './gateway';
import { executeCaptureRefund } from './refund';

export type ReconcileResult = ApplyResult | { kind: 'skipped' };

interface Claimed {
  id: string;
  booking_id: string;
  order_id: string;
  payment_key: string | null;
  amount: string;
  refund_pending: boolean;
  reconcile_attempts: number;
  age_ms: number;
}

/**
 * 결과가 확정되지 않은 결제를 PG 에 물어봐서 결론을 낸다.
 *
 * 대상
 *  - UNKNOWN     승인 호출의 결과를 몰랐던 결제 (타임아웃·5xx) — 바로 대사한다
 *  - CONFIRMING  승인 호출 중 서버가 죽었을 수 있는 결제 — 원래 호출의 타임아웃이 지난 뒤에만 건드린다
 *                (진행 중인 정상 호출과 겹치지 않게)
 *  - refund_pending  승인됐지만 예약에 쓸 수 없어 환불해야 하는 결제
 *
 * 같은 결제를 여러 곳(워커 둘, 상태 폴링)이 동시에 대사하지 않도록 reconcile_attempted_at 으로 먼저 "선점"한다.
 */
export async function reconcilePayment(ctx: AppContext, paymentId: string): Promise<ReconcileResult> {
  const { config, pool, gateway, log } = ctx;
  const claim = await pool.query<Claimed>(
    `UPDATE payments
        SET reconcile_attempts = reconcile_attempts + 1, reconcile_attempted_at = clock_timestamp()
      WHERE id = $1
        AND (
              status = 'UNKNOWN'
           OR (status = 'CONFIRMING'
               AND COALESCE(confirm_started_at, created_at) < clock_timestamp() - make_interval(secs => $3::float8))
           OR refund_pending
        )
        AND (reconcile_attempted_at IS NULL
             OR reconcile_attempted_at < clock_timestamp() - make_interval(secs => $2::float8))
      RETURNING id, booking_id, order_id, payment_key, amount, refund_pending, reconcile_attempts,
                (EXTRACT(EPOCH FROM clock_timestamp() - COALESCE(confirm_started_at, created_at)) * 1000)::float8 AS age_ms`,
    [paymentId, config.reconcileThrottleMs / 1000, (config.confirmTimeoutMs + 5_000) / 1000],
  );
  const p = claim.rows[0];
  if (!p) return { kind: 'skipped' };

  if (p.refund_pending) {
    await executeCaptureRefund(ctx, p.id);
    return { kind: 'refund_scheduled', bookingId: p.booking_id, reason: 'REFUND_PENDING' };
  }

  const pending: ApplyResult = { kind: 'pending', bookingId: p.booking_id };
  const alertIfStuck = async () => {
    if (p.age_ms > config.stuckAlertAfterMs && p.reconcile_attempts % 20 === 0) {
      await enqueue(pool, 'payment.stuck', {
        paymentId: p.id,
        orderId: p.order_id,
        bookingId: p.booking_id,
        ageMinutes: Math.round(p.age_ms / 60_000),
        attempts: p.reconcile_attempts,
      });
    }
  };

  let view: GatewayPayment | null;
  try {
    view = await gateway.getByOrderId(p.order_id, { timeoutMs: 10_000 });
  } catch (err) {
    log.warn('reconcile lookup failed; will retry', { paymentId: p.id, err });
    await alertIfStuck();
    return pending;
  }

  if (view === null) {
    // PG 가 이 주문을 모른다. 조회 지연일 수 있으므로 유예 시간 안에는 단정하지 않는다.
    if (p.age_ms < config.notFoundGraceMs) return pending;
    await failPayment(ctx, p.id, 'NOT_FOUND_AT_PG');
    return { kind: 'failed', bookingId: p.booking_id, reason: 'NOT_FOUND_AT_PG' };
  }

  if (view.status === 'IN_PROGRESS' && p.payment_key) {
    // PG 는 사용자 인증까지만 끝났고 승인은 하지 않았다.
    if (p.age_ms >= config.confirmRetryWindowMs) {
      // PG 가 인증 세션을 만료시킬 시점이 가까우니 포기한다 (승인되지 않았으므로 돈은 움직이지 않았다)
      await failPayment(ctx, p.id, 'PG_SESSION_NOT_CAPTURED');
      return { kind: 'failed', bookingId: p.booking_id, reason: 'PG_SESSION_NOT_CAPTURED' };
    }
    try {
      // 같은 멱등키로 승인을 다시 시도한다. 이미 승인된 건이라면 PG 가 같은 결과를 돌려준다.
      const confirmed = await gateway.confirm(
        { paymentKey: p.payment_key, orderId: p.order_id, amount: num(p.amount), idempotencyKey: `confirm:${p.id}` },
        { timeoutMs: config.confirmTimeoutMs },
      );
      return applyGatewayResult(ctx, p.id, confirmed, 'reconcile');
    } catch (err) {
      if (isGatewayDeclined(err)) {
        await failPayment(ctx, p.id, `DECLINED:${err.code}`);
        return { kind: 'failed', bookingId: p.booking_id, reason: `DECLINED:${err.code}` };
      }
      if (isGatewayIndeterminate(err)) {
        await alertIfStuck();
        return pending;
      }
      throw err;
    }
  }

  return applyGatewayResult(ctx, p.id, view, 'reconcile');
}

/** 워커용: 미확정 결제와 환불 대기 결제를 모두 한 바퀴 돌며 정리한다 */
export async function reconcileStuckPayments(ctx: AppContext, limit = 50): Promise<{ examined: number; resolved: number }> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `SELECT id FROM payments
      WHERE status IN ('CONFIRMING', 'UNKNOWN') OR refund_pending
      ORDER BY reconcile_attempted_at NULLS FIRST, updated_at
      LIMIT $1`,
    [limit],
  );
  let resolved = 0;
  for (const { id } of rows) {
    try {
      const r = await reconcilePayment(ctx, id);
      if (r.kind === 'confirmed' || r.kind === 'failed' || r.kind === 'refund_scheduled') resolved += 1;
    } catch (err) {
      ctx.log.error('reconcile crashed for a payment', { paymentId: id, err });
    }
  }
  return { examined: rows.length, resolved };
}

/** 상태 조회 API 가 부르는 가벼운 대사: 이 예약의 미확정 결제가 있으면 (조회 간격 제한 안에서) 확인해 본다 */
export async function refreshBookingPayment(ctx: AppContext, bookingId: string): Promise<void> {
  const { rows } = await ctx.pool.query<{ id: string }>(
    `SELECT id FROM payments WHERE booking_id = $1 AND (status IN ('CONFIRMING', 'UNKNOWN') OR refund_pending)`,
    [bookingId],
  );
  for (const { id } of rows) {
    try {
      await reconcilePayment(ctx, id);
    } catch (err) {
      ctx.log.warn('on-demand reconcile failed', { paymentId: id, err });
    }
  }
}
