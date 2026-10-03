import { runTossContractChecks } from '../src/server/payments/toss-contract';
import { TossGateway } from '../src/server/payments/toss';

/**
 * 실제 토스 API 에 돈이 움직이지 않는 요청을 보내, 어댑터의 오류 분류가 맞는지 확인한다.
 *
 *   TOSS_SECRET_KEY=test_sk_... npm run toss:check
 *
 * 개발자센터의 "테스트" 시크릿 키를 쓰세요 (라이브 키 금지). 하나라도 어긋나면 종료 코드 1 이고,
 * 관측한 오류 코드가 출력되므로 src/server/payments/toss.ts 의 분류표를 그에 맞게 고치면 됩니다.
 */
async function main() {
  const secretKey = process.env.TOSS_SECRET_KEY;
  if (!secretKey) throw new Error('TOSS_SECRET_KEY 가 필요합니다 (개발자센터의 테스트 시크릿 키)');
  if (!/^test_/.test(secretKey)) throw new Error('테스트 키(test_ 로 시작)만 허용합니다. 라이브 키로는 실행하지 않습니다.');

  const baseUrl = process.env.TOSS_BASE_URL;
  const make = (key: string, timeoutMs?: number) => new TossGateway({ secretKey: key, baseUrl, defaultTimeoutMs: timeoutMs });
  const results = await runTossContractChecks(make(secretKey), { makeGateway: make });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}\n     기대: ${r.expected}\n     관측: ${r.observed}`);
  }
  console.log(failed === 0 ? '\n모든 계약 확인을 통과했습니다.' : `\n${failed}개가 기대와 다릅니다. 위 "관측" 값을 보고 toss.ts 의 분류를 고치세요.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
