import { getContext } from '@/server/context';
import { NotFoundError } from '@/server/errors';
import { DEMO_COOKIE, readCookie } from '@/server/http/auth';
import { handle, json } from '@/server/http/respond';

/** ⚠ 데모 전용: 선택 가능한 데모 사용자 목록과 현재 "로그인" 한 사용자 */
export async function GET(req: Request) {
  return handle(async () => {
    const ctx = getContext();
    if (!ctx.config.demoAuth) throw new NotFoundError();
    const { rows } = await ctx.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE email LIKE '%@demo.slatebook.local' ORDER BY name`,
    );
    const cookie = readCookie(req.headers.get('cookie'), DEMO_COOKIE);
    const current = rows.find((u) => u.id === cookie)?.id ?? null;
    return json({ users: rows, current });
  });
}
