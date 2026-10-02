import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { getContext } from '../context';
import { AppError, ValidationError } from '../errors';
import type { ApiErrorBody } from '../../shared/schemas';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...NO_STORE, ...init.headers } });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    const body: ApiErrorBody = { error: { code: err.code, message: err.message, details: err.extra.details } };
    const headers: Record<string, string> = { ...NO_STORE };
    if (err.extra.retryAfterSec) headers['Retry-After'] = String(err.extra.retryAfterSec);
    return Response.json(body, { status: err.status, headers });
  }
  if (err instanceof ZodError) {
    const body: ApiErrorBody = { error: { code: 'VALIDATION', message: '요청 형식이 올바르지 않습니다.' } };
    return Response.json(body, { status: 400, headers: NO_STORE });
  }
  // 예상하지 못한 오류: 내부 정보는 응답에 싣지 않고, 오류 번호로만 서버 로그와 연결한다
  const errorId = randomUUID().slice(0, 8);
  getContext().log.error('unhandled error in route', { errorId, err });
  const body: ApiErrorBody = {
    error: { code: 'INTERNAL', message: `서버 오류가 발생했습니다. 문제가 계속되면 오류 번호 ${errorId} 를 알려 주세요.` },
  };
  return Response.json(body, { status: 500, headers: NO_STORE });
}

/** 라우트 본문을 감싸 모든 예외를 일관된 JSON 오류로 바꾼다 */
export async function handle(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    return errorResponse(err);
  }
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * JSON 본문 읽기.
 *  - Content-Type 이 application/json 이 아니면 거부한다: 브라우저의 단순 form 전송(교차 사이트 POST)으로는
 *    이 형식을 보낼 수 없어서(preflight 가 필요) 쿠키 기반 인증의 CSRF 를 한 겹 더 막아 준다.
 *  - 크기 제한을 둔다.
 */
export async function readJson(req: Request): Promise<unknown> {
  const contentType = req.headers.get('content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 415, 'Content-Type 은 application/json 이어야 합니다.');
  }
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 413, '요청이 너무 큽니다.');
  const text = await req.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new AppError('PAYLOAD_TOO_LARGE', 413, '요청이 너무 큽니다.');
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError('JSON 형식이 올바르지 않습니다.');
  }
}
