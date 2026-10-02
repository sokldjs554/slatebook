import { toKstParts } from '@/shared/time';

export const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;

export function formatRange(startIso: string, endIso: string): string {
  const s = toKstParts(new Date(startIso));
  const e = toKstParts(new Date(endIso));
  return s.date === e.date ? `${s.date} ${s.hhmm} – ${e.hhmm}` : `${s.date} ${s.hhmm} – ${e.date} ${e.hhmm}`;
}
