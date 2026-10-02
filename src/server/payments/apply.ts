import type { Tx } from '../db';
import { num, withTx } from '../db';
import type { AppContext } from '../context';
import { expireBookingsLocked } from '../bookings/expire';
import type { BookingRow } from '../bookings/rows';
import { postPaymentApproved } from '../ledger/ledger';
import { enqueue } from '../outbox';
import { failPaymentLocked } from './fail';
import type { GatewayPayment } from './gateway';
import { executeCaptureRefund } from './refund';
import { lockBookingAndPayment, type PaymentRow } from './rows';

export type ApplyResult =
  | { kind: 'confirmed'; bookingId: string }
  | { kind: 'already_confirmed'; bookingId: string }
  | { kind: 'failed'; bookingId: string; reason: string }
  | { kind: 'refund_scheduled'; bookingId: string; reason: string }
  | { kind: 'needs_review'; bookingId: string; reason: string }
  | { kind: 'pending'; bookingId: string }
  | { kind: 'noop'; bookingId: string };

export type ApplySource = 'confirm' | 'webhook' | 'reconcile';

interface Decision {
  result: ApplyResult;
  needsRefund: boolean;
}

/**
 * PG 가 알려준 결제 상태를 우리 DB 에 반영하는 **유일한 경로**.
 * 결제 확정 API · 웹훅 · 대사 워커가 모두 이 함수를 쓰므로, 어느 경로로 몇 번 도착해도 결과가 같다(멱등).
 *
 * 규칙
 *  - PG 가 "승인(DONE)"이라고 해도 곧바로 믿지 않는다: 주문번호·결제키·금액·통화가 우리 기록과 같아야 한다.
 *  - 승인이 확인돼도 예약이 그 결제를 받을 수 있는 상태여야 한다(결제 확정 중이거나, 홀드가 살아 있는 대기 중).
 *    아니면 그 돈은 환불 대상이다.
 *  - 모든 변경은 한 트랜잭션: 결제 승인 + 예약 확정 + 슬롯 확정 + 원장 분개 + outbox.
 *  - PG 호출(환불)은 트랜잭션이 커밋된 뒤에 한다.
 */
export async function applyGatewayResult(
  ctx: AppContext,
  paymentId: string,
  view: GatewayPayment,
  source: ApplySource,
): Promise<ApplyResult> {
  const decision = await withTx(ctx.pool, (tx) => decide(tx, paymentId, view, source));
  if (decision.needsRefund) {
    try {
      await executeCaptureRefund(ctx, paymentId);
    } catch (err) {
      // refund_pending 이 DB 에 남아 있으므로 대사 워커가 다시 시도한다
      ctx.log.error('capture refund attempt crashed; reconciler will retry', { paymentId, err });
    }
  }
  return decision.result;
}

async function decide(tx: Tx, paymentId: string, view: GatewayPayment, source: ApplySource): Promise<Decision> {
  const locked = await lockBookingAndPayment(tx, { paymentId });
  if (!locked) throw new Error(`payment ${paymentId} not found`);
  const { booking, payment } = locked;

  switch (view.status) {
    case 'DONE':
      return decideCaptured(tx, booking, payment, view, source);
    case 'FAILED':
    case 'CANCELED':
    case 'PARTIAL_CANCELED':
      return decideNotCaptured(tx, booking, payment, view);
    case 'READY':
    case 'IN_PROGRESS':
      return { result: { kind: 'pending', bookingId: booking.id }, needsRefund: false };
  }
}

