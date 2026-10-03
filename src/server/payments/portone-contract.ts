import { describeOutcome, observe, type ContractResult, type Outcome } from './contract';
import { PortOneGateway } from './portone';

/**
 * 포트원 V2 API 계약 확인 — 돈이 움직이지 않는 호출만 사용한다 (존재하지 않는 결제의 조회·취소, 잘못된 시크릿, 타임아웃).
 * "포트원이 이 요청에 어떻게 답하는가"를 실제로 관측해서, 어댑터의 분류("확정된 실패" vs "알 수 없음")가 맞는지 본다.
 * 실제 결제 성공·위변조·환불 경로는 결제창에서 사람이 결제해야 하므로 docs/portone.md 의 수동 체크리스트로 확인한다.
 */
export async function runPortOneContractChecks(
  gateway: PortOneGateway,
  opts: { makeGateway: (apiSecret: string, timeoutMs?: number) => PortOneGateway; /** 호출당 타임아웃 (기본 15초) */ timeoutMs?: number },
): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  const t = opts.timeoutMs ?? 15_000;
  const check = (name: string, expected: string, o: Outcome, ok: boolean) => results.push({ name, expected, observed: describeOutcome(o), ok });
  const rnd = Math.random().toString(36).slice(2, 10);
  const unknownId = `sb_contract_${rnd}`;

  // 1. 모르는 결제 조회 → null (404 PAYMENT_NOT_FOUND)
  const lookup = await observe(() => gateway.getByOrderId(unknownId, { timeoutMs: t }));
  check('조회: 존재하지 않는 paymentId', '값 null (404 PAYMENT_NOT_FOUND 를 null 로 해석)', lookup, lookup.kind === 'value' && lookup.value === null);

  // 2. 결제창 결과 검증(confirm)에서 포트원이 모르는 결제 → 실패로 단정하지 않는다 (조회 지연일 수 있다)
  const confirm = await observe(() => gateway.confirm({ paymentKey: `tx_${rnd}`, orderId: unknownId, amount: 1000, idempotencyKey: `contract:${rnd}` }, { timeoutMs: t }));
  check('검증: 존재하지 않는 paymentId', '알 수 없음(PAYMENT_NOT_FOUND)', confirm, confirm.kind === 'indeterminate' && confirm.code === 'PAYMENT_NOT_FOUND');

  // 3. 존재하지 않는 결제 취소 → 확정된 실패 (돈이 움직일 수 없다)
  const cancel = await observe(() => gateway.cancel({ paymentKey: `tx_${rnd}`, orderId: unknownId, reason: '계약 확인', idempotencyKey: `contract-cancel:${rnd}` }, { timeoutMs: t }));
  check('취소: 존재하지 않는 paymentId', '확정된 실패 (4xx, 예: PAYMENT_NOT_FOUND)', cancel, cancel.kind === 'declined');

  // 4. 잘못된 API 시크릿 → 확정된 실패 (401 UNAUTHORIZED)
  const wrongKey = await observe(() => opts.makeGateway(`invalid-secret-${rnd}`).getByOrderId(unknownId, { timeoutMs: t }));
  check('인증: 잘못된 API 시크릿', '확정된 실패 (401 UNAUTHORIZED)', wrongKey, wrongKey.kind === 'declined');

  // 5. 아주 짧은 타임아웃 → 요청이 닿았는지 알 수 없으므로 "알 수 없음"
  const tiny = await observe(() => opts.makeGateway('any', 1).getByOrderId(unknownId, { timeoutMs: 1 }));
  check('타임아웃: 1ms', '알 수 없음', tiny, tiny.kind === 'indeterminate');

  return results;
}
