import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import type { AppContext } from '../src/server/context';
import { expireHolds } from '../src/server/bookings/expire';
import { createBooking } from '../src/server/bookings/create';
import { confirmPayment } from '../src/server/payments/confirm';
import { PortOneGateway } from '../src/server/payments/portone';
import { verifyPortOneWebhook } from '../src/server/payments/portone-webhook';
import { reconcilePayment } from '../src/server/payments/reconcile';
import { handlePgWebhook } from '../src/server/payments/webhook';
import { PaymentVerificationFailedError, SlotTakenError } from '../src/server/errors';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx } from './helpers/ctx';
import { futureWindow, idemKey, makeListing, makeUser, type Listing } from './helpers/fixtures';
import { book } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

/**
 * 포트원 V2 흐름 통합 테스트 — 실제 PostgreSQL + 포트원 API 를 흉내 내는 로컬 HTTP 서버.
 *
 * 토스와 다른 점이 핵심이다: 포트원(기본 설정)은 **결제창 안에서 결제가 끝난다.** 서버가 알기 전에 돈이 움직일 수 있으므로
 *  - 금액이 다르면 "확정하지 않는다"로는 부족하고 **자동 환불**까지 가야 하고,
 *  - "결제 대기 중 홀드 만료"를 "돈이 안 움직였다"로 볼 수 없다 → 슬롯을 풀기 전에 포트원에 확인한다.
 */
interface MockPayment {
  status: 'READY' | 'PAID' | 'FAILED' | 'CANCELLED';
  total: number;
  txId: string;
}
let server: Server;
let baseUrl: string;
const store = new Map<string, MockPayment>();
const cancels: string[] = [];

let db: TestDb;
let ctx: AppContext;
let listing: Listing;
let day = 5;
const nextDay = () => day++;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const m = /^\/payments\/([^/?]+)(\/cancel)?/.exec(req.url ?? '');
      const id = m ? decodeURIComponent(m[1]!) : '';
      const p = store.get(id);
      if (!p) return send(404, { type: 'PAYMENT_NOT_FOUND', message: '결제 건이 존재하지 않습니다.' });
      if (m?.[2]) {
        if (p.status === 'CANCELLED') return send(409, { type: 'PAYMENT_ALREADY_CANCELLED' });
        if (p.status !== 'PAID') return send(409, { type: 'PAYMENT_NOT_PAID' });
        p.status = 'CANCELLED';
        cancels.push(id);
        return send(200, { cancellation: { status: 'SUCCEEDED', totalAmount: p.total } });
      }
      send(200, {
        status: p.status,
        id,
        transactionId: p.txId,
        merchantId: 'merchant-test',
        storeId: 'store-test',
        method: { type: 'PaymentMethodCard' },
        amount: { total: p.total, taxFree: 0, discount: 0, paid: p.status === 'PAID' ? p.total : 0, cancelled: 0, cancelledTaxFree: 0 },
        currency: 'KRW',
        ...(p.status === 'PAID' ? { paidAt: new Date().toISOString() } : {}),
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  db = await createTestDb();
  const base = makeCtx(db.pool);
  ctx = { ...base.ctx, gateway: new PortOneGateway({ apiSecret: 'secret', baseUrl, defaultTimeoutMs: 2_000 }) };
  listing = await makeListing(db.pool, { hourlyPrice: 50_000, bufferMinutes: 30, commissionRateBp: 1000 });
});
afterAll(async () => {
  await db.drop();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  cancels.length = 0;
});

const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];
const bookingStatus = async (id: string) => (await q('SELECT status FROM bookings WHERE id = $1', [id]))[0].status as string;
const payRow = async (orderId: string) => (await q('SELECT * FROM payments WHERE order_id = $1', [orderId]))[0];
const slotStates = async (bookingId: string) => (await q('SELECT state FROM booking_slots WHERE booking_id = $1', [bookingId])).map((r) => r.state);
const expireHold = (bookingId: string) => q(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [bookingId]);
/** 대사는 진행 중일 수 있는 확인 호출과 겹치지 않도록 일정 시간이 지난 결제만 건드린다 — 테스트에서는 시간을 되감는다 */
const ageConfirm = (orderId: string) => q(`UPDATE payments SET confirm_started_at = now() - interval '2 minutes' WHERE order_id = $1`, [orderId]);
/** 고객이 포트원 결제창에서 결제를 끝까지 마쳤다 (서버는 아직 모른다) */
const payAtPortOne = (orderId: string, total: number) => {
  const txId = `tx_${randomUUID()}`;
  store.set(orderId, { status: 'PAID', total, txId });
  return txId;
};