async function decideCaptured(
  tx: Tx,
  booking: BookingRow,
  payment: PaymentRow,
  view: GatewayPayment,
  source: ApplySource,
): Promise<Decision> {
  const amount = num(payment.amount);

  // 이미 처리된 결제: 같은 결과를 다시 돌려줄 뿐 아무것도 바꾸지 않는다
  if (payment.status === 'APPROVED' || payment.status === 'PARTIAL_CANCELED' || payment.status === 'CANCELED') {
    const confirmed = booking.status === 'CONFIRMED' || booking.status === 'COMPLETED';
    return {
      result: confirmed ? { kind: 'already_confirmed', bookingId: booking.id } : { kind: 'noop', bookingId: booking.id },
      needsRefund: false,
    };
  }
  if (payment.refund_pending) {
    return {
      result: { kind: 'refund_scheduled', bookingId: booking.id, reason: payment.failure_reason ?? 'REFUND_PENDING' },
      needsRefund: true,
    };
  }

  // 이 결제가 아직 "살아 있는" 결제인가. 이미 실패 처리한 결제에 뒤늦게 승인이 보고돼도 되살리지 않는다
  // (FAILED → APPROVED 는 상태 전이 규칙이 거부한다). 승인된 돈은 환불로 정리하고, 예약은 건드리지 않는다.
  const live = payment.status === 'READY' || payment.status === 'CONFIRMING' || payment.status === 'UNKNOWN';

  // ① 위변조·불일치 검증
  if (payment.payment_key !== null && payment.payment_key !== view.paymentKey) {
    // PG 가 우리가 아는 것과 다른 결제키로 승인했다고 한다. 어느 결제를 취소해야 하는지 자동으로는 알 수 없으므로
    // 예약 확정만 막고 사람이 확인하게 한다.
    return quarantine(tx, booking, payment, view, live, 'PAYMENT_KEY_MISMATCH', {
      expectedPaymentKey: payment.payment_key,
      reportedPaymentKey: view.paymentKey,
    });
  }
  const mismatch = view.orderId !== payment.order_id || view.totalAmount !== amount || view.currency !== 'KRW';
  if (mismatch) {
    return scheduleRefund(tx, booking, payment, view, live, 'AMOUNT_OR_IDENTITY_MISMATCH', {
      expectedAmount: amount,
      reportedAmount: view.totalAmount,
      expectedOrderId: payment.order_id,
      reportedOrderId: view.orderId,
      currency: view.currency,
    });
  }

  // ② 이 결제를 받을 수 있는 예약 상태인가
  const usable =
    live && (booking.status === 'PAYMENT_CONFIRMING' || (booking.status === 'PENDING_PAYMENT' && booking.hold_active));
  if (!usable) {
    return scheduleRefund(tx, booking, payment, view, live, 'LATE_CAPTURE', { bookingStatus: booking.status, paymentStatus: payment.status, source });
  }

  // ③ 확정 — 한 트랜잭션에서 전부
  await tx.query(
    `UPDATE payments
        SET status = 'APPROVED', payment_key = $2, method = $3,
            approved_at = COALESCE($4::timestamptz, clock_timestamp()), raw = $5::jsonb, failure_reason = NULL
      WHERE id = $1`,
    [payment.id, view.paymentKey, view.method, view.approvedAt?.toISOString() ?? null, JSON.stringify(view.raw)],
  );
  if (booking.status === 'PENDING_PAYMENT') {
    // 우리가 승인 호출을 하기 전에 PG 가 먼저 승인한 경우(웹훅이 먼저 도착). 상태 전이 규칙을 지키려 한 단계를 거친다.
    await tx.query(`UPDATE bookings SET status = 'PAYMENT_CONFIRMING' WHERE id = $1`, [booking.id]);
  }
  await tx.query(`UPDATE bookings SET status = 'CONFIRMED', hold_expires_at = NULL WHERE id = $1`, [booking.id]);
  const slots = await tx.query(
    `UPDATE booking_slots SET state = 'CONFIRMED' WHERE booking_id = $1 AND state = 'HELD'`,
    [booking.id],
  );
  if (slots.rowCount !== 1) {
    // 결제를 받을 수 있는 예약에는 HELD 슬롯이 정확히 하나 있어야 한다. 아니라면 코드나 데이터가 깨진 것이므로
    // 전체를 롤백해 "돈은 받았는데 예약은 없는" 반쪽 상태를 만들지 않는다.
    throw new Error(`invariant violated: booking ${booking.id} has ${slots.rowCount} HELD slots`);
  }
  await postPaymentApproved(tx, { paymentId: payment.id, amount });
  await enqueue(tx, 'booking.confirmed', { bookingId: booking.id, paymentId: payment.id, amount, source });

  return { result: { kind: 'confirmed', bookingId: booking.id }, needsRefund: false };
}

/**
 * 승인됐지만 쓸 수 없는 결제: 환불 의사를 DB 에 먼저 남기고(refund_pending), 커밋 후 PG 에 취소를 요청한다.
 * 예약은 "이 결제가 그 예약의 살아 있는 결제였을 때"만 정리한다 — 이미 실패 처리된 옛 결제의 뒤늦은 승인이
 * 지금 재결제를 기다리는 멀쩡한 예약을 만료시키면 안 된다.
 */
