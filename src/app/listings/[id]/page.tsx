import { notFound } from 'next/navigation';
import { z } from 'zod';
import { BookingForm } from '@/components/BookingForm';
import { getContext } from '@/server/context';

export const dynamic = 'force-dynamic';

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const { rows } = await getContext().pool.query<{ id: string; title: string; kind: 'STUDIO' | 'EQUIPMENT'; hourly_price: string }>(
    `SELECT id, title, kind, hourly_price FROM listings WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
  const l = rows[0];
  if (!l) notFound();
  return (
    <>
      <h1>{l.title}</h1>
      <p className="sub">{l.kind === 'STUDIO' ? '촬영 스튜디오' : '촬영 장비'} · 날짜와 시간을 고르면 예약 가능 여부를 바로 보여줘요.</p>
      <BookingForm listing={{ id: l.id, title: l.title, kind: l.kind, hourlyPrice: Number(l.hourly_price) }} />
    </>
  );
}
