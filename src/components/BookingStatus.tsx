'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { startCheckout } from '@/lib/checkout';
import { formatRange, won } from '@/lib/format';
import type { BookingResponse } from '@/shared/schemas';

const POLL_MS = 2_000;
const POLL_GIVE_UP_MS = 3 * 60_000;

type Load = { kind: 'loading' } | { kind: 'ok'; res: BookingResponse } | { kind: 'error'; code: string; message: string };

function useNow(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

export function BookingStatus({ bookingId }: { bookingId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [netWarn, setNetWarn] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const startedAt = useRef(Date.now());

  // 결제 확인 중(PAYMENT_CONFIRMING)이면 확정될 때까지 주기적으로 조회한다.
  // 이 조회가 서버에서 PG 상태 확인(대사)을 앞당겨 주므로, 사용자가 창을 닫았다 다시 와도 결과가 따라온다.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ac = new AbortController();

    async function tick() {
      const r = await api<BookingResponse>(`/api/bookings/${bookingId}`, { signal: ac.signal });
      if (stopped) return;
      if (r.ok) {
        setNetWarn(false);
        setLoad({ kind: 'ok', res: r.data });
        if (r.data.booking.status === 'PAYMENT_CONFIRMING') {
          if (Date.now() - startedAt.current < POLL_GIVE_UP_MS) timer = setTimeout(tick, POLL_MS);
          else setGaveUp(true);
        }
      } else if (r.code === 'NETWORK') {
        setNetWarn(true);
        timer = setTimeout(tick, 4_000); // 끊겼다 돌아와도 계속 확인한다
      } else if (r.code !== 'ABORTED') {
        setLoad({ kind: 'error', code: r.code, message: r.message });
      }
    }
    setGaveUp(false);
    startedAt.current = Date.now();
    tick();
    return () => {
      stopped = true;
      ac.abort();
      if (timer) clearTimeout(timer);
    };
  }, [bookingId, reloadTick]);

  const res = load.kind === 'ok' ? load.res : null;
  const status = res?.booking.status;
  const now = useNow(1_000, status === 'PENDING_PAYMENT');
  const remainingMs = res?.booking.holdExpiresAt ? new Date(res.booking.holdExpiresAt).getTime() - now : 0;

  // 홀드 시간이 다 되면 서버에 다시 물어 화면을 "만료"로 바꾼다
  useEffect(() => {
    if (status === 'PENDING_PAYMENT' && res?.booking.holdExpiresAt && remainingMs <= 0) setReloadTick((n) => n + 1);
  }, [status, res?.booking.holdExpiresAt, remainingMs]);

  async function payNow() {
    if (!res || acting) return;
    setActing(true);
    setActionError(null);
    try {
      let payment = res.payment;
      if (!payment) {
        const r = await api<BookingResponse>(`/api/bookings/${bookingId}/payments`, { method: 'POST' });
        if (!r.ok) {
          setActionError(r.message);
          setReloadTick((n) => n + 1);
          return;
        }
        payment = r.data.payment;
      }
      if (!payment) {
        setActionError('지금은 결제를 시작할 수 없어요. 잠시 후 다시 시도해 주세요.');
        return;
      }
      await startCheckout({ payment, bookingId });
    } catch (err) {
      setActionError(`결제창을 열지 못했어요: ${(err as Error).message}`);
    } finally {
      setActing(false);
    }
  }

  if (load.kind === 'loading') return <p className="muted"><span className="spinner" />예약 정보를 불러오는 중…</p>;
  if (load.kind === 'error') {
    return (
      <div className="stack">
        <p className={`notice ${load.code === 'UNAUTHORIZED' ? 'warn' : 'bad'}`} role="alert">
          {load.code === 'UNAUTHORIZED' ? '예약을 보려면 화면 위쪽에서 데모 사용자를 선택해 주세요.' : load.message}
        </p>
        <Link href="/" className="btn secondary">처음으로</Link>
      </div>
    );
  }

  const b = res!.booking;
  const mm = Math.max(0, Math.floor(remainingMs / 60_000));
  const ss = Math.max(0, Math.floor((remainingMs % 60_000) / 1000));

  return (
    <div className="stack">
      {netWarn && <p className="notice warn">네트워크가 불안정해요. 연결되면 자동으로 다시 확인합니다.</p>}

      {status === 'CONFIRMED' || status === 'COMPLETED' ? (
        <p className="notice ok" role="status">✅ 예약이 확정되었어요. {status === 'COMPLETED' ? '이용이 완료됐습니다.' : ''}</p>
      ) : status === 'PAYMENT_CONFIRMING' ? (
        <p className="notice info" role="status">
          <span className="spinner" />결제를 확인하고 있어요. 이 창을 닫아도 괜찮아요 — 확인이 끝나면 예약이 확정됩니다.
          {gaveUp && (<> 확인이 오래 걸리고 있어요. <button type="button" className="secondary" onClick={() => setReloadTick((n) => n + 1)}>다시 확인</button></>)}
        </p>
      ) : status === 'PENDING_PAYMENT' ? (
        <p className="notice warn" role="status">
          결제 대기 중 · 남은 시간 <strong>{mm}:{String(ss).padStart(2, '0')}</strong> (이 시간 안에 결제하지 않으면 자동으로 풀려요)
        </p>
      ) : status === 'EXPIRED' ? (
        <p className="notice bad" role="status">결제 가능 시간이 지나 예약이 취소됐어요. 결제는 진행되지 않았습니다.</p>
      ) : status === 'PAYMENT_FAILED' ? (
        <p className="notice bad" role="status">결제 내용을 검증하지 못해 예약이 취소됐고, 승인된 결제는 자동으로 환불됩니다.</p>
      ) : (
        <p className="notice bad" role="status">취소된 예약이에요.</p>
      )}

      <div className="card">
        <div className="kv"><span>상품</span><span>{b.listingTitle}</span></div>
        <div className="kv"><span>이용 일시</span><span>{formatRange(b.start, b.end)}</span></div>
        <div className="kv"><span>결제 금액</span><span className="price">{won(b.totalAmount)}</span></div>
        <div className="kv"><span>예약 번호</span><span className="muted" style={{ fontSize: 12 }}>{b.id}</span></div>
      </div>

      {actionError && <p className="notice bad" role="alert">{actionError}</p>}

      {status === 'PENDING_PAYMENT' && (
        <button type="button" className="block" onClick={payNow} disabled={acting}>
          {acting ? (<><span className="spinner" />결제창 여는 중…</>) : res!.payment ? '결제하기' : '다른 결제 수단으로 다시 결제'}
        </button>
      )}
      {(status === 'EXPIRED' || status === 'PAYMENT_FAILED' || status === 'CANCELED') && (
        <Link href={`/listings/${b.listingId}`} className="btn block">다시 예약하기</Link>
      )}
      <Link href="/" className="btn secondary block">처음으로</Link>
    </div>
  );
}
