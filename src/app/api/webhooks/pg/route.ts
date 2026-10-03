import { createHash } from 'node:crypto';
import { getContext } from '@/server/context';
import { AppError, UnauthorizedError, ValidationError } from '@/server/errors';
import { handle, json } from '@/server/http/respond';
import { safeEqual } from '@/server/http/token';
import { handlePgWebhook } from '@/server/payments/webhook';
import { verifyPortOneWebhook } from '@/server/payments/portone-webhook';

/**
 * PG 웹훅 수신: POST /api/webhooks/pg?token=<WEBHOOK_TOKEN>
 *  - 토큰이 설정돼 있지 않거나 맞지 않으면 거부한다 (설정이 없으면 "열어 두지" 않고 "닫아 둔다").
 *  - 포트원 모드에서는 웹훅 서명(Standard Webhooks)도 검증한다.
 *  - 본문은 믿지 않는다. 주문번호만 꺼내 PG 에 다시 조회한다 (payments/webhook.ts).
 *  - 처리 중 실패하면 5xx 로 응답해 PG 가 재전송하게 한다.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = getContext();
    const expected = ctx.config.webhookToken;
    const given = new URL(req.url).searchParams.get('token') ?? '';
    if (!expected || !safeEqual(given, expected)) throw new UnauthorizedError('invalid webhook token');

    const raw = await req.text();
    if (Buffer.byteLength(raw) > 64 * 1024) throw new AppError('PAYLOAD_TOO_LARGE', 413, 'payload too large');
    if (ctx.config.portone) {
      const failure = await verifyPortOneWebhook(ctx.config.portone.webhookSecret, raw, req.headers);
      if (failure) throw new UnauthorizedError(`invalid webhook signature: ${failure}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new ValidationError('invalid JSON');
    }
    // 같은 이벤트의 재전송은 본문이 같으므로 본문 해시가 곧 이벤트 키다
    const eventKey = createHash('sha256').update(raw).digest('hex');
    const status = await handlePgWebhook(ctx, { provider: ctx.gateway.name, eventKey, payload });
    return json({ status });
  });
}
