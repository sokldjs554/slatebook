import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { isPgError, num, PG, withTx, type Tx } from '../db';
import type { AppContext } from '../context';
import {
  ForbiddenError,
  IdempotencyKeyReusedError,
  ListingUnavailableError,
  NotFoundError,
  BusyError,
  SlotTakenError,
  ValidationError,
} from '../errors';
import { calcQuote } from '../../shared/quote';
import { createBookingSchema, idempotencyKeySchema, type BookingResponse } from '../../shared/schemas';
import { WINDOW_PROBLEM_MESSAGE, checkBookingWindow, durationMinutes } from '../../shared/time';
import { BOOKING_SELECT, toBookingResponse, type BookingRow } from './rows';
import { expireDueHolds } from './expire';

export interface CreateBookingResult {
  response: BookingResponse;
  /** true: 같은 Idempotency-Key 의 이전 요청 결과를 그대로 돌려준 것 */
  replayed: boolean;
}

const DEFAULT_CANCEL_POLICY = {
  version: 1,
  rules: [
    { hoursBefore: 48, refundPercent: 100 },
    { hoursBefore: 24, refundPercent: 50 },
    { hoursBefore: 0, refundPercent: 0 },
  ],
};

const BOOKING_IDEMPOTENCY_CONSTRAINT = 'bookings_consumer_id_idempotency_key_key';

/**
 * 예약 생성 — 중복 예약 방어의 핵심.
 *
 * 방어선 (바깥에서 안쪽으로)
 *  1. 멱등키          같은 요청의 재전송·더블클릭은 같은 예약을 돌려준다. 같은 키에 다른 내용이면 422.
 *  2. 자원 행 잠금     같은 상품의 자원 행을 id 순으로 FOR NO KEY UPDATE → 같은 상품에 대한 예약 트랜잭션이 줄을 선다.
 *                     (조회 후 INSERT 방식은 "아직 없는 행"을 잠글 수 없어 뚫린다. 제약만 쓰면 서로의 미커밋 행을
 *                      기다리다 데드락이 난다. 둘을 함께 쓴다.)
 *  3. 빈 자원 선택     잠금을 쥔 상태에서 겹치지 않는 자원을 고른다. 없으면 SLOT_TAKEN.
 *  4. EXCLUDE 제약    위 로직이 틀리거나 다른 경로가 잠금을 잊어도 DB 가 겹침을 거부한다 (23P01 → SLOT_TAKEN).
 */
export async function createBooking(
  ctx: AppContext,
  userId: string,
  idempotencyKey: string,
  rawInput: unknown,
): Promise<CreateBookingResult> {
  const key = idempotencyKeySchema.safeParse(idempotencyKey);
  if (!key.success) throw new ValidationError(key.error.issues[0]?.message ?? 'invalid Idempotency-Key');
  const parsed = createBookingSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ValidationError('요청 형식이 올바르지 않습니다.', parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
  }
  const { listingId } = parsed.data;
  const start = new Date(parsed.data.start);
  const end = new Date(parsed.data.end);

  const problem = checkBookingWindow(start, end, ctx.clock());
  if (problem) throw new ValidationError(WINDOW_PROBLEM_MESSAGE[problem], { problem });

  const requestHash = createHash('sha256')
    .update(JSON.stringify({ listingId, start: start.toISOString(), end: end.toISOString() }))
    .digest('hex');

  try {
    return await withTx(ctx.pool, (tx) => createInTx(tx, ctx, { userId, key: key.data, requestHash, listingId, start, end }));
  } catch (err) {
    if (isPgError(err, PG.EXCLUSION_VIOLATION)) throw new SlotTakenError();
    if (isPgError(err, PG.UNIQUE_VIOLATION, BOOKING_IDEMPOTENCY_CONSTRAINT)) {
      // 같은 키의 요청이 동시에 들어와 다른 쪽이 먼저 커밋했다 → 그 결과를 돌려준다
      const replay = await replayIfExists(ctx.pool, userId, key.data, requestHash);
      if (replay) return replay;
    }
    if (isPgError(err, PG.LOCK_NOT_AVAILABLE) || isPgError(err, PG.DEADLOCK) || isPgError(err, PG.SERIALIZATION)) {
      throw new BusyError();
    }
    throw err;
  }
}

interface CreateArgs {
  userId: string;
  key: string;
  requestHash: string;
  listingId: string;
  start: Date;
  end: Date;
}

async function findByKey(q: Pick<Pool, 'query'>, userId: string, key: string): Promise<BookingRow | null> {
  const { rows } = await q.query<BookingRow>(`${BOOKING_SELECT} WHERE b.consumer_id = $1 AND b.idempotency_key = $2`, [
    userId,
    key,
  ]);
  return rows[0] ?? null;
}

async function replayIfExists(
  q: Pick<Pool, 'query'>,
  userId: string,
  key: string,
  requestHash: string,
): Promise<CreateBookingResult | null> {
  const existing = await findByKey(q, userId, key);
  if (!existing) return null;
  if (existing.request_hash !== requestHash) throw new IdempotencyKeyReusedError();
  return { response: await toBookingResponse(q, existing), replayed: true };
}

