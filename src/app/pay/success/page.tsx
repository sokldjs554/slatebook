import { Suspense } from 'react';
import { PaymentSuccess } from '@/components/PaymentSuccess';

export default function PaySuccessPage() {
  return (
    <>
      <h1>결제 확인</h1>
      <Suspense fallback={<p className="muted">불러오는 중…</p>}>
        <PaymentSuccess />
      </Suspense>
    </>
  );
}
