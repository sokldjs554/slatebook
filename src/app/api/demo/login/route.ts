import { z } from 'zod';
import { getContext } from '@/server/context';
import { DEMO_COOKIE } from '@/server/http/auth';
import { NotFoundError, ValidationError } from '@/server/errors';
import { handle, json, readJson } from '@/server/http/respond';

/** ⚠ 데모 전용: 시드된 데모 사용자 중 하나로 "로그인" 한다 (쿠키에 id 저장) */
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = getContext();
    if (!ctx.config.demoAuth) throw new NotFoundError();
    const body = z.strictObject({ userId: z.guid() }).safeParse(await readJson(req));
    if (!body.success) throw new ValidationError('userId 가 필요합니다.');
    const { rows } = await ctx.pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE id = $1 AND email LIKE '%@demo.slatebook.local'`,
      [body.data.userId],
    );
    const user = rows[0];
    if (!user) throw new NotFoundError('데모 사용자를 찾을 수 없습니다.');
    const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
    return json({ id: user.id, name: user.name }, {
      headers: { 'Set-Cookie': `${DEMO_COOKIE}=${user.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}` },
    });
  });
}

export async function DELETE() {
  return handle(async () => {
    if (!getContext().config.demoAuth) throw new NotFoundError();
    return json({ ok: true }, { headers: { 'Set-Cookie': `${DEMO_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
  });
}
