import { z } from 'zod';
import {
  GatewayDeclinedError,
  GatewayIndeterminateError,
  isGatewayDeclined,
  type CallOptions,
  type CancelRequest,
  type ConfirmRequest,
  type GatewayPayment,
  type GatewayStatus,
  type PaymentGateway,
} from './gateway';

/**
 * 포트원(PortOne) V2 결제 API 어댑터.
 *
 * 토스와 가장 크게 다른 점 — **누가 승인하는가.**
 *   토스: 브라우저는 인증까지만 하고, 서버가 승인 API 를 불러야 돈이 움직인다 (서버가 금액을 지정한다).
 *   포트원(기본 설정): 브라우저 SDK 에서 결제가 끝까지 완료된다. 서버의 `confirm` 은 "승인"이 아니라
 *   **조회로 하는 검증**이다 — 돈은 이미 움직였을 수 있으므로, 금액이 다르면 확정하지 않고 자동 환불한다(apply.ts).
 *   (포트원의 "수동 승인" 채널 설정을 쓰면 서버가 금액을 지정해 승인할 수 있다 — docs/portone.md 참고.)
 *
 * 요청·응답 형태는 공식 SDK(@portone/server-sdk 0.19.0)의 타입 정의와 대조해 맞췄지만,
 * 실제 포트원 API 에 대해 실행해 보지는 않았다. 키를 받으면 가장 먼저 `npm run portone:check` 를 돌려야 한다.
 */
export interface PortOneOptions {
  apiSecret: string;
  /** 접근 권한이 있는 상점이 여럿일 때만 필요하다. 생략하면 API 시크릿의 상점을 쓴다. */
  storeId?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

/** HTTP 상태와 무관하게 "처리됐는지 알 수 없다"고 봐야 하는 오류 */
const INDETERMINATE_TYPES = new Set([
  'PG_PROVIDER', // PG사 쪽 오류 — 취소 요청이 PG 에 반영됐는지 알 수 없다
]);

const paymentSchema = z
  .object({
    status: z.string(),
    id: z.string().min(1),
    // READY 등 모든 상태에 있다고 문서화돼 있지만, 승인(PAID) 판정에 꼭 필요한 값이라 없을 때를 따로 다룬다
    transactionId: z.string().min(1).optional(),
    amount: z.object({ total: z.number().int() }).loose(),
    currency: z.string(),
    method: z.object({ type: z.string() }).loose().nullish(),
    paidAt: z.string().nullish(),
  })
  .loose();

const errorBodySchema = z.object({ type: z.string().optional(), message: z.string().optional() }).loose();

export function mapPortOneStatus(status: string): GatewayStatus {
  switch (status) {
    case 'READY':
      return 'READY';
    case 'PAY_PENDING': // 결제 완료 대기 (일부 결제수단)
    case 'VIRTUAL_ACCOUNT_ISSUED': // 입금 대기
      return 'IN_PROGRESS';
    case 'PAID':
      return 'DONE';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELED';
    case 'PARTIAL_CANCELLED':
      return 'PARTIAL_CANCELED';
    default:
      // 모르는 상태를 성공/실패로 추측하지 않는다
      throw new GatewayIndeterminateError(`unknown payment status from PortOne: ${status}`);
  }
}

export class PortOneGateway implements PaymentGateway {
  readonly name = 'portone';
  readonly capturesBeforeServerConfirm = true; // 기본 설정에서는 결제창 안에서 결제가 완료된다
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;
  private readonly storeId: string | undefined;
  private readonly defaultTimeoutMs: number;

  constructor(opts: PortOneOptions) {
    if (!opts.apiSecret) throw new Error('PORTONE_API_SECRET is required');
    this.baseUrl = (opts.baseUrl ?? 'https://api.portone.io').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.authHeader = `PortOne ${opts.apiSecret}`;
    this.storeId = opts.storeId;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  private async call(method: 'GET' | 'POST', path: string, body: unknown, opts: CallOptions): Promise<unknown> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: this.authHeader, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      // 타임아웃·연결 끊김·DNS — 요청이 포트원에 닿았는지 알 수 없다
      throw new GatewayIndeterminateError(`portone request failed: ${(cause as Error).message}`, undefined, { cause });
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.ok) {
      // 2xx 인데 본문을 못 읽었다면 처리됐을 수 있으므로 성공도 실패도 단정하지 않는다
      if (json === null) throw new GatewayIndeterminateError(`portone returned ${res.status} with an unreadable body`);
      return json;
    }

