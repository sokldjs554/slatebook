import { z } from 'zod';
import { getContext } from '@/server/context';
import { getAvailability } from '@/server/bookings/availability';
import { NotFoundError, ValidationError } from '@/server/errors';
import { handle, json } from '@/server/http/respond';
import { availabilityQuerySchema } from '@/shared/schemas';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const { id } = await params;
    if (!z.guid().safeParse(id).success) throw new NotFoundError('상품을 찾을 수 없습니다.');
    const query = availabilityQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) throw new ValidationError('date 는 YYYY-MM-DD 형식이어야 합니다.');
    return json(await getAvailability(getContext(), id, query.data.date));
  });
}
