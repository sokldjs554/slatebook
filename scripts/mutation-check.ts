/**
 * 손으로 하는 미니 변이 테스트.
 * 핵심 로직에 "그럴듯하지만 틀린" 변경(변이)을 하나씩 넣고 테스트를 돌려서, 테스트가 정말 실패하는지 확인한다.
 * 어떤 변이가 살아남으면(테스트가 그대로 통과하면) 그 줄은 테스트가 지켜 주지 못하고 있다는 뜻이다.
 *
 *   TEST_DATABASE_URL=... npm run mutation-check              # 전부
 *   TEST_DATABASE_URL=... npm run mutation-check -- <id> ...  # 지정한 변이만
 *
 * 소스는 실행 전후로 반드시 원래대로 복구한다. 작업 트리가 깨끗한지(git status) 먼저 확인하고 실행할 것.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface Mutant {
  id: string;
  why: string;
  file: string;
  from: string;
  to: string;
  /** 같은 파일에서 함께 바꿔야 하는 곳 (예: import 문) */
  also?: Array<[from: string, to: string]>;
}

const MUTANTS: Mutant[] = [
  {
    id: 'no-resource-lock',
    why: '자원 행 잠금을 없앤다 → 조회와 쓰기 사이 틈이 생겨 동시 예약이 제약·데드락에 의존하게 된다',
    file: 'src/server/bookings/create.ts',
    from: 'ORDER BY id FOR NO KEY UPDATE',
    to: 'ORDER BY id',
  },
  {
    id: 'no-free-resource-check',
    why: '빈 자원 선택에서 겹침 조건을 뺀다 → 장비 수량을 넘겨 팔고, 잠금은 있어도 DB 제약에만 기대게 된다',
    file: 'src/server/bookings/create.ts',
    from: "AND NOT EXISTS (SELECT 1 FROM booking_slots s\n                         WHERE s.resource_id = r.id AND s.state <> 'RELEASED' AND s.blocked && $2::tstzrange)",
    to: '',
  },
  {
    id: 'no-lazy-expiry',
    why: '예약 시 만료된 홀드를 풀어주지 않는다 → 워커가 늦으면 빈 자리가 영원히 막힌다',
    file: 'src/server/bookings/create.ts',
    from: 'await expireDueHolds(tx, { resourceIds, blocked }, { verifyBeforeRelease: ctx.gateway.capturesBeforeServerConfirm });',
    to: '',
  },
  {
    id: 'expire-confirming',
    why: '결제 확정 중인 예약도 홀드가 지나면 만료시킨다 → 돈은 받았는데 자리를 남에게 준다',
    file: 'src/server/bookings/expire.ts',
    from: "WHERE b.status = 'PENDING_PAYMENT' AND b.hold_expires_at <= clock_timestamp()\n              AND EXISTS",
    to: "WHERE b.status IN ('PENDING_PAYMENT','PAYMENT_CONFIRMING') AND b.hold_expires_at <= clock_timestamp()\n              AND EXISTS",
  },
  {
    id: 'trust-client-amount',
    why: '브라우저가 보낸 금액을 검사하지 않는다 → 금액 위변조 시도가 PG 까지 간다',
    file: 'src/server/payments/confirm.ts',
    from: 'if (input.amount !== amount) {',
    to: 'if (false) {',
  },
  {
    id: 'no-ownership-check',
    why: '결제 확정에서 주문 소유자를 확인하지 않는다 → 남의 주문을 확정할 수 있다',
    file: 'src/server/payments/confirm.ts',
    from: 'locked.booking.consumer_id !== userId',
    to: 'false',
  },
  {
    id: 'timeout-is-failure',
    why: 'PG 호출의 타임아웃을 "실패"로 처리한다 → 돈은 빠졌는데 예약은 풀려 버린다',
    file: 'src/server/payments/confirm.ts',
    from: 'if (isGatewayDeclined(err)) {\n      // 돈이',
    to: "if (true) {\n      if (!isGatewayDeclined(err)) err = new GatewayDeclinedError('TIMEOUT', 'timeout');\n      // 돈이",
    also: [["import { isGatewayDeclined, type GatewayPayment } from './gateway';", "import { GatewayDeclinedError, isGatewayDeclined, type GatewayPayment } from './gateway';"]],
  },
  {
    id: 'skip-pg-amount-verification',
    why: 'PG 가 보고한 금액을 우리 금액과 대조하지 않는다 → 다른 금액의 승인으로 예약이 확정된다',
    file: 'src/server/payments/apply.ts',
    from: 'view.orderId !== payment.order_id || view.totalAmount !== amount ||',
    to: 'view.orderId !== payment.order_id ||',
  },
  {
    id: 'confirm-late-capture',
    why: '승인 시점에 예약이 아직 결제를 받을 수 있는 상태인지 보지 않는다 → 남의 자리를 확정하거나 만료된 예약이 되살아난다',
    file: 'src/server/payments/apply.ts',
    from: "live && (booking.status === 'PAYMENT_CONFIRMING' || (booking.status === 'PENDING_PAYMENT' && booking.hold_active));",
    to: 'true;',
  },
  {
    id: 'ledger-not-idempotent',
    why: '결제 승인 분개의 멱등키에 난수를 섞는다 → 웹훅·재시도마다 원장이 중복 기록된다',
    file: 'src/server/ledger/ledger.ts',
    from: 'idempotencyKey: `payment-approved:${p.paymentId}`',
    to: 'idempotencyKey: `payment-approved:${p.paymentId}:${Math.random()}`',
  },
  {
    id: 'reconcile-without-age-gate',
    why: '진행 중일 수 있는 승인 호출과 겹쳐서 대사한다 → 같은 결제를 PG 에 이중으로 승인 요청할 수 있다',
    file: 'src/server/payments/reconcile.ts',
    from: "OR (status = 'CONFIRMING'\n               AND COALESCE(confirm_started_at, created_at) < clock_timestamp() - make_interval(secs => $3::float8))",
    to: "OR (status = 'CONFIRMING' AND $3::float8 >= 0)",
  },
  {
    id: 'decline-always-expires',
    why: '카드 거절 시 홀드가 남아 있어도 예약을 만료시킨다 → 다른 카드로 재시도할 기회를 잃는다',
    file: 'src/server/payments/fail.ts',
    from: 'if (back.rowCount === 0) await',
    to: 'if (true) await',
  },
  {
    id: 'webhook-no-dedupe',
    why: '웹훅 수신함의 중복 판정을 없앤다 → 같은 이벤트를 매번 처리한다 (결과는 멱등이어야 하지만 duplicate 응답이 사라진다)',
    file: 'src/server/payments/webhook.ts',
    from: "if (prior.rows[0]?.processed_at) return 'duplicate';",
    to: '',
  },
  {
    id: 'quote-floor',
    why: '금액 반올림을 올림에서 내림으로 바꾼다 → 원 단위 금액이 1원씩 어긋난다',
    file: 'src/shared/quote.ts',
    from: 'Math.floor((hourlyPrice * minutes + 30) / 60)',
    to: 'Math.floor((hourlyPrice * minutes) / 60)',
  },
  {
    id: 'lead-time-29',
    why: '최소 사전 예약 시간을 30분에서 29분으로 바꾼다 (경계값 오류)',
    file: 'src/shared/time.ts',
    from: 'export const MIN_LEAD_MINUTES = 30;',
    to: 'export const MIN_LEAD_MINUTES = 29;',
  },
  {
    id: 'instanceof-gateway-errors',
    why: 'PG 오류를 instanceof 로 판별한다 → 번들마다 클래스 복사본이 다른 Next.js 에서 "카드 거절"이 "알 수 없음"으로 둔갑한다',
    file: 'src/server/payments/confirm.ts',
    from: 'if (isGatewayDeclined(err)) {\n      // 돈이',
    to: 'if (err instanceof GatewayDeclinedError) {\n      // 돈이',
    also: [["import { isGatewayDeclined, type GatewayPayment } from './gateway';", "import { GatewayDeclinedError, type GatewayPayment } from './gateway';"]],
  },
  {
    id: 'revive-failed-payment',
    why: '이미 실패 처리한 결제에 뒤늦게 승인이 보고되면 되살려 확정하려 한다 → 상태 전이 규칙에 막혀 웹훅이 예외로 무한 재시도된다',
    file: 'src/server/payments/apply.ts',
    from: "live && (booking.status === 'PAYMENT_CONFIRMING' || (booking.status === 'PENDING_PAYMENT' && booking.hold_active));",
    to: "(booking.status === 'PAYMENT_CONFIRMING' || (booking.status === 'PENDING_PAYMENT' && booking.hold_active));",
  },
  {
    id: 'ignore-key-mismatch',
    why: 'PG 가 보고한 결제키가 우리 기록과 달라도 그대로 확정한다',
    file: 'src/server/payments/apply.ts',
    from: 'if (payment.payment_key !== null && payment.payment_key !== view.paymentKey) {',
    to: 'if (false) {',
  },
  {
    id: 'review-not-completed-ok',
    why: '이용이 끝나지 않은 예약에도 후기를 쓸 수 있게 한다 → 이용하지 않은 사람의 후기가 평점에 섞인다',
    file: 'src/server/reviews/create.ts',
    from: "if (booking.status !== 'COMPLETED') throw new ReviewNotAllowedError();",
    to: '',
  },
  {
    id: 'review-window-ignored',
    why: '후기 작성 기간(30일) 검사를 뺀다',
    file: 'src/server/reviews/create.ts',
    from: 'if (!booking.review_open) throw new ReviewWindowClosedError();',
    to: '',
  },
  {
    id: 'review-owner-ignored',
    why: '후기 작성에서 예약 소유자를 확인하지 않는다 → 남의 예약에 후기를 쓸 수 있다',
    file: 'src/server/reviews/create.ts',
    from: 'booking.consumer_id !== userId',
    to: 'false',
  },
  {
    id: 'review-aggregate-not-updated',
    why: '후기를 저장하고 상품 평점 집계를 갱신하지 않는다 → 목록의 평점이 후기와 어긋난다',
    file: 'src/server/reviews/create.ts',
    from: 'UPDATE listings SET rating_count = rating_count + 1, rating_sum = rating_sum + $2 WHERE id = $1',
    to: 'UPDATE listings SET rating_count = rating_count + 0, rating_sum = rating_sum + 0 WHERE id = $1 AND $2::int > 0',
  },
  {
    id: 'moderation-aggregate-not-adjusted',
    why: '후기를 숨겨도 평점 집계를 보정하지 않는다',
    file: 'src/server/reviews/moderate.ts',
    from: 'rating_count = rating_count + $2, rating_sum = rating_sum + $3',
    to: 'rating_count = rating_count + 0 * $2, rating_sum = rating_sum + 0 * $3',
  },
  {
    id: 'cursor-loses-microseconds',
    why: '커서의 시각을 밀리초로 잘라 보낸다 → 마이크로초만 다른 후기가 페이지 경계에서 빠지거나 겹친다',
    file: 'src/server/reviews/list.ts',
    from: "r.created_at::text AS cursor_ts",
    to: "to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS cursor_ts",
  },
  {
    id: 'cursor-without-id-tiebreak',
    why: '커서 비교에서 id 동순위 처리를 뺀다 → 같은 시각의 후기가 페이지 경계에서 빠진다',
    file: 'src/server/reviews/list.ts',
    from: '(r.created_at, r.id) < ($2::timestamptz, $3::uuid)',
    to: '(r.created_at < $2::timestamptz OR ($3::uuid IS NULL))',
  },
  {
    id: 'portone-release-without-verify',
    why: '포트원에서도 홀드가 지나면 확인 없이 슬롯을 푼다 → 결제를 마치고 창을 닫은 고객의 돈은 빠졌는데 예약은 사라진다',
    file: 'src/server/payments/portone.ts',
    from: 'readonly capturesBeforeServerConfirm = true;',
    to: 'readonly capturesBeforeServerConfirm = false;',
  },
  {
    id: 'reconcile-ignores-ready',
    why: 'PG 가 "아직 결제 전"이라고 해도 대사가 결론을 내지 않는다 → 위조된 성공 신고 하나로 슬롯을 영원히 붙잡을 수 있다',
    file: 'src/server/payments/reconcile.ts',
    from: "if (view.status === 'READY') {",
    to: "if (view.status === 'READY' && false) {",
  },
  {
    id: 'portone-cancel-by-payment-key',
    why: '포트원 취소를 결제키(transactionId)로 요청한다 → 토스식 식별자를 그대로 써서 환불이 엉뚱한 경로로 간다',
    file: 'src/server/payments/portone.ts',
    from: '`/payments/${encodeURIComponent(req.orderId)}/cancel`',
    to: '`/payments/${encodeURIComponent(req.paymentKey)}/cancel`',
  },
  {
    id: 'portone-ready-is-paid',
    why: '포트원의 READY(결제창만 열림)를 결제 완료로 해석한다 → 돈을 받지 않고 예약을 확정한다',
    file: 'src/server/payments/portone.ts',
    from: "    case 'READY':\n      return 'READY';",
    to: "    case 'READY':\n      return 'DONE';",
  },
  {
    id: 'statement-ignores-owner',
    why: '호스트 정산 내역에서 소유자 조건을 뺀다 → 다른 호스트의 예약·정산액이 보인다',
    file: 'src/server/host/statement.ts',
    from: "AND l.host_id = $1\n      GROUP BY",
    to: "AND $1::uuid IS NOT NULL\n      GROUP BY",
  },
  {
    id: 'price-update-no-ownership',
    why: '가격 변경에서 상품 소유자를 확인하지 않는다 → 남의 상품 가격을 바꿀 수 있다',
    file: 'src/server/host/pricing.ts',
    from: 'WHERE id = $2 AND host_id = $3',
    to: 'WHERE id = $2 AND $3::uuid IS NOT NULL',
  },
  {
    id: 'no-buffer-in-slot',
    why: '슬롯에 정리 버퍼를 포함하지 않는다 → 다음 손님이 정리 시간 없이 들어온다',
    file: 'src/server/bookings/create.ts',
    from: "$2::timestamptz + make_interval(mins => $3::int), '[)')::text AS r`",
    to: "$2::timestamptz, '[)')::text AS r`",
  },
];

