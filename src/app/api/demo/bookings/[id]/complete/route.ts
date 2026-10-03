import { z } from 'zod';
import { getContext } from '@/server/context';
import { fastForwardBooking } from '@/server/demo';
import { NotFoundError } from '@/server/errors';
import { requireUser } from '@/server/http/auth';
import { handle, json } from '@/server/http/respond';

/** ⚠ 데모 전용: 내 확정 예약을 "이용이 끝난 것"으로 만든다 (후기 작성 시연용) */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = getContext();
    if (!ctx.config.demoAuth) throw new NotFoundError();
    const userId = await requireUser(ctx, req);
    const { id } = await params;
    if (!z.guid().safeParse(id).success) throw new NotFoundError('예약을 찾을 수 없습니다.');
    return json(await fastForwardBooking(ctx, userId, id));
  });
}
