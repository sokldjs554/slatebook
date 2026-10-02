import { Suspense } from 'react';
import { PaymentFail } from '@/components/PaymentFail';

export default function PayFailPage() {
  return (
    <>
      <h1>결제가 완료되지 않았어요</h1>
      <Suspense fallback={<p className="muted">불러오는 중…</p>}>
        <PaymentFail />
      </Suspense>
    </>
  );
}
