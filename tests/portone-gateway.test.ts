import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isGatewayDeclined, isGatewayIndeterminate } from '../src/server/payments/gateway';
import { PortOneGateway, mapPortOneStatus } from '../src/server/payments/portone';

/**
 * 포트원 V2 어댑터 계약 테스트 — 로컬 HTTP 서버가 포트원 API 의 요청/응답 모양을 흉내 낸다.
 * 모양은 공식 SDK(@portone/server-sdk)의 타입 정의(PaidPayment, PaymentNotFoundError, PgProviderError, CancelPaymentBody 등)를 따랐다.
 * 실제 포트원에 대한 테스트가 아니다 — 키를 받으면 `npm run portone:check` 로 같은 분류를 실제 API 에 확인해야 한다.
 */
interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: any;
}
let server: Server;
let baseUrl: string;
let seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse) => void;

const paid = (over: Record<string, unknown> = {}) => ({
  status: 'PAID',
  id: 'sb_order_1',
  transactionId: 'tx_1',
  merchantId: 'merchant-1',
  storeId: 'store-1',
  method: { type: 'PaymentMethodCard', card: {} },
  amount: { total: 100_000, taxFree: 0, discount: 0, paid: 100_000, cancelled: 0, cancelledTaxFree: 0 },
  currency: 'KRW',
  paidAt: '2026-10-02T10:00:00+09:00',
  ...over,
});
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      handler(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  handler = (_q, res) => send(res, 200, paid());
});

const gw = (opts: { storeId?: string; timeoutMs?: number } = {}) =>
  new PortOneGateway({ apiSecret: 'secret_v2', storeId: opts.storeId, baseUrl, defaultTimeoutMs: opts.timeoutMs ?? 2_000 });

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    const v = await p;
    return v === null ? 'null' : 'value';
  } catch (err) {
    if (isGatewayDeclined(err)) return `declined:${err.code}`;
    if (isGatewayIndeterminate(err)) return `indeterminate${err.code ? `:${err.code}` : ''}`;
    return `other:${(err as Error).message}`;
  }
}

