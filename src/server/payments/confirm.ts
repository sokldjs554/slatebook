import { isPgError, num, PG, withTx } from '../db';
import type { AppContext } from '../context';
import { expireBookingsLocked } from '../bookings/expire';
import {
  AmountMismatchError,
  BookingNotPayableError,
  HoldExpiredError,
  NotFoundError,
  PaymentConflictError,
  PaymentDeclinedError,
  PaymentVerificationFailedError,
} from '../errors';
import { enqueue } from '../outbox';
import { confirmPaymentSchema, type ConfirmResponse } from '../../shared/schemas';
import { ValidationError } from '../errors';
import { applyGatewayResult } from './apply';
import { failPayment, markPaymentUnknown } from './fail';
import { isGatewayDeclined, type GatewayPayment } from './gateway';
import { lockBookingAndPayment } from './rows';

type Claim =
  | { kind: 'claimed'; paymentId: string; bookingId: string; amount: number }
  | { kind: 'already_confirmed'; bookingId: string }
  | { kind: 'in_progress'; bookingId: string }
  | { kind: 'amount_mismatch'; bookingId: string }
  | { kind: 'expired'; bookingId: string };

/**
 * 결제 성공 리다이렉트(paymentKey, orderId, amount)를 받아 PG 에 승인을 요청하고 예약을 확정한다.
 *
 *  1) 선점  (짧은 트랜잭션)  금액 대조 → 예약 PAYMENT_CONFIRMING → 결제 CONFIRMING. 같은 결제는 한 요청만 통과한다.
 *  2) 승인  (트랜잭션 밖)    PG 승인 API. 금액은 클라이언트가 보낸 값이 아니라 DB 의 값을 쓴다.
 *  3) 반영  (짧은 트랜잭션)  applyGatewayResult — 결제 승인·예약 확정·원장·outbox 를 한 번에.
 *
 * 응답 원칙
 *  - 확정된 실패(카드 거절 등)만 오류로 응답한다.
 *  - PG 호출 결과를 알 수 없거나, 승인 뒤 반영 단계가 실패하면 PROCESSING 으로 응답한다. 돈이 이미 움직였을 수 있으므로
 *    "실패"라고 말하지 않는다. 결과는 웹훅·대사 워커·상태 조회가 확정한다.
 *  - 이 함수는 호출자(브라우저)가 연결을 끊어도 끝까지 실행된다 — 요청 취소 신호를 받지 않는다.
 */
