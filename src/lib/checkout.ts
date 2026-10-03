import type { PaymentInfo } from '@/shared/schemas';

/** 결제 시작 시 주문번호 → 예약 id 를 브라우저에 기억해 둔다 (성공 페이지에서 네트워크 오류가 나도 예약을 찾아갈 수 있게) */
export function rememberOrder(orderId: string, bookingId: string): void {
  try {
    sessionStorage.setItem(`sb:order:${orderId}`, bookingId);
    sessionStorage.setItem('sb:lastBooking', bookingId);
  } catch {
    // 사생활 보호 모드 등에서 저장이 막혀도 결제 흐름은 계속된다
  }
}
export function recallOrder(orderId: string): string | null {
  try {
    return sessionStorage.getItem(`sb:order:${orderId}`);
  } catch {
    return null;
  }
}

/**
 * PG 결제창을 연다. 성공하면 PG 가 /pay/success?paymentKey&orderId&amount 로 브라우저를 되돌려 보낸다.
 * 이 값들은 "신고"일 뿐이다 — 서버가 금액을 다시 대조하고 PG 승인 API 로 확정한다.
 */
export async function startCheckout(args: { payment: PaymentInfo; bookingId: string }): Promise<void> {
  const { payment, bookingId } = args;
  rememberOrder(payment.orderId, bookingId);
  const origin = window.location.origin;

  if (process.env.NEXT_PUBLIC_PAYMENT_MODE === 'toss') {
    const clientKey = process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY;
    if (!clientKey) throw new Error('NEXT_PUBLIC_TOSS_CLIENT_KEY 가 설정되지 않았습니다.');
    const { loadTossPayments, ANONYMOUS } = await import('@tosspayments/tosspayments-sdk');
    const toss = await loadTossPayments(clientKey);
    await toss.payment({ customerKey: ANONYMOUS }).requestPayment({
      method: 'CARD',
      amount: { currency: 'KRW', value: payment.amount },
      orderId: payment.orderId,
      orderName: payment.orderName,
      successUrl: `${origin}/pay/success`,
      failUrl: `${origin}/pay/fail?bookingId=${encodeURIComponent(bookingId)}`,
    });
    return;
  }

  if (process.env.NEXT_PUBLIC_PAYMENT_MODE === 'portone') {
    const storeId = process.env.NEXT_PUBLIC_PORTONE_STORE_ID;
    const channelKey = process.env.NEXT_PUBLIC_PORTONE_CHANNEL_KEY;
    if (!storeId || !channelKey) throw new Error('NEXT_PUBLIC_PORTONE_STORE_ID / NEXT_PUBLIC_PORTONE_CHANNEL_KEY 가 설정되지 않았습니다.');
    const { requestPayment } = await import('@portone/browser-sdk/v2');
    const back = new URLSearchParams({ amount: String(payment.amount), bookingId });
    // forceRedirect: PC(프로미스)와 모바일(리디렉션)의 결과를 /pay/portone 한 곳으로 모은다.
    // 포트원 기본 설정에서는 이 결제창 안에서 결제가 끝까지 완료된다 — 서버는 그 뒤에 조회로 검증한다 (payments/portone.ts).
    const res = await requestPayment({
      storeId,
      channelKey,
      paymentId: payment.orderId,
      orderName: payment.orderName,
      totalAmount: payment.amount,
      currency: 'KRW',
      payMethod: 'CARD',
      redirectUrl: `${origin}/pay/portone?${back.toString()}`,
      forceRedirect: true,
    });
    // 결제를 시작하기 전에 난 오류는 리디렉션되지 않고 여기로 돌아온다
    if (res?.code !== undefined) throw new Error(res.message ?? '결제를 시작하지 못했어요.');
    return;
  }

  const q = new URLSearchParams({
    orderId: payment.orderId,
    amount: String(payment.amount),
    orderName: payment.orderName,
    bookingId,
  });
  window.location.assign(`/pay/fake?${q.toString()}`);
}