async function createInTx(tx: Tx, ctx: AppContext, a: CreateArgs): Promise<CreateBookingResult> {
  // 잠금을 오래 기다리지 않는다: 줄이 너무 길면 503 으로 돌려보내 연결을 붙잡고 있지 않게 한다
  await tx.query(`SET LOCAL lock_timeout = '3s'`);

  const listingRes = await tx.query<{
    host_id: string;
    title: string;
    hourly_price: string;
    buffer_minutes: number;
    status: string;
    commission_rate_bp: number;
  }>(
    `SELECT l.host_id, l.title, l.hourly_price, l.buffer_minutes, l.status, hp.commission_rate_bp
       FROM listings l JOIN host_profiles hp ON hp.user_id = l.host_id
      WHERE l.id = $1`,
    [a.listingId],
  );
  const listing = listingRes.rows[0];
  if (!listing) throw new NotFoundError('상품을 찾을 수 없습니다.');

  // ② 자원 행 잠금 (id 순서 고정)
  const resourcesRes = await tx.query<{ id: string }>(
    `SELECT id FROM resources WHERE listing_id = $1 AND active ORDER BY id FOR NO KEY UPDATE`,
    [a.listingId],
  );
  const resourceIds = resourcesRes.rows.map((r) => r.id);

  // ① 멱등 재생 — 잠금 *뒤*에 확인해야 같은 키의 동시 요청 두 개가 둘 다 새로 만들지 않는다
  const replay = await replayIfExists(tx, a.userId, a.key, a.requestHash);
  if (replay) return replay;

  if (listing.status !== 'ACTIVE' || resourceIds.length === 0) throw new ListingUnavailableError();
  if (listing.host_id === a.userId) {
    throw new ForbiddenError('CANNOT_BOOK_OWN_LISTING', '내가 등록한 상품은 예약할 수 없습니다.');
  }

  // 자원이 막히는 구간 = [시작, 종료 + 정리 버퍼). 버퍼는 다음 손님과의 사이 정리 시간이다.
  const blocked = (
    await tx.query<{ r: string }>(
      `SELECT tstzrange($1::timestamptz, $2::timestamptz + make_interval(mins => $3::int), '[)')::text AS r`,
      [a.start.toISOString(), a.end.toISOString(), listing.buffer_minutes],
    )
  ).rows[0]!.r;

  // 홀드가 지났는데 아직 정리 안 된 예약이 길을 막고 있으면 지금 풀어준다 (워커 지연에 의존하지 않는다)
  await expireDueHolds(tx, { resourceIds, blocked });

  // ③ 겹치지 않는 자원 하나를 고른다 (잠금을 쥐고 있으므로 이 판단은 경쟁 상태가 없다)
  const free = await tx.query<{ id: string }>(
    `SELECT r.id FROM resources r
      WHERE r.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM booking_slots s
                         WHERE s.resource_id = r.id AND s.state <> 'RELEASED' AND s.blocked && $2::tstzrange)
      ORDER BY r.id LIMIT 1`,
    [resourceIds, blocked],
  );
  const resourceId = free.rows[0]?.id;
  if (!resourceId) throw new SlotTakenError();

  // 금액은 서버가 계산한다. 클라이언트가 보낸 금액은 받지도 않는다.
  const quote = calcQuote({
    hourlyPrice: num(listing.hourly_price),
    minutes: durationMinutes(a.start, a.end),
    commissionRateBp: listing.commission_rate_bp,
    bufferMinutes: listing.buffer_minutes,
  });
  const snapshot = { ...quote, currency: 'KRW' as const };

  const booking = await tx.query<{ id: string }>(
    `INSERT INTO bookings(consumer_id, listing_id, status, period, total_amount, price_snapshot,
                          cancel_policy_snapshot, hold_expires_at, idempotency_key, request_hash)
     VALUES ($1, $2, 'PENDING_PAYMENT', tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5, $6::jsonb,
             $7::jsonb, clock_timestamp() + make_interval(mins => $8::int), $9, $10)
     RETURNING id`,
    [
      a.userId,
      a.listingId,
      a.start.toISOString(),
      a.end.toISOString(),
      quote.amount,
      JSON.stringify(snapshot),
      JSON.stringify(DEFAULT_CANCEL_POLICY),
      ctx.config.holdMinutes,
      a.key,
      a.requestHash,
    ],
  );
  const bookingId = booking.rows[0]!.id;

  // ④ 겹치면 EXCLUDE 제약이 23P01 로 거부한다
  await tx.query(`INSERT INTO booking_slots(booking_id, resource_id, blocked, state) VALUES ($1, $2, $3::tstzrange, 'HELD')`, [
    bookingId,
    resourceId,
    blocked,
  ]);

  // 주문번호는 서버가 발급한다 (PG 가 요구하는 6~64자의 [A-Za-z0-9_-])
  await tx.query(
    `INSERT INTO payments(booking_id, order_id, provider, amount, status) VALUES ($1, $2, $3, $4, 'READY')`,
    [bookingId, `sb_${randomUUID().replaceAll('-', '')}`, ctx.gateway.name, quote.amount],
  );

  const row = (await tx.query<BookingRow>(`${BOOKING_SELECT} WHERE b.id = $1`, [bookingId])).rows[0]!;
  return { response: await toBookingResponse(tx, row), replayed: false };
}
