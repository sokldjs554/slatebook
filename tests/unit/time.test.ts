import { describe, expect, it } from 'vitest';
import { checkBookingWindow, kstDayRange, kstIso, toKstParts } from '../../src/shared/time';

const NOW = new Date('2026-06-01T00:00:00Z');
const at = (iso: string) => new Date(iso);

describe('checkBookingWindow', () => {
  it('정상: 이틀 뒤 10:00–12:00 KST', () => {
    expect(checkBookingWindow(at('2026-06-03T01:00:00Z'), at('2026-06-03T03:00:00Z'), NOW)).toBeNull();
  });
  it('종료가 시작보다 앞서거나 같으면 거부', () => {
    expect(checkBookingWindow(at('2026-06-03T03:00:00Z'), at('2026-06-03T01:00:00Z'), NOW)).toBe('END_BEFORE_START');
    expect(checkBookingWindow(at('2026-06-03T01:00:00Z'), at('2026-06-03T01:00:00Z'), NOW)).toBe('END_BEFORE_START');
  });
  it('유효하지 않은 Date 는 거부', () => {
    expect(checkBookingWindow(new Date('nope'), at('2026-06-03T03:00:00Z'), NOW)).toBe('END_BEFORE_START');
  });
  it('30분 격자가 아니면 거부', () => {
    expect(checkBookingWindow(at('2026-06-03T01:15:00Z'), at('2026-06-03T03:00:00Z'), NOW)).toBe('NOT_ON_GRID');
    expect(checkBookingWindow(at('2026-06-03T01:00:01Z'), at('2026-06-03T03:00:00Z'), NOW)).toBe('NOT_ON_GRID');
  });
  it('최대 12시간, 초과하면 거부', () => {
    expect(checkBookingWindow(at('2026-06-03T00:00:00Z'), at('2026-06-03T12:00:00Z'), NOW)).toBeNull();
    expect(checkBookingWindow(at('2026-06-03T00:00:00Z'), at('2026-06-03T12:30:00Z'), NOW)).toBe('TOO_LONG');
  });
  it('시작 30분 전까지만: 정확히 30분 뒤는 허용, 29분 30초 뒤는 거부', () => {
    expect(checkBookingWindow(at('2026-06-01T00:30:00Z'), at('2026-06-01T01:30:00Z'), NOW)).toBeNull();
    expect(checkBookingWindow(at('2026-06-01T00:00:00Z'), at('2026-06-01T01:00:00Z'), NOW)).toBe('TOO_SOON');
    expect(checkBookingWindow(at('2026-05-31T23:00:00Z'), at('2026-06-01T00:00:00Z'), NOW)).toBe('TOO_SOON');
  });
  it('30분 규칙의 경계: 29분 30초 전에는 거부하고 30분 전에는 허용한다', () => {
    const now = new Date('2026-06-01T00:00:30Z'); // 시작이 00:30 이면 29분 30초 남음
    expect(checkBookingWindow(at('2026-06-01T00:30:00Z'), at('2026-06-01T01:30:00Z'), now)).toBe('TOO_SOON');
    expect(checkBookingWindow(at('2026-06-01T00:30:00Z'), at('2026-06-01T01:30:00Z'), new Date('2026-06-01T00:00:00Z'))).toBeNull();
  });
  it('180일 넘게 먼 예약은 거부', () => {
    expect(checkBookingWindow(at('2026-12-31T00:00:00Z'), at('2026-12-31T01:00:00Z'), NOW)).toBe('TOO_FAR');
  });
});

describe('KST 변환', () => {
  it('UTC 15:00 은 KST 다음 날 00:00', () => {
    expect(toKstParts(at('2026-06-01T15:00:00Z'))).toEqual({ date: '2026-06-02', hhmm: '00:00' });
  });
  it('kstIso → Date → toKstParts 가 왕복한다', () => {
    const d = new Date(kstIso('2026-12-31', '23:30'));
    expect(toKstParts(d)).toEqual({ date: '2026-12-31', hhmm: '23:30' });
  });
  it('하루 범위는 KST 00:00 부터 24시간', () => {
    const r = kstDayRange('2026-03-01')!;
    expect(r.start.toISOString()).toBe('2026-02-28T15:00:00.000Z');
    expect(r.end.getTime() - r.start.getTime()).toBe(24 * 3_600_000);
  });
  it.each(['2026-02-31', '2026-13-01', '2026-1-1', 'abc', '', '2026-06-01T00:00'])('존재하지 않거나 잘못된 날짜 %s 는 null', (s) => {
    expect(kstDayRange(s)).toBeNull();
  });
});
