import type { Tx } from '../db';
import { withTx } from '../db';
import type { AppContext } from '../context';
import { expireBookingsLocked } from '../bookings/expire';
import type { BookingRow } from '../bookings/rows';
import { lockBookingAndPayment, type PaymentRow } from './rows';

/**
 * 결제가 "돈이 움직이지 않았다"고 확정된 경우의 후처리. 예약과 결제는 이미 잠겨 있어야 한다.
 *
 *  - 결제는 FAILED. 이 결제는 되살리지 않는다 (다시 결제하려면 새 주문번호를 발급받는다).
 *  - 결제 확정 중이던 예약은: 홀드가 남아 있으면 PENDING_PAYMENT 로 되돌려 다른 카드로 다시 시도할 수 있게 하고,
 *    홀드가 지났다면 만료시키며 슬롯을 푼다.
 *  - 이미 확정됐거나 종료된 예약은 건드리지 않는다.
 */
export async function failPaymentLocked(
  tx: Tx,
  booking: BookingRow,
  payment: PaymentRow,
  reason: string,
): Promise<boolean> {
  if (payment.status !== 'READY' && payment.status !== 'CONFIRMING' && payment.status !== 'UNKNOWN') return false;
  await tx.query(`UPDATE payments SET status = 'FAILED', failure_reason = $2 WHERE id = $1`, [payment.id, reason]);

  if (booking.status === 'PAYMENT_CONFIRMING') {
    const back = await tx.query(
      `UPDATE bookings SET status = 'PENDING_PAYMENT'
        WHERE id = $1 AND status = 'PAYMENT_CONFIRMING' AND hold_expires_at > clock_timestamp()`,
      [booking.id],
    );
    if (back.rowCount === 0) await expireBookingsLocked(tx, [booking.id], reason);
  }
  return true;
}

export async function failPayment(ctx: AppContext, paymentId: string, reason: string): Promise<boolean> {
  return withTx(ctx.pool, async (tx) => {
    const locked = await lockBookingAndPayment(tx, { paymentId });
    if (!locked) return false;
    return failPaymentLocked(tx, locked.booking, locked.payment, reason);
  });
}

/** PG 호출의 결과를 알 수 없을 때: 예약은 PAYMENT_CONFIRMING 으로 두고(슬롯 유지), 결제만 UNKNOWN 으로 표시한다 */
export async function markPaymentUnknown(ctx: AppContext, paymentId: string, reason: string): Promise<void> {
  await ctx.pool.query(
    `UPDATE payments SET status = 'UNKNOWN', failure_reason = $2 WHERE id = $1 AND status = 'CONFIRMING'`,
    [paymentId, reason],
  );
}