function runTests(): { failed: number; passed: number; ok: boolean } {
  const outFile = path.join(os.tmpdir(), `slatebook-mutation-${process.pid}.json`);
  rmSync(outFile, { force: true });
  spawnSync('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${outFile}`], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const json = JSON.parse(readFileSync(outFile, 'utf8'));
    return { failed: json.numFailedTests, passed: json.numPassedTests, ok: json.success === true };
  } catch {
    return { failed: -1, passed: 0, ok: false }; // 테스트가 아예 돌지 못함(문법 오류 등)도 "죽은" 것으로 본다
  }
}

const baseline = runTests();
if (!baseline.ok) {
  console.error(`기준선 테스트가 통과하지 않는다 (${baseline.failed} 실패). 먼저 고치고 다시 실행하세요.`);
  process.exit(1);
}
console.log(`기준선: ${baseline.passed}개 통과\n`);

const only = process.argv.slice(2);
const selected = only.length ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
let survived = 0;
for (const m of selected) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    console.log(`?? ${m.id}: 변이 대상 코드를 찾지 못했다 (코드가 바뀌었다면 변이를 갱신하세요)`);
    survived += 1;
    continue;
  }
  let mutated = original.replace(m.from, m.to);
  for (const [a, b] of m.also ?? []) mutated = mutated.replace(a, b);
  writeFileSync(m.file, mutated);
  let result;
  try {
    result = runTests();
  } finally {
    writeFileSync(m.file, original);
  }
  const killed = !result.ok;
  if (!killed) survived += 1;
  console.log(`${killed ? '죽음   ' : '살아남음'} ${m.id}  (${result.failed < 0 ? '실행 불가' : `${result.failed}개 테스트 실패`})  — ${m.why}`);
}
console.log(`\n변이 ${selected.length}개 중 ${selected.length - survived}개를 테스트가 잡아냈다. 살아남은 변이: ${survived}`);
process.exit(survived === 0 ? 0 : 1);
