'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

/** PG 결제창에서 결제를 마치지 못하고 돌아온 경우 (사용자가 창을 닫거나 카드 인증 실패 등) */
export function PaymentFail() {
  const params = useSearchParams();
  const code = params.get('code');
  const bookingId = params.get('bookingId');
  const canceled = code === 'PAY_PROCESS_CANCELED' || code === 'USER_CANCEL';
  return (
    <div className="stack">
      {canceled ? (
        <p className="notice info" role="status">결제를 취소했어요. 예약은 결제 대기 상태로 잠시 남아 있어서, 시간 안에 다시 결제할 수 있어요.</p>
      ) : (
        <p className="notice bad" role="alert">결제를 완료하지 못했어요{params.get('message') ? `: ${params.get('message')}` : '.'} (돈은 빠져나가지 않았어요)</p>
      )}
      {bookingId && <Link className="btn block" href={`/bookings/${encodeURIComponent(bookingId)}`}>예약으로 돌아가기</Link>}
      <Link className="btn secondary block" href="/">처음으로</Link>
    </div>
  );
}
