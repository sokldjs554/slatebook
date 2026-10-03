import { withTx, num } from '../db';
import type { AppContext } from '../context';
import { lockBookingAndPayment, findPaymentById } from './rows';
import { isGatewayDeclined } from './gateway';
import { postPaymentApproved, postRefund } from '../ledger/ledger';
import { enqueue } from '../outbox';

/**
 * "PG 에서는 승인됐지만 예약에 쓸 수 없는 결제"를 환불한다.
 *   - 홀드가 만료돼 다른 사람이 슬롯을 가져간 뒤 승인 결과가 뒤늦게 도착한 경우
 *   - PG 가 보고한 금액·주문이 우리 기록과 다른 경우
 * 환불 의사는 payments.refund_pending 으로 DB 에 먼저 남겨 두므로(apply.ts), 이 함수가 도중에 죽어도
 * 대사 워커가 같은 멱등키로 다시 실행한다.
 */
export async function executeCaptureRefund(ctx: AppContext, paymentId: string): Promise<'refunded' | 'retry_later' | 'noop'> {
  const p = await findPaymentById(ctx.pool, paymentId);
  if (!p || !p.refund_pending) return 'noop';
  if (!p.payment_key) {
    ctx.log.error('refund pending but payment_key is unknown', { paymentId });
    return 'retry_later';
  }

  try {
    await ctx.gateway.cancel(
      {
        paymentKey: p.payment_key,
        orderId: p.order_id,
        reason: `자동 환불 (${p.failure_reason ?? 'unusable capture'})`,
        idempotencyKey: `capture-refund:${p.id}`,
      },
      { timeoutMs: ctx.config.confirmTimeoutMs },
    );
  } catch (err) {
    if (isGatewayDeclined(err)) {
      // 이미 취소돼 있다면 목적은 달성된 것이다. 아니라면 사람이 봐야 한다.
      const view = await ctx.gateway.getByOrderId(p.order_id).catch(() => null);
      if (view?.status !== 'CANCELED') {
        ctx.log.error('PG rejected the automatic refund', { paymentId, code: err.code });
        await enqueue(ctx.pool, 'payment.refund_rejected', { paymentId, orderId: p.order_id, code: err.code });
        return 'retry_later';
      }
    } else {
      ctx.log.warn('automatic refund call did not complete; will retry', { paymentId, err });
      return 'retry_later';
    }
  }

  await withTx(ctx.pool, async (tx) => {
    const locked = await lockBookingAndPayment(tx, { paymentId });
    if (!locked || !locked.payment.refund_pending) return;
    const amount = num(locked.payment.amount);
    await tx.query(
      `UPDATE payments SET status = 'CANCELED', canceled_amount = amount, refund_pending = false WHERE id = $1`,
      [paymentId],
    );
    const key = `capture-refund:${paymentId}`;
    const refund = await tx.query<{ id: string }>(
      `INSERT INTO refunds(payment_id, amount, reason, status, idempotency_key)
       VALUES ($1, $2, $3, 'DONE', $4)
       ON CONFLICT (idempotency_key) DO UPDATE SET status = 'DONE' RETURNING id`,
      [paymentId, amount, locked.payment.failure_reason ?? 'capture refund', key],
    );
    // 승인 분개와 환불 분개를 모두 남겨 PG 정산 내역과 원장이 항상 대조되게 한다 (순효과 0원)
    await postPaymentApproved(tx, { paymentId, amount });
    await postRefund(tx, { refundId: refund.rows[0]!.id, amount });
    await enqueue(tx, 'payment.capture_refunded', { paymentId, bookingId: locked.booking.id, amount });
  });
  return 'refunded';
}
