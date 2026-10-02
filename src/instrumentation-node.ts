import { getContext } from './server/context';
import { startJobLoop } from './server/jobs';

if (process.env.RUN_JOBS_IN_PROCESS === '1') {
  const ctx = getContext();
  startJobLoop(ctx, { intervalMs: 5_000 });
  ctx.log.info('background jobs started in the web process (RUN_JOBS_IN_PROCESS=1)');
}
