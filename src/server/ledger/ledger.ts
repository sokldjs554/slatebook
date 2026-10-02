import type { Queryable } from '../db';

/**
 * 복식부기 원장. 차변(+) 합계와 대변(−) 합계가 같은 거래만 기록할 수 있고(DB 트리거가 COMMIT 시 검사),
 * 한 번 쓴 줄은 고칠 수 없다. 같은 사건은 idempotency_key 로 두 번 분개되지 않는다.
 *
 *   PG_RECEIVABLE        PG 로부터 받을 돈 (자산)
 *   CUSTOMER_ESCROW      이용 완료 전 고객이 맡긴 돈 (부채)
 *   HOST_PAYABLE         호스트에게 지급할 돈 (부채, 호스트별 계정)
 *   PLATFORM_FEE_REVENUE 플랫폼 수수료 매출
 */
export const ACCOUNT = {
  PG_RECEIVABLE: 'PG_RECEIVABLE',
  CUSTOMER_ESCROW: 'CUSTOMER_ESCROW',
  HOST_PAYABLE: 'HOST_PAYABLE',
  PLATFORM_FEE_REVENUE: 'PLATFORM_FEE_REVENUE',
} as const;
export type AccountCode = (typeof ACCOUNT)[keyof typeof ACCOUNT];

export interface LedgerLine {
  account: AccountCode;
  ownerId?: string;
  /** 차변 +, 대변 − (원) */
  amount: number;
}

export interface LedgerTransactionInput {
  kind: string;
  refType: string;
  refId: string;
  idempotencyKey: string;
  lines: LedgerLine[];
}

async function accountId(q: Queryable, code: AccountCode, ownerId: string | null): Promise<number> {
  const inserted = await q.query<{ id: string }>(
    `INSERT INTO ledger_accounts(code, owner_id) VALUES ($1, $2)
     ON CONFLICT (code, owner_id) DO NOTHING RETURNING id`,
    [code, ownerId],
  );
  if (inserted.rows[0]) return Number(inserted.rows[0].id);
  const existing = await q.query<{ id: string }>(
    'SELECT id FROM ledger_accounts WHERE code = $1 AND owner_id IS NOT DISTINCT FROM $2',
    [code, ownerId],
  );
  return Number(existing.rows[0]!.id);
}

/** @returns true: 이번 호출에서 기록됨 / false: 같은 idempotencyKey 로 이미 기록돼 있어 아무것도 하지 않음 */
export async function postTransaction(q: Queryable, input: LedgerTransactionInput): Promise<boolean> {
  const lines = input.lines.filter((l) => l.amount !== 0); // 0원 줄(수수료 0원 등)은 기록하지 않는다
  if (lines.length < 2) throw new Error(`ledger transaction ${input.idempotencyKey} needs at least two lines`);
  for (const l of lines) {
    if (!Number.isSafeInteger(l.amount)) throw new Error(`non-integer ledger amount in ${input.idempotencyKey}`);
  }
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new Error(`unbalanced ledger transaction ${input.idempotencyKey}: sum=${sum}`);

  const tx = await q.query<{ id: string }>(
    `INSERT INTO ledger_transactions(kind, ref_type, ref_id, idempotency_key)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.kind, input.refType, input.refId, input.idempotencyKey],
  );
  if (!tx.rows[0]) return false;
  const txId = Number(tx.rows[0].id);
  for (const l of lines) {
    const acc = await accountId(q, l.account, l.ownerId ?? null);
    await q.query('INSERT INTO ledger_entries(transaction_id, account_id, amount) VALUES ($1, $2, $3)', [
      txId,
      acc,
      l.amount,
    ]);
  }
  return true;
}

/** PG 승인: PG 에서 받을 돈이 생기고, 그만큼 고객에게 빚(예수금)이 생긴다 */
export function postPaymentApproved(q: Queryable, p: { paymentId: string; amount: number }): Promise<boolean> {
  return postTransaction(q, {
    kind: 'PAYMENT_APPROVED',
    refType: 'payment',
    refId: p.paymentId,
    idempotencyKey: `payment-approved:${p.paymentId}`,
    lines: [
      { account: ACCOUNT.PG_RECEIVABLE, amount: p.amount },
      { account: ACCOUNT.CUSTOMER_ESCROW, amount: -p.amount },
    ],
  });
}

/** 이용 완료 전 환불: 승인 분개의 정확한 반대 */
export function postRefund(q: Queryable, p: { refundId: string; amount: number }): Promise<boolean> {
  return postTransaction(q, {
    kind: 'REFUND',
    refType: 'refund',
    refId: p.refundId,
    idempotencyKey: `refund:${p.refundId}`,
    lines: [
      { account: ACCOUNT.CUSTOMER_ESCROW, amount: p.amount },
      { account: ACCOUNT.PG_RECEIVABLE, amount: -p.amount },
    ],
  });
}

/** 이용 완료: 예수금이 호스트 미지급금(정산 대상)과 플랫폼 수수료 매출로 나뉜다 */
export function postRevenueRecognition(
  q: Queryable,
  p: { bookingId: string; hostId: string; gross: number; fee: number },
): Promise<boolean> {
  if (p.fee < 0 || p.fee > p.gross) throw new Error(`invalid fee ${p.fee} for gross ${p.gross}`);
  return postTransaction(q, {
    kind: 'REVENUE_RECOGNIZED',
    refType: 'booking',
    refId: p.bookingId,
    idempotencyKey: `revenue:${p.bookingId}`,
    lines: [
      { account: ACCOUNT.CUSTOMER_ESCROW, amount: p.gross },
      { account: ACCOUNT.HOST_PAYABLE, ownerId: p.hostId, amount: -(p.gross - p.fee) },
      { account: ACCOUNT.PLATFORM_FEE_REVENUE, amount: -p.fee },
    ],
  });
}