async function scheduleRefund(
  tx: Tx,
  booking: BookingRow,
  payment: PaymentRow,
  view: GatewayPayment,
  live: boolean,
  reason: 'AMOUNT_OR_IDENTITY_MISMATCH' | 'LATE_CAPTURE',
  details: Record<string, unknown>,
): Promise<Decision> {
  if (live) await tx.query(`UPDATE payments SET status = 'FAILED' WHERE id = $1`, [payment.id]);
  await tx.query(
    `UPDATE payments
        SET refund_pending = true, failure_reason = $2, payment_key = COALESCE(payment_key, $3), raw = $4::jsonb
      WHERE id = $1`,
    [payment.id, reason, view.paymentKey, JSON.stringify(view.raw)],
  );

  if (live && (booking.status === 'PENDING_PAYMENT' || booking.status === 'PAYMENT_CONFIRMING')) {
    if (reason === 'AMOUNT_OR_IDENTITY_MISMATCH') {
      // 위변조가 의심되는 결제로는 예약을 확정하지 않고 슬롯을 풀어준다
      await tx.query(`UPDATE bookings SET status = 'PAYMENT_FAILED' WHERE id = $1`, [booking.id]);
      await tx.query(`UPDATE booking_slots SET state = 'RELEASED' WHERE booking_id = $1 AND state = 'HELD'`, [booking.id]);
    } else if (booking.status === 'PENDING_PAYMENT' && !booking.hold_active) {
      await expireBookingsLocked(tx, [booking.id], reason); // 홀드가 이미 지났다
    }
  }

  await enqueue(tx, 'payment.anomaly', {
    type: reason,
    paymentId: payment.id,
    bookingId: booking.id,
    orderId: payment.order_id,
    ...details,
  });
  return { result: { kind: 'refund_scheduled', bookingId: booking.id, reason }, needsRefund: true };
}

/** 자동으로 안전하게 되돌릴 수 없는 불일치: 예약 확정만 막고 운영 알림을 남겨 사람이 확인하게 한다 */
async function quarantine(
  tx: Tx,
  booking: BookingRow,
  payment: PaymentRow,
  view: GatewayPayment,
  live: boolean,
  reason: 'PAYMENT_KEY_MISMATCH',
  details: Record<string, unknown>,
): Promise<Decision> {
  if (live) {
    await tx.query(`UPDATE payments SET status = 'FAILED', failure_reason = $2, raw = $3::jsonb WHERE id = $1`, [
      payment.id,
      reason,
      JSON.stringify(view.raw),
    ]);
    if (booking.status === 'PENDING_PAYMENT' || booking.status === 'PAYMENT_CONFIRMING') {
      await tx.query(`UPDATE bookings SET status = 'PAYMENT_FAILED' WHERE id = $1`, [booking.id]);
      await tx.query(`UPDATE booking_slots SET state = 'RELEASED' WHERE booking_id = $1 AND state = 'HELD'`, [booking.id]);
    }
  }
  await enqueue(tx, 'payment.anomaly', {
    type: reason,
    needsManualRefund: true,
    paymentId: payment.id,
    bookingId: booking.id,
    orderId: payment.order_id,
    ...details,
  });
  return { result: { kind: 'needs_review', bookingId: booking.id, reason }, needsRefund: false };
}

async function decideNotCaptured(
  tx: Tx,
  booking: BookingRow,
  payment: PaymentRow,
  view: GatewayPayment,
): Promise<Decision> {
  if (payment.status === 'READY' || payment.status === 'CONFIRMING' || payment.status === 'UNKNOWN') {
    const failed = await failPaymentLocked(tx, booking, payment, `PG_${view.status}`);
    return {
      result: failed
        ? { kind: 'failed', bookingId: booking.id, reason: `PG_${view.status}` }
        : { kind: 'noop', bookingId: booking.id },
      needsRefund: false,
    };
  }
  if ((payment.status === 'APPROVED' || payment.status === 'PARTIAL_CANCELED') && view.status !== 'FAILED') {
    // 우리는 승인으로 기록했는데 PG 쪽에서 취소됐다 (PG 관리자 화면에서 직접 취소 등) → 사람이 확인해야 한다
    await enqueue(tx, 'payment.anomaly', {
      type: 'CANCELED_AT_PG',
      paymentId: payment.id,
      bookingId: booking.id,
      orderId: payment.order_id,
      pgStatus: view.status,
    });
  }
  return { result: { kind: 'noop', bookingId: booking.id }, needsRefund: false };
}
