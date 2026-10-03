import type { Queryable } from '../db';
import type { BookingResponse, BookingStatus, BookingView, ReviewView } from '../../shared/schemas';
import { num } from '../db';
import { REVIEW_WINDOW_DAYS, maskName } from '../../shared/rating';

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
  /** DB 시계 기준으로 이용 완료 후 후기 작성 기간 안인가 */
  review_open: boolean;
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
         COALESCE(b.completed_at + make_interval(days => ${REVIEW_WINDOW_DAYS}) > clock_timestamp(), false) AS review_open,
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

export interface ReviewRow {
  id: string;
  rating: number;
  body: string | null;
  created_at: Date;
  author_name: string;
}

export function toReviewView(r: ReviewRow): ReviewView {
  return { id: r.id, rating: r.rating, body: r.body, createdAt: r.created_at.toISOString(), authorName: maskName(r.author_name) };
}

/** 지금 결제를 진행할 수 있을 때만 결제 정보를, 이용이 끝난 예약이면 후기 정보를 함께 돌려준다 */
export async function toBookingResponse(q: Queryable, row: BookingRow): Promise<BookingResponse> {
  const booking = toBookingView(row);
  let review: ReviewView | null = null;
  let canReview = false;
  if (row.status === 'COMPLETED') {
    const { rows } = await q.query<ReviewRow>(
      `SELECT r.id, r.rating, r.body, r.created_at, u.name AS author_name
         FROM reviews r JOIN users u ON u.id = r.author_id WHERE r.booking_id = $1`,
      [row.id],
    );
    review = rows[0] ? toReviewView(rows[0]) : null;
    canReview = review === null && row.review_open;
  }
  if (row.status !== 'PENDING_PAYMENT' || !row.hold_active) return { booking, payment: null, review, canReview };
  const { rows } = await q.query<{ order_id: string; amount: string }>(
    `SELECT order_id, amount FROM payments WHERE booking_id = $1 AND status = 'READY'`,
    [row.id],
  );
  const p = rows[0];
  return {
    booking,
    payment: p ? { orderId: p.order_id, amount: num(p.amount), orderName: row.listing_title } : null,
    review,
    canReview,
  };
}
