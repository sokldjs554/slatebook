import { Suspense } from 'react';
import { FakePgCheckout } from '@/components/FakePgCheckout';

export default function FakePgPage() {
  return (
    <Suspense fallback={<p className="muted">불러오는 중…</p>}>
      <FakePgCheckout />
    </Suspense>
  );
}
