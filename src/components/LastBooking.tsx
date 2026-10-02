'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

/** 결제창에서 나갔다가 돌아온 사용자가 진행 중인 예약을 다시 찾을 수 있게 한다 */
export function LastBooking() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    try {
      setId(sessionStorage.getItem('sb:lastBooking'));
    } catch {
      setId(null);
    }
  }, []);
  if (!id) return null;
  return (
    <p className="notice info">
      최근에 진행한 예약이 있어요. <Link href={`/bookings/${id}`}>예약 상태 보기 →</Link>
    </p>
  );
}
