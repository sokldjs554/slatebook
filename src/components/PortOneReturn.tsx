'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * 포트원 결제창이 돌려보내는 페이지: /pay/portone?amount&bookingId&paymentId&txId[&code&message]
 * 포트원의 결과 이름을 이 앱의 공통 결과 페이지(/pay/success · /pay/fail)의 이름으로 옮겨 줄 뿐이다.
 * 여기 담긴 값은 모두 "신고"다 — 서버가 포트원에 다시 조회해 금액·결제키를 대조한다.
 */
export function PortOneReturn() {
  const router = useRouter();
  const params = useSearchParams();

  useEffect(() => {
    const bookingId = params.get('bookingId') ?? '';
    const code = params.get('code');
    if (code) {
      // 결제창에서 실패·취소: 결제가 완료되지 않았으므로 돈은 움직이지 않았다
      const q = new URLSearchParams({ code, message: params.get('message') ?? '', bookingId });
      router.replace(`/pay/fail?${q.toString()}`);
      return;
    }
    const q = new URLSearchParams({
      paymentKey: params.get('txId') ?? '',
      orderId: params.get('paymentId') ?? '',
      amount: params.get('amount') ?? '',
    });
    router.replace(`/pay/success?${q.toString()}`);
  }, [params, router]);

  return <p className="muted">결제 결과를 확인하고 있어요…</p>;
}
