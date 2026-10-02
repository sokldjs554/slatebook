import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/server/db';
import { postPaymentApproved, postRefund, postRevenueRecognition, postTransaction } from '../src/server/ledger/ledger';
import { createTestDb, type TestDb } from './helpers/db';
import { findInvariantViolations } from './helpers/invariants';

/** 원장 계층을 상태 머신과 따로 직접 검증한다. 상위 로직의 가드가 뚫려도 이 계층만으로 중복 분개가 막혀야 한다. */
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.drop());

const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];
const post = <T>(fn: (tx: Parameters<typeof postPaymentApproved>[0]) => Promise<T>) => withTx(db.pool, fn);

describe('멱등성', () => {
  it('같은 결제의 승인 분개는 두 번째부터 기록되지 않는다 (true → false)', async () => {
    const id = randomUUID();
    expect(await post((tx) => postPaymentApproved(tx, { paymentId: id, amount: 100_000 }))).toBe(true);
    expect(await post((tx) => postPaymentApproved(tx, { paymentId: id, amount: 100_000 }))).toBe(false);
    expect(await q('SELECT 1 FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.ref_id = $1', [id])).toHaveLength(2);
  });

  it('같은 분개를 10개 트랜잭션이 동시에 시도해도 정확히 하나만 기록된다', async () => {
    const id = randomUUID();
    const rs = await Promise.all(Array.from({ length: 10 }, () => post((tx) => postPaymentApproved(tx, { paymentId: id, amount: 70_000 }))));
    expect(rs.filter(Boolean)).toHaveLength(1);
    expect(await q('SELECT 1 FROM ledger_transactions WHERE ref_id = $1', [id])).toHaveLength(1);
    const unbalanced = (await findInvariantViolations(db.pool)).filter((v) => v.startsWith('LEDGER_UNBALANCED'));
    expect(unbalanced).toEqual([]);
  });

  it('호스트 미지급금 계정을 동시에 처음 쓰는 요청들이 계정을 중복 생성하지 않는다', async () => {
    const host = randomUUID();
    await Promise.all(
      Array.from({ length: 8 }, () => post((tx) => postRevenueRecognition(tx, { bookingId: randomUUID(), hostId: host, gross: 100_000, fee: 10_000 }))),
    );
    expect(await q(`SELECT 1 FROM ledger_accounts WHERE code = 'HOST_PAYABLE' AND owner_id = $1`, [host])).toHaveLength(1);
    expect(await q(`SELECT sum(e.amount)::int AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.owner_id = $1`, [host])).toEqual([{ s: -720_000 }]);
  });
});

describe('입력 검증', () => {
  const base = { kind: 'T', refType: 't', idempotencyKey: '' };
  it('합계가 0 이 아니면 DB 에 닿기 전에 거부한다', async () => {
    await expect(
      post((tx) => postTransaction(tx, { ...base, refId: randomUUID(), idempotencyKey: 'u1', lines: [{ account: 'PG_RECEIVABLE', amount: 100 }, { account: 'CUSTOMER_ESCROW', amount: -99 }] })),
    ).rejects.toThrow(/unbalanced/);
  });
  it('두 줄 미만이거나 정수가 아닌 금액은 거부한다', async () => {
    await expect(post((tx) => postTransaction(tx, { ...base, refId: randomUUID(), idempotencyKey: 'u2', lines: [{ account: 'PG_RECEIVABLE', amount: 100 }] }))).rejects.toThrow(/at least two/);
    await expect(
      post((tx) => postTransaction(tx, { ...base, refId: randomUUID(), idempotencyKey: 'u3', lines: [{ account: 'PG_RECEIVABLE', amount: 10.5 }, { account: 'CUSTOMER_ESCROW', amount: -10.5 }] })),
    ).rejects.toThrow(/non-integer/);
  });
  it('실패한 분개는 어떤 흔적도 남기지 않는다 (거래 헤더 포함)', async () => {
    const before = await q('SELECT 1 FROM ledger_transactions');
    await post((tx) =>
      postTransaction(tx, { ...base, refId: randomUUID(), idempotencyKey: 'u4', lines: [{ account: 'PG_RECEIVABLE', amount: 100 }, { account: 'CUSTOMER_ESCROW', amount: -1 }] }),
    ).catch(() => {});
    expect(await q('SELECT 1 FROM ledger_transactions')).toHaveLength(before.length);
  });
  it('수수료가 금액보다 크거나 음수인 수익 인식은 거부한다', async () => {
    await expect(post((tx) => postRevenueRecognition(tx, { bookingId: randomUUID(), hostId: randomUUID(), gross: 1_000, fee: 1_001 }))).rejects.toThrow(/invalid fee/);
    await expect(post((tx) => postRevenueRecognition(tx, { bookingId: randomUUID(), hostId: randomUUID(), gross: 1_000, fee: -1 }))).rejects.toThrow(/invalid fee/);
  });
  it('수수료가 전액이면 호스트 몫(0원) 줄은 생략되고 합계는 맞는다', async () => {
    const id = randomUUID();
    await post((tx) => postRevenueRecognition(tx, { bookingId: id, hostId: randomUUID(), gross: 1_000, fee: 1_000 }));
    expect(await q('SELECT e.amount::int AS amount FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.ref_id = $1 ORDER BY e.amount', [id])).toEqual([{ amount: -1_000 }, { amount: 1_000 }]);
  });
});

describe('승인과 환불은 서로 반대 분개다', () => {
  it('승인 후 환불하면 모든 계정의 순효과가 0 이다', async () => {
    const pay = randomUUID();
    const refund = randomUUID();
    await post((tx) => postPaymentApproved(tx, { paymentId: pay, amount: 55_000 }));
    await post((tx) => postRefund(tx, { refundId: refund, amount: 55_000 }));
    const rows = await q(
      `SELECT a.code, sum(e.amount)::int AS s FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
         JOIN ledger_transactions t ON t.id = e.transaction_id WHERE t.ref_id IN ($1, $2) GROUP BY a.code ORDER BY a.code`,
      [pay, refund],
    );
    expect(rows).toEqual([{ code: 'CUSTOMER_ESCROW', s: 0 }, { code: 'PG_RECEIVABLE', s: 0 }]);
  });
});
