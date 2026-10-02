'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, newIdempotencyKey, type ApiResult } from '@/lib/api';
import { startCheckout } from '@/lib/checkout';
import { won } from '@/lib/format';
import { calcQuote } from '@/shared/quote';
import type { AvailabilityResponse, BookingResponse } from '@/shared/schemas';
import { SLOT_MINUTES, WINDOW_PROBLEM_MESSAGE, checkBookingWindow, kstDayRange, kstIso, toKstParts } from '@/shared/time';

interface Props {
  listing: { id: string; title: string; kind: 'STUDIO' | 'EQUIPMENT'; hourlyPrice: number };
}

type Phase = 'idle' | 'submitting' | 'redirecting';
type Problem = { message: string; kind: 'slot' | 'login' | 'retry-same' | 'other' };

const START_OPTIONS = Array.from({ length: 36 }, (_, i) => {
  const mins = 6 * 60 + i * SLOT_MINUTES; // 06:00 ~ 23:30
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
});
const DURATION_OPTIONS = Array.from({ length: 16 }, (_, i) => (i + 1) * SLOT_MINUTES); // 30분 ~ 8시간

function tomorrowKst(): string {
  return toKstParts(new Date(Date.now() + 24 * 3_600_000)).date;
}

export function BookingForm({ listing }: Props) {
  const [date, setDate] = useState(tomorrowKst);
  const [startHHMM, setStartHHMM] = useState('10:00');
  const [minutes, setMinutes] = useState(120);
  const [avail, setAvail] = useState<AvailabilityResponse | null>(null);
  const [availError, setAvailError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<Problem | null>(null);

  // 같은 내용의 요청에는 같은 키를 쓴다: 네트워크 오류 뒤 다시 눌러도 예약이 두 번 생기지 않는다.
  // 선택 내용이 바뀌면 키도 바꾼다 (같은 키에 다른 내용을 보내면 서버가 422 로 거부한다).
  const keyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const inFlight = useRef(false);

  // 날짜가 바뀔 때마다 가용성을 다시 읽는다. 늦게 도착한 이전 요청의 응답은 버린다.
  useEffect(() => {
    const ac = new AbortController();
    setAvail(null);
    setAvailError(null);
    api<AvailabilityResponse>(`/api/listings/${listing.id}/availability?date=${date}`, { signal: ac.signal }).then((r) => {
      if (ac.signal.aborted) return;
      if (r.ok) setAvail(r.data);
      else if (r.code !== 'ABORTED') setAvailError(r.message);
    });
    return () => ac.abort();
  }, [listing.id, date, refreshTick]);

  const start = useMemo(() => new Date(kstIso(date, startHHMM)), [date, startHHMM]);
  const end = useMemo(() => new Date(start.getTime() + minutes * 60_000), [start, minutes]);
  const windowProblem = checkBookingWindow(start, end, new Date());

  const hourlyPrice = avail?.hourlyPrice ?? listing.hourlyPrice;
  const bufferMinutes = avail?.bufferMinutes ?? 0;
  const quote = useMemo(
    () => calcQuote({ hourlyPrice, minutes, commissionRateBp: avail?.commissionRateBp ?? 0, bufferMinutes }),
    [hourlyPrice, minutes, avail?.commissionRateBp, bufferMinutes],
  );

  // 화면 안내용 충돌 검사: 선택한 구간(+정리 버퍼)이 이미 찬 칸을 건드리는가. 최종 판정은 서버가 한다.
  const busyCells = useMemo(() => {
    const set = new Set<number>();
    for (const c of avail?.cells ?? []) if (c.freeUnits === 0) set.add(new Date(c.start).getTime());
    return set;
  }, [avail]);
  const overlapsBusy = (s: Date, mins: number) => {
    const until = s.getTime() + (mins + bufferMinutes) * 60_000;
    for (let t = s.getTime(); t < until; t += SLOT_MINUTES * 60_000) if (busyCells.has(t)) return true;
    return false;
  };
  const selectedBusy = overlapsBusy(start, minutes);
  const dayStart = kstDayRange(date)?.start.getTime() ?? 0;

  function explain(r: Extract<ApiResult<unknown>, { ok: false }>): Problem {
    switch (r.code) {
      case 'SLOT_TAKEN':
        return { kind: 'slot', message: r.message };
      case 'UNAUTHORIZED':
        return { kind: 'login', message: '먼저 화면 위쪽에서 데모 사용자를 선택해 주세요.' };
      case 'NETWORK':
        return { kind: 'retry-same', message: '네트워크 연결이 불안정해요. 버튼을 다시 누르면 같은 요청으로 안전하게 재시도합니다. (예약이 중복으로 생기지 않아요)' };
      case 'BUSY':
        return { kind: 'retry-same', message: `${r.message}${r.retryAfterSec ? ` (${r.retryAfterSec}초 뒤)` : ''}` };
      default:
        return { kind: 'other', message: r.message };
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current || windowProblem || selectedBusy) return; // 더블클릭 방지 (서버의 멱등성이 두 번째 방어선)
    inFlight.current = true;
    setPhase('submitting');
    setProblem(null);

    const body = { listingId: listing.id, start: start.toISOString(), end: end.toISOString() };
    const fingerprint = `${body.listingId}|${body.start}|${body.end}`;
    if (keyRef.current?.fingerprint !== fingerprint) keyRef.current = { fingerprint, key: newIdempotencyKey() };

    let redirecting = false;
    try {
      const r = await api<BookingResponse>('/api/bookings', { method: 'POST', body, headers: { 'Idempotency-Key': keyRef.current.key } });
      if (!r.ok) {
        const p = explain(r);
        setProblem(p);
        if (r.code === 'SLOT_TAKEN') {
          keyRef.current = null;
          setRefreshTick((n) => n + 1); // 최신 가용성을 다시 보여 준다
        }
        if (r.code === 'IDEMPOTENCY_KEY_REUSED') keyRef.current = null;
        return;
      }
      const { booking, payment } = r.data;
      if (!payment) {
        // 이전에 만든 예약의 재전송이었는데 이미 결제할 수 없는 상태다 → 새로 시작
        keyRef.current = null;
        setProblem({ kind: 'other', message: '이전에 만든 예약의 결제 시간이 지났어요. 한 번 더 눌러 새로 예약해 주세요.' });
        return;
      }
      redirecting = true;
      setPhase('redirecting');
      try {
        await startCheckout({ payment, bookingId: booking.id });
      } catch (err) {
        redirecting = false;
        // 결제창을 열지 못했다. 예약은 홀드 중이므로 예약 페이지에서 이어서 결제할 수 있다.
        setProblem({ kind: 'other', message: `결제창을 열지 못했어요 (${(err as Error).message}). 예약 페이지에서 다시 결제할 수 있어요.` });
        window.location.assign(`/bookings/${booking.id}`);
      }
    } finally {
      inFlight.current = false;
      if (!redirecting) setPhase('idle');
    }
  }

  const disabled = phase !== 'idle' || !!windowProblem || selectedBusy || !avail;

  return (
    <form onSubmit={onSubmit} className="stack" aria-label="예약 신청">
      <div className="card stack">
        <div className="row">
          <div>
            <label htmlFor="date">날짜 (KST)</label>
            <input id="date" type="date" value={date} min={toKstParts(new Date()).date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor="start">시작 시간</label>
            <select id="start" value={startHHMM} onChange={(e) => setStartHHMM(e.target.value)}>
              {START_OPTIONS.map((hhmm) => {
                const s = new Date(kstIso(date, hhmm));
                const busy = avail !== null && overlapsBusy(s, minutes);
                return (
                  <option key={hhmm} value={hhmm} disabled={busy}>
                    {hhmm}
                    {busy ? ' (예약 불가)' : ''}
                  </option>
                );
              })}
            </select>
          </div>
          <div>
            <label htmlFor="minutes">이용 시간</label>
            <select id="minutes" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {DURATION_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m % 60 === 0 ? `${m / 60}시간` : `${Math.floor(m / 60)}시간 ${m % 60}분`.replace(/^0시간 /, '')}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div aria-label="시간대별 예약 현황">
          {availError ? (
            <p className="notice bad">예약 현황을 불러오지 못했어요: {availError}{' '}
              <button type="button" className="secondary" onClick={() => setRefreshTick((n) => n + 1)}>다시 불러오기</button>
            </p>
          ) : !avail ? (
            <p className="muted"><span className="spinner" />예약 현황을 불러오는 중…</p>
          ) : (
            <div className="cells">
              {avail.cells.map((c) => {
                const t = new Date(c.start).getTime();
                const inSel = t >= start.getTime() && t < end.getTime();
                if (t < dayStart + 6 * 3_600_000) return null; // 06:00 이전은 숨긴다
                return (
                  <div key={c.start} className={`cell${c.freeUnits === 0 ? ' busy' : ''}${inSel ? ' sel' : ''}`} title={c.freeUnits === 0 ? '예약됨' : `남은 수량 ${c.freeUnits}`}>
                    {toKstParts(new Date(c.start)).hhmm}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="kv"><span>이용 시간</span><span>{minutes / 60}시간 ({toKstParts(start).hhmm} – {toKstParts(end).hhmm})</span></div>
        {bufferMinutes > 0 && <div className="kv"><span>정리 시간</span><span>이용 후 {bufferMinutes}분 (예약 불가)</span></div>}
        <div className="kv"><span>결제 금액</span><span className="price">{won(quote.amount)}</span></div>
        <p className="muted" style={{ fontSize: 13, margin: '8px 0 0' }}>표시 금액은 안내용이에요. 실제 결제 금액은 서버가 다시 계산합니다.</p>
      </div>

      {windowProblem && <p className="notice warn" role="alert">{WINDOW_PROBLEM_MESSAGE[windowProblem]}</p>}
      {!windowProblem && selectedBusy && <p className="notice warn" role="alert">선택한 시간(정리 시간 포함)에 이미 예약된 칸이 있어요.</p>}
      {problem && (
        <p className={`notice ${problem.kind === 'slot' ? 'warn' : 'bad'}`} role="alert">{problem.message}</p>
      )}

      <button type="submit" className="block" disabled={disabled}>
        {phase === 'submitting' ? (<><span className="spinner" />예약 확인 중…</>) : phase === 'redirecting' ? (<><span className="spinner" />결제창으로 이동 중…</>) : '예약하고 결제하기'}
      </button>
      <p className="muted" style={{ fontSize: 13, textAlign: 'center' }}>결제 전까지 10분간 시간이 잡혀 있어요. 10분 안에 결제하지 않으면 자동으로 풀립니다.</p>
    </form>
  );
}
