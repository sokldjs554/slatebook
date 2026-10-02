import type { Tx } from '../db';
import { withTx } from '../db';
import type { AppContext } from '../context';

/**
 * 이미 잠근 예약들을 만료 처리한다. 잠금 순서: 예약 → 결제 → 슬롯 (결제 확정 경로와 같다 → 데드락 없음)
 * 호출자는 반드시 대상 예약 행을 FOR UPDATE 로 잡고 있어야 한다.
 */
export async function expireBookingsLocked(tx: Tx, bookingIds: string[], reason = 'HOLD_EXPIRED'): Promise<void> {
  if (bookingIds.length === 0) return;
  await tx.query(`UPDATE bookings SET status = 'EXPIRED' WHERE id = ANY($1::uuid[])`, [bookingIds]);
  await tx.query(
    `UPDATE payments SET status = 'FAILED', failure_reason = $2
      WHERE booking_id = ANY($1::uuid[]) AND status = 'READY'`,
    [bookingIds, reason],
  );
  await tx.query(
    `UPDATE booking_slots SET state = 'RELEASED' WHERE booking_id = ANY($1::uuid[]) AND state = 'HELD'`,
    [bookingIds],
  );
}

/**
 * 홀드가 지난 PENDING_PAYMENT 예약을 만료시킨다.
 *  - 결제가 진행 중인(PAYMENT_CONFIRMING) 예약은 홀드가 지나도 건드리지 않는다 — PG 가 이미 돈을 받았을 수 있다.
 *  - 다른 트랜잭션이 잠근 행은 기다리지 않고 건너뛴다(SKIP LOCKED): 결제 확정 중이거나 다른 청소 작업 중이라는 뜻이다.
 */
export async function expireDueHolds(
  tx: Tx,
  scope: { resourceIds: string[]; blocked: string } | { limit: number },
): Promise<number> {
  const { rows } =
    'blocked' in scope
      ? await tx.query<{ id: string }>(
          `SELECT b.id FROM bookings b
            WHERE b.status = 'PENDING_PAYMENT' AND b.hold_expires_at <= clock_timestamp()
              AND EXISTS (SELECT 1 FROM booking_slots s
                           WHERE s.booking_id = b.id AND s.state = 'HELD'
                             AND s.resource_id = ANY($1::uuid[]) AND s.blocked && $2::tstzrange)
            ORDER BY b.id FOR UPDATE OF b SKIP LOCKED`,
          [scope.resourceIds, scope.blocked],
        )
      : await tx.query<{ id: string }>(
          `SELECT b.id FROM bookings b
            WHERE b.status = 'PENDING_PAYMENT' AND b.hold_expires_at <= clock_timestamp()
            ORDER BY b.hold_expires_at LIMIT $1 FOR UPDATE OF b SKIP LOCKED`,
          [scope.limit],
        );
  await expireBookingsLocked(tx, rows.map((r) => r.id));
  return rows.length;
}

/** 워커용: 만료된 홀드를 배치로 정리한다. 방금 정리한 개수를 돌려준다. */
export async function expireHolds(ctx: AppContext, batch = 100): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await withTx(ctx.pool, (tx) => expireDueHolds(tx, { limit: batch }));
    total += n;
    if (n < batch) break;
  }
  if (total > 0) ctx.log.info('expired stale holds', { count: total });
  return total;
}
