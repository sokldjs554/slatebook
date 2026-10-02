/**
 * 예약 시간 규칙 — 서버와 브라우저가 같은 함수를 쓴다.
 * 서버가 최종 판정자이고, 브라우저는 같은 규칙으로 미리 안내만 한다.
 *
 * 한국 서비스이므로 표시 시간대는 KST(UTC+9, 서머타임 없음)로 고정한다.
 * 30분 격자는 UTC 기준으로 맞춰도 KST 와 동일하다 (9시간 = 30분의 배수).
 */
export const SLOT_MINUTES = 30;
export const MIN_DURATION_MINUTES = 30;
export const MAX_DURATION_MINUTES = 12 * 60;
export const MIN_LEAD_MINUTES = 30;
export const MAX_ADVANCE_DAYS = 180;
export const KST_OFFSET = '+09:00';

const MS_PER_MINUTE = 60_000;
const KST_SHIFT_MS = 9 * 60 * MS_PER_MINUTE;

export type WindowProblem =
  | 'END_BEFORE_START'
  | 'NOT_ON_GRID'
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'TOO_SOON'
  | 'TOO_FAR';

export const WINDOW_PROBLEM_MESSAGE: Record<WindowProblem, string> = {
  END_BEFORE_START: '종료 시각은 시작 시각보다 뒤여야 합니다.',
  NOT_ON_GRID: `시간은 ${SLOT_MINUTES}분 단위로 선택해 주세요.`,
  TOO_SHORT: `최소 ${MIN_DURATION_MINUTES}분 이상 예약해야 합니다.`,
  TOO_LONG: `한 번에 최대 ${MAX_DURATION_MINUTES / 60}시간까지 예약할 수 있습니다.`,
  TOO_SOON: `시작 ${MIN_LEAD_MINUTES}분 전까지만 예약할 수 있습니다.`,
  TOO_FAR: `${MAX_ADVANCE_DAYS}일 이내의 날짜만 예약할 수 있습니다.`,
};

export function isOnSlotGrid(d: Date): boolean {
  return d.getTime() % (SLOT_MINUTES * MS_PER_MINUTE) === 0;
}

export function checkBookingWindow(start: Date, end: Date, now: Date): WindowProblem | null {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 'END_BEFORE_START';
  if (end.getTime() <= start.getTime()) return 'END_BEFORE_START';
  if (!isOnSlotGrid(start) || !isOnSlotGrid(end)) return 'NOT_ON_GRID';
  const minutes = (end.getTime() - start.getTime()) / MS_PER_MINUTE;
  if (minutes < MIN_DURATION_MINUTES) return 'TOO_SHORT';
  if (minutes > MAX_DURATION_MINUTES) return 'TOO_LONG';
  if (start.getTime() < now.getTime() + MIN_LEAD_MINUTES * MS_PER_MINUTE) return 'TOO_SOON';
  if (start.getTime() > now.getTime() + MAX_ADVANCE_DAYS * 24 * 60 * MS_PER_MINUTE) return 'TOO_FAR';
  return null;
}

export function durationMinutes(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE);
}

/** Date → KST 의 {date: 'YYYY-MM-DD', hhmm: 'HH:MM'} */
export function toKstParts(d: Date): { date: string; hhmm: string } {
  const shifted = new Date(d.getTime() + KST_SHIFT_MS);
  const iso = shifted.toISOString(); // 2026-12-01T10:30:00.000Z (시프트된 값이므로 KST 벽시계)
  return { date: iso.slice(0, 10), hhmm: iso.slice(11, 16) };
}

/** 'YYYY-MM-DD' (KST) → 그날 [00:00, 24:00) 의 UTC Date 범위. 존재하지 않는 날짜면 null. */
export function kstDayRange(dateStr: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const start = new Date(`${dateStr}T00:00:00${KST_OFFSET}`);
  if (Number.isNaN(start.getTime())) return null;
  if (toKstParts(start).date !== dateStr) return null; // 2026-02-31 같은 날짜 거르기
  return { start, end: new Date(start.getTime() + 24 * 60 * MS_PER_MINUTE) };
}

/** KST 벽시계 → 오프셋이 명시된 ISO 문자열 (서버로 보낼 형식) */
export function kstIso(date: string, hhmm: string): string {
  return `${date}T${hhmm}:00${KST_OFFSET}`;
}
