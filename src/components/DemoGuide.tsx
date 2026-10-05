/** 로컬·데모 배포에서만 보이는 시나리오 안내 (가짜 PG 모드). 심사자가 무엇을 눌러 보면 되는지 알려 준다. */
export function DemoGuide() {
  if (process.env.NEXT_PUBLIC_PAYMENT_MODE !== 'fake') return null;
  return (
    <details className="card" open>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>🧪 데모 시나리오 — 이렇게 눌러 보세요</summary>
      <ol style={{ paddingLeft: 20, margin: '12px 0 0' }}>
        <li><strong>정상 결제</strong> — 위쪽에서 <em>앨리스</em>를 고르고 A홀 예약 → 가짜 결제창에서 &ldquo;정상 승인&rdquo;.</li>
        <li><strong>중복 예약 방지</strong> — 결제창에서 멈춘 채 <em>밥</em>(다른 브라우저·시크릿 창)으로 같은 시간을 예약하면 &ldquo;먼저 예약했어요&rdquo;가 떠요.</li>
        <li><strong>카드 거절 → 재결제</strong> — &ldquo;승인 단계에서 카드사 거절&rdquo; 후 같은 예약에서 다른 결제 수단으로 다시 결제해요.</li>
        <li><strong>승인 후 응답 유실</strong> — 실패 안내 없이 &ldquo;결제를 확인하고 있어요&rdquo;가 뜨고, 잠시 뒤 서버가 PG 를 확인해 예약이 확정돼요.</li>
        <li><strong>결제창 닫기</strong> — 결제 없이 나가도 예약은 10분간 유지돼요. 홈의 안내 링크로 돌아오면 이어서 결제할 수 있어요.</li>
        <li><strong>이용 완료 → 후기</strong> — 확정된 예약 화면의 &ldquo;데모 전용&rdquo; 버튼으로 이용을 끝낸 뒤 별점과 후기를 남겨요. 상품 목록의 평점이 바로 바뀝니다.</li>
        <li><strong>호스트 정산</strong> — <em>호스트(스튜디오 사장님)</em>를 고르고 위쪽 &ldquo;호스트 화면&rdquo;을 열면 이용이 끝난 예약의 정산 내역이 원장에서 읽혀 나와요. 가격을 바꿔도 이미 잡힌 예약의 금액은 그대로예요.</li>
      </ol>
      <p className="muted" style={{ fontSize: 13, marginBottom: 0 }}>가짜 PG 데모이며 실제 결제는 일어나지 않아요. 구현과 검증 내용은 저장소 README 에 있어요.</p>
    </details>
  );
}