describe('정상 결제', () => {
  it('결제창에서 결제 → 서버는 조회로 검증하고 확정한다 (승인 호출이 없다)', async () => {
    const user = await makeUser(db.pool);
    const b = await book(ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const txId = payAtPortOne(b.payment.orderId, b.payment.amount);

    const r = await confirmPayment(ctx, user, { paymentKey: txId, orderId: b.payment.orderId, amount: b.payment.amount });
    expect(r.status).toBe('CONFIRMED');
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(await payRow(b.payment.orderId)).toMatchObject({ status: 'APPROVED', payment_key: txId, method: 'Card' });
    expect(cancels).toEqual([]);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('토스에서는 없던 위험: 돈이 서버보다 먼저 움직인다', () => {
  it('결제창에서 금액을 고쳐 1,000원만 결제했다 → 확정하지 않고, 슬롯을 풀고, 그 1,000원은 자동 환불한다', async () => {
    const user = await makeUser(db.pool);
    const b = await book(ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const txId = payAtPortOne(b.payment.orderId, 1_000); // 서버 금액은 100,000원

    // 서버에는 정상 금액을 신고해서 1차 금액 대조를 통과하려 한다 → 포트원 조회에서 드러난다
    await expect(
      confirmPayment(ctx, user, { paymentKey: txId, orderId: b.payment.orderId, amount: b.payment.amount }),
    ).rejects.toBeInstanceOf(PaymentVerificationFailedError);

    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_FAILED');
    expect(await slotStates(b.booking.id)).toEqual(['RELEASED']);
    expect(cancels).toEqual([b.payment.orderId]); // 포트원 취소는 paymentId(= 우리 주문번호)로
    expect(await payRow(b.payment.orderId)).toMatchObject({ status: 'CANCELED', refund_pending: false, failure_reason: 'AMOUNT_OR_IDENTITY_MISMATCH' });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('결제를 마치고 서버에 알리기 전에 브라우저를 닫았고 웹훅도 유실됐다 → 홀드가 지나도 슬롯을 풀지 않고 확인해서 예약을 확정한다', async () => {
    const user = await makeUser(db.pool);
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(ctx, user, listing, win);
    payAtPortOne(b.payment.orderId, b.payment.amount);
    // …브라우저 종료, 웹훅 유실…
    await expireHold(b.booking.id);
    await expireHolds(ctx);

    // 토스였다면 여기서 EXPIRED 였다. 포트원에서는 돈이 움직였을 수 있으므로 슬롯을 쥔 채 확인 단계로 넘긴다
    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_CONFIRMING');
    expect(await slotStates(b.booking.id)).toEqual(['HELD']);
    await expect(book(ctx, await makeUser(db.pool), listing, win)).rejects.toBeInstanceOf(SlotTakenError);

    await ageConfirm(b.payment.orderId);
    const r = await reconcilePayment(ctx, (await payRow(b.payment.orderId)).id);
    expect(r.kind).toBe('confirmed');
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(cancels).toEqual([]);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('결제창을 열지도 않고 떠났다 → 확인해 보니 포트원에 결제가 없으므로 그때 슬롯을 푼다', async () => {
    const user = await makeUser(db.pool);
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(ctx, user, listing, win);
    await expireHold(b.booking.id);
    await expireHolds(ctx);
    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_CONFIRMING');

    await ageConfirm(b.payment.orderId);
    const r = await reconcilePayment(ctx, (await payRow(b.payment.orderId)).id);
    expect(r).toMatchObject({ kind: 'failed', reason: 'NOT_FOUND_AT_PG' });
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');
    expect(await slotStates(b.booking.id)).toEqual(['RELEASED']);
    const other = await book(ctx, await makeUser(db.pool), listing, win);
    expect(other.booking.status).toBe('PENDING_PAYMENT');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('홀드가 지난 뒤에 결제 결과를 들고 돌아와도, 결제가 끝났다면 확정한다 (슬롯은 아직 이 예약이 쥐고 있다)', async () => {
    const user = await makeUser(db.pool);
    const b = await book(ctx, user, listing, futureWindow(nextDay(), 1, 2));
    const txId = payAtPortOne(b.payment.orderId, b.payment.amount);
    await expireHold(b.booking.id); // 워커가 아직 돌지 않았다

    const r = await confirmPayment(ctx, user, { paymentKey: txId, orderId: b.payment.orderId, amount: b.payment.amount });
    expect(r.status).toBe('CONFIRMED');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('성공 신고 위조 · 늦은 결제', () => {
  it('결제하지 않고 성공 페이지만 호출했다 → "확인 중"으로 두고, 유예 뒤 실패로 정리해 슬롯을 영원히 붙잡지 못한다', async () => {
    const user = await makeUser(db.pool);
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(ctx, user, listing, win);
    store.set(b.payment.orderId, { status: 'READY', total: b.payment.amount, txId: 'tx_ready' }); // 결제창만 열었다

    const r = await confirmPayment(ctx, user, { paymentKey: 'tx_forged', orderId: b.payment.orderId, amount: b.payment.amount });
    expect(r.status).toBe('PROCESSING');
    expect(await bookingStatus(b.booking.id)).toBe('PAYMENT_CONFIRMING');

    await ageConfirm(b.payment.orderId);
    const rec = await reconcilePayment(ctx, (await payRow(b.payment.orderId)).id);
    expect(rec).toMatchObject({ kind: 'failed', reason: 'NOT_PAID_AT_PG' });
    // 홀드가 남아 있으므로 같은 예약에서 다시 결제할 수 있다 (거절과 같은 처리)
    expect(await bookingStatus(b.booking.id)).toBe('PENDING_PAYMENT');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('실패로 정리한 뒤에 결제가 완료됐다 → 웹훅이 오면 그 돈은 자동 환불된다 (예약은 되살리지 않는다)', async () => {
    const user = await makeUser(db.pool);
    const b = await book(ctx, user, listing, futureWindow(nextDay(), 1, 2));
    await expireHold(b.booking.id);
    await expireHolds(ctx);
    await ageConfirm(b.payment.orderId);
    await reconcilePayment(ctx, (await payRow(b.payment.orderId)).id); // 포트원에 없음 → 실패, 만료
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');

    payAtPortOne(b.payment.orderId, b.payment.amount); // 그 뒤에야 결제가 끝났다
    const payload = { type: 'Transaction.Paid', timestamp: new Date().toISOString(), data: { paymentId: b.payment.orderId, storeId: 'store-test', transactionId: 'tx' } };
    expect(await handlePgWebhook(ctx, { provider: 'portone', eventKey: randomUUID(), payload })).toBe('processed');

    expect(cancels).toEqual([b.payment.orderId]);
    expect(await payRow(b.payment.orderId)).toMatchObject({ status: 'CANCELED', failure_reason: 'LATE_CAPTURE' });
    expect(await bookingStatus(b.booking.id)).toBe('EXPIRED');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('웹훅 — 포트원 형식(data.paymentId)과 서명', () => {
  it('Transaction.Paid 웹훅만으로도(브라우저가 돌아오지 않아도) 결제를 확정한다 — 본문이 아니라 재조회 결과로', async () => {
    const user = await makeUser(db.pool);
    const b = await book(ctx, user, listing, futureWindow(nextDay(), 1, 2));
    payAtPortOne(b.payment.orderId, b.payment.amount);
    // 본문의 transactionId 는 엉터리여도 상관없다 — 쓰지 않는다
    const payload = { type: 'Transaction.Paid', timestamp: new Date().toISOString(), data: { paymentId: b.payment.orderId, storeId: 'x', transactionId: 'forged' } };
    expect(await handlePgWebhook(ctx, { provider: 'portone', eventKey: randomUUID(), payload })).toBe('processed');
    expect(await bookingStatus(b.booking.id)).toBe('CONFIRMED');
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  // Standard Webhooks 서명: base64(HMAC-SHA256(base64디코드(시크릿), "id.timestamp.body")) — 공식 SDK 가 검증한다
  const secretBytes = Buffer.from('slatebook-webhook-secret-for-tests');
  const secret = `whsec_${secretBytes.toString('base64')}`;
  const signedHeaders = (body: string, at = Math.floor(Date.now() / 1000), id = `msg_${randomUUID()}`) => {
    const sig = createHmac('sha256', secretBytes).update(`${id}.${at}.${body}`).digest('base64');
    return new Headers({ 'webhook-id': id, 'webhook-timestamp': String(at), 'webhook-signature': `v1,${sig}` });
  };
  const body = JSON.stringify({ type: 'Transaction.Paid', timestamp: '2026-10-03T00:00:00Z', data: { paymentId: 'sb_x', storeId: 's', transactionId: 't' } });

  it('올바른 서명은 통과한다', async () => {
    expect(await verifyPortOneWebhook(secret, body, signedHeaders(body))).toBeNull();
  });

  it('본문을 한 글자라도 바꾸면 거부한다', async () => {
    expect(await verifyPortOneWebhook(secret, body.replace('sb_x', 'sb_y'), signedHeaders(body))).toBe('NO_MATCHING_SIGNATURE');
  });

  it('서명 헤더가 없거나, 오래된 요청(재전송 공격)은 거부한다', async () => {
    expect(await verifyPortOneWebhook(secret, body, new Headers())).toBe('MISSING_REQUIRED_HEADERS');
    expect(await verifyPortOneWebhook(secret, body, signedHeaders(body, Math.floor(Date.now() / 1000) - 3600))).toBe('TIMESTAMP_TOO_OLD');
  });
});

describe('토스·가짜 PG 의 동작은 바뀌지 않았다', () => {
  it('서버 승인 전에는 돈이 움직이지 않는 PG 에서는 홀드가 지나면 확인 없이 바로 푼다', async () => {
    const fake = makeCtx(db.pool);
    const user = await makeUser(db.pool);
    const { response } = await createBooking(fake.ctx, user, idemKey(), { listingId: listing.id, ...futureWindow(nextDay(), 1, 2) });
    await expireHold(response.booking.id);
    expect(await expireHolds(fake.ctx)).toBe(1);
    expect(await bookingStatus(response.booking.id)).toBe('EXPIRED');
  });
});
