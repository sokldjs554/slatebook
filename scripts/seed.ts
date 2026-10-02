import { createPool } from '../src/server/db';

/** 데모 데이터. 여러 번 실행해도 중복되지 않는다. 데모 사용자의 이메일은 @demo.slatebook.local 로 끝난다. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, { max: 2 });
  try {
    const user = async (email: string, name: string): Promise<string> =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO users(email, name) VALUES ($1, $2)
           ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [email, name],
        )
      ).rows[0]!.id;

    const host = await user('host@demo.slatebook.local', '호스트(스튜디오 사장님)');
    await pool.query(
      `INSERT INTO host_profiles(user_id, business_type, kyc_status, commission_rate_bp)
       VALUES ($1, 'SOLE_PROPRIETOR', 'VERIFIED', 1000) ON CONFLICT (user_id) DO NOTHING`,
      [host],
    );
    for (const [email, name] of [
      ['alice@demo.slatebook.local', '앨리스'],
      ['bob@demo.slatebook.local', '밥'],
      ['chris@demo.slatebook.local', '크리스'],
    ] as const) {
      await user(email, name);
    }

    const listing = async (title: string, kind: 'STUDIO' | 'EQUIPMENT', price: number, buffer: number, units: number) => {
      const found = await pool.query<{ id: string }>('SELECT id FROM listings WHERE host_id = $1 AND title = $2', [host, title]);
      if (found.rows[0]) return;
      const id = (
        await pool.query<{ id: string }>(
          `INSERT INTO listings(host_id, kind, title, hourly_price, buffer_minutes) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [host, kind, title, price, buffer],
        )
      ).rows[0]!.id;
      for (let i = 1; i <= units; i++) {
        await pool.query('INSERT INTO resources(listing_id, label) VALUES ($1, $2)', [id, units === 1 ? title : `${title} #${i}`]);
      }
    };
    await listing('A홀 (화이트 톤 스튜디오)', 'STUDIO', 50_000, 30, 1);
    await listing('B홀 (시네마 스튜디오)', 'STUDIO', 80_000, 60, 1);
    await listing('LED 조명 세트', 'EQUIPMENT', 15_000, 0, 3);
    console.log('seeded: 호스트 1명, 데모 사용자 3명, 상품 3개');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
