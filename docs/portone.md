# 포트원(PortOne) V2 어댑터

`PAYMENT_GATEWAY=portone` 으로 켜는 두 번째 PG 어댑터입니다 (`src/server/payments/portone.ts`).
**실제 포트원 API 에 대해서는 아직 실행해 보지 못했습니다.** 개발 환경에서 포트원 API 에 접근할 수 없어서,
요청·응답 형태를 **공식 SDK 의 타입 정의**(`@portone/server-sdk` 0.19.0, `@portone/browser-sdk` 0.1.13)와 대조해 맞추고,
그 형태를 흉내 낸 로컬 서버로 검증했습니다. 키를 받으면 아래 "검증 절차"부터 해 주세요.

## 토스와 무엇이 다른가 — 누가 승인하는가

| | 토스페이먼츠 | 포트원 V2 (기본 설정) |
|---|---|---|
| 돈이 움직이는 시점 | 서버가 승인 API(`/confirm`)를 부를 때 | **결제창 안에서** (서버가 알기 전) |
| 서버의 `confirm` | 승인 요청 — 금액을 서버가 지정 | **조회로 하는 검증** (`GET /payments/{paymentId}`) |
| 금액이 다르면 | PG 가 승인 자체를 거절 | 이미 결제됐으므로 **확정하지 않고 자동 환불** |
| 취소 식별자 | `paymentKey` | `paymentId` (= 우리 주문번호) |
| 취소 멱등성 | `Idempotency-Key` 헤더 | 멱등키 없음 → "이미 취소됨"(409)을 조회로 확인해 성공으로 처리 |
| 웹훅 본문 | `data.orderId` | `data.paymentId` + Standard Webhooks 서명 |

포트원에는 서버가 금액을 지정해 승인하는 **"수동 승인"** 방식(`POST /payments/{paymentId}/confirm`, 결제 토큰 사용)도 있습니다.
채널 설정이 필요하고 PG 마다 지원 여부가 달라서 이번에는 기본(자동 승인) 흐름만 구현했습니다. 금액 위변조를 "결제 전에" 막고 싶다면 이쪽을 검토하세요.

## 어댑터만으로는 끝나지 않았다 — 공통 코드에서 바꾼 것

"PG 를 바꾸면 어댑터 하나만 고치면 된다"고 설계했지만, 포트원을 붙여 보니 **"서버가 승인하기 전에는 돈이 움직이지 않는다"는 토스의 성질에 기대던 곳**이 세 군데 있었습니다.

1. **홀드 만료 = 돈이 안 움직였다?** — 토스에서는 맞지만 포트원에서는 아닙니다. 결제를 마치고 서버에 알리기 전에 브라우저를 닫고 웹훅까지 유실되면,
   기존 코드는 홀드가 지나 예약을 만료시키고 **돈은 빠졌는데 예약도 환불도 없는** 상태를 남겼을 것입니다.
   → PG 에 `capturesBeforeServerConfirm` 성질을 두고, 이 값이 참이면 대기 중인 결제가 있는 예약을 바로 풀지 않고 **슬롯을 쥔 채 확인 단계로 넘깁니다**
   (`src/server/bookings/expire.ts`). 대사가 포트원에 물어 결제됐으면 확정하고, 아니면 그때 풉니다.
2. **"아직 결제 전(READY)" 응답을 대사가 처리하지 않았다** — 결제하지 않고 성공 페이지만 호출하면 예약이 "결제 확인 중"으로 슬롯을 **영원히** 붙잡을 수 있었습니다.
   → 조회 지연 유예(60초) 뒤에는 실패로 정리합니다 (`reconcile.ts`). 그 뒤에 결제가 완료되면 웹훅·대사가 `LATE_CAPTURE` 로 자동 환불합니다. 토스 경로에도 같이 적용됩니다.
3. **취소 식별자** — 취소 요청(`CancelRequest`)에 주문번호를 추가했습니다.

이 세 가지는 각각 변이 검사에 들어가 있습니다 (`portone-release-without-verify`, `reconcile-ignores-ready`, `portone-cancel-by-payment-key`, `portone-ready-is-paid`).

