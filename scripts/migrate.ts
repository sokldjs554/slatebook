import { createPool } from '../src/server/db';
import { migrate } from '../src/server/migrate';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
