import { Pool, type PoolClient, type PoolConfig } from 'pg';

/** Pool 과 PoolClient 둘 다 받는 최소 인터페이스 */
export type Queryable = Pick<Pool, 'query'>;
export type Tx = PoolClient;

export function createPool(connectionString: string, extra: PoolConfig = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // 정지된 커넥션이 잠금을 쥔 채 남지 않게 한다
    idle_in_transaction_session_timeout: 30_000,
    statement_timeout: 20_000,
    ...extra,
  });
  // idle 커넥션 오류가 프로세스를 죽이지 않게 한다 (다음 사용 때 새 커넥션이 만들어진다)
  pool.on('error', () => {});
  return pool;
}

/**
 * 한 트랜잭션 안에서 fn 을 실행한다. 예외가 나면 ROLLBACK 후 그대로 다시 던진다.
 * PG 같은 외부 호출은 절대 이 안에서 하지 않는다 — 잠금을 쥔 채 네트워크를 기다리게 된다.
 */
export async function withTx<T>(pool: Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true; // ROLLBACK 도 실패했다면 이 커넥션은 풀에 돌려주지 않고 버린다
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/** bigint 컬럼(pg 는 문자열로 돌려준다)을 number 로. 원 단위 금액은 2^53 미만이므로 안전하다. */
export function num(value: string | number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`unsafe integer from database: ${String(value)}`);
  return n;
}

export interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

export function isPgError(err: unknown, code?: string, constraint?: string): err is PgErrorLike {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as PgErrorLike;
  if (typeof e.code !== 'string') return false;
  if (code !== undefined && e.code !== code) return false;
  if (constraint !== undefined && e.constraint !== constraint) return false;
  return true;
}

/** PostgreSQL SQLSTATE 중 이 프로젝트가 의미를 부여한 것들 */
export const PG = {
  EXCLUSION_VIOLATION: '23P01',
  UNIQUE_VIOLATION: '23505',
  LOCK_NOT_AVAILABLE: '55P03',
  DEADLOCK: '40P01',
  SERIALIZATION: '40001',
} as const;