    const parsed = errorBodySchema.safeParse(json);
    const type = parsed.success ? parsed.data.type : undefined;
    const message = (parsed.success ? parsed.data.message : undefined) ?? `HTTP ${res.status}`;
    if (res.status >= 500 || res.status === 429 || res.status === 408 || (type && INDETERMINATE_TYPES.has(type))) {
      throw new GatewayIndeterminateError(`portone error ${res.status} ${type ?? ''}: ${message}`, type);
    }
    throw new GatewayDeclinedError(type ?? `HTTP_${res.status}`, message);
  }

  private toPayment(json: unknown): GatewayPayment {
    const p = paymentSchema.safeParse(json);
    if (!p.success) throw new GatewayIndeterminateError('portone returned an unexpected payment payload');
    const status = mapPortOneStatus(p.data.status);
    if (status === 'DONE' && !p.data.transactionId) {
      // 결제키 없이는 "우리가 아는 그 결제"인지 대조할 수 없다 → 승인으로 받아들이지 않는다
      throw new GatewayIndeterminateError('portone reported PAID without a transactionId');
    }
    return {
      // 포트원의 paymentId 는 우리가 정한 주문번호이고, 결제 시도마다 발급되는 transactionId 가 토스의 paymentKey 에 해당한다
      paymentKey: p.data.transactionId ?? '',
      orderId: p.data.id,
      status,
      totalAmount: p.data.amount.total,
      currency: p.data.currency,
      method: p.data.method?.type.replace(/^PaymentMethod/, '') ?? null,
      approvedAt: p.data.paidAt ? new Date(p.data.paidAt) : null,
      raw: json,
    };
  }

  private query(): string {
    return this.storeId ? `?storeId=${encodeURIComponent(this.storeId)}` : '';
  }

  /**
   * 포트원 기본 흐름에서는 브라우저 SDK 가 결제를 이미 완료했다. 여기서는 포트원에 다시 물어 "정말 결제됐는지"만 확인한다.
   * 금액·결제키 대조는 모든 PG 에 공통인 applyGatewayResult 가 한다 (다르면 확정하지 않고 자동 환불).
   * 아직 결제되지 않은 상태(READY)는 그대로 돌려준다 — 대사가 유예 시간 뒤 실패로 정리하고, 그 뒤에 결제가 완료되면 자동 환불된다.
   */
  async confirm(req: ConfirmRequest, opts: CallOptions = {}): Promise<GatewayPayment> {
    const view = await this.getByOrderId(req.orderId, opts);
    // 브라우저는 결제가 끝났다고 하는데 포트원은 모른다 → 조회 지연일 수 있으므로 실패로 단정하지 않는다 (대사가 유예 뒤 정리)
    if (view === null) throw new GatewayIndeterminateError('payment not found at PortOne', 'PAYMENT_NOT_FOUND');
    return view;
  }

  async getByOrderId(orderId: string, opts: CallOptions = {}): Promise<GatewayPayment | null> {
    try {
      const json = await this.call('GET', `/payments/${encodeURIComponent(orderId)}${this.query()}`, undefined, opts);
      return this.toPayment(json);
    } catch (err) {
      if (isGatewayDeclined(err) && (err.code === 'PAYMENT_NOT_FOUND' || err.code === 'HTTP_404')) return null;
      throw err;
    }
  }

  /**
   * 전액 취소. 포트원 V2 의 취소 API 에는 멱등키가 없으므로, "이미 취소됨" 응답을 조회로 확인해 성공으로 본다 —
   * 같은 환불을 몇 번 다시 시도해도 결과가 같다.
   * 부분 취소는 지원하지 않는다: 재시도가 두 번 취소되지 않게 막을 수단(멱등키)을 확인하지 못했고, 이 프로젝트는 전액 환불만 쓴다.
   */
  async cancel(req: CancelRequest, opts: CallOptions = {}): Promise<GatewayPayment> {
    if (req.cancelAmount !== undefined) {
      throw new Error('PortOneGateway: partial cancel is not supported (no idempotency guarantee)');
    }
    const body: Record<string, unknown> = { reason: req.reason };
    if (this.storeId) body.storeId = this.storeId;
    try {
      await this.call('POST', `/payments/${encodeURIComponent(req.orderId)}/cancel`, body, opts);
    } catch (err) {
      if (!(isGatewayDeclined(err) && err.code === 'PAYMENT_ALREADY_CANCELLED')) throw err;
    }
    // 취소 응답에는 결제 상태가 없으므로 다시 조회해서 돌려준다 (조회가 실패하면 "알 수 없음" → 호출자가 다시 시도한다)
    const view = await this.getByOrderId(req.orderId, opts);
    if (view === null) throw new GatewayIndeterminateError('payment disappeared after cancel', 'PAYMENT_NOT_FOUND');
    if (view.status !== 'CANCELED') {
      throw new GatewayIndeterminateError(`cancel accepted but payment is ${view.status}`);
    }
    return view;
  }
}
