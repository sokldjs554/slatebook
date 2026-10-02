import Link from 'next/link';
import { LastBooking } from '@/components/LastBooking';
import { getContext } from '@/server/context';
import { won } from '@/lib/format';

// 항상 요청 시점의 DB 를 읽는다 (빌드 시점에 미리 렌더링하지 않는다)
export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  title: string;
  kind: 'STUDIO' | 'EQUIPMENT';
  hourly_price: string;
  units: number;
}

export default async function Home() {
  const { rows } = await getContext().pool.query<Row>(
    `SELECT l.id, l.title, l.kind, l.hourly_price, count(r.id)::int AS units
       FROM listings l LEFT JOIN resources r ON r.listing_id = l.id AND r.active
      WHERE l.status = 'ACTIVE' GROUP BY l.id ORDER BY l.created_at, l.title`,
  );
  return (
    <>
      <h1>스튜디오 · 장비 예약</h1>
      <p className="sub">시간 단위로 예약하고, 결제가 끝나면 바로 확정돼요.</p>
      <LastBooking />
      <div className="grid">
        {rows.map((l) => (
          <div key={l.id} className="card listing">
            <div>
              <div><span className="badge">{l.kind === 'STUDIO' ? '스튜디오' : `장비 ${l.units}대`}</span><strong>{l.title}</strong></div>
              <div className="muted">시간당 {won(Number(l.hourly_price))}</div>
            </div>
            <Link className="btn" href={`/listings/${l.id}`}>예약하기</Link>
          </div>
        ))}
        {rows.length === 0 && <p className="notice info">등록된 상품이 없어요. <code>npm run db:seed</code> 로 데모 데이터를 넣어 주세요.</p>}
      </div>
    </>
  );
}
