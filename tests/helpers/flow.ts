import type { AppContext } from '../../src/server/context';
import { createBooking } from '../../src/server/bookings/create';
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
