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
 * 토스페이먼츠 결제 API 어댑터.
 * 문서화된 요청 형식(Basic 인증, Idempotency-Key, /confirm · /orders/{orderId} · /{paymentKey}/cancel)을 따르지만
 * 실제 토스 샌드박스에 대해 실행해 보지는 않았다 — 테스트는 로컬 HTTP 서버로 요청/응답 형태만 검증한다.
 * 키를 발급받으면 가장 먼저 샌드박스 계약 테스트를 돌려야 한다.
 */
export interface TossOptions {
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
}

/** HTTP 상태와 무관하게 "처리됐는지 알 수 없다"고 봐야 하는 PG 오류 코드 */
const INDETERMINATE_CODES = new Set([
  'ALREADY_PROCESSED_PAYMENT', // 이미 처리됨 → 조회해서 결과를 확인해야 한다
  'PROVIDER_ERROR',
  'FAILED_INTERNAL_SYSTEM_PROCESSING',
  'FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING',
  'UNKNOWN_PAYMENT_ERROR',
]);

const paymentSchema = z.object({
  paymentKey: z.string().min(1),
  orderId: z.string().min(1),
  status: z.string(),
  totalAmount: z.number().int(),
  currency: z.string().optional(),
  method: z.string().nullish(),
  approvedAt: z.string().nullish(),
});

const errorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() });

export function mapTossStatus(status: string): GatewayStatus {
  switch (status) {
    case 'READY':
      return 'READY';
    case 'IN_PROGRESS':
    case 'WAITING_FOR_DEPOSIT':
      return 'IN_PROGRESS';
    case 'DONE':
      return 'DONE';
    case 'CANCELED':
      return 'CANCELED';
    case 'PARTIAL_CANCELED':
      return 'PARTIAL_CANCELED';
    case 'ABORTED':
    case 'EXPIRED':
      return 'FAILED';
    default:
      // 모르는 상태를 성공/실패로 추측하지 않는다
      throw new GatewayIndeterminateError(`unknown payment status from PG: ${status}`);
  }
}

export class TossGateway implements PaymentGateway {
  readonly name = 'toss';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;
  private readonly defaultTimeoutMs: number;

  constructor(opts: TossOptions) {
    if (!opts.secretKey) throw new Error('TOSS_SECRET_KEY is required');
    this.baseUrl = (opts.baseUrl ?? 'https://api.tosspayments.com/v1/payments').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.authHeader = 'Basic ' + Buffer.from(`${opts.secretKey}:`).toString('base64');
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: CallOptions & { idempotencyKey?: string },
  ): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const headers: Record<string, string> = { Authorization: this.authHeader, 'Content-Type': 'application/json' };
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      // 타임아웃·연결 끊김·DNS — 요청이 PG 에 닿았는지 알 수 없다
      throw new GatewayIndeterminateError(`toss request failed: ${(cause as Error).message}`, undefined, { cause });
    }

    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (res.ok) {
      // 2xx 인데 본문을 못 읽었다면 승인됐을 수 있으므로 성공도 실패도 단정하지 않는다
      if (json === null) throw new GatewayIndeterminateError(`toss returned ${res.status} with an unreadable body`);
      return { status: res.status, json };
    }

    const parsed = errorBodySchema.safeParse(json);
    const code = parsed.success ? parsed.data.code : undefined;
    const message = (parsed.success ? parsed.data.message : undefined) ?? `HTTP ${res.status}`;
    if (res.status >= 500 || res.status === 429 || res.status === 408 || (code && INDETERMINATE_CODES.has(code))) {
      throw new GatewayIndeterminateError(`toss error ${res.status} ${code ?? ''}: ${message}`, code);
    }
    throw new GatewayDeclinedError(code ?? `HTTP_${res.status}`, message);
  }

  private toPayment(json: unknown): GatewayPayment {
    const p = paymentSchema.safeParse(json);
    if (!p.success) throw new GatewayIndeterminateError('toss returned an unexpected payment payload');
    return {
      paymentKey: p.data.paymentKey,
      orderId: p.data.orderId,
      status: mapTossStatus(p.data.status),
      totalAmount: p.data.totalAmount,
      currency: p.data.currency ?? 'KRW',
      method: p.data.method ?? null,
      approvedAt: p.data.approvedAt ? new Date(p.data.approvedAt) : null,
      raw: json,
    };
  }

  async confirm(req: ConfirmRequest, opts: CallOptions = {}): Promise<GatewayPayment> {
    const { json } = await this.call(
      'POST',
      '/confirm',
      { paymentKey: req.paymentKey, orderId: req.orderId, amount: req.amount },
      { ...opts, idempotencyKey: req.idempotencyKey },
    );
    return this.toPayment(json);
  }

  async getByOrderId(orderId: string, opts: CallOptions = {}): Promise<GatewayPayment | null> {
    try {
      const { json } = await this.call('GET', `/orders/${encodeURIComponent(orderId)}`, undefined, opts);
      return this.toPayment(json);
    } catch (err) {
      if (isGatewayDeclined(err) && (err.code === 'NOT_FOUND_PAYMENT' || err.code === 'HTTP_404')) return null;
      throw err;
    }
  }

  async cancel(req: CancelRequest, opts: CallOptions = {}): Promise<GatewayPayment> {
    const body: Record<string, unknown> = { cancelReason: req.reason };
    if (req.cancelAmount !== undefined) body.cancelAmount = req.cancelAmount;
    const { json } = await this.call('POST', `/${encodeURIComponent(req.paymentKey)}/cancel`, body, {
      ...opts,
      idempotencyKey: req.idempotencyKey,
    });
    return this.toPayment(json);
  }
}
