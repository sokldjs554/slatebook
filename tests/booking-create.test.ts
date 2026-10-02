import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBooking } from '../src/server/bookings/create';
import { getAvailability } from '../src/server/bookings/availability';
import {
  ForbiddenError,
  IdempotencyKeyReusedError,
  ListingUnavailableError,
  NotFoundError,
  SlotTakenError,
  ValidationError,
} from '../src/server/errors';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, idemKey, makeListing, makeUser, type Listing } from './helpers/fixtures';
import { book } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';
import { kstDayRange } from '../src/shared/time';

let db: TestDb;
let t: TestCtx;
let listing: Listing;
let guest: string;
let dayCounter = 5;
const nextDay = () => dayCounter++;

beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool);
  listing = await makeListing(db.pool, { hourlyPrice: 50_000, bufferMinutes: 30, commissionRateBp: 1000 });
  guest = await makeUser(db.pool, 'guest');
});
afterAll(() => db.drop());

const body = (win: { start: string; end: string }, extra: object = {}) => ({ listingId: listing.id, ...win, ...extra });

describe('입력 검증', () => {
  it.each([
    ['종료가 시작보다 이르다', (w: { start: string; end: string }) => ({ start: w.end, end: w.start })],
    ['30분 격자가 아니다', (w: { start: string; end: string }) => ({ ...w, start: new Date(Date.parse(w.start) + 15 * 60_000).toISOString() })],
    ['12시간을 넘는다', (w: { start: string; end: string }) => ({ ...w, end: new Date(Date.parse(w.start) + 13 * 3_600_000).toISOString() })],
    ['시간대(오프셋)가 없다', (w: { start: string; end: string }) => ({ ...w, start: '2030-01-01T10:00:00' })],
    ['날짜 형식이 아니다', (w: { start: string; end: string }) => ({ ...w, end: 'tomorrow' })],
  ])('%s → 400 VALIDATION', async (_name, mutate) => {
    const win = mutate(futureWindow(nextDay(), 1, 2));
    const err = await createBooking(t.ctx, guest, idemKey(), body(win)).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.status).toBe(400);
  });

  it('너무 임박하거나 너무 먼 예약은 거부한다', async () => {
    // 지금 이후 첫 30분 격자 시각: 항상 0~30분 안에 있으므로 "시작 30분 전까지만" 규칙에 걸린다 (실행 시각과 무관)
    const soon = new Date(Math.ceil(Date.now() / (30 * 60_000)) * 30 * 60_000);
    await expect(
      createBooking(t.ctx, guest, idemKey(), body({ start: soon.toISOString(), end: new Date(soon.getTime() + 3_600_000).toISOString() })),
    ).rejects.toMatchObject({ code: 'VALIDATION', extra: { details: { problem: 'TOO_SOON' } } });
    await expect(createBooking(t.ctx, guest, idemKey(), body(futureWindow(400, 1, 1)))).rejects.toMatchObject({
      extra: { details: { problem: 'TOO_FAR' } },
    });
  });

  it('요청에 금액을 끼워 넣으면(가격 조작 시도) 받아들이지 않는다', async () => {
    const win = futureWindow(nextDay(), 1, 2);
    const count = async () => (await db.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n as number;
    const before = await count();
    for (const extra of [{ amount: 1 }, { totalAmount: 1 }, { hourlyPrice: 1 }, { status: 'CONFIRMED' }]) {
      await expect(createBooking(t.ctx, guest, idemKey(), body(win, extra))).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await count()).toBe(before);
  });

  it.each(['short', 'has space in it 1234567890', 'x'.repeat(129), '한글키한글키한글키한글키한글키'])('잘못된 Idempotency-Key %j 는 거부', async (key) => {
    await expect(createBooking(t.ctx, guest, key, body(futureWindow(nextDay(), 1, 1)))).rejects.toBeInstanceOf(ValidationError);
  });

  it('listingId 가 UUID 형식이 아니면 거부한다', async () => {
    await expect(createBooking(t.ctx, guest, idemKey(), { ...futureWindow(nextDay(), 1, 1), listingId: "1' OR '1'='1" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('상품 상태', () => {
  it('없는 상품 → 404, 일시중지 상품 → 409, 내 상품 → 403', async () => {
    const win = futureWindow(nextDay(), 1, 1);
    await expect(
      createBooking(t.ctx, guest, idemKey(), { listingId: '11111111-1111-1111-1111-111111111111', ...win }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const paused = await makeListing(db.pool);
    await db.pool.query(`UPDATE listings SET status = 'PAUSED' WHERE id = $1`, [paused.id]);
    await expect(createBooking(t.ctx, guest, idemKey(), { listingId: paused.id, ...win })).rejects.toBeInstanceOf(ListingUnavailableError);

    await expect(createBooking(t.ctx, listing.hostId, idemKey(), body(win))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('활성 자원이 하나도 없는 상품은 예약할 수 없다', async () => {
    const empty = await makeListing(db.pool);
    await db.pool.query(`UPDATE resources SET active = false WHERE listing_id = $1`, [empty.id]);
    await expect(createBooking(t.ctx, guest, idemKey(), { listingId: empty.id, ...futureWindow(nextDay(), 1, 1) })).rejects.toBeInstanceOf(ListingUnavailableError);
  });
});

describe('저장되는 값', () => {
  it('금액은 서버가 계산하고, 단가·수수료율·버퍼는 예약 시점 그대로 스냅샷으로 남는다', async () => {
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(t.ctx, guest, listing, win);
    expect(b.payment.amount).toBe(100_000);
    expect(b.payment.orderId).toMatch(/^sb_[0-9a-f]{32}$/);

    const row = (await db.pool.query(`SELECT total_amount, price_snapshot, hold_expires_at, now() AS now FROM bookings WHERE id = $1`, [b.booking.id])).rows[0];
    expect(Number(row.total_amount)).toBe(100_000);
    expect(row.price_snapshot).toMatchObject({ hourlyPrice: 50_000, minutes: 120, amount: 100_000, feeAmount: 10_000, hostNet: 90_000, commissionRateBp: 1000, bufferMinutes: 30 });
    const holdMs = new Date(row.hold_expires_at).getTime() - new Date(row.now).getTime();
    expect(holdMs).toBeGreaterThan((t.ctx.config.holdMinutes * 60 - 5) * 1000);
    expect(holdMs).toBeLessThanOrEqual(t.ctx.config.holdMinutes * 60 * 1000);

    // 이후 호스트가 가격을 올려도 이 예약의 금액은 그대로
    await db.pool.query(`UPDATE listings SET hourly_price = 90_000 WHERE id = $1`, [listing.id]);
    const stored = await db.pool.query(`SELECT total_amount FROM bookings WHERE id = $1`, [b.booking.id]);
    expect(Number(stored.rows[0].total_amount)).toBe(100_000);
    await db.pool.query(`UPDATE listings SET hourly_price = 50_000 WHERE id = $1`, [listing.id]);
  });

  it('슬롯이 막는 구간은 [시작, 종료+정리버퍼) 이고, 결제(READY)도 함께 만들어진다', async () => {
    const win = futureWindow(nextDay(), 1, 2);
    const b = await book(t.ctx, guest, listing, win);
    const slot = (await db.pool.query(`SELECT lower(blocked) AS s, upper(blocked) AS e, state FROM booking_slots WHERE booking_id = $1`, [b.booking.id])).rows[0];
    expect(slot.s.toISOString()).toBe(win.start);
    expect(slot.e.getTime() - new Date(win.end).getTime()).toBe(30 * 60_000);
    expect(slot.state).toBe('HELD');
    const pay = (await db.pool.query(`SELECT status, provider FROM payments WHERE booking_id = $1`, [b.booking.id])).rows;
    expect(pay).toEqual([{ status: 'READY', provider: 'fake' }]);
  });
});

describe('정리 버퍼', () => {
  it('앞 예약의 종료+30분 전에는 시작할 수 없고, 정확히 그 시각에는 시작할 수 있다', async () => {
    const d = nextDay();
    await book(t.ctx, guest, listing, futureWindow(d, 2, 2)); // 02–04 (+30분 정리 → 04:30까지 막힘)
    const other = await makeUser(db.pool, 'o');
    await expect(book(t.ctx, other, listing, futureWindow(d, 4, 1))).rejects.toBeInstanceOf(SlotTakenError); // 04–05 는 정리 중
    const base = futureWindow(d, 4, 0);
    const startAt = new Date(Date.parse(base.start) + 30 * 60_000).toISOString(); // 04:30
    const ok = await book(t.ctx, other, listing, { start: startAt, end: new Date(Date.parse(startAt) + 3_600_000).toISOString() });
    expect(ok.booking.status).toBe('PENDING_PAYMENT');
  });

  it('내 예약이 뒤 예약과 닿지 않게: 뒤 예약 시작 30분 전에 끝나야 한다 (버퍼가 내 구간에 포함되므로)', async () => {
    const d = nextDay();
    const other = await makeUser(db.pool, 'o2');
    await book(t.ctx, guest, listing, futureWindow(d, 6, 1)); // 06–07 (+정리 → 07:30)
    // 04–06 예약: 버퍼 포함 04–06:30 이 06 시작과 겹침
    await expect(book(t.ctx, other, listing, futureWindow(d, 4, 2))).rejects.toBeInstanceOf(SlotTakenError);
    // 03–05:30 으로 끝나면(버퍼 포함 06:00) 맞닿기만 하므로 가능
    const base = futureWindow(d, 3, 0);
    const ok = await book(t.ctx, other, listing, { start: base.start, end: new Date(Date.parse(base.start) + 2.5 * 3_600_000).toISOString() });
    expect(ok.booking.status).toBe('PENDING_PAYMENT');
  });
});

describe('멱등성 (같은 Idempotency-Key)', () => {
  it('같은 키·같은 내용: 새로 만들지 않고 같은 예약과 같은 주문번호를 돌려준다', async () => {
    const win = futureWindow(nextDay(), 1, 1);
    const key = idemKey();
    const first = await createBooking(t.ctx, guest, key, body(win));
    const again = await createBooking(t.ctx, guest, key, body(win));
    expect(first.replayed).toBe(false);
    expect(again.replayed).toBe(true);
    expect(again.response).toEqual(first.response);
  });

  it('상품이 그 사이 일시중지돼도 재전송에는 이전 결과를 돌려준다 (결과를 못 받은 클라이언트의 재시도 보호)', async () => {
    const own = await makeListing(db.pool);
    const win = futureWindow(nextDay(), 1, 1);
    const key = idemKey();
    const first = await createBooking(t.ctx, guest, key, { listingId: own.id, ...win });
    await db.pool.query(`UPDATE listings SET status = 'PAUSED' WHERE id = $1`, [own.id]);
    const again = await createBooking(t.ctx, guest, key, { listingId: own.id, ...win });
    expect(again.response.booking.id).toBe(first.response.booking.id);
  });

  it('같은 키에 다른 내용이면 422 — 다른 예약이 조용히 무시되지 않는다', async () => {
    const key = idemKey();
    await createBooking(t.ctx, guest, key, body(futureWindow(nextDay(), 1, 1)));
    await expect(createBooking(t.ctx, guest, key, body(futureWindow(nextDay(), 1, 1)))).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it('키는 사용자별로 독립이다 — 다른 사용자의 같은 키는 별개의 예약', async () => {
    const [u1, u2] = [await makeUser(db.pool), await makeUser(db.pool)];
    const key = idemKey();
    const d = nextDay();
    const a = await createBooking(t.ctx, u1, key, body(futureWindow(d, 1, 1)));
    const b = await createBooking(t.ctx, u2, key, body(futureWindow(d, 8, 1)));
    expect(a.response.booking.id).not.toBe(b.response.booking.id);
  });

  it('만료된 예약의 재전송은 EXPIRED 상태를 알려주고 결제 정보는 주지 않는다', async () => {
    const own = await makeListing(db.pool);
    const key = idemKey();
    const win = futureWindow(nextDay(), 1, 1);
    const first = await createBooking(t.ctx, guest, key, { listingId: own.id, ...win });
    await db.pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [first.response.booking.id]);
    // 다른 사람이 그 자리를 가져가며 만료 정리가 일어난다
    await book(t.ctx, await makeUser(db.pool), own, win);
    const again = await createBooking(t.ctx, guest, key, { listingId: own.id, ...win });
    expect(again.response.booking.status).toBe('EXPIRED');
    expect(again.response.payment).toBeNull();
  });
});

describe('홀드가 지났지만 아직 정리되지 않은 예약', () => {
  it('화면에는 이미 EXPIRED 로 보이고, 결제 정보와 남은 시간은 주지 않는다 (워커 지연이 사용자에게 새지 않는다)', async () => {
    const own = await makeListing(db.pool);
    const key = idemKey();
    const input = { listingId: own.id, ...futureWindow(nextDay(), 1, 1) };
    const first = await createBooking(t.ctx, guest, key, input);
    expect(first.response.booking.status).toBe('PENDING_PAYMENT');
    expect(first.response.booking.holdExpiresAt).not.toBeNull();

    await db.pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [first.response.booking.id]);
    const stored = await db.pool.query('SELECT status FROM bookings WHERE id = $1', [first.response.booking.id]);
    expect(stored.rows[0].status).toBe('PENDING_PAYMENT'); // DB 에는 아직 정리 전

    const again = await createBooking(t.ctx, guest, key, input);
    expect(again.response.booking.status).toBe('EXPIRED');
    expect(again.response.booking.holdExpiresAt).toBeNull();
    expect(again.response.payment).toBeNull();
  });
});

describe('가용성 조회', () => {
  it('예약된 칸(+정리 버퍼)은 0, 나머지는 1. 만료된 홀드는 비어 있는 것으로 센다', async () => {
    const own = await makeListing(db.pool, { bufferMinutes: 30 });
    const d = nextDay();
    const win = futureWindow(d, 1, 2);
    const kstDate = new Date(Date.parse(win.start) + 9 * 3_600_000).toISOString().slice(0, 10);
    const b = await book(t.ctx, guest, own, win);

    const a1 = await getAvailability(t.ctx, own.id, kstDate);
    const cell = (iso: string) => a1.cells.find((c) => c.start === new Date(iso).toISOString())!;
    expect(a1.cells).toHaveLength(48);
    expect(cell(win.start).freeUnits).toBe(0);
    expect(cell(new Date(Date.parse(win.start) + 90 * 60_000).toISOString()).freeUnits).toBe(0); // 정리 버퍼 칸
    expect(cell(new Date(Date.parse(win.end) + 30 * 60_000).toISOString()).freeUnits).toBe(1);
    expect(cell(new Date(Date.parse(win.start) - 30 * 60_000).toISOString()).freeUnits).toBe(1);
    expect(a1).toMatchObject({ bufferMinutes: 30, hourlyPrice: 50_000, commissionRateBp: 1000 });
    expect(JSON.stringify(a1)).not.toMatch(/consumer|user|email|name/i); // 개인정보 없음

    await db.pool.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [b.booking.id]);
    const a2 = await getAvailability(t.ctx, own.id, kstDate);
    expect(a2.cells.find((c) => c.start === win.start)!.freeUnits).toBe(1);
  });

  it('장비 3대: 한 대가 예약되면 남은 수량 2', async () => {
    const gear = await makeListing(db.pool, { kind: 'EQUIPMENT', units: 3, bufferMinutes: 0 });
    const win = futureWindow(nextDay(), 1, 1);
    const kstDate = new Date(Date.parse(win.start) + 9 * 3_600_000).toISOString().slice(0, 10);
    await book(t.ctx, guest, gear, win);
    const a = await getAvailability(t.ctx, gear.id, kstDate);
    expect(a.cells.find((c) => c.start === win.start)!.freeUnits).toBe(2);
  });

  it('잘못된 날짜(2026-02-31)는 400, 없는 상품·중지된 상품은 404', async () => {
    await expect(getAvailability(t.ctx, listing.id, '2026-02-31')).rejects.toBeInstanceOf(ValidationError);
    await expect(getAvailability(t.ctx, '11111111-1111-1111-1111-111111111111', '2026-06-01')).rejects.toBeInstanceOf(NotFoundError);
    const paused = await makeListing(db.pool);
    await db.pool.query(`UPDATE listings SET status = 'PAUSED' WHERE id = $1`, [paused.id]);
    await expect(getAvailability(t.ctx, paused.id, '2026-06-01')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('KST 하루 경계: 자정을 넘는 예약은 양쪽 날짜의 칸에 모두 반영된다', async () => {
    const own = await makeListing(db.pool, { bufferMinutes: 0 });
    const d = nextDay();
    // UTC 14:00–16:00 = KST 23:00–01:00(다음 날)
    const win = futureWindow(d, 14, 2);
    await book(t.ctx, guest, own, win);
    const day1 = new Date(Date.parse(win.start) + 9 * 3_600_000).toISOString().slice(0, 10);
    const day2 = new Date(Date.parse(win.end) + 9 * 3_600_000 - 1).toISOString().slice(0, 10);
    expect(day1).not.toBe(day2);
    const [a1, a2] = [await getAvailability(t.ctx, own.id, day1), await getAvailability(t.ctx, own.id, day2)];
    expect(a1.cells.find((c) => c.start === win.start)!.freeUnits).toBe(0);
    expect(a2.cells.find((c) => c.start === new Date(Date.parse(win.start) + 60 * 60_000).toISOString())!.freeUnits).toBe(0);
    expect(kstDayRange(day1)!.end.toISOString()).toBe(kstDayRange(day2)!.start.toISOString());
  });
});

describe('마무리', () => {
  it('이 파일의 모든 시나리오 뒤에도 시스템 불변식이 깨지지 않았다', async () => {
    expect(await findInvariantViolations(db.pool)).toEqual([]);
  });
});
