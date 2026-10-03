import type { AppContext } from '../../src/server/context';
import { createBooking } from '../../src/server/bookings/create';
import { completeEndedBookings } from '../../src/server/bookings/complete';
import { confirmPayment } from '../../src/server/payments/confirm';
import type { Pool } from 'pg';
import type { FakeGateway } from '../../src/server/payments/fake';
import type { BookingResponse, PaymentInfo } from '../../src/shared/schemas';
import { idemKey, type Listing } from './fixtures';

export async function book(
  ctx: AppContext,
  userId: string,
  listing: Pick<Listing, 'id'>,
  win: { start: string; end: string },
  key = idemKey(),
): Promise<BookingResponse & { payment: PaymentInfo }> {
  const { response } = await createBooking(ctx, userId, key, { listingId: listing.id, start: win.start, end: win.end });
  if (!response.payment) throw new Error('expected a payable booking');
  return response as BookingResponse & { payment: PaymentInfo };
}

/** 사용자가 PG 결제창에서 카드 인증을 끝낸 뒤 성공 URL 로 돌아올 때 들고 오는 값 */
export function payAtPg(gateway: FakeGateway, payment: PaymentInfo) {
  const paymentKey = gateway.authenticate({ orderId: payment.orderId, amount: payment.amount });
  return { paymentKey, orderId: payment.orderId, amount: payment.amount };
}

/**
 * 결제까지 끝나고 이용도 끝난(COMPLETED) 예약을 만든다. 예약은 과거로 만들 수 없으므로
 * 확정 뒤에 이용 시간을 과거로 되감고 완료 작업을 돌린다. completedDaysAgo 로 "완료된 지 며칠 됐는지"를 정한다.
 */
export async function completedBooking(
  ctx: AppContext,
  gateway: FakeGateway,
  pool: Pool,
  userId: string,
  listing: Pick<Listing, 'id'>,
  win: { start: string; end: string },
  opts: { completedDaysAgo?: number } = {},
): Promise<{ bookingId: string }> {
  const b = await book(ctx, userId, listing, win);
  await confirmPayment(ctx, userId, payAtPg(gateway, b.payment));
  await pool.query(`UPDATE bookings SET period = tstzrange(now() - interval '3 hours', now() - interval '1 hour', '[)') WHERE id = $1`, [b.booking.id]);
  await completeEndedBookings(ctx);
  if (opts.completedDaysAgo !== undefined) {
    await pool.query(`UPDATE bookings SET completed_at = now() - make_interval(days => $2) WHERE id = $1`, [b.booking.id, opts.completedDaysAgo]);
  }
  return { bookingId: b.booking.id };
}
