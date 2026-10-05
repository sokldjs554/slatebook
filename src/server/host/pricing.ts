import { num } from '../db';
import type { AppContext } from '../context';
import { NotFoundError, ValidationError } from '../errors';
import { updateListingPriceSchema } from '../../shared/schemas';

/**
 * 호스트가 자기 상품의 시간당 가격을 정한다.
 *
 * 이미 잡힌 예약은 영향받지 않는다 — 예약은 생성 시점의 단가·수수료율·버퍼를 price_snapshot 에 저장하고
 * 결제·정산은 그 스냅샷을 쓴다(bookings/create.ts, bookings/complete.ts). 손님이 본 가격이 결제·정산까지 그대로 간다.
 * 소유자가 아니면 "없는 상품"과 같은 응답이다 (남의 상품 id 가 존재하는지 알려주지 않는다).
 */
export async function updateListingPrice(
  ctx: AppContext,
  hostId: string,
  listingId: string,
  rawInput: unknown,
): Promise<{ id: string; title: string; hourlyPrice: number }> {
  const parsed = updateListingPriceSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError(
      '시간당 가격은 1,000원 이상 10,000,000원 이하의 정수여야 합니다.',
      parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  }
  const { rows } = await ctx.pool.query<{ id: string; title: string; hourly_price: string }>(
    `UPDATE listings SET hourly_price = $1 WHERE id = $2 AND host_id = $3 RETURNING id, title, hourly_price`,
    [parsed.data.hourlyPrice, listingId, hostId],
  );
  const l = rows[0];
  if (!l) throw new NotFoundError('상품을 찾을 수 없습니다.');
  return { id: l.id, title: l.title, hourlyPrice: num(l.hourly_price) };
}
