import { describe, expect, it } from 'vitest';
import { averageRating, maskName, rankingScore } from '../../src/shared/rating';

describe('averageRating', () => {
  it('후기가 없으면 null', () => expect(averageRating(0, 0)).toBeNull());
  it.each([
    [5, 1, 5],
    [9, 2, 4.5],
    [13, 3, 4.3], // 4.333…
    [14, 3, 4.7], // 4.666…
    [87, 20, 4.4], // 정확히 4.35 → 0.5 올림 (부동소수점으로는 4.3 이 되기 쉽다)
    [43, 10, 4.3],
    [2000, 500, 4.0],
  ])('합 %i / 개수 %i → %f', (sum, count, expected) => {
    expect(averageRating(sum, count)).toBe(expected);
  });
  it('항상 1.0 ~ 5.0 안이다 (속성 검사)', () => {
    let seed = 99;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 3_000; i++) {
      const count = 1 + rnd(400);
      const sum = count + rnd(4 * count + 1); // 각 후기 1~5점
      const avg = averageRating(sum, count)!;
      expect(avg).toBeGreaterThanOrEqual(1);
      expect(avg).toBeLessThanOrEqual(5);
      expect(Math.abs(avg - sum / count)).toBeLessThanOrEqual(0.05 + 1e-9);
    }
  });
  it.each([[-1, 1], [1, -1], [1.5, 2], [Number.NaN, 1]])('잘못된 집계(%f, %f)는 거부한다', (sum, count) => {
    expect(() => averageRating(sum, count)).toThrow(RangeError);
  });
});

describe('rankingScore (베이지안 평균)', () => {
  it('후기가 없으면 사전 평균, 후기가 쌓일수록 실제 평균에 가까워진다', () => {
    expect(rankingScore(0, 0)).toBe(4.0);
    expect(Math.abs(rankingScore(960, 200) - 4.8)).toBeLessThan(0.1);
  });
  it('후기 1개짜리 5.0점이 후기 200개의 4.8점보다 위에 오르지 않는다', () => {
    expect(rankingScore(5, 1)).toBeLessThan(rankingScore(960, 200));
  });
  it('같은 개수에서는 평점이 높을수록 점수가 높다', () => {
    expect(rankingScore(50, 10)).toBeGreaterThan(rankingScore(40, 10));
  });
});

describe('maskName', () => {
  it.each([
    ['앨리스', '앨**'],
    ['Bob', 'B**'],
    ['  크리스 ', '크**'],
    ['😀스마일', '😀**'], // 글자 하나가 두 칸(UTF-16)이어도 깨지지 않는다
    ['', '익명**'],
    ['   ', '익명**'],
  ])('%j → %s', (name, masked) => expect(maskName(name)).toBe(masked));
});
