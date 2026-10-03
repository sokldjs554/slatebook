import { z } from 'zod';
import { getContext } from '@/server/context';
import { NotFoundError, ValidationError } from '@/server/errors';
import { handle, json } from '@/server/http/respond';
import { listReviews } from '@/server/reviews/list';
import { reviewListQuerySchema } from '@/shared/schemas';

/** 상품의 후기 목록 (공개). 커서 방식 페이지네이션, 최신순. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    if (!z.guid().safeParse(id).success) throw new NotFoundError('상품을 찾을 수 없습니다.');
    const query = reviewListQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) throw new ValidationError('cursor 또는 limit 이 올바르지 않습니다.');
    return json(await listReviews(getContext(), id, query.data));
  });
}
