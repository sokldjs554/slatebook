import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PortOneGateway } from '../src/server/payments/portone';
import { runPortOneContractChecks } from '../src/server/payments/portone-contract';

/**
 * 포트원 계약 확인 도구 자체의 검증. 로컬 모의 서버로 "포트원이 SDK 타입대로 답하는 경우"와 "다르게 답하는 경우"를 흉내 내,
 * 도구가 올바른 경우는 통과시키고 어긋난 경우는 실제로 실패로 보고하는지 확인한다.
 * (실제 포트원 API 에 대한 실행은 이 환경에서 할 수 없다 — `npm run portone:check`.)
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
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const make = (secret: string, timeoutMs?: number) => new PortOneGateway({ apiSecret: secret, baseUrl, defaultTimeoutMs: timeoutMs ?? 2_000 });
const run = () => runPortOneContractChecks(make('good-secret'), { makeGateway: make });

describe('포트원 계약 확인 도구', () => {
  it('포트원이 SDK 타입대로 답하면 모든 확인을 통과한다', async () => {
    handler = (req, res) => {
      if (req.headers.authorization !== 'PortOne good-secret') return send(res, 401, { type: 'UNAUTHORIZED', message: '인증 정보가 올바르지 않습니다.' });
      return send(res, 404, { type: 'PAYMENT_NOT_FOUND', message: '결제 건이 존재하지 않습니다.' });
    };
    const results = await run();
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(results).toHaveLength(5);
  });

  it('없는 결제의 취소에 5xx 로 답하면 "확정된 실패" 확인이 실패로 보고된다 (도구가 어긋남을 잡아낸다)', async () => {
    handler = (req, res) => {
      if (req.headers.authorization !== 'PortOne good-secret') return send(res, 401, { type: 'UNAUTHORIZED' });
      return req.method === 'POST' ? send(res, 500, { type: 'UNKNOWN', message: 'x' }) : send(res, 404, { type: 'PAYMENT_NOT_FOUND' });
    };
    const failed = (await run()).filter((r) => !r.ok).map((r) => r.name);
    expect(failed).toEqual(['취소: 존재하지 않는 paymentId']);
  });

  it('조회가 404 가 아닌 다른 종류로 답하면 실패로 보고하고, 관측한 종류를 보여준다', async () => {
    handler = (_req, res) => send(res, 400, { type: 'SOMETHING_NEW', message: 'x' });
    const lookup = (await run()).find((r) => r.name.startsWith('조회'))!;
    expect(lookup.ok).toBe(false);
    expect(lookup.observed).toContain('SOMETHING_NEW');
  });
});
