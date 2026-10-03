import { observe, describeOutcome, type ContractResult, type Outcome } from './contract';
import { TossGateway } from './toss';

export type { ContractResult } from './contract';

/**
 * 토스 API 계약 확인 — 돈이 움직이지 않는 호출만 사용한다.
 *   "PG 가 이 요청에 어떻게 답하는가"를 실제로 관측해서, 우리 어댑터의 분류("확정된 실패" vs "알 수 없음")가 맞는지 본다.
 * 카드 승인 성공 경로는 결제창에서 사람이 카드 인증을 해야 하므로 여기서 다루지 않는다 (docs/toss-sandbox.md 의 수동 체크리스트).
 */
export async function runTossContractChecks(
  gateway: TossGateway,
  opts: { makeGateway: (secretKey: string, timeoutMs?: number) => TossGateway; /** 호출당 타임아웃 (기본 15초) */ timeoutMs?: number },
): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  const t = opts.timeoutMs ?? 15_000;
  const check = (name: string, expected: string, o: Outcome, ok: boolean) => results.push({ name, expected, observed: describeOutcome(o), ok });
  const rnd = Math.random().toString(36).slice(2, 10);

  // 1. 모르는 주문 조회 → null (PG 가 "그런 주문 없음"이라고 답한다)
  const lookup = await observe(() => gateway.getByOrderId(`sb_contract_${rnd}`, { timeoutMs: t }));
  check('주문 조회: 모르는 주문번호', '값 null (404 NOT_FOUND_PAYMENT 를 null 로 해석)', lookup, lookup.kind === 'value' && lookup.value === null);

  // 2. 존재하지 않는 결제키로 승인 → "확정된 실패" 여야 한다 (돈이 움직이지 않았다고 PG 가 확정해 줌)
  const confirm = await observe(() => gateway.confirm({ paymentKey: `pk_contract_${rnd}`, orderId: `sb_contract_${rnd}`, amount: 1000, idempotencyKey: `contract:${rnd}` }, { timeoutMs: t }));
  check('승인: 존재하지 않는 paymentKey', '확정된 실패 (4xx)', confirm, confirm.kind === 'declined');

  // 3. 같은 멱등키로 같은 요청을 다시 보내도 같은 분류여야 한다
  const confirmAgain = await observe(() => gateway.confirm({ paymentKey: `pk_contract_${rnd}`, orderId: `sb_contract_${rnd}`, amount: 1000, idempotencyKey: `contract:${rnd}` }, { timeoutMs: t }));
  check('승인: 같은 Idempotency-Key 재시도', '같은 분류·같은 코드', confirmAgain, confirm.kind === 'declined' && confirmAgain.kind === 'declined' && confirm.code === confirmAgain.code);

  // 4. 존재하지 않는 결제키 취소 → 확정된 실패
  const cancel = await observe(() => gateway.cancel({ paymentKey: `pk_contract_${rnd}`, orderId: `sb_contract_${rnd}`, reason: '계약 확인', idempotencyKey: `contract-cancel:${rnd}` }, { timeoutMs: t }));
  check('취소: 존재하지 않는 paymentKey', '확정된 실패 (4xx)', cancel, cancel.kind === 'declined');

  // 5. 틀린 비밀키 → 인증 실패는 "확정된 실패"로 분류된다 (결제 시도 자체가 처리되지 않았다)
  const wrongKey = await observe(() => opts.makeGateway(`test_sk_invalid_${rnd}`).getByOrderId(`sb_contract_${rnd}`, { timeoutMs: t }));
  check('인증: 잘못된 비밀키', '확정된 실패 (401 계열)', wrongKey, wrongKey.kind === 'declined');

  // 6. 아주 짧은 타임아웃 → 요청이 닿았는지 알 수 없으므로 "알 수 없음"이어야 한다 (절대 실패로 단정하면 안 된다)
  const tiny = await observe(() => opts.makeGateway('test_sk_any', 1).confirm({ paymentKey: 'k', orderId: 'sb_x_000000', amount: 1, idempotencyKey: `contract-timeout:${rnd}` }, { timeoutMs: 1 }));
  check('타임아웃: 1ms', '알 수 없음', tiny, tiny.kind === 'indeterminate');

  return results;
}
