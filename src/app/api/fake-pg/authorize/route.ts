import { z } from 'zod';
import { getContext, getFakeGateway } from '@/server/context';
import { NotFoundError, ValidationError } from '@/server/errors';
import { requireUser } from '@/server/http/auth';
import { handle, json, readJson } from '@/server/http/respond';
import { num } from '@/server/db';

const bodySchema = z.strictObject({
  orderId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  outcome: z.enum(['success', 'decline_on_confirm', 'timeout_after_capture']),
});

/**
 * 가짜 PG 결제창이 호출한다 (로컬 데모 전용 — PAYMENT_GATEWAY=fake 일 때만 존재).
 * 실제 PG 결제창에서 카드 인증을 마치는 것에 해당하고, 이어질 승인 호출의 결과를 시나리오로 정한다.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = getContext();
    const fake = getFakeGateway(ctx);
    if (!fake) throw new NotFoundError();
    const userId = await requireUser(ctx, req);
    const body = bodySchema.safeParse(await readJson(req));
    if (!body.success) throw new ValidationError('요청 형식이 올바르지 않습니다.');

    const { rows } = await ctx.pool.query<{ amount: string }>(
      `SELECT p.amount FROM payments p JOIN bookings b ON b.id = p.booking_id
        WHERE p.order_id = $1 AND b.consumer_id = $2 AND p.status = 'READY'`,
      [body.data.orderId, userId],
    );
    const payment = rows[0];
    if (!payment) throw new NotFoundError('결제할 수 있는 주문이 아닙니다.');

    const amount = num(payment.amount);
    const paymentKey = fake.authenticate({ orderId: body.data.orderId, amount });
    if (body.data.outcome === 'decline_on_confirm') fake.script('decline', body.data.orderId);
    if (body.data.outcome === 'timeout_after_capture') fake.script(['timeout_after_capture', 'ok'], body.data.orderId);
    return json({ paymentKey, amount });
  });
}
