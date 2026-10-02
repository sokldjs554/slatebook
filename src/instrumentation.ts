/**
 * 서버가 뜰 때 한 번 실행된다. 로컬 데모(RUN_JOBS_IN_PROCESS=1)에서는 웹 서버 프로세스 안에서
 * 만료 정리·결제 대사·정산 분개 작업을 돌려, 별도 워커 없이도 전체 흐름이 완결되게 한다.
 * (가짜 PG 의 상태가 웹 프로세스 메모리에 있으므로 대사도 같은 프로세스에서 돌아야 한다.)
 * 실서비스에서는 이 옵션을 끄고 `npm run worker` 를 별도 프로세스로 운영한다.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
