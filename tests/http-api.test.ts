import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { POST as bookingsPOST } from '../src/app/api/bookings/route';
import { GET as bookingGET } from '../src/app/api/bookings/[id]/route';
import { POST as retryPOST } from '../src/app/api/bookings/[id]/payments/route';
import { GET as availabilityGET } from '../src/app/api/listings/[id]/availability/route';
import { POST as confirmPOST } from '../src/app/api/payments/confirm/route';
import { POST as webhookPOST } from '../src/app/api/webhooks/pg/route';
import { DELETE as logoutDELETE, POST as loginPOST } from '../src/app/api/demo/login/route';
import { GET as usersGET } from '../src/app/api/demo/users/route';
import { POST as fakeAuthPOST } from '../src/app/api/fake-pg/authorize/route';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, idemKey, makeListing, type Listing } from './helpers/fixtures';

/**
 * HTTP 계층: 인증·형식 검사·상태 코드·오류 본문. 실제 라우트 핸들러를 Request 로 직접 호출한다.
 * (getContext() 가 읽는 전역 슬롯에 테스트용 컨텍스트를 꽂는다.)
 */
const WEBHOOK_TOKEN = 'w'.repeat(32);
let db: TestDb;
let t: TestCtx;
let listing: Listing;
let alice: string;
let bob: string;
let day = 5;
const nextDay = () => day++;

const SLOT = Symbol.for('slatebook.context');
const install = (ctx: unknown) => ((globalThis as Record<symbol, unknown>)[SLOT] = ctx);

async function demoUser(name: string) {
  const id = randomUUID();
  await db.pool.query('INSERT INTO users(id, email, name) VALUES ($1, $2, $3)', [id, `${name}-${id}@demo.slatebook.local`, name]);
  return id;
}

beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool, { demoAuth: true, webhookToken: WEBHOOK_TOKEN });
  listing = await makeListing(db.pool, { hourlyPrice: 50_000, bufferMinutes: 30 });
  alice = await demoUser('alice');
  bob = await demoUser('bob');
});
afterAll(() => db.drop());
beforeEach(() => install(t.ctx));

const asUser = (id: string | null): Record<string, string> => (id ? { cookie: `sb_uid=${id}` } : {});
function req(method: string, path: string, opts: { user?: string | null; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...asUser(opts.user ?? null), ...opts.headers };
  let body: string | undefined;
  if (opts.raw !== undefined) body = opts.raw;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] ??= 'application/json';
  }
  return new Request(`http://localhost${path}`, { method, headers, body });
}
const ctxParams = (id: string) => ({ params: Promise.resolve({ id }) });
const bookBody = (win: { start: string; end: string }) => ({ listingId: listing.id, ...win });
const call = async (res: Response) => ({ status: res.status, body: await res.json().catch(() => null), headers: res.headers });

async function createViaApi(user: string, win = futureWindow(nextDay(), 1, 2)) {
  const r = await call(await bookingsPOST(req('POST', '/api/bookings', { user, body: bookBody(win), headers: { 'idempotency-key': idemKey() } })));
  expect(r.status).toBe(201);
  return r.body as { booking: { id: string }; payment: { orderId: string; amount: number } };
}

