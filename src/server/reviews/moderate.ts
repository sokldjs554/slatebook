import { withTx } from '../db';
import type { AppContext } from '../context';
import { NotFoundError } from '../errors';

/**
 * 후기 숨김/복원. 숨긴 후기는 목록과 평점 집계에서 빠진다.
 * 상태 변경과 집계 보정이 한 트랜잭션이고, 같은 상태로 다시 바꾸는 호출은 아무것도 하지 않는다(멱등).
 * (관리자 인증이 아직 없으므로 HTTP 로는 노출하지 않는다 — 운영 도구·스크립트용 서버 함수.)
 */
export async function setReviewVisibility(ctx: AppContext, reviewId: string, status: 'PUBLISHED' | 'HIDDEN'): Promise<boolean> {
  return withTx(ctx.pool, async (tx) => {
    const { rows } = await tx.query<{ status: string; listing_id: string; rating: number }>(
      `SELECT status, listing_id, rating FROM reviews WHERE id = $1 FOR UPDATE`,
      [reviewId],
    );
    const r = rows[0];
    if (!r) throw new NotFoundError('후기를 찾을 수 없습니다.');
    if (r.status === status) return false;
    await tx.query(`UPDATE reviews SET status = $2 WHERE id = $1`, [reviewId, status]);
    const sign = status === 'HIDDEN' ? -1 : 1;
    await tx.query(
      `UPDATE listings SET rating_count = rating_count + $2, rating_sum = rating_sum + $3 WHERE id = $1`,
      [r.listing_id, sign, sign * r.rating],
    );
    return true;
  });
}
