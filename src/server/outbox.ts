import type { Pool } from 'pg';
import type { Queryable } from './db';
import { withTx } from './db';
import type { Logger } from './logger';

/** 상태 변경과 같은 트랜잭션에 이벤트를 남긴다 — 롤백되면 이벤트도 사라지고, 커밋되면 반드시 남는다 */
export async function enqueue(q: Queryable, topic: string, payload: Record<string, unknown>): Promise<void> {
  await q.query('INSERT INTO outbox(topic, payload) VALUES ($1, $2)', [topic, JSON.stringify(payload)]);
}

export interface OutboxEvent {
  id: number;
  topic: string;
  payload: Record<string, unknown>;
}

/**
 * 아직 발행되지 않은 이벤트를 꺼내 handler 로 넘기고, 성공한 것만 발행 완료로 표시한다.
 * handler 가 던지면 그 이벤트는 다음 주기에 다시 시도된다 (at-least-once → handler 는 멱등해야 한다).
 */
export async function drainOutbox(
  pool: Pool,
  log: Logger,
  handler: (e: OutboxEvent) => Promise<void> | void,
  limit = 100,
): Promise<number> {
  return withTx(pool, async (tx) => {
    const { rows } = await tx.query<OutboxEvent>(
      `SELECT id::int AS id, topic, payload FROM outbox
        WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let published = 0;
    for (const ev of rows) {
      try {
        await handler(ev);
        await tx.query('UPDATE outbox SET published_at = now() WHERE id = $1', [ev.id]);
        published += 1;
      } catch (err) {
        log.warn('outbox handler failed; will retry', { id: ev.id, topic: ev.topic, err });
      }
    }
    return published;
  });
}
