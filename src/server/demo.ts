import { withTx } from './db';
import type { AppContext } from './context';
import { completeEndedBookings } from './bookings/complete';
import { findBookingById, lockBookingById, toBookingResponse } from './bookings/rows';
import { BookingNotPayableError, NotFoundError } from './errors';
import type { BookingResponse } from '../shared/schemas';

/**
 * ⚠ 데모 전용 "시간 여행": 확정된 예약의 이용 시간을 과거로 되감고 이용 완료 처리(수익 인식 분개 포함)를 돌린다.
 * 실제로는 이용 시간이 지나야 일어나는 일을 시연에서 바로 볼 수 있게 한다. HTTP 노출은 DEMO_AUTH 가 켜졌을 때뿐이다.
 * 슬롯의 구간은 건드리지 않는다(슬롯은 생성 후 변경 불가). 데모에서는 그 시간대가 계속 막혀 있을 뿐이다.
 */
export async function fastForwardBooking(ctx: AppContext, userId: string, bookingId: string): Promise<BookingResponse> {
  await withTx(ctx.pool, async (tx) => {
    const booking = await lockBookingById(tx, bookingId);
    if (!booking || booking.consumer_id !== userId) throw new NotFoundError('예약을 찾을 수 없습니다.');
    if (booking.status !== 'CONFIRMED') throw new BookingNotPayableError('확정된 예약만 이용 완료로 만들 수 있어요.');
    await tx.query(
      `UPDATE bookings SET period = tstzrange(now() - interval '3 hours', now() - interval '1 hour', '[)') WHERE id = $1`,
      [bookingId],
    );
  });
  await completeEndedBookings(ctx);
  const done = await findBookingById(ctx.pool, bookingId);
  if (!done) throw new NotFoundError('예약을 찾을 수 없습니다.');
  return toBookingResponse(ctx.pool, done);
}
