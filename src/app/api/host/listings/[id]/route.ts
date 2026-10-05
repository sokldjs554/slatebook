import { z } from 'zod';
import { getContext } from '@/server/context';
import { NotFoundError } from '@/server/errors';
import { updateListingPrice } from '@/server/host/pricing';
import { requireUser } from '@/server/http/auth';
import { handle, json, readJson } from '@/server/http/respond';

/** 호스트가 자기 상품의 시간당 가격을 바꾼다 (이미 잡힌 예약은 예약 시점 스냅샷을 쓰므로 그대로) */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const ctx = getContext();
    const userId = await requireUser(ctx, req);
    const { id } = await params;
    if (!z.guid().safeParse(id).success) throw new NotFoundError('상품을 찾을 수 없습니다.');
    return json(await updateListingPrice(ctx, userId, id, await readJson(req)));
  });
}
