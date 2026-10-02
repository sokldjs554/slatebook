import { createHash, timingSafeEqual } from 'node:crypto';

/** 길이가 달라도 시간차로 새지 않도록 해시한 뒤 상수 시간으로 비교한다 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