describe('요청 형식', () => {
  it('조회: GET /payments/{paymentId}, "PortOne <시크릿>" 인증, 주문번호는 URL 인코딩', async () => {
    const p = await gw().getByOrderId('sb order/1');
    const r = seen[0]!;
    expect(r.method).toBe('GET');
    expect(r.url).toBe('/payments/sb%20order%2F1');
    expect(r.headers.authorization).toBe('PortOne secret_v2');
    expect(p).toMatchObject({ paymentKey: 'tx_1', orderId: 'sb_order_1', status: 'DONE', totalAmount: 100_000, currency: 'KRW', method: 'Card' });
    expect(p!.approvedAt?.toISOString()).toBe('2026-10-02T01:00:00.000Z');
  });

  it('상점 ID 를 설정하면 조회는 쿼리로, 취소는 본문으로 보낸다', async () => {
    await gw({ storeId: 'store-9' }).getByOrderId('sb_order_1');
    expect(seen[0]!.url).toBe('/payments/sb_order_1?storeId=store-9');

    seen = [];
    handler = (req, res) => (req.method === 'POST' ? send(res, 200, { cancellation: { status: 'SUCCEEDED' } }) : send(res, 200, paid({ status: 'CANCELLED' })));
    await gw({ storeId: 'store-9' }).cancel({ paymentKey: 'tx_1', orderId: 'sb_order_1', reason: '자동 환불', idempotencyKey: 'k' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/payments/sb_order_1/cancel', body: { reason: '자동 환불', storeId: 'store-9' } });
  });

  it('confirm 은 승인 호출이 아니라 조회다 — 포트원 기본 흐름에서는 결제창에서 이미 결제가 끝났다', async () => {
    const p = await gw().confirm({ paymentKey: 'tx_1', orderId: 'sb_order_1', amount: 100_000, idempotencyKey: 'confirm:x' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/payments/sb_order_1' });
    expect(p.status).toBe('DONE');
  });
});

describe('상태 대응표', () => {
  it.each([
    ['READY', 'READY'],
    ['PAY_PENDING', 'IN_PROGRESS'],
    ['VIRTUAL_ACCOUNT_ISSUED', 'IN_PROGRESS'],
    ['PAID', 'DONE'],
    ['FAILED', 'FAILED'],
    ['CANCELLED', 'CANCELED'],
    ['PARTIAL_CANCELLED', 'PARTIAL_CANCELED'],
  ])('%s → %s', (portone, ours) => {
    expect(mapPortOneStatus(portone)).toBe(ours);
  });

  it('모르는 상태는 성공/실패로 추측하지 않고 "알 수 없음"', async () => {
    handler = (_q, res) => send(res, 200, paid({ status: 'SOMETHING_NEW' }));
    expect(await outcome(gw().getByOrderId('sb_order_1'))).toBe('indeterminate');
  });

  it('PAID 인데 transactionId 가 없으면 승인으로 받아들이지 않는다 (어느 결제인지 대조할 수 없다)', async () => {
    const { transactionId: _omit, ...noTx } = paid();
    handler = (_q, res) => send(res, 200, noTx);
    expect(await outcome(gw().getByOrderId('sb_order_1'))).toBe('indeterminate');
  });

  it('READY 는 그대로 돌려준다 — confirm 이 실패로 단정하지 않는다 (대사가 유예 뒤 정리)', async () => {
    handler = (_q, res) => send(res, 200, paid({ status: 'READY', paidAt: undefined }));
    const p = await gw().confirm({ paymentKey: 'tx_1', orderId: 'sb_order_1', amount: 100_000, idempotencyKey: 'k' });
    expect(p.status).toBe('READY');
  });
});

describe('오류 분류 — "확정된 실패"는 포트원이 그렇다고 말했을 때만', () => {
  it('조회: PAYMENT_NOT_FOUND(404) → null', async () => {
    handler = (_q, res) => send(res, 404, { type: 'PAYMENT_NOT_FOUND', message: '결제 건이 존재하지 않습니다.' });
    expect(await outcome(gw().getByOrderId('sb_x'))).toBe('null');
  });

  it('confirm: 브라우저는 결제했다는데 포트원이 모른다 → 실패가 아니라 "알 수 없음" (조회 지연일 수 있다)', async () => {
    handler = (_q, res) => send(res, 404, { type: 'PAYMENT_NOT_FOUND' });
    expect(await outcome(gw().confirm({ paymentKey: 'tx', orderId: 'sb_x', amount: 1, idempotencyKey: 'k' }))).toBe('indeterminate:PAYMENT_NOT_FOUND');
  });

  it.each([
    [401, 'UNAUTHORIZED', 'declined:UNAUTHORIZED'],
    [403, 'FORBIDDEN', 'declined:FORBIDDEN'],
    [400, 'INVALID_REQUEST', 'declined:INVALID_REQUEST'],
    [500, 'UNKNOWN', 'indeterminate:UNKNOWN'],
    [503, undefined, 'indeterminate'],
    [429, undefined, 'indeterminate'],
    [408, undefined, 'indeterminate'],
    [502, 'PG_PROVIDER', 'indeterminate:PG_PROVIDER'],
  ])('HTTP %s %s → %s', async (status, type, expected) => {
    handler = (_q, res) => send(res, status, type ? { type, message: 'x' } : {});
    expect(await outcome(gw().getByOrderId('sb_order_1'))).toBe(expected);
  });

  it('2xx 인데 본문을 읽을 수 없으면 "알 수 없음"', async () => {
    handler = (_q, res) => send(res, 200, 'not json');
    expect(await outcome(gw().getByOrderId('sb_order_1'))).toBe('indeterminate');
  });

  it('응답이 늦으면(타임아웃) "알 수 없음"', async () => {
    handler = (_q, res) => setTimeout(() => send(res, 200, paid()), 300);
    expect(await outcome(gw({ timeoutMs: 50 }).getByOrderId('sb_order_1'))).toBe('indeterminate');
  });
});

describe('취소 — 포트원 V2 취소 API 에는 멱등키가 없으므로 "이미 취소됨"을 조회로 확인해 성공으로 본다', () => {
  it('정상: 취소 후 다시 조회해 CANCELED 를 돌려준다', async () => {
    handler = (req, res) => (req.method === 'POST' ? send(res, 200, { cancellation: {} }) : send(res, 200, paid({ status: 'CANCELLED' })));
    const p = await gw().cancel({ paymentKey: 'tx_1', orderId: 'sb_order_1', reason: 'r', idempotencyKey: 'k' });
    expect(p.status).toBe('CANCELED');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /payments/sb_order_1/cancel', 'GET /payments/sb_order_1']);
  });

  it('재시도: PAYMENT_ALREADY_CANCELLED(409) 는 조회해서 정말 취소돼 있으면 성공', async () => {
    handler = (req, res) =>
      req.method === 'POST' ? send(res, 409, { type: 'PAYMENT_ALREADY_CANCELLED' }) : send(res, 200, paid({ status: 'CANCELLED' }));
    const p = await gw().cancel({ paymentKey: 'tx_1', orderId: 'sb_order_1', reason: 'r', idempotencyKey: 'k' });
    expect(p.status).toBe('CANCELED');
  });

  it('취소가 받아들여졌는데 조회해 보니 아직 취소 전이면 "알 수 없음" (호출자가 다시 시도한다)', async () => {
    handler = (req, res) => (req.method === 'POST' ? send(res, 200, { cancellation: {} }) : send(res, 200, paid()));
    expect(await outcome(gw().cancel({ paymentKey: 'tx_1', orderId: 'sb_order_1', reason: 'r', idempotencyKey: 'k' }))).toBe('indeterminate');
  });

  it('PG사 오류(PG_PROVIDER)로 취소 결과를 모르면 "알 수 없음"', async () => {
    handler = (_q, res) => send(res, 502, { type: 'PG_PROVIDER', pgCode: 'X', pgMessage: 'y' });
    expect(await outcome(gw().cancel({ paymentKey: 'tx_1', orderId: 'sb_order_1', reason: 'r', idempotencyKey: 'k' }))).toBe('indeterminate:PG_PROVIDER');
  });

  it('결제되지 않은 건(PAYMENT_NOT_PAID) 취소는 확정된 실패', async () => {
    handler = (_q, res) => send(res, 409, { type: 'PAYMENT_NOT_PAID' });
    expect(await outcome(gw().cancel({ paymentKey: 'tx_1', orderId: 'sb_order_1', reason: 'r', idempotencyKey: 'k' }))).toBe('declined:PAYMENT_NOT_PAID');
  });

  it('부분 취소는 지원하지 않는다 — 재시도가 두 번 취소되지 않게 막을 수단을 확인하지 못했다', async () => {
    expect(await outcome(gw().cancel({ paymentKey: 'tx_1', orderId: 'sb_order_1', reason: 'r', cancelAmount: 500, idempotencyKey: 'k' }))).toMatch(/^other:.*partial cancel/);
    expect(seen).toHaveLength(0);
  });
});
