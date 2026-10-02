import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPayment } from '../src/server/payments/confirm';
import { runJobsOnce, startJobLoop } from '../src/server/jobs';
import { createTestDb, type TestDb } from './helpers/db';
import { makeCtx, type TestCtx } from './helpers/ctx';
import { futureWindow, makeListing, makeUser } from './helpers/fixtures';
import { book, payAtPg } from './helpers/flow';
import { findInvariantViolations } from './helpers/invariants';

let db: TestDb;
let t: TestCtx;
let day = 5;
const nextDay = () => day++;

beforeAll(async () => {
  db = await createTestDb();
  t = makeCtx(db.pool);
});
afterAll(() => db.drop());

const q = async <T = any>(sql: string, params: unknown[] = []) => (await db.pool.query(sql, params)).rows as T[];

describe('runJobsOnce', () => {
  it('한 바퀴에 만료 정리·결제 대사·이용 완료 분개·outbox 발행이 모두 처리된다', async () => {
    const listing = await makeListing(db.pool, { bufferMinutes: 0 });
    const [u1, u2, u3] = [await makeUser(db.pool), await makeUser(db.pool), await makeUser(db.pool)];

    const stale = await book(t.ctx, u1, listing, futureWindow(nextDay(), 1, 1)); // 만료될 홀드
    await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1`, [stale.booking.id]);

    const unknown = await book(t.ctx, u2, listing, futureWindow(nextDay(), 1, 1)); // 응답 유실된 결제
    t.gateway.script('timeout_after_capture', unknown.payment.orderId);
    await confirmPayment(t.ctx, u2, payAtPg(t.gateway, unknown.payment));

    const ended = await book(t.ctx, u3, listing, futureWindow(nextDay(), 1, 1)); // 이용이 끝난 확정 예약
    await confirmPayment(t.ctx, u3, payAtPg(t.gateway, ended.payment));
    await q(`UPDATE bookings SET period = tstzrange(now() - interval '3 hours', now() - interval '1 hour', '[)') WHERE id = $1`, [ended.booking.id]);

    const report = await runJobsOnce(t.ctx);
    expect(report.expired).toBe(1);
    expect(report.reconciled).toMatchObject({ examined: 1, resolved: 1 });
    expect(report.completed).toBe(1);
    expect(report.outbox).toBeGreaterThan(0);

    const status = async (id: string) => (await q('SELECT status FROM bookings WHERE id = $1', [id]))[0].status;
    expect(await status(stale.booking.id)).toBe('EXPIRED');
    expect(await status(unknown.booking.id)).toBe('CONFIRMED');
    expect(await status(ended.booking.id)).toBe('COMPLETED');
    expect(await q('SELECT 1 FROM outbox WHERE published_at IS NULL')).toHaveLength(0);
    expect(await findInvariantViolations(db.pool)).toEqual([]);

    // 두 번째 바퀴에서는 할 일이 없다
    expect(await runJobsOnce(t.ctx)).toMatchObject({ expired: 0, completed: 0, outbox: 0 });
  });

  it('reconcile: false 면 결제 대사를 건너뛴다 (가짜 PG 를 별도 프로세스에서 대사하면 안 되므로)', async () => {
    const listing = await makeListing(db.pool);
    const user = await makeUser(db.pool);
    const b = await book(t.ctx, user, listing, futureWindow(nextDay(), 1, 1));
    t.gateway.script('timeout_after_capture', b.payment.orderId);
    await confirmPayment(t.ctx, user, payAtPg(t.gateway, b.payment));
    const lookups = t.gateway.lookupCalls.length;
    const report = await runJobsOnce(t.ctx, { reconcile: false });
    expect(report.reconciled).toBeNull();
    expect(t.gateway.lookupCalls.length).toBe(lookups);
    expect((await q('SELECT status FROM bookings WHERE id = $1', [b.booking.id]))[0].status).toBe('PAYMENT_CONFIRMING');
  });

  it('DB 가 통째로 죽어도 던지지 않고 한 바퀴를 끝낸다 (각 작업이 따로 감싸져 있고, 다음 바퀴가 다시 시도한다)', async () => {
    const dbDown = {
      ...t.ctx,
      pool: new Proxy(db.pool, { get: (target, p) => (p === 'query' || p === 'connect' ? () => Promise.reject(new Error('db down')) : Reflect.get(target, p)) }),
    } as typeof t.ctx;
    await expect(runJobsOnce(dbDown)).resolves.toEqual({ expired: 0, reconciled: null, completed: 0, outbox: 0 });
  });
});

describe('startJobLoop', () => {
  it('이전 바퀴가 끝나기 전에는 다음 바퀴를 시작하지 않고, stop() 은 진행 중인 바퀴를 기다린다', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let runs = 0;
    const loop = startJobLoop(t.ctx, {
      intervalMs: 10,
      run: async () => {
        runs += 1;
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 60));
        concurrent -= 1;
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    await loop.stop();
    expect(concurrent).toBe(0); // stop 이 끝난 뒤 진행 중인 작업이 없다
    expect(maxConcurrent).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(2);
    const after = runs;
    await new Promise((r) => setTimeout(r, 80));
    expect(runs).toBe(after); // 멈춘 뒤에는 더 돌지 않는다
  });

  it('한 바퀴가 예외로 끝나도 루프는 살아 있다', async () => {
    let runs = 0;
    const loop = startJobLoop(t.ctx, { intervalMs: 10, run: async () => { runs += 1; throw new Error('iteration failed'); } });
    await new Promise((r) => setTimeout(r, 120));
    await loop.stop();
    expect(runs).toBeGreaterThanOrEqual(3);
  });
});
