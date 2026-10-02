import type { Queryable } from '../db';
import { lockBookingById, type BookingRow } from '../bookings/rows';

export type PaymentStatus =
  | 'READY'
  | 'CONFIRMING'
  | 'APPROVED'
  | 'PARTIAL_CANCELED'
  | 'CANCELED'
  | 'FAILED'
  | 'UNKNOWN';

export interface PaymentRow {
  id: string;
  booking_id: string;
  order_id: string;
  provider: string;
  payment_key: string | null;
  amount: string;
  canceled_amount: string;
  status: PaymentStatus;
  method: string | null;
  approved_at: Date | null;
  failure_reason: string | null;
  refund_pending: boolean;
  confirm_started_at: Date | null;
  reconcile_attempts: number;
  reconcile_attempted_at: Date | null;
  created_at: Date;
}

const PAYMENT_COLUMNS = `p.id, p.booking_id, p.order_id, p.provider, p.payment_key, p.amount, p.canceled_amount,
  p.status, p.method, p.approved_at, p.failure_reason, p.refund_pending, p.confirm_started_at,
  p.reconcile_attempts, p.reconcile_attempted_at, p.created_at`;

export type PaymentLookup = { orderId: string } | { paymentId: string };

/**
 * 예약과 결제를 잠가서 읽는다.
 *
 * 잠금 순서는 언제나 "예약 → 결제 → 슬롯" 이다. 만료 작업·결제 확정·웹훅 처리가 모두 이 순서를 지키므로
 * 서로 다른 순서로 잠그다 생기는 데드락이 없다.
 */
export async function lockBookingAndPayment(
  tx: Queryable,
  by: PaymentLookup,
): Promise<{ booking: BookingRow; payment: PaymentRow } | null> {
  // 먼저 잠금 없이 어느 예약의 결제인지만 찾는다 (예약 id 는 바뀌지 않는다)
  const probe =
    'orderId' in by
      ? await tx.query<{ id: string; booking_id: string }>('SELECT id, booking_id FROM payments WHERE order_id = $1', [by.orderId])
      : await tx.query<{ id: string; booking_id: string }>('SELECT id, booking_id FROM payments WHERE id = $1', [by.paymentId]);
  const ref = probe.rows[0];
  if (!ref) return null;

  const booking = await lockBookingById(tx, ref.booking_id);
  if (!booking) return null;
  const { rows } = await tx.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1 FOR UPDATE`, [ref.id]);
  const payment = rows[0];
  return payment ? { booking, payment } : null;
}

export async function findPaymentById(q: Queryable, id: string): Promise<PaymentRow | null> {
  const { rows } = await q.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM payments p WHERE p.id = $1`, [id]);
  return rows[0] ?? null;
}
