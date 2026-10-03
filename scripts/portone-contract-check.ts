import { runPortOneContractChecks } from '../src/server/payments/portone-contract';
import { PortOneGateway } from '../src/server/payments/portone';

/**
 * 실제 포트원 V2 API 에 돈이 움직이지 않는 요청(존재하지 않는 결제의 조회·취소 등)을 보내, 어댑터의 오류 분류가 맞는지 확인한다.
 *
 *   PORTONE_API_SECRET=... npm run portone:check
 *
 * 포트원 V2 시크릿은 토스처럼 테스트/라이브가 키 모양으로 구분되지 않는다. 이 스크립트의 요청은 모두 존재하지 않는
 * 결제를 대상으로 하므로 돈은 움직이지 않지만, 가능하면 테스트 채널만 연결된 상점의 시크릿을 쓰세요.
 * 하나라도 어긋나면 종료 코드 1 이고, 관측한 오류 종류가 출력되므로 src/server/payments/portone.ts 의 분류를 그에 맞게 고칩니다.
 */
async function main() {
  const apiSecret = process.env.PORTONE_API_SECRET;
  if (!apiSecret) throw new Error('PORTONE_API_SECRET 이 필요합니다 (관리자 콘솔 → 결제 연동 → API 시크릿)');

  const baseUrl = process.env.PORTONE_BASE_URL;
  const storeId = process.env.PORTONE_STORE_ID || undefined;
  const make = (secret: string, timeoutMs?: number) => new PortOneGateway({ apiSecret: secret, storeId, baseUrl, defaultTimeoutMs: timeoutMs });
  const results = await runPortOneContractChecks(make(apiSecret), { makeGateway: make });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}\n     기대: ${r.expected}\n     관측: ${r.observed}`);
  }
  console.log(failed === 0 ? '\n모든 계약 확인을 통과했습니다.' : `\n${failed}개가 기대와 다릅니다. 위 "관측" 값을 보고 portone.ts 의 분류를 고치세요.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
