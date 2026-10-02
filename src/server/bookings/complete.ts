import { num, withTx } from '../db';
import type { AppContext } from '../context';
import { postRevenueRecognition } from '../ledger/ledger';
import { enqueue } from '../outbox';
import type { PriceSnapshot } from './rows';

/**
 * 이용이 끝난 확정 예약을 COMPLETED 로 바꾸고, 그 순간 예수금을 호스트 미지급금과 플랫폼 수수료 매출로 나눠 분개한다.
 * 금액은 예약 시점에 저장한 price_snapshot 을 쓴다 (이후 수수료율이 바뀌어도 이 예약의 정산은 그대로).
 * 예약 하나의 상태 변경과 분개가 한 트랜잭션이라, 둘 중 하나만 반영되는 일이 없다.
 */
export async function completeEndedBookings(ctx: AppContext, batch = 100): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await withTx(ctx.pool, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        host_id: string;
        total_amount: string;
        price_snapshot: PriceSnapshot;
      }>(
        `SELECT b.id, l.host_id, b.total_amount, b.price_snapshot
           FROM bookings b JOIN listings l ON l.id = b.listing_id
          WHERE b.status = 'CONFIRMED' AND upper(b.period) <= clock_timestamp()
          ORDER BY upper(b.period) LIMIT $1 FOR UPDATE OF b SKIP LOCKED`,
        [batch],
      );
      for (const b of rows) {
        const gross = num(b.total_amount);
        await tx.query(`UPDATE bookings SET status = 'COMPLETED', completed_at = clock_timestamp() WHERE id = $1`, [b.id]);
        await postRevenueRecognition(tx, { bookingId: b.id, hostId: b.host_id, gross, fee: b.price_snapshot.feeAmount });
        await enqueue(tx, 'booking.completed', { bookingId: b.id, hostId: b.host_id, gross, fee: b.price_snapshot.feeAmount });
      }
      return rows.length;
    });
    total += n;
    if (n < batch) break;
  }
  if (total > 0) ctx.log.info('completed ended bookings', { count: total });
  return total;
}
