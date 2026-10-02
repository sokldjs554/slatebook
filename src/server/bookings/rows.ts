import type { Queryable } from '../db';
import type { BookingResponse, BookingStatus, BookingView } from '../../shared/schemas';
import { num } from '../db';

export interface BookingRow {
  id: string;
  consumer_id: string;
  listing_id: string;
  listing_title: string;
  host_id: string;
  status: BookingStatus;
  start_at: Date;
  end_at: Date;
  total_amount: string;
  hold_expires_at: Date | null;
  /** DB 시계 기준으로 지금 홀드가 살아 있는가 */
  hold_active: boolean;
  idempotency_key: string;
  request_hash: string;
  price_snapshot: PriceSnapshot;
}

export interface PriceSnapshot {
  hourlyPrice: number;
  minutes: number;
  amount: number;
  feeAmount: number;
  hostNet: number;
  commissionRateBp: number;
  bufferMinutes: number;
  currency: 'KRW';
}

export const BOOKING_SELECT = `
  SELECT b.id, b.consumer_id, b.listing_id, l.title AS listing_title, l.host_id, b.status,
         lower(b.period) AS start_at, upper(b.period) AS end_at, b.total_amount,
         b.hold_expires_at,
         COALESCE(b.hold_expires_at > clock_timestamp(), false) AS hold_active,
         b.idempotency_key, b.request_hash, b.price_snapshot
    FROM bookings b JOIN listings l ON l.id = b.listing_id`;

export async function findBookingById(q: Queryable, id: string): Promise<BookingRow | null> {
  const { rows } = await q.query<BookingRow>(`${BOOKING_SELECT} WHERE b.id = $1`, [id]);
  return rows[0] ?? null;
}

/** 행 잠금까지 걸어 읽는다. 잠금 순서 규칙: 예약 → 결제 → 슬롯 */
export async function lockBookingById(q: Queryable, id: string): Promise<BookingRow | null> {
  const { rows } = await q.query<BookingRow>(`${BOOKING_SELECT} WHERE b.id = $1 FOR UPDATE OF b`, [id]);
  return rows[0] ?? null;
}

export function toBookingView(row: BookingRow): BookingView {
  return {
    id: row.id,
    listingId: row.listing_id,
    listingTitle: row.listing_title,
    // 홀드가 지났지만 워커가 아직 정리하지 않은 예약도 사용자에게는 만료로 보인다 (가용성·결제 확정과 같은 판단)
    status: row.status === 'PENDING_PAYMENT' && !row.hold_active ? 'EXPIRED' : row.status,
    start: row.start_at.toISOString(),
    end: row.end_at.toISOString(),
    totalAmount: num(row.total_amount),
    holdExpiresAt:
      (row.status === 'PENDING_PAYMENT' && row.hold_active) || row.status === 'PAYMENT_CONFIRMING'
        ? (row.hold_expires_at?.toISOString() ?? null)
        : null,
  };
}

/** 지금 결제를 진행할 수 있을 때만 결제 정보를 함께 돌려준다 */
export async function toBookingResponse(q: Queryable, row: BookingRow): Promise<BookingResponse> {
  const booking = toBookingView(row);
  if (row.status !== 'PENDING_PAYMENT' || !row.hold_active) return { booking, payment: null };
  const { rows } = await q.query<{ order_id: string; amount: string }>(
    `SELECT order_id, amount FROM payments WHERE booking_id = $1 AND status = 'READY'`,
    [row.id],
  );
  const p = rows[0];
  return {
    booking,
    payment: p ? { orderId: p.order_id, amount: num(p.amount), orderName: row.listing_title } : null,
  };
}
