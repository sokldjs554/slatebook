import { getContext } from '@/server/context';
import { createBooking } from '@/server/bookings/create';
import { ValidationError } from '@/server/errors';
import { requireUser } from '@/server/http/auth';
import { handle, json, readJson } from '@/server/http/respond';

/** 예약 생성. Idempotency-Key 헤더 필수 — 같은 키의 재전송은 같은 예약을 돌려준다(200), 새로 만들면 201. */
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = getContext();
    const userId = await requireUser(ctx, req);
    const key = req.headers.get('idempotency-key');
    if (!key) throw new ValidationError('Idempotency-Key 헤더가 필요합니다.');
    const { response, replayed } = await createBooking(ctx, userId, key, await readJson(req));
    return json(response, { status: replayed ? 200 : 201 });
  });
}
