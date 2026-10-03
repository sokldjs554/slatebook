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
 * 결제창 안에서 결제가 끝나는 PG(포트원 등)에서는 "결제 대기 + 홀드 만료"가 "돈이 안 움직였다"를 뜻하지 않는다 —
 * 결제를 마치고 서버에 알리기 전에 브라우저를 닫았을 수 있고, 웹훅도 유실될 수 있다.
 * 대기 중인(READY) 결제가 있는 예약은 슬롯을 쥔 채 결제 확인 단계(PAYMENT_CONFIRMING · CONFIRMING)로 넘긴다.
 * 대사가 PG 에 물어 결제됐으면 확정하고, 아니면 그때 푼다. 결제가 없는 예약 id 만 돌려준다 (그것들은 바로 만료해도 된다).
 */
async function moveToVerificationLocked(tx: Tx, bookingIds: string[]): Promise<string[]> {
  if (bookingIds.length === 0) return [];
  // 잠금 순서: 예약(호출자가 이미 잠금) → 결제
  const { rows } = await tx.query<{ booking_id: string }>(
    `UPDATE payments SET status = 'CONFIRMING', confirm_started_at = clock_timestamp(), failure_reason = 'HOLD_EXPIRED_UNVERIFIED'
      WHERE booking_id = ANY($1::uuid[]) AND status = 'READY' RETURNING booking_id`,
    [bookingIds],
  );
  const moved = rows.map((r) => r.booking_id);
  if (moved.length > 0) await tx.query(`UPDATE bookings SET status = 'PAYMENT_CONFIRMING' WHERE id = ANY($1::uuid[])`, [moved]);
  return bookingIds.filter((id) => !moved.includes(id));
}

export interface ExpireOptions {
  /** true: 대기 중인 결제가 있는 예약은 풀기 전에 PG 에 확인한다 (PaymentGateway.capturesBeforeServerConfirm) */
  verifyBeforeRelease?: boolean;
}

/**
 * 홀드가 지난 PENDING_PAYMENT 예약을 만료시킨다.
 *  - 결제가 진행 중인(PAYMENT_CONFIRMING) 예약은 홀드가 지나도 건드리지 않는다 — PG 가 이미 돈을 받았을 수 있다.
 *  - 다른 트랜잭션이 잠근 행은 기다리지 않고 건너뛴다(SKIP LOCKED): 결제 확정 중이거나 다른 청소 작업 중이라는 뜻이다.
 */
export async function expireDueHolds(
  tx: Tx,
  scope: { resourceIds: string[]; blocked: string } | { limit: number },
  opts: ExpireOptions = {},
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
  const ids = rows.map((r) => r.id);
  await expireBookingsLocked(tx, opts.verifyBeforeRelease ? await moveToVerificationLocked(tx, ids) : ids);
  return rows.length;
}

/** 워커용: 만료된 홀드를 배치로 정리한다. 방금 정리한 개수를 돌려준다. */
export async function expireHolds(ctx: AppContext, batch = 100): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await withTx(ctx.pool, (tx) =>
      expireDueHolds(tx, { limit: batch }, { verifyBeforeRelease: ctx.gateway.capturesBeforeServerConfirm }),
    );
    total += n;
    if (n < batch) break;
  }
  if (total > 0) ctx.log.info('expired stale holds', { count: total });
  return total;
}
