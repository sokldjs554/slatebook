import { Suspense } from 'react';
import { PortOneReturn } from '@/components/PortOneReturn';

export default function PayPortOnePage() {
  return (
    <>
      <h1>결제 확인</h1>
      <Suspense fallback={<p className="muted">불러오는 중…</p>}>
        <PortOneReturn />
      </Suspense>
    </>
  );
}
