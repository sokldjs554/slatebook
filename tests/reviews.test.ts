import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createReview } from '../src/server/reviews/create';
import { listReviews } from '../src/server/reviews/list';
import { setReviewVisibility } from '../src/server/reviews/moderate';
import { toBookingResponse, findBookingById } from '../src/server/bookings/rows';
import { confirmPayment } from '../src/server/payments/confirm';
import {
  NotFoundError,
  ReviewExistsError,
  ReviewNotAllowedError,
  ReviewWindowClosedError,
  ValidationError,
} from '../src/server/errors';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, makeListing, makeUser, type Listing } from './helpers/fixtures';
import { book, completedBooking, payAtPg } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

let db: TestDb;
let t: TestCtx;
let listing: Listing;
let day = 5;
const nextDay = () => day++;

beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool);
  listing = await makeListing(db.pool, { bufferMinutes: 0 });
});
afterAll(() => db.drop());

const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];
const agg = async (listingId: string) => (await q('SELECT rating_count, rating_sum FROM listings WHERE id = $1', [listingId]))[0];
const view = async (bookingId: string) => toBookingResponse(db.pool, (await findInvariantBooking(bookingId))!);
const findInvariantBooking = (id: string) => findBookingById(db.pool, id);

async function newCompleted(opts: { user?: string; completedDaysAgo?: number; on?: Listing } = {}) {
  const user = opts.user ?? (await makeUser(db.pool, '리뷰어'));
  const l = opts.on ?? listing;
  const { bookingId } = await completedBooking(t.ctx, t.gateway, db.pool, user, l, futureWindow(nextDay(), 1, 1), { completedDaysAgo: opts.completedDaysAgo });
  return { user, bookingId };
}