describe('인증 (데모 쿠키)', () => {
  it.each([
    ['쿠키 없음', null],
    ['UUID 형식이 아닌 값', 'admin'],
    ['SQL 조각', "x' OR '1'='1"],
    ['존재하지 않는 사용자 id', randomUUID()],
  ])('%s → 401', async (_n, cookieValue) => {
    const headers: Record<string, string> = cookieValue === null ? {} : { cookie: `sb_uid=${encodeURIComponent(cookieValue)}` };
    const r = await call(await bookingsPOST(req('POST', '/api/bookings', { body: bookBody(futureWindow(nextDay(), 1, 1)), headers: { ...headers, 'idempotency-key': idemKey() } })));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHORIZED');
  });

  it('DEMO_AUTH 가 꺼져 있으면 올바른 쿠키여도 401 이고 데모 로그인 API 는 404 다', async () => {
    const off = makeCtx(db.pool, { demoAuth: false });
    install(off.ctx);
    expect((await call(await bookingsPOST(req('POST', '/api/bookings', { user: alice, body: bookBody(futureWindow(nextDay(), 1, 1)), headers: { 'idempotency-key': idemKey() } })))).status).toBe(401);
    expect((await call(await loginPOST(req('POST', '/api/demo/login', { body: { userId: alice } })))).status).toBe(404);
    expect((await call(await usersGET(req("GET", "/api/demo/users")))).status).toBe(404);
  });

  it('로그인은 HttpOnly·SameSite=Lax 쿠키를 심고, 데모 사용자가 아니면 거부한다. 로그아웃은 쿠키를 지운다', async () => {
    const ok = await loginPOST(req('POST', '/api/demo/login', { body: { userId: alice } }));
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get('set-cookie')!;
    expect(cookie).toContain(`sb_uid=${alice}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const notDemo = (await db.pool.query(`INSERT INTO users(email, name) VALUES ('real@example.com', 'real') RETURNING id`)).rows[0].id;
    expect((await loginPOST(req('POST', '/api/demo/login', { body: { userId: notDemo } }))).status).toBe(404);
    expect((await loginPOST(req('POST', '/api/demo/login', { body: { userId: 'not-a-uuid' } }))).status).toBe(400);
    expect((await logoutDELETE()).headers.get('set-cookie')).toMatch(/Max-Age=0/);

    const users = await call(await usersGET(req("GET", "/api/demo/users", { user: alice })));
    expect(users.body.current).toBe(alice);
    expect(users.body.users.map((u: { name: string }) => u.name)).toEqual(expect.arrayContaining(['alice', 'bob']));
    expect(JSON.stringify(users.body)).not.toContain('real@example.com');
  });
});

describe('POST /api/bookings', () => {
  it('201 로 생성, 같은 키로 다시 보내면 200 으로 같은 본문', async () => {
    const win = futureWindow(nextDay(), 1, 2);
    const key = idemKey();
    const first = await call(await bookingsPOST(req('POST', '/api/bookings', { user: alice, body: bookBody(win), headers: { 'idempotency-key': key } })));
    const again = await call(await bookingsPOST(req('POST', '/api/bookings', { user: alice, body: bookBody(win), headers: { 'idempotency-key': key } })));
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(first.body.booking).toMatchObject({ status: 'PENDING_PAYMENT', totalAmount: 100_000, listingTitle: 'A홀' });
    expect(first.body.payment).toMatchObject({ amount: 100_000, orderName: 'A홀' });
    expect(first.headers.get('cache-control')).toBe('no-store');
  });

  it('Idempotency-Key 가 없으면 400, JSON 이 아니면 415, 깨진 JSON 은 400, 너무 크면 413', async () => {
    const win = futureWindow(nextDay(), 1, 1);
    expect((await call(await bookingsPOST(req('POST', '/api/bookings', { user: alice, body: bookBody(win) })))).status).toBe(400);
    expect((await call(await bookingsPOST(req('POST', '/api/bookings', { user: alice, raw: 'listingId=1', headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idemKey() } })))).status).toBe(415);
    expect((await call(await bookingsPOST(req('POST', '/api/bookings', { user: alice, raw: '{not json', headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() } })))).status).toBe(400);
    const big = JSON.stringify({ listingId: listing.id, pad: 'x'.repeat(20_000) });
    expect((await call(await bookingsPOST(req('POST', '/api/bookings', { user: alice, raw: big, headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() } })))).status).toBe(413);
  });

  it('이미 예약된 시간이면 409 SLOT_TAKEN, 같은 키로 다른 내용이면 422, 잘못된 입력은 400 — 오류 본문 모양이 일정하다', async () => {
    const win = futureWindow(nextDay(), 1, 2);
    await createViaApi(alice, win);
    const taken = await call(await bookingsPOST(req('POST', '/api/bookings', { user: bob, body: bookBody(win), headers: { 'idempotency-key': idemKey() } })));
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({ error: { code: 'SLOT_TAKEN', message: expect.any(String) } });

    const key = idemKey();
    await bookingsPOST(req('POST', '/api/bookings', { user: bob, body: bookBody(futureWindow(nextDay(), 1, 1)), headers: { 'idempotency-key': key } }));
    const reused = await call(await bookingsPOST(req('POST', '/api/bookings', { user: bob, body: bookBody(futureWindow(nextDay(), 1, 1)), headers: { 'idempotency-key': key } })));
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    const bad = await call(await bookingsPOST(req('POST', '/api/bookings', { user: bob, body: { ...bookBody(win), amount: 1 }, headers: { 'idempotency-key': idemKey() } })));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION');
  });
});

describe('GET /api/bookings/:id', () => {
  it('본인에게는 상태를, 다른 사람이나 형식이 잘못된 id 에게는 똑같이 404', async () => {
    const b = await createViaApi(alice);
    const mine = await call(await bookingGET(req('GET', `/api/bookings/${b.booking.id}`, { user: alice }), ctxParams(b.booking.id)));
    expect(mine.status).toBe(200);
    expect(mine.body.booking.id).toBe(b.booking.id);
    const theirs = await call(await bookingGET(req('GET', `/api/bookings/${b.booking.id}`, { user: bob }), ctxParams(b.booking.id)));
    const missing = await call(await bookingGET(req('GET', '/api/bookings/x', { user: alice }), ctxParams(randomUUID())));
    const malformed = await call(await bookingGET(req('GET', '/api/bookings/x', { user: alice }), ctxParams('not-a-uuid')));
    expect([theirs.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
    expect((await call(await bookingGET(req('GET', `/api/bookings/${b.booking.id}`), ctxParams(b.booking.id)))).status).toBe(401);
  });
});

describe('POST /api/payments/confirm', () => {
  const confirm = async (user: string | null, body: unknown) => call(await confirmPOST(req('POST', '/api/payments/confirm', { user, body })));
  const authorize = async (user: string, orderId: string, outcome: string) => call(await fakeAuthPOST(req('POST', '/api/fake-pg/authorize', { user, body: { orderId, outcome } })));

  it('200 CONFIRMED — 가짜 PG 결제창을 거친 전체 흐름', async () => {
    const b = await createViaApi(alice);
    const auth = await authorize(alice, b.payment.orderId, 'success');
    expect(auth.status).toBe(200);
    const r = await confirm(alice, { paymentKey: auth.body.paymentKey, orderId: b.payment.orderId, amount: auth.body.amount });
    expect(r).toMatchObject({ status: 200, body: { status: 'CONFIRMED', bookingId: b.booking.id } });
    const after = await call(await bookingGET(req('GET', '/x', { user: alice }), ctxParams(b.booking.id)));
    expect(after.body.booking.status).toBe('CONFIRMED');
    expect(after.body.payment).toBeNull();
  });

  it('금액 위변조는 400 AMOUNT_MISMATCH(+예약 id), 남의 주문은 404, 형식 오류는 400', async () => {
    const b = await createViaApi(alice);
    const auth = await authorize(alice, b.payment.orderId, 'success');
    const forged = await confirm(alice, { paymentKey: auth.body.paymentKey, orderId: b.payment.orderId, amount: 1_000 });
    expect(forged.status).toBe(400);
    expect(forged.body.error).toMatchObject({ code: 'AMOUNT_MISMATCH', details: { bookingId: b.booking.id } });
    expect((await confirm(bob, { paymentKey: auth.body.paymentKey, orderId: b.payment.orderId, amount: auth.body.amount })).status).toBe(404);
    expect((await confirm(alice, { paymentKey: 'k', orderId: 'x', amount: 1 })).status).toBe(400);
    expect((await confirm(null, { paymentKey: 'k', orderId: 'sb_abcdef', amount: 1 })).status).toBe(401);
  });

  it('카드 거절은 422 PAYMENT_DECLINED(+예약 id) 이고, 새 주문으로 재결제해 성공한다', async () => {
    const b = await createViaApi(alice);
    const auth = await authorize(alice, b.payment.orderId, 'decline_on_confirm');
    const declined = await confirm(alice, { paymentKey: auth.body.paymentKey, orderId: b.payment.orderId, amount: auth.body.amount });
    expect(declined.status).toBe(422);
    expect(declined.body.error).toMatchObject({ code: 'PAYMENT_DECLINED', details: { pgCode: 'REJECT_CARD_COMPANY', bookingId: b.booking.id } });

    const retry = await call(await retryPOST(req('POST', '/x', { user: alice }), ctxParams(b.booking.id)));
    expect(retry.status).toBe(200);
    expect(retry.body.payment.orderId).not.toBe(b.payment.orderId);
    const auth2 = await authorize(alice, retry.body.payment.orderId, 'success');
    expect((await confirm(alice, { paymentKey: auth2.body.paymentKey, orderId: retry.body.payment.orderId, amount: auth2.body.amount })).status).toBe(200);
  });

  it('승인 응답이 유실되면 202 PROCESSING 이고, 상태를 조회하면 대사가 확정해 준다', async () => {
    const b = await createViaApi(alice);
    const auth = await authorize(alice, b.payment.orderId, 'timeout_after_capture');
    const r = await confirm(alice, { paymentKey: auth.body.paymentKey, orderId: b.payment.orderId, amount: auth.body.amount });
    expect(r).toMatchObject({ status: 202, body: { status: 'PROCESSING', bookingId: b.booking.id } });
    const view = await call(await bookingGET(req('GET', '/x', { user: alice }), ctxParams(b.booking.id)));
    expect(view.body.booking.status).toBe('CONFIRMED'); // 이 조회가 PG 를 확인해 확정했다
  });

  it('홀드가 지난 뒤에는 410 HOLD_EXPIRED', async () => {
    const b = await createViaApi(alice);
    const auth = await authorize(alice, b.payment.orderId, 'success');
    await db.pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [b.booking.id]);
    const r = await confirm(alice, { paymentKey: auth.body.paymentKey, orderId: b.payment.orderId, amount: auth.body.amount });
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('HOLD_EXPIRED');
  });

  it('가짜 PG 결제창 API 는 남의 주문·이미 처리된 주문에는 동작하지 않는다', async () => {
    const b = await createViaApi(alice);
    expect((await authorize(bob, b.payment.orderId, 'success')).status).toBe(404);
    expect((await call(await fakeAuthPOST(req('POST', '/x', { body: { orderId: b.payment.orderId, outcome: 'success' } })))).status).toBe(401);
    expect((await call(await fakeAuthPOST(req('POST', '/x', { user: alice, body: { orderId: b.payment.orderId, outcome: 'free-money' } })))).status).toBe(400);
  });
});

describe('GET /api/listings/:id/availability', () => {
  it('200 은 칸 목록, 잘못된 날짜는 400, 모르는 상품·잘못된 id 는 404', async () => {
    const date = new Date(Date.now() + 9 * 3_600_000 + 20 * 86_400_000).toISOString().slice(0, 10);
    const ok = await call(await availabilityGET(req('GET', `/api/listings/${listing.id}/availability?date=${date}`), ctxParams(listing.id)));
    expect(ok.status).toBe(200);
    expect(ok.body.cells).toHaveLength(48);
    expect((await call(await availabilityGET(req('GET', `/x?date=2026-02-31`), ctxParams(listing.id)))).status).toBe(400);
    expect((await call(await availabilityGET(req('GET', `/x`), ctxParams(listing.id)))).status).toBe(400);
    expect((await call(await availabilityGET(req('GET', `/x?date=${date}`), ctxParams(randomUUID())))).status).toBe(404);
    expect((await call(await availabilityGET(req('GET', `/x?date=${date}`), ctxParams('1; DROP TABLE users')))).status).toBe(404);
  });
});

describe('POST /api/webhooks/pg', () => {
  const hook = (token: string | null, body: unknown, raw?: string) =>
    webhookPOST(
      new Request(`http://localhost/api/webhooks/pg${token === null ? '' : `?token=${encodeURIComponent(token)}`}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw ?? JSON.stringify(body),
      }),
    );

  it('토큰이 없거나 틀리면 401, 서버에 토큰이 설정돼 있지 않으면 누구에게도 열지 않는다', async () => {
    const payload = { data: { orderId: 'sb_whatever_1' } };
    expect((await hook(null, payload)).status).toBe(401);
    expect((await hook('wrong', payload)).status).toBe(401);
    expect((await hook('w'.repeat(31), payload)).status).toBe(401);
    install(makeCtx(db.pool, { webhookToken: undefined }).ctx);
    expect((await hook('', payload)).status).toBe(401);
    expect((await hook('undefined', payload)).status).toBe(401);
  });

  it('깨진 JSON 은 400, 너무 큰 본문은 413, 올바른 웹훅은 200 이고 같은 본문의 재전송은 duplicate', async () => {
    expect((await hook(WEBHOOK_TOKEN, null, '{broken')).status).toBe(400);
    expect((await hook(WEBHOOK_TOKEN, null, JSON.stringify({ pad: 'x'.repeat(70_000) }))).status).toBe(413);

    const b = await createViaApi(alice);
    t.gateway.authenticate({ orderId: b.payment.orderId, amount: b.payment.amount });
    t.gateway.capture(b.payment.orderId);
    const payload = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-10-02T10:00:00+09:00', data: { orderId: b.payment.orderId, status: 'DONE' } };
    const first = await call(await hook(WEBHOOK_TOKEN, payload));
    const second = await call(await hook(WEBHOOK_TOKEN, payload));
    expect(first).toMatchObject({ status: 200, body: { status: 'processed' } });
    expect(second).toMatchObject({ status: 200, body: { status: 'duplicate' } });
    expect((await db.pool.query('SELECT status FROM bookings WHERE id = $1', [b.booking.id])).rows[0].status).toBe('CONFIRMED');
  });

  it('처리 중 예상 밖 오류가 나면 5xx 로 응답해 PG 가 재전송하게 하고, 내부 정보는 응답에 싣지 않는다', async () => {
    const b = await createViaApi(alice);
    t.gateway.authenticate({ orderId: b.payment.orderId, amount: b.payment.amount });
    const original = t.gateway.getByOrderId.bind(t.gateway);
    t.gateway.getByOrderId = async () => {
      throw new Error('secret internal detail: db password is hunter2');
    };
    try {
      const r = await call(await hook(WEBHOOK_TOKEN, { data: { orderId: b.payment.orderId } }));
      expect(r.status).toBe(500);
      expect(r.body.error.code).toBe('INTERNAL');
      expect(JSON.stringify(r.body)).not.toMatch(/hunter2|secret internal/);
      expect(r.body.error.message).toMatch(/오류 번호 [0-9a-f]{8}/);
    } finally {
      t.gateway.getByOrderId = original;
    }
  });
});
