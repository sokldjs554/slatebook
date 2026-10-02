import { randomUUID } from 'node:crypto';
import { num, withTx } from '../db';
import type { AppContext } from '../context';
import { lockBookingById, toBookingResponse } from '../bookings/rows';
import { BookingNotPayableError, HoldExpiredError, NotFoundError, PaymentConflictError } from '../errors';
import type { BookingResponse } from '../../shared/schemas';

/**
 * 다른 결제 수단으로 다시 결제하기 위한 새 주문번호를 발급한다.
 * 카드 거절로 이전 결제가 FAILED 가 된 뒤, 홀드가 남아 있는 동안에만 가능하다.
 * 이미 시작 가능한 결제(READY)가 있으면 그것을 그대로 돌려준다 → 버튼을 여러 번 눌러도 주문이 늘어나지 않는다.
 */
export async function createRetryPayment(ctx: AppContext, userId: string, bookingId: string): Promise<BookingResponse> {
  return withTx(ctx.pool, async (tx) => {
    const booking = await lockBookingById(tx, bookingId);
    if (!booking || booking.consumer_id !== userId) throw new NotFoundError('예약을 찾을 수 없습니다.');

    if (booking.status === 'EXPIRED') throw new HoldExpiredError();
    if (booking.status !== 'PENDING_PAYMENT') throw new BookingNotPayableError();
    if (!booking.hold_active) throw new HoldExpiredError();

    const live = await tx.query<{ status: string }>(
      `SELECT status FROM payments WHERE booking_id = $1 AND status IN ('READY','CONFIRMING','UNKNOWN','APPROVED','PARTIAL_CANCELED')`,
      [bookingId],
    );
    const existing = live.rows[0];
    if (existing && existing.status !== 'READY') {
      throw new PaymentConflictError('PAYMENT_IN_PROGRESS', '이미 진행 중인 결제가 있습니다.');
    }
    if (!existing) {
      await tx.query(
        `INSERT INTO payments(booking_id, order_id, provider, amount, status) VALUES ($1, $2, $3, $4, 'READY')`,
        [bookingId, `sb_${randomUUID().replaceAll('-', '')}`, ctx.gateway.name, num(booking.total_amount)],
      );
    }
    return toBookingResponse(tx, booking);
  });
}
