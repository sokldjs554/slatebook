import type { Pool } from 'pg';

/**
 * 어떤 시나리오가 끝난 뒤에도 항상 참이어야 하는 시스템 전체의 불변식.
 * 위반이 있으면 사람이 읽을 수 있는 설명의 배열을 돌려준다 (빈 배열 = 정상).
 * 각 시나리오 테스트의 마지막에 호출해서 "겉으로 맞아 보이는데 속이 깨진" 상태를 잡는다.
 */
export async function findInvariantViolations(pool: Pool): Promise<string[]> {
  const out: string[] = [];
  const check = async (label: string, sql: string) => {
    const { rows } = await pool.query(sql);
    for (const r of rows) out.push(`${label}: ${JSON.stringify(r)}`);
  };

  await check(
    'OVERLAP — 같은 자원에 겹치는 활성 슬롯',
    `SELECT a.id AS a, b.id AS b FROM booking_slots a JOIN booking_slots b
       ON a.resource_id = b.resource_id AND a.id < b.id AND a.blocked && b.blocked
      WHERE a.state <> 'RELEASED' AND b.state <> 'RELEASED'`,
  );

  await check(
    'LEDGER_UNBALANCED — 합계가 0 이 아닌 원장 거래',
    `SELECT transaction_id, sum(amount) AS s FROM ledger_entries GROUP BY transaction_id HAVING sum(amount) <> 0`,
  );

  await check(
    'CONFIRMED_BOOKING_BROKEN — 확정 예약은 CONFIRMED 슬롯 1개, APPROVED 결제 1개, 그 결제의 승인 분개 1개가 있어야 한다 (환불된 옛 결제의 분개는 세지 않는다)',
    `SELECT b.id,
            (SELECT count(*) FROM booking_slots s WHERE s.booking_id = b.id AND s.state = 'CONFIRMED') AS slots,
            (SELECT count(*) FROM payments p WHERE p.booking_id = b.id AND p.status = 'APPROVED') AS payments,
            (SELECT count(*) FROM ledger_transactions t JOIN payments p ON t.ref_id = p.id
               WHERE t.kind = 'PAYMENT_APPROVED' AND p.booking_id = b.id AND p.status = 'APPROVED') AS ledger
       FROM bookings b WHERE b.status = 'CONFIRMED'
     AND NOT ((SELECT count(*) FROM booking_slots s WHERE s.booking_id = b.id AND s.state = 'CONFIRMED') = 1
          AND (SELECT count(*) FROM payments p WHERE p.booking_id = b.id AND p.status = 'APPROVED') = 1
          AND (SELECT count(*) FROM ledger_transactions t JOIN payments p ON t.ref_id = p.id
                WHERE t.kind = 'PAYMENT_APPROVED' AND p.booking_id = b.id AND p.status = 'APPROVED') = 1)`,
  );

  await check(
    'DEAD_BOOKING_HOLDS_SLOT — 끝난 예약이 슬롯을 쥐고 있다',
    `SELECT b.id, b.status FROM bookings b JOIN booking_slots s ON s.booking_id = b.id
      WHERE b.status IN ('EXPIRED','CANCELED','PAYMENT_FAILED') AND s.state <> 'RELEASED'`,
  );

  await check(
    'LIVE_BOOKING_WITHOUT_SLOT — 결제 대기·확정 중인 예약에 HELD 슬롯이 없다',
    `SELECT b.id, b.status FROM bookings b
      WHERE b.status IN ('PENDING_PAYMENT','PAYMENT_CONFIRMING')
        AND (SELECT count(*) FROM booking_slots s WHERE s.booking_id = b.id AND s.state = 'HELD') <> 1`,
  );

  await check(
    'APPROVED_PAYMENT_WITHOUT_CONFIRMED_BOOKING — 승인된 결제의 예약이 확정 상태가 아니다',
    `SELECT p.id, b.status FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.status = 'APPROVED' AND b.status NOT IN ('CONFIRMED','COMPLETED','CANCELED')`,
  );

  await check(
    'PG_RECEIVABLE_MISMATCH — PG 미수금 잔액 ≠ 승인된 결제 합계',
    `SELECT (SELECT COALESCE(sum(e.amount), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
              WHERE a.code = 'PG_RECEIVABLE') AS ledger,
            (SELECT COALESCE(sum(amount), 0) FROM payments WHERE status IN ('APPROVED','PARTIAL_CANCELED')) AS payments
     WHERE (SELECT COALESCE(sum(e.amount), 0) FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
             WHERE a.code = 'PG_RECEIVABLE')
        <> (SELECT COALESCE(sum(amount), 0) FROM payments WHERE status IN ('APPROVED','PARTIAL_CANCELED'))`,
  );

  await check(
    'CANCELED_PAYMENT_NOT_REFUNDED_IN_LEDGER — 환불된 결제에 환불 분개가 없다',
    `SELECT p.id FROM payments p
      WHERE p.status = 'CANCELED' AND p.canceled_amount = p.amount
        AND NOT EXISTS (SELECT 1 FROM refunds r JOIN ledger_transactions t ON t.ref_id = r.id AND t.kind = 'REFUND'
                         WHERE r.payment_id = p.id)`,
  );

  await check(
    'REFUND_PENDING_ON_FINISHED_PAYMENT — 환불 대기 표시가 남은 채 취소 완료',
    `SELECT id FROM payments WHERE refund_pending AND status = 'CANCELED'`,
  );

  await check(
    'RATING_AGGREGATE_DRIFT — 상품의 평점 집계가 공개된 후기와 다르다',
    `SELECT l.id, l.rating_count, l.rating_sum,
            (SELECT count(*) FROM reviews r WHERE r.listing_id = l.id AND r.status = 'PUBLISHED') AS actual_count,
            (SELECT COALESCE(sum(r.rating), 0) FROM reviews r WHERE r.listing_id = l.id AND r.status = 'PUBLISHED') AS actual_sum
       FROM listings l
      WHERE l.rating_count <> (SELECT count(*) FROM reviews r WHERE r.listing_id = l.id AND r.status = 'PUBLISHED')
         OR l.rating_sum <> (SELECT COALESCE(sum(r.rating), 0) FROM reviews r WHERE r.listing_id = l.id AND r.status = 'PUBLISHED')`,
  );

  await check(
    'REVIEW_ON_UNFINISHED_BOOKING — 이용 완료되지 않은 예약에 후기가 있다',
    `SELECT r.id, b.status FROM reviews r JOIN bookings b ON b.id = r.booking_id WHERE b.status <> 'COMPLETED'`,
  );

  return out;
}
