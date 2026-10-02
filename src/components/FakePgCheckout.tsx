'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { won } from '@/lib/format';

type Outcome = 'success' | 'decline_on_confirm' | 'timeout_after_capture';

/**
 * 로컬 데모용 가짜 PG 결제창 (PAYMENT_GATEWAY=fake). 실제 PG 결제창이 하는 일 — 카드 인증 후 성공 URL 로 되돌려 보내기 —
 * 을 흉내 내고, 이어질 서버의 승인 호출이 어떻게 끝날지 시나리오를 고를 수 있게 한다.
 */
export function FakePgCheckout() {
  const router = useRouter();
  const params = useSearchParams();
  const orderId = params.get('orderId');
  const amount = params.get('amount');
  const orderName = params.get('orderName');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (process.env.NEXT_PUBLIC_PAYMENT_MODE !== 'fake') {
    return <p className="notice bad">가짜 결제창은 PAYMENT_GATEWAY=fake 일 때만 사용할 수 있어요.</p>;
  }
  if (!orderId || !amount) return <p className="notice bad">주문 정보가 없어요.</p>;

  async function pay(outcome: Outcome) {
    setBusy(true);
    setError(null);
    const r = await api<{ paymentKey: string; amount: number }>('/api/fake-pg/authorize', { method: 'POST', body: { orderId, outcome } });
    if (!r.ok) {
      setError(r.message);
      setBusy(false);
      return;
    }
    const q = new URLSearchParams({ paymentKey: r.data.paymentKey, orderId: orderId!, amount: String(r.data.amount) });
    window.location.assign(`/pay/success?${q.toString()}`); // 실제 PG 도 이 URL 로 브라우저를 돌려보낸다
  }

  return (
    <div className="pg stack">
      <div className="banner">⚠ 가짜 PG 결제창 (데모) — 실제 결제는 일어나지 않아요</div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{orderName}</h2>
        <div className="kv"><span>결제 금액</span><span className="price">{won(Number(amount))}</span></div>
        <div className="kv"><span>주문번호</span><span className="muted" style={{ fontSize: 12 }}>{orderId}</span></div>
      </div>

      {error && <p className="notice bad" role="alert">{error}</p>}

      <button type="button" className="block" disabled={busy} onClick={() => pay('success')}>카드로 결제하기 (정상 승인)</button>
      <button type="button" className="block secondary" disabled={busy} onClick={() => pay('decline_on_confirm')}>승인 단계에서 카드사 거절</button>
      <button type="button" className="block secondary" disabled={busy} onClick={() => pay('timeout_after_capture')}>승인은 됐는데 응답이 유실됨 (타임아웃)</button>
      <button type="button" className="block danger" disabled={busy} onClick={() => router.push('/')}>
        결제창 닫기 (브라우저 종료 시뮬레이션)
      </button>
      <p className="muted" style={{ fontSize: 13 }}>
        마지막 버튼은 결제 없이 나가는 상황이에요. 예약은 10분간 유지되다가 자동으로 풀리고, 홈의 안내 링크로 돌아와 이어서 결제할 수도 있어요.
      </p>
    </div>
  );
}
