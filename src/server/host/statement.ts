import type { Queryable } from '../db';
import { num } from '../db';

/**
 * 호스트(공급자) 정산 내역.
 *
 * 정산액은 예약 행의 금액을 다시 계산하지 않고 **원장(복식부기)에서 읽는다.** 이용 완료 시 "고객 예수금 → 호스트 미지급금 + 플랫폼 수수료"
 * 분개가 예약 상태 변경과 한 트랜잭션으로 기록되므로(bookings/complete.ts), 원장에 있는 것만이 정산 대상이다.
 * 예약 화면의 숫자와 원장이 어긋나면 그 자체가 사고이고, 불변식 검사기가 그것을 잡는다(tests/helpers/invariants.ts).
 */
export interface StatementRow {
  bookingId: string;
  listingTitle: string;
  start: string;
  end: string;
  completedAt: string;
  /** 손님 이름 (화면에서 가린다) */
  customerName: string;
  gross: number;
  fee: number;
  net: number;
}

export interface HostListing {
  id: string;
  title: string;
  kind: 'STUDIO' | 'EQUIPMENT';
  hourlyPrice: number;
  status: 'ACTIVE' | 'PAUSED';
}

export interface HostStatement {
  /** 지급 예정 — 원장의 호스트 미지급금 잔액 (이용 완료, 아직 지급 전) */
  payable: number;
  /** 이 호스트의 거래에서 발생한 플랫폼 수수료 누계 */
  feeTotal: number;
  /** 이용 전 예수금 — 결제는 끝났지만 아직 이용 전인 예약의 결제액 (정산 대상 아님) */
  escrow: number;
  rows: StatementRow[];
  listings: HostListing[];
}

/** 호스트가 아닌 사용자면 null */
export async function getHostStatement(q: Queryable, hostId: string): Promise<HostStatement | null> {
  const host = await q.query('SELECT 1 FROM host_profiles WHERE user_id = $1', [hostId]);
  if (!host.rowCount) return null;

  const rows = await q.query<{
    booking_id: string;
    title: string;
    start: Date;
    end: Date;
    completed_at: Date;
    customer_name: string;
    gross: string;
    fee: string;
    net: string;
  }>(
    `SELECT b.id AS booking_id, l.title, lower(b.period) AS start, upper(b.period) AS "end", b.completed_at, u.name AS customer_name,
            SUM(CASE WHEN a.code = 'CUSTOMER_ESCROW' THEN e.amount ELSE 0 END)        AS gross,
            -SUM(CASE WHEN a.code = 'PLATFORM_FEE_REVENUE' THEN e.amount ELSE 0 END)  AS fee,
            -SUM(CASE WHEN a.code = 'HOST_PAYABLE' THEN e.amount ELSE 0 END)          AS net
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id
       JOIN ledger_accounts a ON a.id = e.account_id
       JOIN bookings b ON b.id = t.ref_id
       JOIN listings l ON l.id = b.listing_id
       JOIN users u ON u.id = b.consumer_id
      WHERE t.kind = 'REVENUE_RECOGNIZED' AND t.ref_type = 'booking' AND l.host_id = $1
      GROUP BY b.id, l.title, b.period, b.completed_at, u.name
      ORDER BY b.completed_at DESC, b.id`,
    [hostId],
  );

  const payable = await q.query<{ balance: string }>(
    `SELECT -COALESCE(SUM(e.amount), 0) AS balance
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.code = 'HOST_PAYABLE' AND a.owner_id = $1`,
    [hostId],
  );
  const escrow = await q.query<{ total: string }>(
    `SELECT COALESCE(SUM(b.total_amount), 0) AS total
       FROM bookings b JOIN listings l ON l.id = b.listing_id
      WHERE l.host_id = $1 AND b.status = 'CONFIRMED'`,
    [hostId],
  );
  const listings = await q.query<{ id: string; title: string; kind: 'STUDIO' | 'EQUIPMENT'; hourly_price: string; status: 'ACTIVE' | 'PAUSED' }>(
    `SELECT id, title, kind, hourly_price, status FROM listings WHERE host_id = $1 ORDER BY created_at, title`,
    [hostId],
  );

  const statementRows = rows.rows.map((r) => ({
    bookingId: r.booking_id,
    listingTitle: r.title,
    start: r.start.toISOString(),
    end: r.end.toISOString(),
    completedAt: r.completed_at.toISOString(),
    customerName: r.customer_name,
    gross: num(r.gross),
    fee: num(r.fee),
    net: num(r.net),
  }));
  return {
    payable: num(payable.rows[0]!.balance),
    feeTotal: statementRows.reduce((s, r) => s + r.fee, 0),
    escrow: num(escrow.rows[0]!.total),
    rows: statementRows,
    listings: listings.rows.map((l) => ({ id: l.id, title: l.title, kind: l.kind, hourlyPrice: num(l.hourly_price), status: l.status })),
  };
}
