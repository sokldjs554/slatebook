'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { recallOrder } from '@/lib/checkout';
import type { ConfirmResponse } from '@/shared/schemas';

type View =
  | { kind: 'working' }
  | { kind: 'error'; code: string; message: string; bookingId: string | null; canRetry: boolean };

/**
 * PG 가 결제 성공 후 브라우저를 돌려보내는 페이지: /pay/success?paymentKey=…&orderId=…&amount=…
 * 이 값들은 브라우저를 거쳐 온 "신고"일 뿐이다. 서버가 금액을 다시 대조하고 PG 에 승인을 요청해 확정한다.
 */
export function PaymentSuccess() {
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<View>({ kind: 'working' });
  const started = useRef(false);

  const run = useCallback(async () => {
    setView({ kind: 'working' });
    const paymentKey = params.get('paymentKey');
    const orderId = params.get('orderId');
    const amountRaw = params.get('amount');
    const amount = amountRaw !== null && /^\d{1,12}$/.test(amountRaw) ? Number(amountRaw) : NaN;
    if (!paymentKey || !orderId || !Number.isSafeInteger(amount)) {
      setView({ kind: 'error', code: 'BAD_RETURN', message: '결제 정보가 올바르지 않아요. 결제를 다시 시도해 주세요.', bookingId: null, canRetry: false });
      return;
    }

    const r = await api<ConfirmResponse>('/api/payments/confirm', { method: 'POST', body: { paymentKey, orderId, amount } });
    if (r.ok) {
      // 확정(200)이든 확인 중(202)이든 예약 페이지로 간다 — 예약 페이지가 결과를 끝까지 따라간다
      router.replace(`/bookings/${r.data.bookingId}`);
      return;
    }
    const bookingId = (r.details?.bookingId as string | undefined) ?? recallOrder(orderId);
    setView({
      kind: 'error',
      code: r.code,
      message:
        r.code === 'NETWORK'
          ? '결제 확인 중에 네트워크가 끊겼어요. 결제가 이미 완료됐을 수도 있으니, 아래 버튼으로 다시 확인해 주세요. (같은 요청을 다시 보내도 중복 결제되지 않아요)'
          : r.message,
      bookingId,
      canRetry: r.code === 'NETWORK' || r.code === 'BUSY',
    });
  }, [params, router]);

  useEffect(() => {
    if (started.current) return; // 개발 모드의 이중 실행 방지 (서버도 멱등이라 두 번 와도 안전하다)
    started.current = true;
    void run();
  }, [run]);

  if (view.kind === 'working') {
    return <p className="notice info" role="status"><span className="spinner" />결제를 확인하고 있어요. 창을 닫지 말아 주세요…</p>;
  }
  return (
    <div className="stack">
      <p className="notice bad" role="alert">{view.message}</p>
      {view.canRetry && (
        <button type="button" className="block" onClick={() => void run()}>다시 확인</button>
      )}
      {view.bookingId && (
        <Link className="btn block" href={`/bookings/${view.bookingId}`}>
          {view.code === 'PAYMENT_DECLINED' ? '다른 결제 수단으로 다시 결제' : '예약 상태 보기'}
        </Link>
      )}
      <Link className="btn secondary block" href="/">처음으로</Link>
    </div>
  );
}
