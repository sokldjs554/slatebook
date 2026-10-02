import type { ApiErrorBody } from '@/shared/schemas';

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown>; retryAfterSec?: number };

interface ApiInit {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * fetch 래퍼. 던지지 않고 항상 ApiResult 를 돌려준다.
 *  - status 0 / code NETWORK : 네트워크 오류 (서버가 요청을 처리했는지 알 수 없다 → 같은 Idempotency-Key 로 다시 보내면 안전)
 *  - code ABORTED            : 호출자가 취소함 (보통 오래된 요청이라 결과를 버린다)
 */
export async function api<T>(path: string, init: ApiInit = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: init.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { ok: false, status: 0, code: 'ABORTED', message: '요청이 취소되었습니다.' };
    return { ok: false, status: 0, code: 'NETWORK', message: '네트워크 연결을 확인해 주세요.' };
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (res.ok) return { ok: true, status: res.status, data: payload as T };

  const err = (payload as Partial<ApiErrorBody> | null)?.error;
  const retryAfter = Number(res.headers.get('retry-after'));
  return {
    ok: false,
    status: res.status,
    code: err?.code ?? `HTTP_${res.status}`,
    message: err?.message ?? '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    details: (err?.details as Record<string, unknown> | undefined) ?? undefined,
    retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  };
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '').slice(0, 8);
}
