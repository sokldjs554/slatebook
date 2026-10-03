/** 클라이언트에 그대로 보여줘도 되는 오류. 그 밖의 예외는 500 으로 숨긴다. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: { details?: unknown; retryAfterSec?: number } = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION', 400, message, { details });
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = '로그인이 필요합니다.') {
    super('UNAUTHORIZED', 401, message);
  }
}
export class ForbiddenError extends AppError {
  constructor(code: string, message: string) {
    super(code, 403, message);
  }
}
export class NotFoundError extends AppError {
  constructor(message = '찾을 수 없습니다.') {
    super('NOT_FOUND', 404, message);
  }
}
export class SlotTakenError extends AppError {
  constructor() {
    super('SLOT_TAKEN', 409, '방금 다른 분이 먼저 예약했어요. 다른 시간을 선택해 주세요.');
  }
}
export class ListingUnavailableError extends AppError {
  constructor() {
    super('LISTING_UNAVAILABLE', 409, '현재 예약할 수 없는 상품입니다.');
  }
}
export class IdempotencyKeyReusedError extends AppError {
  constructor() {
    super('IDEMPOTENCY_KEY_REUSED', 422, '같은 Idempotency-Key 로 다른 내용의 요청을 보낼 수 없습니다.');
  }
}
export class BookingNotPayableError extends AppError {
  constructor(message = '결제할 수 없는 예약입니다.') {
    super('BOOKING_NOT_PAYABLE', 409, message);
  }
}
export class HoldExpiredError extends AppError {
  constructor(bookingId?: string) {
    super('HOLD_EXPIRED', 410, '결제 가능 시간이 지났어요. 처음부터 다시 예약해 주세요. (결제는 진행되지 않았습니다)', {
      details: { bookingId },
    });
  }
}
export class AmountMismatchError extends AppError {
  constructor(bookingId?: string) {
    super('AMOUNT_MISMATCH', 400, '결제 금액이 주문 금액과 일치하지 않아 결제를 진행하지 않았습니다.', {
      details: { bookingId },
    });
  }
}
export class PaymentConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, 409, message);
  }
}
export class PaymentDeclinedError extends AppError {
  constructor(
    readonly pgCode: string,
    bookingId?: string,
  ) {
    super('PAYMENT_DECLINED', 422, '결제가 승인되지 않았어요. 다른 결제 수단으로 다시 시도해 주세요.', {
      details: { pgCode, bookingId },
    });
  }
}
export class BusyError extends AppError {
  constructor() {
    super('BUSY', 503, '요청이 몰려 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', { retryAfterSec: 1 });
  }
}

export class PaymentVerificationFailedError extends AppError {
  constructor(bookingId?: string) {
    super(
      'PAYMENT_VERIFICATION_FAILED',
      422,
      '결제 내용을 검증하지 못해 예약을 확정하지 않았어요. 승인된 금액은 확인 후 환불해 드립니다. 문제가 계속되면 문의해 주세요.',
      { details: { bookingId } },
    );
  }
}

export class ReviewNotAllowedError extends AppError {
  constructor() {
    super('BOOKING_NOT_REVIEWABLE', 409, '이용이 완료된 예약에만 후기를 남길 수 있어요.');
  }
}
export class ReviewExistsError extends AppError {
  constructor() {
    super('REVIEW_EXISTS', 409, '이미 후기를 남긴 예약이에요.');
  }
}
export class ReviewWindowClosedError extends AppError {
  constructor() {
    super('REVIEW_WINDOW_CLOSED', 410, '후기 작성 기간이 지났어요.');
  }
}
