import { z } from 'zod';

export const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/, 'Idempotency-Key must be 16-128 chars of [A-Za-z0-9_-]');

export const createBookingSchema = z.strictObject({
  listingId: z.guid(),
  // 오프셋이 없는 시각은 어느 시간대인지 모호하므로 받지 않는다
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const confirmPaymentSchema = z.strictObject({
  paymentKey: z.string().min(1).max(200),
  orderId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
  // 쿼리스트링에서 온 값이 문자열일 수 있으므로 클라이언트가 Number 로 바꿔 보낸다
  amount: z.number().int().positive().safe(),
});
export type ConfirmPaymentInput = z.infer<typeof confirmPaymentSchema>;

export const availabilityQuerySchema = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/** API 가 돌려주는 모양 — 화면과 서버가 같은 타입을 쓴다 */
export type BookingStatus =
  | 'PENDING_PAYMENT'
  | 'PAYMENT_CONFIRMING'
  | 'CONFIRMED'
  | 'COMPLETED'
  | 'CANCELED'
  | 'EXPIRED'
  | 'PAYMENT_FAILED';

export interface BookingView {
  id: string;
  listingId: string;
  listingTitle: string;
  status: BookingStatus;
  start: string;
  end: string;
  totalAmount: number;
  holdExpiresAt: string | null;
}

export interface PaymentInfo {
  orderId: string;
  amount: number;
  orderName: string;
}

export interface BookingResponse {
  booking: BookingView;
  /** 지금 결제를 진행할 수 있을 때만 존재 (홀드가 살아 있고 READY 결제가 있을 때) */
  payment: PaymentInfo | null;
}

export type ConfirmResponse =
  | { status: 'CONFIRMED'; bookingId: string }
  | { status: 'PROCESSING'; bookingId: string };

export interface AvailabilityCell {
  start: string;
  freeUnits: number;
}
export interface AvailabilityResponse {
  listingId: string;
  date: string;
  bufferMinutes: number;
  hourlyPrice: number;
  commissionRateBp: number;
  cells: AvailabilityCell[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
