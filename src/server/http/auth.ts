import type { AppContext } from '../context';
import { UnauthorizedError } from '../errors';

/**
 * ⚠ 데모 전용 인증 ⚠
 * 쿠키에 사용자 id 를 그대로 담는다. 누구나 id 를 알면 그 사용자가 될 수 있으므로 실서비스에는 절대 쓸 수 없다.
 * DEMO_AUTH=1 일 때만 동작하고, 프로덕션 기동은 ALLOW_DEMO_AUTH=1 을 따로 요구한다(config.ts).
 * 실서비스에서는 이 파일의 requireUser 만 실제 세션 검증(Auth.js 등)으로 바꾸면 나머지 코드는 그대로 쓸 수 있다.
 */
export const DEMO_COOKIE = 'sb_uid';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export async function requireUser(ctx: AppContext, req: Request): Promise<string> {
  if (!ctx.config.demoAuth) throw new UnauthorizedError();
  const uid = readCookie(req.headers.get('cookie'), DEMO_COOKIE);
  if (!uid || !UUID.test(uid)) throw new UnauthorizedError();
  const { rowCount } = await ctx.pool.query('SELECT 1 FROM users WHERE id = $1', [uid]);
  if (!rowCount) throw new UnauthorizedError();
  return uid;
}
