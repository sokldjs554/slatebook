import { getContext } from '@/server/context';
import { requireUser } from '@/server/http/auth';
import { handle, json, readJson } from '@/server/http/respond';
import { confirmPayment } from '@/server/payments/confirm';

/**
 * 결제 성공 리다이렉트 값을 받아 승인·확정한다.
 *   200 CONFIRMED   확정됨
 *   202 PROCESSING  결과가 아직 확정되지 않음 (PG 응답 지연·유실). 실패가 아니다 — 예약 상태를 조회하며 기다린다.
 * 요청 취소 신호(req.signal)는 일부러 쓰지 않는다: 브라우저를 닫아도 서버는 끝까지 처리한다.
 */
export async function POST(req: Request) {
  return handle(async () => {
    const ctx = getContext();
    const userId = await requireUser(ctx, req);
    const result = await confirmPayment(ctx, userId, await readJson(req));
    return json(result, { status: result.status === 'CONFIRMED' ? 200 : 202 });
  });
}
