import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayDeclinedError, GatewayIndeterminateError } from '../src/server/payments/gateway';
import { TossGateway, mapTossStatus } from '../src/server/payments/toss';

/**
 * 토스 어댑터 계약 테스트 — 로컬 HTTP 서버가 토스 API 의 문서화된 요청/응답 모양을 흉내 낸다.
 * (실제 토스 샌드박스에 대한 테스트가 아니다. 키를 받으면 가장 먼저 샌드박스로 같은 시나리오를 돌려야 한다.)
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
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

const tossPayment = (over: Record<string, unknown> = {}) => ({
  paymentKey: 'pk_test_1',
  orderId: 'sb_order_1',
  status: 'DONE',
  totalAmount: 100_000,
  currency: 'KRW',
  method: '카드',
  approvedAt: '2026-10-02T10:00:00+09:00',
  ...over,
});
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
      handler(req, res, raw);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/payments`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  handler = (_q, res) => json(res, 200, tossPayment());
});

const gw = (timeoutMs = 2_000) => new TossGateway({ secretKey: 'test_sk_secret', baseUrl, defaultTimeoutMs: timeoutMs });

describe('요청 형식', () => {
  it('confirm: Basic 인증(비밀키:), Idempotency-Key, JSON 본문 {paymentKey, orderId, amount}', async () => {
    const p = await gw().confirm({ paymentKey: 'pk_test_1', orderId: 'sb_order_1', amount: 100_000, idempotencyKey: 'confirm:abc' });
    const r = seen[0]!;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/v1/payments/confirm');
    expect(r.headers.authorization).toBe('Basic ' + Buffer.from('test_sk_secret:').toString('base64'));
    expect(r.headers['idempotency-key']).toBe('confirm:abc');
    expect(r.headers['content-type']).toMatch(/application\/json/);
    expect(r.body).toEqual({ paymentKey: 'pk_test_1', orderId: 'sb_order_1', amount: 100_000 });
    expect(p).toMatchObject({ paymentKey: 'pk_test_1', orderId: 'sb_order_1', status: 'DONE', totalAmount: 100_000, currency: 'KRW', method: '카드' });
    expect(p.approvedAt?.toISOString()).toBe('2026-10-02T01:00:00.000Z');
  });

  it('getByOrderId: GET /orders/{orderId} (주문번호는 URL 인코딩)', async () => {
    await gw().getByOrderId('sb order/1?x=1');
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/v1/payments/orders/sb%20order%2F1%3Fx%3D1' });
  });

  it('cancel: POST /{paymentKey}/cancel 에 cancelReason(+전액이면 cancelAmount 생략)과 Idempotency-Key', async () => {
    handler = (_q, res) => json(res, 200, tossPayment({ status: 'CANCELED' }));
    const p = await gw().cancel({ paymentKey: 'pk/weird key', orderId: 'sb_order_1', reason: '자동 환불', idempotencyKey: 'capture-refund:1' });
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/payments/pk%2Fweird%20key/cancel', body: { cancelReason: '자동 환불' } });
    expect(seen[0]!.headers['idempotency-key']).toBe('capture-refund:1');
    expect(p.status).toBe('CANCELED');
    await gw().cancel({ paymentKey: 'pk', orderId: 'sb_order_1', reason: 'r', cancelAmount: 500, idempotencyKey: 'k' });
    expect(seen[1]!.body).toEqual({ cancelReason: 'r', cancelAmount: 500 });
  });

  it('비밀키가 없으면 어댑터를 만들 수 없다', () => {
    expect(() => new TossGateway({ secretKey: '' })).toThrow();
  });
});

describe('결과 분류 — "확실한 실패" 와 "알 수 없음" 을 구분한다', () => {
  const confirm = () => gw().confirm({ paymentKey: 'pk', orderId: 'sb_order_1', amount: 1, idempotencyKey: 'k' });

  it.each([
    [400, 'INVALID_CARD_NUMBER'],
    [403, 'REJECT_CARD_COMPANY'],
    [404, 'NOT_FOUND_PAYMENT_SESSION'],
    [401, 'UNAUTHORIZED_KEY'],
  ])('HTTP %i %s → 확정된 실패(Declined)', async (status, code) => {
    handler = (_q, res) => json(res, status, { code, message: 'nope' });
    const err = await confirm().catch((e) => e);
    expect(err).toBeInstanceOf(GatewayDeclinedError);
    expect(err.code).toBe(code);
  });

  it.each([
    [500, 'FAILED_INTERNAL_SYSTEM_PROCESSING'],
    [502, undefined],
    [503, undefined],
    [429, 'TOO_MANY_REQUESTS'],
    [408, undefined],
    [400, 'ALREADY_PROCESSED_PAYMENT'], // 이미 처리됨 → 조회로 확인해야 하므로 실패가 아니다
    [400, 'PROVIDER_ERROR'],
  ])('HTTP %i %s → 결과 알 수 없음(Indeterminate)', async (status, code) => {
    handler = (_q, res) => json(res, status, code ? { code, message: 'x' } : { message: 'x' });
    expect(await confirm().catch((e) => e)).toBeInstanceOf(GatewayIndeterminateError);
  });

  it('200 인데 본문이 JSON 이 아니면 성공도 실패도 단정하지 않는다', async () => {
    handler = (_q, res) => {
      res.writeHead(200);
      res.end('<html>gateway</html>');
    };
    expect(await confirm().catch((e) => e)).toBeInstanceOf(GatewayIndeterminateError);
  });

  it('200 인데 결제 객체 모양이 다르거나, 모르는 상태값이면 알 수 없음으로 처리한다', async () => {
    handler = (_q, res) => json(res, 200, { hello: 'world' });
    expect(await confirm().catch((e) => e)).toBeInstanceOf(GatewayIndeterminateError);
    handler = (_q, res) => json(res, 200, tossPayment({ status: 'SOMETHING_NEW' }));
    expect(await confirm().catch((e) => e)).toBeInstanceOf(GatewayIndeterminateError);
  });

  it('응답 도중 연결이 끊기면 알 수 없음이다', async () => {
    handler = (req) => req.socket.destroy();
    expect(await confirm().catch((e) => e)).toBeInstanceOf(GatewayIndeterminateError);
  });

  it('타임아웃이면 알 수 없음이다 (요청은 PG 에 닿았을 수 있다)', async () => {
    handler = () => {}; // 응답하지 않는다
    const t0 = Date.now();
    const err = await new TossGateway({ secretKey: 'k', baseUrl, defaultTimeoutMs: 150 }).confirm({ paymentKey: 'p', orderId: 'sb_order_1', amount: 1, idempotencyKey: 'k' }).catch((e) => e);
    expect(err).toBeInstanceOf(GatewayIndeterminateError);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('호출자가 신호로 취소해도 알 수 없음이다', async () => {
    handler = () => {};
    const ac = new AbortController();
    const p = gw(5_000).confirm({ paymentKey: 'p', orderId: 'sb_order_1', amount: 1, idempotencyKey: 'k' }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    expect(await p.catch((e) => e)).toBeInstanceOf(GatewayIndeterminateError);
  });

  it('PG 에 닿지 못하면(연결 거부) 알 수 없음이다', async () => {
    const dead = new TossGateway({ secretKey: 'k', baseUrl: 'http://127.0.0.1:1/v1/payments', defaultTimeoutMs: 1_000 });
    expect(await dead.confirm({ paymentKey: 'p', orderId: 'sb_order_1', amount: 1, idempotencyKey: 'k' }).catch((e) => e)).toBeInstanceOf(GatewayIndeterminateError);
  });

  it('조회: 404 NOT_FOUND_PAYMENT 는 null(PG 가 모르는 주문), 그 밖의 오류는 그대로 던진다', async () => {
    handler = (_q, res) => json(res, 404, { code: 'NOT_FOUND_PAYMENT', message: 'none' });
    expect(await gw().getByOrderId('sb_order_1')).toBeNull();
    handler = (_q, res) => json(res, 500, { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: 'x' });
    expect(await gw().getByOrderId('sb_order_1').catch((e) => e)).toBeInstanceOf(GatewayIndeterminateError);
  });
});

describe('상태 매핑', () => {
  it.each([
    ['READY', 'READY'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
    ['WAITING_FOR_DEPOSIT', 'IN_PROGRESS'],
    ['DONE', 'DONE'],
    ['CANCELED', 'CANCELED'],
    ['PARTIAL_CANCELED', 'PARTIAL_CANCELED'],
    ['ABORTED', 'FAILED'],
    ['EXPIRED', 'FAILED'],
  ])('%s → %s', (toss, ours) => {
    expect(mapTossStatus(toss)).toBe(ours);
  });
  it('모르는 상태는 추측하지 않고 던진다', () => {
    expect(() => mapTossStatus('NEW_STATE')).toThrow(GatewayIndeterminateError);
  });
});