describe('후기 작성', () => {
  it('이용 완료 예약에 후기를 남기면 후기가 저장되고 상품 평점 집계가 함께 갱신된다', async () => {
    const own = await makeListing(db.pool);
    const { user, bookingId } = await newCompleted({ on: own });
    expect((await view(bookingId)).canReview).toBe(true);

    const r = await createReview(t.ctx, user, bookingId, { rating: 4, body: '  조명이 좋았어요  ' });
    expect(r).toMatchObject({ rating: 4, body: '조명이 좋았어요', authorName: '리**' });
    expect(await agg(own.id)).toEqual({ rating_count: 1, rating_sum: 4 });

    const after = await view(bookingId);
    expect(after.canReview).toBe(false);
    expect(after.review).toMatchObject({ id: r.id, rating: 4 });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('본문은 선택 사항이고, 공백뿐이면 본문 없음으로 저장한다. HTML 은 가공하지 않고 그대로 보관한다 (출력할 때 React 가 이스케이프)', async () => {
    const a = await newCompleted();
    expect((await createReview(t.ctx, a.user, a.bookingId, { rating: 5 })).body).toBeNull();
    const b = await newCompleted();
    expect((await createReview(t.ctx, b.user, b.bookingId, { rating: 5, body: '   \n  ' })).body).toBeNull();
    const c = await newCompleted();
    const html = '<script>alert(1)</script> 😀 줄바꿈\n두 번째 줄';
    expect((await createReview(t.ctx, c.user, c.bookingId, { rating: 3, body: html })).body).toBe(html);
    const d = await newCompleted();
    expect((await createReview(t.ctx, d.user, d.bookingId, { rating: 3, body: 'x'.repeat(1000) })).body).toHaveLength(1000);
  });

  it('남의 예약이든 없는 예약이든 똑같이 404', async () => {
    const { bookingId } = await newCompleted();
    const e1 = await createReview(t.ctx, await makeUser(db.pool), bookingId, { rating: 5 }).catch((e) => e);
    const e2 = await createReview(t.ctx, await makeUser(db.pool), randomUUID(), { rating: 5 }).catch((e) => e);
    expect(e1).toBeInstanceOf(NotFoundError);
    expect(e2).toBeInstanceOf(NotFoundError);
    expect(e1.message).toBe(e2.message);
  });

  it('이용이 끝나지 않은 예약(결제 대기·확정·만료)에는 후기를 쓸 수 없다', async () => {
    const user = await makeUser(db.pool);
    const pending = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 1));
    await expect(createReview(t.ctx, user, pending.booking.id, { rating: 5 })).rejects.toBeInstanceOf(ReviewNotAllowedError);

    const confirmed = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 1));
    await confirmPayment(t.ctx, user, payAtPg(t.gateway, confirmed.payment));
    await expect(createReview(t.ctx, user, confirmed.booking.id, { rating: 5 })).rejects.toBeInstanceOf(ReviewNotAllowedError);

    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [pending.booking.id]);
    expect((await view(pending.booking.id)).canReview).toBe(false);
    expect(await q('SELECT 1 FROM reviews WHERE booking_id = ANY($1)', [[pending.booking.id, confirmed.booking.id]])).toHaveLength(0);
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('완료 후 30일 안에만 쓸 수 있다: 29일 뒤는 가능, 31일 뒤는 410 이고 canReview 도 false', async () => {
    const ok = await newCompleted({ completedDaysAgo: 29 });
    expect((await view(ok.bookingId)).canReview).toBe(true);
    await expect(createReview(t.ctx, ok.user, ok.bookingId, { rating: 5 })).resolves.toBeTruthy();

    const late = await newCompleted({ completedDaysAgo: 31 });
    expect((await view(late.bookingId)).canReview).toBe(false);
    await expect(createReview(t.ctx, late.user, late.bookingId, { rating: 5 })).rejects.toBeInstanceOf(ReviewWindowClosedError);
  });

  it('같은 예약에 두 번 쓰면 409. 동시에 10번 제출해도 후기는 1건이고 집계도 1건분이다', async () => {
    const own = await makeListing(db.pool);
    const { user, bookingId } = await newCompleted({ on: own });
    await createReview(t.ctx, user, bookingId, { rating: 5 });
    await expect(createReview(t.ctx, user, bookingId, { rating: 1 })).rejects.toBeInstanceOf(ReviewExistsError);
    expect(await agg(own.id)).toEqual({ rating_count: 1, rating_sum: 5 }); // 두 번째 시도는 점수를 바꾸지 못한다

    const own2 = await makeListing(db.pool);
    const second = await newCompleted({ on: own2 });
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => createReview(t.ctx, second.user, second.bookingId, { rating: 4 })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of rs.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) expect(r.reason).toBeInstanceOf(ReviewExistsError);
    expect(await agg(own2.id)).toEqual({ rating_count: 1, rating_sum: 4 });
  });

  it.each([
    ['평점 0', { rating: 0 }],
    ['평점 6', { rating: 6 }],
    ['평점 소수', { rating: 3.5 }],
    ['평점 문자열', { rating: '5' }],
    ['평점 없음', { body: 'hi' }],
    ['평점 null', { rating: null }],
    ['본문 1001자', { rating: 5, body: 'x'.repeat(1001) }],
    ['본문에 NUL 문자', { rating: 5, body: 'a\u0000b' }],
    ['본문이 숫자', { rating: 5, body: 123 }],
    ['여분 필드: 상태 조작', { rating: 5, status: 'HIDDEN' }],
    ['여분 필드: 작성자 조작', { rating: 5, authorId: randomUUID() }],
    ['본문 자체가 null', null],
  ])('잘못된 입력(%s)은 400 이고 아무것도 저장하지 않는다', async (_n, bad) => {
    const { user, bookingId } = await newCompleted();
    const before = await q('SELECT 1 FROM reviews');
    await expect(createReview(t.ctx, user, bookingId, bad)).rejects.toBeInstanceOf(ValidationError);
    expect(await q('SELECT 1 FROM reviews')).toHaveLength(before.length);
  });

  it('같은 상품에 대한 20개 후기가 동시에 들어와도 집계가 정확하다', async () => {
    const own = await makeListing(db.pool);
    const made = await Promise.all(Array.from({ length: 20 }, () => newCompleted({ on: own })));
    const ratings = made.map((_, i) => 1 + (i % 5));
    await Promise.all(made.map((m, i) => createReview(t.ctx, m.user, m.bookingId, { rating: ratings[i]! })));
    expect(await agg(own.id)).toEqual({ rating_count: 20, rating_sum: ratings.reduce((a, b) => a + b, 0) });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});