export async function confirmPayment(ctx: AppContext, userId: string, rawInput: unknown): Promise<ConfirmResponse> {
  const parsed = confirmPaymentSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError('요청 형식이 올바르지 않습니다.', parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
  const input = parsed.data;

  let claim: Claim;
  try {
    claim = await withTx(ctx.pool, async (tx): Promise<Claim> => {
      const locked = await lockBookingAndPayment(tx, { orderId: input.orderId });
      // 남의 주문이든 없는 주문이든 같은 응답 — 주문번호 존재 여부를 알려주지 않는다
      if (!locked || locked.booking.consumer_id !== userId) throw new NotFoundError('주문을 찾을 수 없습니다.');
      const { booking, payment } = locked;
      const amount = num(payment.amount);

      // 금액 위변조: 브라우저가 보낸 금액이 서버가 계산한 금액과 다르면 PG 를 호출하지 않는다
      if (input.amount !== amount) {
        await enqueue(tx, 'payment.anomaly', {
          type: 'CLIENT_AMOUNT_MISMATCH',
          paymentId: payment.id,
          bookingId: booking.id,
          orderId: payment.order_id,
          expectedAmount: amount,
          reportedAmount: input.amount,
          userId,
        });
        return { kind: 'amount_mismatch', bookingId: booking.id };
      }
      if (payment.payment_key !== null && payment.payment_key !== input.paymentKey) {
        throw new PaymentConflictError('PAYMENT_KEY_MISMATCH', '이 주문에는 다른 결제 정보가 이미 연결되어 있습니다.');
      }

      switch (payment.status) {
        case 'APPROVED':
        case 'PARTIAL_CANCELED':
          return { kind: 'already_confirmed', bookingId: booking.id }; // 새로고침·더블클릭·재시도
        case 'CONFIRMING':
        case 'UNKNOWN':
          return { kind: 'in_progress', bookingId: booking.id }; // 다른 요청이 이미 승인 중
        case 'READY':
          break;
        default:
          // 다른 사람의 예약 시도가 먼저 만료 정리를 해서 이 결제가 FAILED(HOLD_EXPIRED)가 된 경우도 "홀드 만료"로 안내한다
          if (booking.status === 'EXPIRED') return { kind: 'expired', bookingId: booking.id };
          throw new PaymentConflictError('PAYMENT_NOT_PAYABLE', '이미 종료된 결제입니다. 결제를 새로 시작해 주세요.');
      }

      if (booking.status !== 'PENDING_PAYMENT') {
        if (booking.status === 'EXPIRED') return { kind: 'expired', bookingId: booking.id };
        throw new BookingNotPayableError();
      }
      // 결제창에서 이미 결제가 끝났을 수 있는 PG(포트원 등)는 홀드가 지났어도 확인을 진행한다.
      // 예약이 아직 PENDING_PAYMENT 이므로 슬롯은 이 예약이 쥐고 있다 — 다른 사람에게 넘어가지 않았다.
      if (!booking.hold_active && !ctx.gateway.capturesBeforeServerConfirm) {
        // 홀드가 지났다. 워커를 기다리지 않고 지금 풀어준다 (PG 승인 전이므로 돈은 움직이지 않았다)
        await expireBookingsLocked(tx, [booking.id]);
        return { kind: 'expired', bookingId: booking.id };
      }

      // 선점: 예약을 PAYMENT_CONFIRMING 으로 — 이 상태의 예약은 홀드가 지나도 슬롯을 풀지 않는다
      await tx.query(`UPDATE bookings SET status = 'PAYMENT_CONFIRMING' WHERE id = $1`, [booking.id]);
      await tx.query(
        `UPDATE payments SET status = 'CONFIRMING', payment_key = $2, confirm_started_at = clock_timestamp(),
                failure_reason = NULL WHERE id = $1 AND status = 'READY'`,
        [payment.id, input.paymentKey],
      );
      return { kind: 'claimed', paymentId: payment.id, bookingId: booking.id, amount };
    });
  } catch (err) {
    // 같은 paymentKey 를 다른 주문에 쓰려는 시도 (payments.payment_key UNIQUE)
    if (isPgError(err, PG.UNIQUE_VIOLATION)) {
      throw new PaymentConflictError('PAYMENT_KEY_ALREADY_USED', '이미 다른 주문에 사용된 결제 정보입니다.');
    }
    throw err;
  }

  switch (claim.kind) {
    case 'amount_mismatch':
      throw new AmountMismatchError(claim.bookingId);
    case 'expired':
      throw new HoldExpiredError(claim.bookingId);
    case 'already_confirmed':
      return { status: 'CONFIRMED', bookingId: claim.bookingId };
    case 'in_progress':
      return { status: 'PROCESSING', bookingId: claim.bookingId };
    case 'claimed':
      break;
  }

  // ② 트랜잭션 밖에서 PG 승인 호출. 금액은 DB 값.
  let view: GatewayPayment;
  try {
    view = await ctx.gateway.confirm(
      {
        paymentKey: input.paymentKey,
        orderId: input.orderId,
        amount: claim.amount,
        idempotencyKey: `confirm:${claim.paymentId}`,
      },
      { timeoutMs: ctx.config.confirmTimeoutMs },
    );
  } catch (err) {
    if (isGatewayDeclined(err)) {
      // 돈이 움직이지 않았다고 PG 가 확정해 준 경우에만 실패로 처리한다
      try {
        await failPayment(ctx, claim.paymentId, `DECLINED:${err.code}`);
      } catch (recordErr) {
        // 기록에 실패해도 사용자에게는 거절을 알린다. 결제는 CONFIRMING 으로 남고 대사가 PG 상태를 보고 정리한다.
        ctx.log.error('failed to record declined payment', { paymentId: claim.paymentId, err: recordErr });
      }
      throw new PaymentDeclinedError(err.code, claim.bookingId);
    }
    // 타임아웃·5xx·네트워크 단절·예상 밖 예외: PG 가 이미 승인했을 수 있다 → 실패로 단정하지 않는다
    ctx.log.warn('PG confirm outcome unknown; leaving payment for reconciliation', { paymentId: claim.paymentId, err });
    try {
      await markPaymentUnknown(ctx, claim.paymentId, 'CONFIRM_OUTCOME_UNKNOWN');
    } catch (markErr) {
      ctx.log.error('failed to mark payment unknown (CONFIRMING is also reconciled)', { paymentId: claim.paymentId, err: markErr });
    }
    return { status: 'PROCESSING', bookingId: claim.bookingId };
  }

  // ③ 반영. 여기서 예외가 나도 PG 는 이미 승인했으므로 실패로 응답하지 않는다.
  let result;
  try {
    result = await applyGatewayResult(ctx, claim.paymentId, view, 'confirm');
  } catch (err) {
    ctx.log.error('PG approved but applying the result failed; reconciler will finish it', { paymentId: claim.paymentId, err });
    return { status: 'PROCESSING', bookingId: claim.bookingId };
  }

  switch (result.kind) {
    case 'confirmed':
    case 'already_confirmed':
      return { status: 'CONFIRMED', bookingId: claim.bookingId };
    case 'refund_scheduled':
    case 'needs_review':
      throw new PaymentVerificationFailedError(claim.bookingId);
    case 'failed':
      throw new PaymentDeclinedError(result.reason, claim.bookingId);
    case 'pending':
    case 'noop':
      return { status: 'PROCESSING', bookingId: claim.bookingId };
  }
}
