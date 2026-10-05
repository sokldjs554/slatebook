import { cookies } from 'next/headers';
import { z } from 'zod';
import { HostPriceForm } from '@/components/HostPriceForm';
import { formatRange, won } from '@/lib/format';
import { getContext } from '@/server/context';
import { getHostStatement } from '@/server/host/statement';
import { DEMO_COOKIE } from '@/server/http/auth';
import { maskName } from '@/shared/rating';

export const dynamic = 'force-dynamic';

/** 호스트(공급자) 화면 — 내 상품의 가격과, 원장에서 읽은 정산 내역 */
export default async function HostPage() {
  const ctx = getContext();
  // ⚠ 데모 전용 쿠키 인증 (src/server/http/auth.ts). 실서비스에서는 세션 검증으로 바꾼다.
  const uid = ctx.config.demoAuth ? ((await cookies()).get(DEMO_COOKIE)?.value ?? null) : null;
  const statement = uid && z.guid().safeParse(uid).success ? await getHostStatement(ctx.pool, uid) : null;

  if (!statement) {
    return (
      <>
        <h1>호스트 화면</h1>
        <p className="notice info" role="alert">화면 위쪽에서 데모 사용자 중 <strong>호스트(스튜디오 사장님)</strong>를 선택하면 내 상품의 가격과 정산 내역이 보여요.</p>
      </>
    );
  }

  return (
    <>
      <h1>호스트 화면</h1>
      <p className="sub">내 상품의 가격과, 이용이 끝난 예약의 정산 내역이에요. 정산액은 예약 화면의 숫자가 아니라 <strong>원장(복식부기)</strong>에서 읽어요.</p>

      <div className="row" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="muted" style={{ fontSize: 13 }}>지급 예정 (이용 완료, 미지급)</div>
          <div className="price" data-testid="payable">{won(statement.payable)}</div>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 13 }}>이용 전 예수금 (확정된 예약)</div>
          <div className="price" data-testid="escrow">{won(statement.escrow)}</div>
        </div>
        <div className="card">
          <div className="muted" style={{ fontSize: 13 }}>플랫폼 수수료 (누계)</div>
          <div className="price" data-testid="fee-total">{won(statement.feeTotal)}</div>
        </div>
      </div>

      <section className="card stack" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>내 상품 · 가격</h2>
        <div>
          {statement.listings.map((l) => (
            <HostPriceForm key={l.id} listing={{ id: l.id, title: l.title, hourlyPrice: l.hourlyPrice }} />
          ))}
        </div>
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          가격을 바꿔도 <strong>이미 잡힌 예약의 금액은 바뀌지 않아요.</strong> 예약 시점의 단가·수수료율이 예약에 저장돼 있어서(price_snapshot) 손님이 본 가격이 결제·정산까지 그대로 가요.
        </p>
      </section>

      <section className="card">
        <h2 style={{ marginTop: 0 }}>정산 내역 (이용 완료)</h2>
        {statement.rows.length === 0 ? (
          <p className="muted">아직 이용이 끝난 예약이 없어요. 확정된 예약 화면의 &ldquo;데모 전용&rdquo; 버튼으로 이용을 끝내면 여기 나타나요.</p>
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>이용 시간</th>
                <th>상품</th>
                <th>손님</th>
                <th className="num">결제액</th>
                <th className="num">수수료</th>
                <th className="num">정산액</th>
              </tr>
            </thead>
            <tbody>
              {statement.rows.map((r) => (
                <tr key={r.bookingId}>
                  <td>{formatRange(r.start, r.end)}</td>
                  <td>{r.listingTitle}</td>
                  <td>{maskName(r.customerName)}</td>
                  <td className="num">{won(r.gross)}</td>
                  <td className="num">{won(r.fee)}</td>
                  <td className="num"><strong>{won(r.net)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>
          실제 지급(송금)은 이 데모에 없어요. 남의 돈을 보관·이체하는 일은 규제 영역이라 PG 지급대행·펌뱅킹 같은 검증된 외부 서비스에 맡기는 것으로 두었어요 (docs/design.md).
        </p>
      </section>
    </>
  );
}
