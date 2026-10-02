import { describe, expect, it } from 'vitest';
import { calcQuote } from '../../src/shared/quote';

describe('calcQuote', () => {
  it('2시간 × 5만원 = 10만원, 수수료 10% 는 1만원, 호스트는 9만원', () => {
    expect(calcQuote({ hourlyPrice: 50_000, minutes: 120, commissionRateBp: 1000, bufferMinutes: 30 })).toMatchObject({
      amount: 100_000,
      feeAmount: 10_000,
      hostNet: 90_000,
    });
  });

  it('금액은 0.5원 올림, 수수료는 내림 — 합계는 항상 원 단위로 정확히 떨어진다', () => {
    // 50,001원/시간 × 30분 = 25,000.5 → 25,001
    expect(calcQuote({ hourlyPrice: 50_001, minutes: 30, commissionRateBp: 0, bufferMinutes: 0 }).amount).toBe(25_001);
    // 33,333 × 10% = 3,333.3 → 수수료 3,333 (내림), 호스트 30,000
    const q = calcQuote({ hourlyPrice: 66_666, minutes: 30, commissionRateBp: 1000, bufferMinutes: 0 });
    expect(q.amount).toBe(33_333);
    expect(q.feeAmount).toBe(3_333);
    expect(q.hostNet).toBe(30_000);
  });

  it('임의의 입력에서도 amount = fee + hostNet 이고 모두 안전한 정수다 (속성 검사)', () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 5_000; i++) {
      const q = calcQuote({
        hourlyPrice: 1 + rnd(5_000_000),
        minutes: 30 * (1 + rnd(24)),
        commissionRateBp: rnd(10_001),
        bufferMinutes: 0,
      });
      expect(Number.isSafeInteger(q.amount)).toBe(true);
      expect(q.feeAmount).toBeGreaterThanOrEqual(0);
      expect(q.hostNet).toBeGreaterThanOrEqual(0);
      expect(q.feeAmount + q.hostNet).toBe(q.amount);
    }
  });

  it('수수료율 100% 면 호스트 몫은 0', () => {
    expect(calcQuote({ hourlyPrice: 10_000, minutes: 60, commissionRateBp: 10_000, bufferMinutes: 0 }).hostNet).toBe(0);
  });

  it.each([
    { hourlyPrice: 0, minutes: 60 },
    { hourlyPrice: 10_000, minutes: 0 },
    { hourlyPrice: -1, minutes: 60 },
    { hourlyPrice: 10_000.5, minutes: 60 },
    { hourlyPrice: Number.NaN, minutes: 60 },
    { hourlyPrice: 10_000, minutes: 60, commissionRateBp: 10_001 },
  ])('잘못된 입력은 거부한다: %o', (bad) => {
    expect(() => calcQuote({ commissionRateBp: 1000, bufferMinutes: 0, ...bad })).toThrow(RangeError);
  });
});
