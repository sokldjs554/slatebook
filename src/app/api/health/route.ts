import { getContext } from '@/server/context';
import { json } from '@/server/http/respond';

/** 배포 환경의 상태 점검용. DB 에 닿는지만 확인하고, 내부 정보는 싣지 않는다. */
export async function GET() {
  try {
    await getContext().pool.query('SELECT 1');
    return json({ ok: true });
  } catch {
    return json({ ok: false }, { status: 503 });
  }
}
