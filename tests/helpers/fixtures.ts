import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface Listing {
  id: string;
  hostId: string;
  resourceIds: string[];
}

export async function makeUser(pool: Pool, name = 'user'): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id, email, name) VALUES ($1, $2, $3)', [id, `${name}-${id}@test.local`, name]);
  return id;
}

export async function makeHost(pool: Pool, commissionRateBp = 1000): Promise<string> {
  const id = await makeUser(pool, 'host');
  await pool.query(
    `INSERT INTO host_profiles(user_id, business_type, commission_rate_bp) VALUES ($1, 'SOLE_PROPRIETOR', $2)`,
    [id, commissionRateBp],
  );
  return id;
}

export async function makeListing(
  pool: Pool,
  opts: { hostId?: string; kind?: 'STUDIO' | 'EQUIPMENT'; hourlyPrice?: number; bufferMinutes?: number; units?: number; commissionRateBp?: number } = {},
): Promise<Listing> {
  const hostId = opts.hostId ?? (await makeHost(pool, opts.commissionRateBp));
  const id = randomUUID();
  await pool.query(
    `INSERT INTO listings(id, host_id, kind, title, hourly_price, buffer_minutes) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, hostId, opts.kind ?? 'STUDIO', 'A홀', opts.hourlyPrice ?? 50_000, opts.bufferMinutes ?? 30],
  );
  const resourceIds: string[] = [];
  for (let i = 0; i < (opts.units ?? 1); i++) {
    const rid = randomUUID();
    await pool.query('INSERT INTO resources(id, listing_id, label) VALUES ($1, $2, $3)', [rid, id, `unit-${i + 1}`]);
    resourceIds.push(rid);
  }
  return { id, hostId, resourceIds };
}

const HOUR = 3_600_000;

/**
 * 미래의 한 시간 칸. dayOffset 일 뒤 UTC 자정 + startHour 시간에서 durationHours 시간.
 * (30분 격자 위이고, 최소 사전 예약 시간(30분)보다 충분히 뒤다.)
 */
export function futureWindow(dayOffset: number, startHour: number, durationHours: number) {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  const start = new Date(base.getTime() + dayOffset * 24 * HOUR + startHour * HOUR);
  const end = new Date(start.getTime() + durationHours * HOUR);
  return { start: start.toISOString(), end: end.toISOString() };
}

let keySeq = 0;
export function idemKey(): string {
  return `test-key-${Date.now()}-${++keySeq}-${randomUUID().slice(0, 8)}`;
}
