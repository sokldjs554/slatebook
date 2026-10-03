import { getContext } from './server/context';
import { startJobLoop } from './server/jobs';

// 설정(DATABASE_URL 등)이 잘못됐다면 첫 요청이 500 으로 터질 때가 아니라 기동할 때 분명하게 죽는다.
// Next 는 instrumentation 이 던진 예외를 로그만 남기고 서버를 계속 띄우므로, 직접 종료해야 배포 플랫폼이 실패로 인식한다.
let ctx: ReturnType<typeof getContext>;
try {
  ctx = getContext();
} catch (err) {
  console.error(`[slatebook] 서버 설정이 올바르지 않아 기동을 중단합니다.\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (process.env.RUN_JOBS_IN_PROCESS === '1') {
  startJobLoop(ctx, { intervalMs: 5_000 });
  ctx.log.info('background jobs started in the web process (RUN_JOBS_IN_PROCESS=1)');
}
