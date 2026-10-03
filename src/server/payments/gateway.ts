/**
 * 결제 게이트웨이(PG) 추상화. 앱의 나머지 코드는 이 인터페이스만 안다.
 *
 * 가장 중요한 구분 — 호출이 어떻게 끝났는가:
 *   1) 성공                      → GatewayPayment 를 돌려준다
 *   2) 확정된 실패(카드 거절 등)   → GatewayDeclinedError   : 돈이 움직이지 않았다고 확신할 수 있다
 *   3) 결과를 알 수 없음           → GatewayIndeterminateError: 타임아웃·5xx·네트워크 단절·응답 파싱 실패
 *                                  PG 는 이미 승인했을 수 있다 → 절대 "실패"로 처리하면 안 된다
 * 예상치 못한 예외도 3) 으로 취급한다. "확실히 실패했다"는 PG 가 그렇다고 말했을 때만 성립한다.
 */
export type GatewayStatus = 'READY' | 'IN_PROGRESS' | 'DONE' | 'CANCELED' | 'PARTIAL_CANCELED' | 'FAILED';

export interface GatewayPayment {
  paymentKey: string;
  orderId: string;
  status: GatewayStatus;
  totalAmount: number;
  currency: string;
  method: string | null;
  approvedAt: Date | null;
  /** 원본 응답 (감사·분쟁용으로 payments.raw 에 저장) */
  raw: unknown;
}

export interface ConfirmRequest {
  paymentKey: string;
  orderId: string;
  amount: number;
  /** 같은 키로 다시 호출하면 PG 가 같은 결과를 돌려준다 — 재시도·대사를 안전하게 만든다 */
  idempotencyKey: string;
}

export interface CancelRequest {
  paymentKey: string;
  /** PG 마다 취소에 쓰는 식별자가 다르다 — 토스는 paymentKey, 포트원은 paymentId(= 우리 주문번호) */
  orderId: string;
  reason: string;
  /** 생략하면 전액 취소 */
  cancelAmount?: number;
  idempotencyKey: string;
}

export interface CallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PaymentGateway {
  readonly name: string;
  /**
   * 서버가 승인을 요청하기 전에 결제창 안에서 돈이 움직이는 PG 인가 (포트원 기본 설정: true, 토스: false).
   * true 라면 "결제 대기 중 홀드 만료"가 "돈이 안 움직였다"를 뜻하지 않으므로, 슬롯을 풀기 전에 PG 에 확인해야 한다.
   */
  readonly capturesBeforeServerConfirm: boolean;
  confirm(req: ConfirmRequest, opts?: CallOptions): Promise<GatewayPayment>;
  /** 주문번호로 PG 의 현재 상태를 조회한다. PG 가 모르는 주문이면 null. */
  getByOrderId(orderId: string, opts?: CallOptions): Promise<GatewayPayment | null>;
  cancel(req: CancelRequest, opts?: CallOptions): Promise<GatewayPayment>;
}

/**
 * 오류 종류는 instanceof 가 아니라 전역 심볼 낙인으로 판별한다.
 * Next.js 는 같은 소스를 번들(서버 라우트·instrumentation)마다 따로 복사해 넣을 수 있고, 그러면 한 번들에서 만든 PG 어댑터가
 * 던진 오류를 다른 번들의 `instanceof` 가 알아보지 못한다 ("거절"이 "알 수 없음"으로 둔갑한다). Symbol.for 는 복사본끼리 공유된다.
 */
const DECLINED = Symbol.for('slatebook.GatewayDeclinedError');
const INDETERMINATE = Symbol.for('slatebook.GatewayIndeterminateError');

export class GatewayDeclinedError extends Error {
  readonly [DECLINED] = true;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayDeclinedError';
  }
}

export class GatewayIndeterminateError extends Error {
  readonly [INDETERMINATE] = true;
  constructor(
    message: string,
    readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'GatewayIndeterminateError';
  }
}

export function isGatewayDeclined(err: unknown): err is GatewayDeclinedError {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[DECLINED] === true;
}

export function isGatewayIndeterminate(err: unknown): err is GatewayIndeterminateError {
  return typeof err === 'object' && err !== null && (err as Record<symbol, unknown>)[INDETERMINATE] === true;
}