describe('후기 목록', () => {
  async function listingWithReviews(n: number) {
    const own = await makeListing(db.pool);
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const m = await newCompleted({ on: own });
      ids.push((await createReview(t.ctx, m.user, m.bookingId, { rating: 1 + (i % 5), body: `후기 ${i}` })).id);
    }
    return { own, ids };
  }
  async function walk(listingId: string, limit: number) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 100; guard++) {
      const r = await listReviews(t.ctx, listingId, { cursor, limit });
      pages.push(r.reviews.map((x) => x.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    return pages;
  }

  it('최신순으로 페이지를 넘기며 하나도 빠지거나 겹치지 않는다 (10개씩 25개 → 10/10/5)', async () => {
    const { own, ids } = await listingWithReviews(25);
    const pages = await walk(own.id, 10);
    expect(pages.map((p) => p.length)).toEqual([10, 10, 5]);
    const flat = pages.flat();
    expect(new Set(flat).size).toBe(25);
    expect(flat).toEqual([...ids].reverse()); // 나중에 쓴 후기가 먼저
  });

  it('같은 시각에 쓴 후기들이 많아도 페이지 경계에서 빠지거나 겹치지 않는다 (id 로 순서를 확정)', async () => {
    const { own, ids } = await listingWithReviews(25);
    await q(`UPDATE reviews SET created_at = '2030-01-01T00:00:00.123456Z' WHERE listing_id = $1`, [own.id]);
    for (const limit of [1, 3, 7, 10]) {
      const flat = (await walk(own.id, limit)).flat();
      expect(flat.length, `limit ${limit}`).toBe(25);
      expect(new Set(flat).size, `limit ${limit}`).toBe(25);
      expect(new Set(flat)).toEqual(new Set(ids));
    }
  });

  it('밀리초 아래(마이크로초)만 다른 후기들도 순서가 유지된다', async () => {
    const { own } = await listingWithReviews(6);
    const rows = await q<{ id: string }>('SELECT id FROM reviews WHERE listing_id = $1 ORDER BY id', [own.id]);
    for (let i = 0; i < rows.length; i++) {
      await q(`UPDATE reviews SET created_at = '2030-01-01T00:00:00Z'::timestamptz + make_interval(secs => $2) WHERE id = $1`, [rows[i]!.id, i * 0.000001]);
    }
    const flat = (await walk(own.id, 2)).flat();
    expect(flat).toEqual([...rows].map((r) => r.id).reverse());
  });

  it('요약은 개수와 평균(소수 첫째 자리)이고, 숨긴 후기는 목록과 요약에서 빠졌다가 복원하면 돌아온다', async () => {
    const { own, ids } = await listingWithReviews(5); // 평점 1,2,3,4,5
    expect((await listReviews(t.ctx, own.id)).summary).toEqual({ count: 5, average: 3 });

    expect(await setReviewVisibility(t.ctx, ids[4]!, 'HIDDEN')).toBe(true); // 5점 숨김
    const hidden = await listReviews(t.ctx, own.id);
    expect(hidden.summary).toEqual({ count: 4, average: 2.5 });
    expect(hidden.reviews.map((r) => r.id)).not.toContain(ids[4]);
    expect(await setReviewVisibility(t.ctx, ids[4]!, 'HIDDEN')).toBe(false); // 두 번 숨겨도 집계가 두 번 빠지지 않는다
    expect((await listReviews(t.ctx, own.id)).summary.count).toBe(4);

    expect(await setReviewVisibility(t.ctx, ids[4]!, 'PUBLISHED')).toBe(true);
    expect((await listReviews(t.ctx, own.id)).summary).toEqual({ count: 5, average: 3 });
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });

  it('숨김·복원을 동시에 마구 호출해도 집계가 후기와 어긋나지 않는다', async () => {
    const { own, ids } = await listingWithReviews(6);
    await Promise.all(Array.from({ length: 30 }, (_, i) => setReviewVisibility(t.ctx, ids[i % 6]!, i % 3 === 0 ? 'PUBLISHED' : 'HIDDEN')));
    expect(await findInvariantViolations(db.pool)).toEqual([]);
    const published = await q('SELECT count(*)::int AS n, COALESCE(sum(rating),0)::int AS s FROM reviews WHERE listing_id = $1 AND status = $2', [own.id, 'PUBLISHED']);
    expect(await agg(own.id)).toEqual({ rating_count: published[0].n, rating_sum: published[0].s });
  });

  it.each([
    ['아무 문자열', 'garbage'],
    ['JSON 이 아닌 base64', Buffer.from('not json').toString('base64url')],
    ['배열이 아닌 JSON', Buffer.from('{"a":1}').toString('base64url')],
    ['id 형식이 잘못됨', Buffer.from(JSON.stringify(['2030-01-01T00:00:00Z', "1' OR '1'='1"])).toString('base64url')],
    ['시각 형식이 잘못됨', Buffer.from(JSON.stringify(['yesterday', randomUUID()])).toString('base64url')],
  ])('잘못된 커서(%s)는 400', async (_n, cursor) => {
    const { own } = await listingWithReviews(1);
    await expect(listReviews(t.ctx, own.id, { cursor })).rejects.toBeInstanceOf(ValidationError);
  });

  it('없는 상품·중지된 상품은 404, 후기가 없으면 빈 목록과 평균 null', async () => {
    await expect(listReviews(t.ctx, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    const paused = await makeListing(db.pool);
    await q(`UPDATE listings SET status = 'PAUSED' WHERE id = $1`, [paused.id]);
    await expect(listReviews(t.ctx, paused.id)).rejects.toBeInstanceOf(NotFoundError);
    const empty = await makeListing(db.pool);
    expect(await listReviews(t.ctx, empty.id)).toEqual({ summary: { count: 0, average: null }, reviews: [], nextCursor: null });
  });

  it('작성자 이름은 마스킹되어 나오고 이메일 같은 개인정보는 응답에 없다', async () => {
    const own = await makeListing(db.pool);
    const user = await makeUser(db.pool, '홍길동');
    const { bookingId } = await completedBooking(t.ctx, t.gateway, db.pool, user, own, futureWindow(nextDay(), 1, 1));
    await createReview(t.ctx, user, bookingId, { rating: 5, body: '좋아요' });
    const json = JSON.stringify(await listReviews(t.ctx, own.id));
    expect(json).toContain('홍**');
    expect(json).not.toMatch(/홍길동|@test\.local|author_id|consumer/);
  });
});

describe('마무리', () => {
  it('이 파일의 모든 시나리오 뒤에도 시스템 불변식이 깨지지 않았다', async () => {
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});
