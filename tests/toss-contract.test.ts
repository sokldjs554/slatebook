import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TossGateway } from '../src/server/payments/toss';
import { runTossContractChecks } from '../src/server/payments/toss-contract';

/**
 * 계약 확인 도구 자체의 검증. 로컬 모의 서버로 "토스가 문서대로 답하는 경우"와 "다르게 답하는 경우"를 흉내 내,
 * 도구가 올바른 경우는 통과시키고 어긋난 경우는 실제로 실패로 보고하는지 확인한다.
 * (실제 토스 API 에 대한 실행은 이 환경에서 할 수 없다 — `npm run toss:check`.)
 */
let server: Server;
let baseUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/payments`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const make = (key: string, timeoutMs?: number) => new TossGateway({ secretKey: key, baseUrl, defaultTimeoutMs: timeoutMs ?? 2_000 });
const run = () => runTossContractChecks(make('test_sk_good'), { makeGateway: make });

describe('토스 계약 확인 도구', () => {
  it('토스가 문서대로 답하면 모든 확인을 통과한다', async () => {
    handler = (req, res) => {
      const auth = req.headers.authorization ?? '';
      if (auth !== 'Basic ' + Buffer.from('test_sk_good:').toString('base64')) return send(res, 401, { code: 'UNAUTHORIZED_KEY', message: '인증되지 않은 시크릿 키 혹은 클라이언트 키 입니다.' });
      if (req.url!.includes('/orders/')) return send(res, 404, { code: 'NOT_FOUND_PAYMENT', message: '존재하지 않는 결제 입니다.' });
      if (req.url!.endsWith('/confirm')) return send(res, 404, { code: 'NOT_FOUND_PAYMENT_SESSION', message: '결제 시간이 만료되어 결제 진행 데이터가 존재하지 않습니다.' });
      return send(res, 404, { code: 'NOT_FOUND_PAYMENT', message: '존재하지 않는 결제 입니다.' });
    };
    const results = await run();
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(6);
  });

  it('PG 가 승인 요청에 5xx 로 답하면 "확정된 실패" 확인이 실패로 보고된다 (도구가 어긋남을 잡아낸다)', async () => {
    handler = (req, res) => {
      if (req.url!.includes('/orders/')) return send(res, 404, { code: 'NOT_FOUND_PAYMENT', message: 'x' });
      return send(res, 500, { code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: 'x' });
    };
    const failed = (await run()).filter((r) => !r.ok).map((r) => r.name);
    expect(failed).toContain('승인: 존재하지 않는 paymentKey');
    expect(failed).toContain('취소: 존재하지 않는 paymentKey');
  });

  it('주문 조회가 404 가 아닌 다른 코드로 답하면 실패로 보고하고, 관측한 코드를 보여준다', async () => {
    handler = (_req, res) => send(res, 400, { code: 'SOMETHING_NEW', message: 'x' });
    const lookup = (await run()).find((r) => r.name.startsWith('주문 조회'))!;
    expect(lookup.ok).toBe(false);
    expect(lookup.observed).toContain('SOMETHING_NEW');
  });

  it('응답하지 않는 서버에서 타임아웃은 "알 수 없음"으로 분류된다', async () => {
    handler = () => {}; // 응답 없음
    const tiny = new TossGateway({ secretKey: 'k', baseUrl, defaultTimeoutMs: 80 });
    const results = await runTossContractChecks(tiny, { timeoutMs: 80, makeGateway: (k, ms) => new TossGateway({ secretKey: k, baseUrl, defaultTimeoutMs: ms ?? 80 }) });
    expect(results.find((r) => r.name.startsWith('타임아웃'))!.ok).toBe(true);
    // 다른 확인들은 "알 수 없음"이라 "확정된 실패"를 기대하는 항목이 실패한다 — 응답 없는 PG 에 대해 성급히 실패로 단정하지 않는다는 뜻
    expect(results.find((r) => r.name.startsWith('승인: 존재하지 않는'))!.ok).toBe(false);
  });
});
