import { withTx } from '../db';
import type { AppContext } from '../context';
import { lockBookingById, toReviewView, type ReviewRow } from '../bookings/rows';
import { NotFoundError, ReviewExistsError, ReviewNotAllowedError, ReviewWindowClosedError, ValidationError } from '../errors';
import { createReviewSchema, type ReviewView } from '../../shared/schemas';

/**
 * 후기 작성.
 *  - 본인의 예약만, 이용이 완료(COMPLETED)된 예약만, 완료 후 30일 안에만 쓸 수 있다. 예약당 1건.
 *  - 후기 INSERT 와 상품 평점 집계(rating_count/rating_sum) 갱신이 한 트랜잭션이다 → 집계가 후기와 어긋나지 않는다.
 *  - 예약 행을 잠그므로 같은 예약에 대한 동시 제출은 한 줄로 서고, 둘째는 REVIEW_EXISTS 가 된다
 *    (booking_id UNIQUE 가 최종 방어선).
 */
export async function createReview(ctx: AppContext, userId: string, bookingId: string, rawInput: unknown): Promise<ReviewView> {
  const parsed = createReviewSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError('후기 형식이 올바르지 않습니다.', parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
  const body = parsed.data.body?.trim() ? parsed.data.body.trim() : null; // 공백뿐인 본문은 "본문 없음"
  const { rating } = parsed.data;

  return withTx(ctx.pool, async (tx) => {
    const booking = await lockBookingById(tx, bookingId);
    // 남의 예약이든 없는 예약이든 같은 응답
    if (!booking || booking.consumer_id !== userId) throw new NotFoundError('예약을 찾을 수 없습니다.');
    if (booking.status !== 'COMPLETED') throw new ReviewNotAllowedError();
    if (!booking.review_open) throw new ReviewWindowClosedError();

    const inserted = await tx.query<ReviewRow>(
      `WITH ins AS (
         INSERT INTO reviews(booking_id, author_id, listing_id, rating, body)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (booking_id) DO NOTHING
         RETURNING id, rating, body, created_at
       )
       SELECT ins.id, ins.rating, ins.body, ins.created_at, u.name AS author_name
         FROM ins, users u WHERE u.id = $2`,
      [bookingId, userId, booking.listing_id, rating, body],
    );
    const row = inserted.rows[0];
    if (!row) throw new ReviewExistsError();

    await tx.query(
      `UPDATE listings SET rating_count = rating_count + 1, rating_sum = rating_sum + $2 WHERE id = $1`,
      [booking.listing_id, rating],
    );
    return toReviewView(row);
  });
}
