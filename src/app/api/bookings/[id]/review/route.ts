import { z } from 'zod';
import { getContext } from '@/server/context';
import { NotFoundError } from '@/server/errors';
import { requireUser } from '@/server/http/auth';
import { handle, json, readJson } from '@/server/http/respond';
import { createReview } from '@/server/reviews/create';

/** 후기 작성 (본인의 이용 완료 예약에 한해, 예약당 1건) */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = getContext();
    const userId = await requireUser(ctx, req);
    const { id } = await params;
    if (!z.guid().safeParse(id).success) throw new NotFoundError('예약을 찾을 수 없습니다.');
    return json(await createReview(ctx, userId, id, await readJson(req)), { status: 201 });
  });
}
