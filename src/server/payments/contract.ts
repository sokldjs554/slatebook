import { isGatewayDeclined, isGatewayIndeterminate, type GatewayDeclinedError, type GatewayIndeterminateError } from './gateway';

/** PG 계약 확인(toss-contract · portone-contract)의 공통 부품 */
export interface ContractResult {
  name: string;
  ok: boolean;
  /** 실제로 관측한 것 (오류 코드·분류) — 어댑터 가정과 다르면 이 값을 보고 매핑을 고친다 */
  observed: string;
  expected: string;
}

export type Outcome =
  | { kind: 'value'; value: unknown }
  | { kind: 'declined'; code: string }
  | { kind: 'indeterminate'; code?: string }
  | { kind: 'other'; message: string };

export async function observe(fn: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: 'value', value: await fn() };
  } catch (err) {
    if (isGatewayDeclined(err)) return { kind: 'declined', code: (err as GatewayDeclinedError).code };
    if (isGatewayIndeterminate(err)) return { kind: 'indeterminate', code: (err as GatewayIndeterminateError).code };
    return { kind: 'other', message: (err as Error).message };
  }
}

export const describeOutcome = (o: Outcome): string =>
  o.kind === 'value'
    ? `값 ${o.value === null ? 'null' : typeof o.value}`
    : o.kind === 'declined'
      ? `확정된 실패(${o.code})`
      : o.kind === 'indeterminate'
        ? `알 수 없음${o.code ? `(${o.code})` : ''}`
        : `예상 밖 오류(${o.message})`;
