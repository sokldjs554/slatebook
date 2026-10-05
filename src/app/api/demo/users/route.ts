import { getContext } from '@/server/context';
import { NotFoundError } from '@/server/errors';
import { DEMO_COOKIE, readCookie } from '@/server/http/auth';
import { handle, json } from '@/server/http/respond';

/** ⚠ 데모 전용: 선택 가능한 데모 사용자 목록과 현재 "로그인" 한 사용자 */
export async function GET(req: Request) {
  return handle(async () => {
    const ctx = getContext();
    if (!ctx.config.demoAuth) throw new NotFoundError();
    const { rows } = await ctx.pool.query<{ id: string; name: string; host: boolean }>(
      `SELECT u.id, u.name, EXISTS (SELECT 1 FROM host_profiles h WHERE h.user_id = u.id) AS host
         FROM users u WHERE u.email LIKE '%@demo.slatebook.local' ORDER BY u.name`,
    );
    const cookie = readCookie(req.headers.get('cookie'), DEMO_COOKIE);
    const current = rows.find((u) => u.id === cookie)?.id ?? null;
    return json({ users: rows, current });
  });
}