## 검증한 것 / 하지 못한 것

| | 상태 |
|---|---|
| 요청 형식·상태 대응표·오류 분류 (모의 서버) | `tests/portone-gateway.test.ts` |
| 결제 흐름 전체 (실제 PostgreSQL + 모의 포트원): 정상 · 결제창 금액 변조 → 자동 환불 · 결제 후 브라우저 종료 + 웹훅 유실 → 확정 · 결제창 미진입 → 해제 · 성공 신고 위조 → 유예 뒤 정리 · 늦은 결제 → 환불 · 웹훅만으로 확정 | `tests/portone-flow.test.ts` |
| 웹훅 서명 검증 (공식 SDK `verify`, 본문 변조·헤더 누락·오래된 요청 거부) | `tests/portone-flow.test.ts` |
| 포트원 모드 프로덕션 빌드 (결제창 SDK 가 별도 청크로 분리) | 빌드 확인 |
| **실제 포트원 API** | ❌ 미실행 → 아래 1단계 |
| **실제 결제창(브라우저 SDK)** — 특히 `forceRedirect` 로 돌아올 때 `redirectUrl` 에 붙여 둔 `amount`·`bookingId` 쿼리가 유지되는지 | ❌ 미확인 → 아래 2단계 |
| 부분 취소 | 지원하지 않음 (멱등키 없이 재시도하면 두 번 취소될 수 있어서) |
| 남은 위험: "결제 전"으로 확인해 실패 처리한 **뒤에** 결제가 완료되고 웹훅도 모두 유실되는 경우 | 웹훅 재전송에 기댐. 근본 대책은 포트원 결제 목록 조회로 하는 일일 대사 (미구현) |

## 검증 절차

### 1단계 — 돈이 움직이지 않는 계약 확인 (1분)

```bash
PORTONE_API_SECRET=... npm run portone:check
```

존재하지 않는 결제의 조회·검증·취소, 잘못된 시크릿, 1ms 타임아웃에 포트원이 어떻게 답하는지 관측해 어댑터의 분류와 비교합니다.
요청은 모두 존재하지 않는 결제를 대상으로 하므로 돈은 움직이지 않습니다. 어긋나면 관측한 오류 종류가 출력되니 `portone.ts` 의 분류를 그에 맞게 고칩니다.

### 2단계 — 테스트 채널로 결제창까지 (수동, 15분)

`.env.local` 에 `PAYMENT_GATEWAY=portone`, `NEXT_PUBLIC_PAYMENT_MODE=portone`, `PORTONE_API_SECRET`, `PORTONE_WEBHOOK_SECRET`,
`NEXT_PUBLIC_PORTONE_STORE_ID`, `NEXT_PUBLIC_PORTONE_CHANNEL_KEY`(테스트 채널), `WEBHOOK_TOKEN` 을 넣고, 콘솔의 웹훅 URL 을
`https://<호스트>/api/webhooks/pg?token=<WEBHOOK_TOKEN>` 으로 설정합니다 (로컬이면 터널 필요).

- [ ] 정상 결제 → 예약 `CONFIRMED`, 결제의 `payment_key` 가 포트원 콘솔의 거래 ID 와 같다
- [ ] 결제창에서 돌아온 URL 에 `amount`·`bookingId`·`paymentId`·`txId` 가 모두 있다 (없으면 `src/lib/checkout.ts` 의 복귀 방식 수정)
- [ ] 결제창에서 취소 → 실패 화면, 예약은 홀드 동안 유지
- [ ] 결제 완료 직후 탭을 닫음 → 웹훅으로 예약 확정 (서버 로그에 `webhook` 처리)
- [ ] 웹훅을 끄고 같은 실험 → 홀드가 지난 뒤 대사로 확정 (슬롯이 풀리지 않는지)
- [ ] 콘솔에서 결제 취소 → 운영 알림(`payment.anomaly` · `CANCELED_AT_PG`)
- [ ] 웹훅 서명 시크릿을 틀리게 설정 → 웹훅이 `401` 로 거부된다
- [ ] 웹훅 본문의 실제 모양이 `{ type, timestamp, data: { paymentId, storeId, transactionId } }` 인지
