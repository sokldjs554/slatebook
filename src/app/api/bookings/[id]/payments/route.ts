import { z } from 'zod';
import { getContext } from '@/server/context';
import { NotFoundError } from '@/server/errors';
import { requireUser } from '@/server/http/auth';
import { handle, json } from '@/server/http/respond';
import { createRetryPayment } from '@/server/payments/retry';

/** 카드 거절 뒤 다른 결제 수단으로 다시 결제할 새 주문번호를 받는다 (진행 가능한 결제가 있으면 그것을 돌려준다) */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = getContext();
    const userId = await requireUser(ctx, req);
    const { id } = await params;
    if (!z.guid().safeParse(id).success) throw new NotFoundError('예약을 찾을 수 없습니다.');
    return json(await createRetryPayment(ctx, userId, id));
  });
}
