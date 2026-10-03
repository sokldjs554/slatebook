# 토스페이먼츠 샌드박스 검증 가이드

토스 어댑터(`src/server/payments/toss.ts`)는 문서화된 요청 형식을 따라 작성했지만, **실제 토스 API 에 대해서는 아직 실행해 보지 못했습니다.**
(개발 환경의 네트워크 정책이 `api.tosspayments.com` 을 막고 있어서 로컬 모의 서버로만 검증했습니다.) 이 문서는 그 빈칸을 직접 메우는 방법입니다.

## 1단계 — 돈이 움직이지 않는 계약 확인 (1분)

개발자센터(developers.tosspayments.com)의 **테스트** 시크릿 키로 실행합니다. `test_` 로 시작하지 않는 키는 스크립트가 거부합니다.

```bash
TOSS_SECRET_KEY=test_sk_... npm run toss:check
```

실제 토스 API 에 아래 6가지를 물어보고, 우리 어댑터의 분류("확정된 실패" vs "알 수 없음")와 같은지 봅니다.

| 확인 | 기대 | 어긋나면 |
|---|---|---|
| 모르는 주문번호 조회 | `null` (404 `NOT_FOUND_PAYMENT`) | 관측된 코드를 `toss.ts` 의 `getByOrderId` 에 추가 |
| 없는 paymentKey 로 승인 | 확정된 실패(4xx) | 5xx 계열이면 분류표 재검토 |
| 같은 `Idempotency-Key` 로 재시도 | 같은 분류·같은 코드 | 헤더 이름·형식 확인 |
| 없는 paymentKey 로 취소 | 확정된 실패(4xx) | 〃 |
| 잘못된 시크릿 키 | 확정된 실패(401 계열) | 〃 |
| 1ms 타임아웃 | 알 수 없음 | (어댑터 버그) |

하나라도 어긋나면 종료 코드 1 이고, **관측한 오류 코드**가 함께 출력됩니다. 그 코드를 보고 `INDETERMINATE_CODES`(결과를 모르는 것으로 봐야 하는 코드)를 고치세요.
이 분류가 가장 중요한 이유: "확정된 실패"로 잘못 분류하면 돈은 빠졌는데 예약이 풀리고, "알 수 없음"으로 잘못 분류하면 결제가 불필요하게 대사로 넘어갑니다.

## 2단계 — 실제 결제창으로 끝까지 (10분, 수동)

```bash
# .env.local
PAYMENT_GATEWAY=toss
NEXT_PUBLIC_PAYMENT_MODE=toss
TOSS_SECRET_KEY=test_sk_...
NEXT_PUBLIC_TOSS_CLIENT_KEY=test_ck_...
WEBHOOK_TOKEN=<24자 이상 임의 문자열>
```

```bash
npm run build && npm start     # 또는 npm run dev
```

웹훅까지 보려면 터널(예: ngrok)로 서버를 열고 개발자센터의 웹훅 URL 에 `https://<터널>/api/webhooks/pg?token=<WEBHOOK_TOKEN>` 을 등록합니다.

아래 체크리스트를 순서대로 하면서 결과를 기록하세요. **기대와 다른 항목이 이 어댑터의 실제 버그입니다.**

| # | 해 볼 것 | 기대 | 결과 |
|---|---|---|---|
| 1 | 테스트 카드로 정상 결제 | 예약 `CONFIRMED`, `payments.status=APPROVED`, 원장 2줄, `payments.raw` 에 토스 응답 | |
| 2 | 결제창에서 닫기/취소 | `/pay/fail?code=PAY_PROCESS_CANCELED`, 예약은 `PENDING_PAYMENT` 유지 | |
| 3 | 취소 후 **같은 주문번호로** 다시 결제창 열기 (예약 페이지의 "결제하기") | 열린다 / 안 열린다 → **안 열리면 `createRetryPayment` 가 새 주문번호를 발급하도록 바꿔야 한다** | |
| 4 | 성공 URL 의 `amount` 를 브라우저에서 바꿔서 접속 | `400 AMOUNT_MISMATCH`, 토스 승인 API 호출 없음 | |
| 5 | 성공 URL 을 새로고침 | 같은 결과(멱등), 토스 승인 API 는 1번만 호출 | |
| 6 | 웹훅 수신 | `pg_webhook_inbox` 에 행이 생기고 `processed_at` 이 채워진다. **본문 모양이 `{eventType, createdAt, data:{orderId,...}}` 와 같은지** 확인 | |
| 7 | 같은 웹훅 재전송(개발자센터의 재발송) | `duplicate` 로 처리, 상태 변화 없음 | |
| 8 | 승인 직후 서버를 죽이고(승인 호출 중 `kill -9`) 재기동 | 결제는 `CONFIRMING`/`UNKNOWN` 으로 남고, 워커·상태 조회가 토스 조회로 확정 | |
| 9 | 결제 후 토스 대시보드에서 취소 | 웹훅 → `payment.anomaly(CANCELED_AT_PG)` outbox 알림, 예약 상태는 그대로 | |

특히 **3번과 6번**은 문서만으로 확신하지 못한 부분입니다 — 3번은 토스가 실패한 `orderId` 의 재사용을 허용하는지, 6번은 웹훅 본문의 실제 모양입니다.
