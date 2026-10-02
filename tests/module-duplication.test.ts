import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getFakeGateway } from '../src/server/context';
import { FakeGateway } from '../src/server/payments/fake';
import { confirmPayment } from '../src/server/payments/confirm';
import { PaymentDeclinedError } from '../src/server/errors';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, makeListing, makeUser } from './helpers/fixtures';
import { book } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

/**
 * 실제로 겪은 버그의 재현: Next.js 는 같은 소스를 번들마다 복사해 넣는다.
 * 서버 시작 시 instrumentation 번들이 만든 PG 어댑터가 던진 오류를, 라우트 번들의 `instanceof` 가 알아보지 못해
 * 카드 거절이 "결과 알 수 없음"(PROCESSING)으로 둔갑했다. (통합 테스트는 모듈 복사본이 하나뿐이라 못 잡았고 e2e 가 잡았다.)
 * vi.resetModules() 로 모듈을 한 번 더 로드해 같은 상황을 만든다.
 */
let db: TestDb;
let t: TestCtx;
beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool);
});
afterAll(() => db.drop());

describe('모듈 복사본이 둘일 때', () => {
  it('다른 복사본의 PG 어댑터가 던진 "거절"도 거절로 처리한다 (instanceof 가 아닌 낙인으로 판별)', async () => {
    vi.resetModules();
    const dup = await import('../src/server/payments/fake');
    const otherCopy = new dup.FakeGateway();
    expect(dup.FakeGateway).not.toBe(FakeGateway); // 정말 다른 클래스다
    expect(otherCopy instanceof FakeGateway).toBe(false);

    const ctx = { ...t.ctx, gateway: otherCopy };
    const listing = await makeListing(db.pool);
    const user = await makeUser(db.pool);
    const b = await book(ctx, user, listing, futureWindow(10, 1, 2));
    const paymentKey = otherCopy.authenticate({ orderId: b.payment.orderId, amount: b.payment.amount });
    otherCopy.script('decline', b.payment.orderId);

    await expect(confirmPayment(ctx, user, { paymentKey, orderId: b.payment.orderId, amount: b.payment.amount })).rejects.toBeInstanceOf(PaymentDeclinedError);
    expect((await db.pool.query('SELECT status FROM payments WHERE order_id = $1', [b.payment.orderId])).rows[0].status).toBe('FAILED');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('데모 가짜 PG 판별도 클래스 동일성이 아니라 이름으로 한다', async () => {
    vi.resetModules();
    const dup = await import('../src/server/payments/fake');
    expect(getFakeGateway({ ...t.ctx, gateway: new dup.FakeGateway() })).not.toBeNull();
  });
});
