import { createPool } from '../src/server/db';
import { seedDemoData } from '../src/server/seed';

/** 데모 데이터(호스트·사용자·상품·과거 이용 내역과 후기). 여러 번 실행해도 중복되지 않는다. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, { max: 2 });
  try {
    const r = await seedDemoData(pool);
    console.log(`seeded: 데모 사용자 ${r.users}명, 상품 ${r.listings}개${r.reviews ? `, 과거 이용 내역·후기 ${r.reviews}건` : ' (과거 이용 내역은 이미 있음)'}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
