/**
 * 견적 계산. 서버가 계산한 값만 결제 금액이 된다 — 브라우저의 같은 함수는 화면 표시용이다.
 *
 * 반올림 규칙(한 곳에 고정):
 *   - 금액 = 시간당 단가 × 분 / 60, 원 단위 반올림(0.5 올림)
 *   - 수수료 = 금액 × 수수료율(bp) / 10000, 원 단위 내림 → 호스트가 나머지를 받는다
 */
export interface QuoteInput {
  hourlyPrice: number;
  minutes: number;
  commissionRateBp: number;
  bufferMinutes: number;
}

export interface Quote extends QuoteInput {
  amount: number;
  feeAmount: number;
  hostNet: number;
}

export function calcQuote(input: QuoteInput): Quote {
  const { hourlyPrice, minutes, commissionRateBp, bufferMinutes } = input;
  for (const [name, v] of Object.entries({ hourlyPrice, minutes, commissionRateBp, bufferMinutes })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError(`invalid quote input ${name}: ${v}`);
  }
  if (hourlyPrice === 0 || minutes === 0) throw new RangeError('hourlyPrice and minutes must be positive');
  if (commissionRateBp > 10_000) throw new RangeError('commissionRateBp must be <= 10000');

  const amount = Math.floor((hourlyPrice * minutes + 30) / 60);
  const feeAmount = Math.floor((amount * commissionRateBp) / 10_000);
  return { ...input, amount, feeAmount, hostNet: amount - feeAmount };
}
