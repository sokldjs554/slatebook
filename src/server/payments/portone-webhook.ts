import { verify } from '@portone/server-sdk/webhook';

const FAILURE_REASONS = new Set(['MISSING_REQUIRED_HEADERS', 'NO_MATCHING_SIGNATURE', 'INVALID_SIGNATURE', 'TIMESTAMP_TOO_OLD', 'TIMESTAMP_TOO_NEW']);

/**
 * 포트원 웹훅 서명(Standard Webhooks: webhook-id · webhook-timestamp · webhook-signature) 검증.
 * 통과하면 null, 실패하면 사유를 돌려준다. 시크릿 형식이 잘못된 것 같은 설정 오류는 그대로 던진다.
 *
 * 서명 계산은 직접 구현하지 않고 공식 SDK 를 쓴다 (Buy). 우리 웹훅 처리는 본문을 믿지 않고 PG 에 다시 조회하므로
 * 서명이 없어도 돈이 잘못 움직이지는 않지만, 위조 요청이 재조회를 유발하는 것까지 막는 한 겹을 더 둔다.
 */
export async function verifyPortOneWebhook(secret: string, rawBody: string, headers: Headers): Promise<string | null> {
  try {
    await verify(secret, rawBody, Object.fromEntries(headers.entries()));
    return null;
  } catch (err) {
    // instanceof 대신 사유 값으로 판별한다 (번들마다 클래스 복사본이 다를 수 있다 — gateway.ts 참고)
    const reason = (err as { reason?: unknown } | null)?.reason;
    if (typeof reason === 'string' && FAILURE_REASONS.has(reason)) return reason;
    throw err;
  }
}
