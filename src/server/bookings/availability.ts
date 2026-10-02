import type { AppContext } from '../context';
import { num } from '../db';
import { NotFoundError, ValidationError } from '../errors';
import { SLOT_MINUTES, kstDayRange } from '../../shared/time';
import type { AvailabilityResponse } from '../../shared/schemas';

/**
 * 하루(KST)를 30분 칸으로 나눠 칸마다 비어 있는 자원 수를 돌려준다.
 * 이 값은 화면 안내용일 뿐이다 — 예약이 가능한지의 최종 판정은 예약 시점의 DB 제약이 한다.
 * 개인정보는 포함하지 않는다. 만료됐지만 아직 정리되지 않은 홀드는 비어 있는 것으로 센다.
 */
export async function getAvailability(ctx: AppContext, listingId: string, date: string): Promise<AvailabilityResponse> {
  const day = kstDayRange(date);
  if (!day) throw new ValidationError('date 는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.');

  const listing = await ctx.pool.query<{
    hourly_price: string;
    buffer_minutes: number;
    commission_rate_bp: number;
  }>(
    `SELECT l.hourly_price, l.buffer_minutes, hp.commission_rate_bp
       FROM listings l JOIN host_profiles hp ON hp.user_id = l.host_id
      WHERE l.id = $1 AND l.status = 'ACTIVE'`,
    [listingId],
  );
  const l = listing.rows[0];
  if (!l) throw new NotFoundError('상품을 찾을 수 없습니다.');

  const { rows } = await ctx.pool.query<{ start_at: Date; free_units: number }>(
    `SELECT c.start_at,
            (SELECT count(*)::int FROM resources r
              WHERE r.listing_id = $1 AND r.active
                AND NOT EXISTS (
                  SELECT 1 FROM booking_slots s JOIN bookings b ON b.id = s.booking_id
                   WHERE s.resource_id = r.id AND s.state <> 'RELEASED'
                     AND NOT (b.status = 'PENDING_PAYMENT' AND b.hold_expires_at <= clock_timestamp())
                     AND s.blocked && tstzrange(c.start_at, c.start_at + make_interval(mins => $4::int), '[)')
                )) AS free_units
       FROM generate_series($2::timestamptz, $3::timestamptz - make_interval(mins => $4::int),
                            make_interval(mins => $4::int)) AS c(start_at)
      ORDER BY c.start_at`,
    [listingId, day.start.toISOString(), day.end.toISOString(), SLOT_MINUTES],
  );

  return {
    listingId,
    date,
    bufferMinutes: l.buffer_minutes,
    hourlyPrice: num(l.hourly_price),
    commissionRateBp: l.commission_rate_bp,
    cells: rows.map((r) => ({ start: r.start_at.toISOString(), freeUnits: r.free_units })),
  };
}
