import type { AppContext } from '../context';
import { num } from '../db';
import { NotFoundError, ValidationError } from '../errors';
import { averageRating } from '../../shared/rating';
import type { ReviewListResponse } from '../../shared/schemas';
import { toReviewView, type ReviewRow } from '../bookings/rows';

export const DEFAULT_PAGE_SIZE = 10;

/**
 * 커서는 (created_at, id) 의 불투명 문자열이다. created_at 은 마이크로초 정밀도를 잃지 않도록 PG 가 만든 텍스트 그대로 주고받는다
 * (JS Date 는 밀리초라서, 같은 밀리초 안의 후기들이 페이지 경계에서 빠지거나 겹칠 수 있다).
 */
function encodeCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify([ts, id])).toString('base64url');
}
function decodeCursor(cursor: string): { ts: string; id: string } {
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof ts !== 'string' || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) || Number.isNaN(Date.parse(ts))) throw new Error('bad');
    return { ts, id };
  } catch {
    throw new ValidationError('cursor 가 올바르지 않습니다.');
  }
}

export async function listReviews(
  ctx: AppContext,
  listingId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<ReviewListResponse> {
  const limit = opts.limit ?? DEFAULT_PAGE_SIZE;
  const listing = await ctx.pool.query<{ rating_count: number; rating_sum: number }>(
    `SELECT rating_count, rating_sum FROM listings WHERE id = $1 AND status = 'ACTIVE'`,
    [listingId],
  );
  const l = listing.rows[0];
  if (!l) throw new NotFoundError('상품을 찾을 수 없습니다.');

  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  const { rows } = await ctx.pool.query<ReviewRow & { cursor_ts: string }>(
    `SELECT r.id, r.rating, r.body, r.created_at, r.created_at::text AS cursor_ts, u.name AS author_name
       FROM reviews r JOIN users u ON u.id = r.author_id
      WHERE r.listing_id = $1 AND r.status = 'PUBLISHED'
        AND ($2::timestamptz IS NULL OR (r.created_at, r.id) < ($2::timestamptz, $3::uuid))
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $4`,
    [listingId, cur?.ts ?? null, cur?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    summary: { count: num(l.rating_count), average: averageRating(num(l.rating_sum), num(l.rating_count)) },
    reviews: page.map(toReviewView),
    nextCursor: rows.length > limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
  };
}
