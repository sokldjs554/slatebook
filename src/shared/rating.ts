/** 후기·평점 규칙 — 서버와 브라우저가 같은 함수를 쓴다 */
export const REVIEW_MAX_BODY = 1000;
export const REVIEW_WINDOW_DAYS = 30;
export const MIN_RATING = 1;
export const MAX_RATING = 5;

/**
 * 평균 평점(소수 첫째 자리, 0.5 올림). 후기가 없으면 null.
 * 부동소수점(4.35 * 10 = 43.49999…)으로 반올림이 어긋나지 않도록 정수 연산만 쓴다.
 */
export function averageRating(sum: number, count: number): number | null {
  if (!Number.isSafeInteger(sum) || !Number.isSafeInteger(count) || sum < 0 || count < 0) {
    throw new RangeError(`invalid rating aggregate: sum=${sum} count=${count}`);
  }
  if (count === 0) return null;
  const tenths = Math.floor((sum * 20 + count) / (2 * count));
  return tenths / 10;
}

/**
 * 정렬용 점수(베이지안 평균): 후기가 1개뿐인 5.0점이 후기 200개의 4.8점보다 위에 오르지 않게 한다.
 *   (priorWeight · priorMean + sum) / (priorWeight + count)
 * 후기가 쌓일수록 실제 평균에 가까워지고, 없으면 priorMean 이다.
 */
export function rankingScore(sum: number, count: number, priorMean = 4.0, priorWeight = 5): number {
  return (priorWeight * priorMean + sum) / (priorWeight + count);
}

/** 작성자 이름은 첫 글자만 보여준다 (예: 앨리스 → 앨**) */
export function maskName(name: string): string {
  const first = [...name.trim()][0];
  return first ? `${first}**` : '익명**';
}
