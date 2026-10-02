import { z } from 'zod';
import { getContext } from '@/server/context';
import { findBookingById, toBookingResponse } from '@/server/bookings/rows';
import { NotFoundError } from '@/server/errors';
import { requireUser } from '@/server/http/auth';
import { handle, json } from '@/server/http/respond';
import { refreshBookingPayment } from '@/server/payments/reconcile';

/** 예약 상태 조회 (본인만). 결제 확인 중인 예약이면 간격 제한 안에서 PG 상태를 확인해 결과를 앞당겨 확정한다. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = getContext();
    const userId = await requireUser(ctx, req);
    const { id } = await params;
    if (!z.guid().safeParse(id).success) throw new NotFoundError('예약을 찾을 수 없습니다.');

    let booking = await findBookingById(ctx.pool, id);
    if (!booking || booking.consumer_id !== userId) throw new NotFoundError('예약을 찾을 수 없습니다.');
    if (booking.status === 'PAYMENT_CONFIRMING') {
      await refreshBookingPayment(ctx, id);
      booking = (await findBookingById(ctx.pool, id)) ?? booking;
    }
    return json(await toBookingResponse(ctx.pool, booking));
  });
}
