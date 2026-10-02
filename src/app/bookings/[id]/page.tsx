import { notFound } from 'next/navigation';
import { z } from 'zod';
import { BookingStatus } from '@/components/BookingStatus';

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  return (
    <>
      <h1>예약 상태</h1>
      <p className="sub">결제 결과는 여기서 확인할 수 있어요.</p>
      <BookingStatus bookingId={id} />
    </>
  );
}
