import {
  GatewayDeclinedError,
  GatewayIndeterminateError,
  type CallOptions,
  type CancelRequest,
  type ConfirmRequest,
  type GatewayPayment,
  type GatewayStatus,
  type PaymentGateway,
} from './gateway';

/**
 * 테스트·로컬 데모용 가짜 PG. 실제 PG 처럼 "PG 쪽 진실"을 따로 들고 있다.
 * 사용자가 PG 결제창에서 카드 인증을 마친 것은 authenticate() 로 흉내 낸다.
 */
export type ConfirmOutcome =
  | 'ok'
  | 'decline' // 카드사 거절: 확정 실패
  | 'timeout_before_capture' // 응답을 못 받았고 PG 도 처리하지 않았다
  | 'timeout_after_capture' // 응답을 못 받았는데 PG 는 이미 승인했다 (가장 위험한 경우)
  | 'server_error'; // 5xx, 처리되지 않음

interface FakeRecord {
  orderId: string;
  paymentKey: string;
  amount: number;
  status: GatewayStatus;
  method: string | null;
  approvedAt: Date | null;
  reportedTotal: number | null; // 위변조 시뮬레이션용
  reportedKey: string | null; // PG 가 다른 결제키를 보고하는 상황
}

export interface FakeCall {
  orderId: string;
  paymentKey: string;
  amount: number;
  idempotencyKey: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FakeGateway implements PaymentGateway {
  readonly name = 'fake';
  readonly records = new Map<string, FakeRecord>();
  readonly confirmCalls: FakeCall[] = [];
  readonly cancelCalls: Array<{ paymentKey: string; idempotencyKey: string; reason: string }> = [];
  readonly lookupCalls: string[] = [];

  latencyMs = 0;
  private outcomes = new Map<string, ConfirmOutcome[]>();
  private idem = new Set<string>();
  private gate: Promise<void> | null = null;
  private failLookups = 0;
  private failCancels = 0;
  private keySeq = 0;

  /** 사용자가 PG 결제창에서 카드 인증을 끝냈다 (아직 승인(capture) 전). paymentKey 를 돌려준다. */
  authenticate(input: { orderId: string; amount: number; paymentKey?: string }): string {
    const paymentKey = input.paymentKey ?? `fake_pk_${++this.keySeq}_${input.orderId.slice(-8)}`;
    this.records.set(input.orderId, {
      orderId: input.orderId,
      paymentKey,
      amount: input.amount,
      status: 'IN_PROGRESS',
      method: null,
      approvedAt: null,
      reportedTotal: null,
      reportedKey: null,
    });
    return paymentKey;
  }

  /** 다음 confirm 호출들의 결과를 미리 정한다. orderId 를 생략하면 모든 주문에 적용. */
  script(outcomes: ConfirmOutcome | ConfirmOutcome[], orderId = '*'): void {
    this.outcomes.set(orderId, Array.isArray(outcomes) ? [...outcomes] : [outcomes]);
  }

  /** 이후의 confirm 호출을 release() 때까지 붙잡아 둔다 (동시 요청·브라우저 종료 시나리오용) */
  pauseConfirms(): { release: () => void } {
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    const gate = this.gate;
    return {
      release: () => {
        if (this.gate === gate) this.gate = null;
        release();
      },
    };
  }

  failNextLookups(n: number): void {
    this.failLookups = n;
  }
  failNextCancels(n: number): void {
    this.failCancels = n;
  }
  /** PG 가 실제 승인액과 다른 금액을 보고하는 상황 (위변조·사고 시뮬레이션) */
  forceReportedTotal(orderId: string, total: number): void {
    const rec = this.records.get(orderId);
    if (rec) rec.reportedTotal = total;
  }
  /** PG 가 우리가 아는 것과 다른 결제키를 보고하는 상황 */
  forceReportedKey(orderId: string, key: string): void {
    const rec = this.records.get(orderId);
    if (rec) rec.reportedKey = key;
  }
  /** PG 쪽에서 결제가 이미 승인돼 있는 상태를 만든다 (사용자가 브라우저를 닫았지만 PG 는 승인한 경우) */
  capture(orderId: string): void {
    const rec = this.records.get(orderId);
    if (!rec) throw new Error(`unknown order ${orderId}`);
    rec.status = 'DONE';
    rec.method = '카드';
    rec.approvedAt = new Date();
  }
  /** PG 쪽 결제 세션이 만료·중단됐다 */
  abort(orderId: string): void {
    const rec = this.records.get(orderId);
    if (rec) rec.status = 'FAILED';
  }

  private view(rec: FakeRecord): GatewayPayment {
    return {
      paymentKey: rec.reportedKey ?? rec.paymentKey,
      orderId: rec.orderId,
      status: rec.status,
      totalAmount: rec.reportedTotal ?? rec.amount,
      currency: 'KRW',
      method: rec.method,
      approvedAt: rec.approvedAt,
      raw: { fake: true, orderId: rec.orderId, status: rec.status, totalAmount: rec.reportedTotal ?? rec.amount },
    };
  }

  private nextOutcome(orderId: string): ConfirmOutcome {
    for (const key of [orderId, '*']) {
      const queue = this.outcomes.get(key);
      if (queue && queue.length > 0) {
        const next = queue.length > 1 ? queue.shift()! : queue[0]!; // 마지막 항목은 계속 적용
        return next;
      }
    }
    return 'ok';
  }

  private assertNotAborted(opts?: CallOptions) {
    if (opts?.signal?.aborted) throw new GatewayIndeterminateError('request aborted by caller');
  }

  async confirm(req: ConfirmRequest, opts?: CallOptions): Promise<GatewayPayment> {
    this.confirmCalls.push({
      orderId: req.orderId,
      paymentKey: req.paymentKey,
      amount: req.amount,
      idempotencyKey: req.idempotencyKey,
    });
    this.assertNotAborted(opts);
    if (this.latencyMs > 0) await sleep(this.latencyMs);
    if (this.gate) await this.gate;
    this.assertNotAborted(opts);

    const rec = this.records.get(req.orderId);
    if (!rec || rec.paymentKey !== req.paymentKey) {
      throw new GatewayDeclinedError('NOT_FOUND_PAYMENT', 'unknown paymentKey/orderId');
    }
    if (rec.status === 'DONE') {
      if (this.idem.has(req.idempotencyKey)) return this.view(rec); // 같은 키 재시도 → 같은 결과
      throw new GatewayIndeterminateError('already processed', 'ALREADY_PROCESSED_PAYMENT');
    }
    if (rec.status !== 'IN_PROGRESS') {
      throw new GatewayDeclinedError('NOT_FOUND_PAYMENT_SESSION', `payment session is ${rec.status}`);
    }
    if (req.amount !== rec.amount) {
      throw new GatewayDeclinedError('INVALID_REQUEST', 'amount does not match the authenticated amount');
    }

    switch (this.nextOutcome(req.orderId)) {
      case 'ok':
        this.capture(req.orderId);
        this.idem.add(req.idempotencyKey);
        return this.view(rec);
      case 'decline':
        rec.status = 'FAILED';
        throw new GatewayDeclinedError('REJECT_CARD_COMPANY', '카드사에서 승인을 거절했습니다.');
      case 'timeout_before_capture':
        throw new GatewayIndeterminateError('timeout (before capture)');
      case 'server_error':
        throw new GatewayIndeterminateError('upstream 500', 'FAILED_INTERNAL_SYSTEM_PROCESSING');
      case 'timeout_after_capture':
        this.capture(req.orderId);
        this.idem.add(req.idempotencyKey);
        throw new GatewayIndeterminateError('timeout (after capture)');
    }
  }

  async getByOrderId(orderId: string, opts?: CallOptions): Promise<GatewayPayment | null> {
    this.lookupCalls.push(orderId);
    this.assertNotAborted(opts);
    if (this.failLookups > 0) {
      this.failLookups -= 1;
      throw new GatewayIndeterminateError('lookup failed');
    }
    const rec = this.records.get(orderId);
    return rec ? this.view(rec) : null;
  }

  async cancel(req: CancelRequest, opts?: CallOptions): Promise<GatewayPayment> {
    this.cancelCalls.push({ paymentKey: req.paymentKey, idempotencyKey: req.idempotencyKey, reason: req.reason });
    this.assertNotAborted(opts);
    if (this.failCancels > 0) {
      this.failCancels -= 1;
      throw new GatewayIndeterminateError('cancel failed');
    }
    const rec = [...this.records.values()].find((r) => r.paymentKey === req.paymentKey);
    if (!rec) throw new GatewayDeclinedError('NOT_FOUND_PAYMENT', 'unknown paymentKey');
    if (rec.status === 'CANCELED') return this.view(rec); // 멱등
    if (rec.status !== 'DONE') {
      throw new GatewayDeclinedError('NOT_CANCELABLE_PAYMENT', `cannot cancel a ${rec.status} payment`);
    }
    rec.status = 'CANCELED';
    return this.view(rec);
  }
}
