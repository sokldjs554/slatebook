import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Pool } from 'pg';

/**
 * 브라우저에서 사용자가 실제로 겪는 흐름과, 그 뒤 DB 에 남은 결과를 함께 확인한다.
 * 가짜 PG 결제창이 "승인 단계 거절", "승인 후 응답 유실", "결제창 닫기" 같은 상황을 만들어 준다.
 */
const dbUrl = process.env.E2E_DATABASE_URL;
if (!dbUrl || !/e2e/.test(new URL(dbUrl).pathname)) {
  throw new Error('E2E_DATABASE_URL 이 필요하고 DB 이름에 "e2e" 가 들어 있어야 합니다 (테스트가 데이터를 비웁니다)');
}
const pool = new Pool({ connectionString: dbUrl, max: 3 });
test.afterAll(() => pool.end());

const q = async <T = any>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];

test.beforeEach(async () => {
  await q(`TRUNCATE bookings, booking_slots, payments, refunds, pg_webhook_inbox, ledger_entries, ledger_transactions,
           ledger_accounts, outbox, reviews, settlement_items, settlements, payouts RESTART IDENTITY CASCADE`);
});

const kstDate = (daysAhead: number) => new Date(Date.now() + 9 * 3_600_000 + daysAhead * 86_400_000).toISOString().slice(0, 10);

async function login(context: BrowserContext, name: string) {
  const [u] = await q<{ id: string }>(`SELECT id FROM users WHERE name = $1 AND email LIKE '%@demo.slatebook.local'`, [name]);
  const res = await context.request.post('/api/demo/login', { data: { userId: u!.id } });
  expect(res.ok()).toBeTruthy();
  return u!.id;
}
const listingId = async (title: string) => (await q<{ id: string }>(`SELECT id FROM listings WHERE title LIKE $1`, [`${title}%`]))[0]!.id;

async function openListing(page: Page, title: string, daysAhead: number, opts: { start?: string; minutes?: number } = {}) {
  await page.goto(`/listings/${await listingId(title)}`);
  await page.locator('#date').fill(kstDate(daysAhead));
  await page.locator('#start').selectOption(opts.start ?? '10:00');
  await page.locator('#minutes').selectOption(String(opts.minutes ?? 120));
  await expect(page.locator('.cells .cell').first()).toBeVisible(); // 예약 현황이 로드됐다
}
/** 화면의 안내 문구. Next.js 가 심어 두는 라우트 안내 영역(role=alert)은 제외한다 */
const notice = (page: Page) => page.locator('p[role="alert"]');
const submit = (page: Page) => page.getByRole('button', { name: /예약하고 결제하기/ });

test('정상 결제: 예약 → 가짜 PG 승인 → 예약 확정, DB 에는 확정 예약과 원장이 남는다', async ({ page, context }) => {
  await login(context, '앨리스');
  await openListing(page, 'A홀', 40);
  await expect(page.getByText('100,000원').first()).toBeVisible();
  await submit(page).click();

  await expect(page).toHaveURL(/\/pay\/fake\?/);
  await expect(page.getByText('100,000원')).toBeVisible();
  await page.getByRole('button', { name: /정상 승인/ }).click();

  await expect(page).toHaveURL(/\/bookings\/[0-9a-f-]{36}/);
  await expect(page.getByText('예약이 확정되었어요')).toBeVisible();

  const [b] = await q(`SELECT status FROM bookings`);
  expect(b.status).toBe('CONFIRMED');
  expect(await q(`SELECT 1 FROM ledger_transactions WHERE kind = 'PAYMENT_APPROVED'`)).toHaveLength(1);
  expect((await q(`SELECT state FROM booking_slots`)).map((r) => r.state)).toEqual(['CONFIRMED']);
});

test('데모 사용자 선택기로 로그인하면 예약할 수 있고, 로그인하지 않으면 안내 메시지가 나온다', async ({ page }) => {
  await openListing(page, 'A홀', 41);
  await submit(page).click();
  await expect(notice(page).filter({ hasText: '데모 사용자를 선택' })).toBeVisible();

  // 선택하면 로그인 API 를 부른 뒤 페이지를 새로 읽는다. 그 reload 가 끝나기 전에 다른 곳으로 이동하면 요청이 중단되므로 load 이벤트를 기다린다.
  const reloaded = page.waitForEvent('load');
  await page.locator('#demo-user').selectOption({ label: '밥' });
  await reloaded;
  await expect(page.locator('#demo-user')).toHaveValue(/.+/);
  await openListing(page, 'A홀', 41);
  await submit(page).click();
  await expect(page).toHaveURL(/\/pay\/fake\?/);
});

test('같은 1초에 두 사람이 같은 스튜디오·같은 시간을 눌러도 한 사람만 결제 단계로 가고, 다른 사람은 안내를 받는다', async ({ browser }) => {
  const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()];
  const baseURL = test.info().project.use.baseURL!;
  const [pageA, pageB] = [await ctxA.newPage(), await ctxB.newPage()];
  for (const [ctx, name] of [[ctxA, '앨리스'], [ctxB, '밥']] as const) {
    const [u] = await q<{ id: string }>(`SELECT id FROM users WHERE name = $1`, [name]);
    await ctx.request.post(`${baseURL}/api/demo/login`, { data: { userId: u!.id } });
  }
  await Promise.all([openListing(pageA, 'A홀', 42), openListing(pageB, 'A홀', 42)]);

  await Promise.all([submit(pageA).click(), submit(pageB).click()]);

  const outcome = async (p: Page) =>
    Promise.race([
      p.waitForURL(/\/pay\/fake\?/).then(() => 'pay' as const),
      notice(p).filter({ hasText: '먼저 예약' }).waitFor().then(() => 'taken' as const),
    ]);
  const results = (await Promise.all([outcome(pageA), outcome(pageB)])).sort();
  expect(results).toEqual(['pay', 'taken']);
  expect(await q(`SELECT 1 FROM bookings`)).toHaveLength(1);
  expect(await q(`SELECT 1 FROM booking_slots WHERE state <> 'RELEASED'`)).toHaveLength(1);
  await Promise.all([ctxA.close(), ctxB.close()]);
});

test('예약 버튼을 빠르게 두 번 눌러도 예약은 한 건이다', async ({ page, context }) => {
  await login(context, '앨리스');
  await openListing(page, 'A홀', 43);
  await submit(page).dblclick();
  await expect(page).toHaveURL(/\/pay\/fake\?/);
  expect(await q(`SELECT 1 FROM bookings`)).toHaveLength(1);
});

test('카드 거절 → 같은 예약에서 다른 결제 수단으로 다시 결제해 확정', async ({ page, context }) => {
  await login(context, '앨리스');
  await openListing(page, 'A홀', 44);
  await submit(page).click();
  await page.getByRole('button', { name: /카드사 거절/ }).click();

  await expect(notice(page)).toContainText('결제가 승인되지 않았어요');
  await page.getByRole('link', { name: /다른 결제 수단으로 다시 결제/ }).click();
  await expect(page).toHaveURL(/\/bookings\//);
  await expect(page.getByText('결제 대기 중')).toBeVisible();
  expect((await q(`SELECT status FROM bookings`))[0].status).toBe('PENDING_PAYMENT');

  await page.getByRole('button', { name: /다시 결제/ }).click();
  await expect(page).toHaveURL(/\/pay\/fake\?/);
  await page.getByRole('button', { name: /정상 승인/ }).click();
  await expect(page.getByText('예약이 확정되었어요')).toBeVisible();
  expect(await q(`SELECT status FROM payments ORDER BY created_at`)).toEqual([{ status: 'FAILED' }, { status: 'APPROVED' }]);
});

test('결제창을 닫고 나가도 예약은 홀드 중으로 남고, 시간이 지나면 만료되어 다른 사람이 예약할 수 있다', async ({ page, context, browser }) => {
  await login(context, '앨리스');
  await openListing(page, 'A홀', 45);
  await submit(page).click();
  await page.getByRole('button', { name: /결제창 닫기/ }).click();

  await expect(page).toHaveURL(/\/$/);
  await page.getByRole('link', { name: /예약 상태 보기/ }).click();
  await expect(page.getByText('결제 대기 중')).toBeVisible();
  await expect(page.getByRole('button', { name: '결제하기' })).toBeVisible();

  // 10분이 흘렀다고 치고 (DB 의 홀드 시각을 과거로) 화면을 새로 연다 — 워커가 돌기 전이라도 만료로 보인다
  await q(`UPDATE bookings SET hold_expires_at = now() - interval '1 second'`);
  await page.reload();
  await expect(page.getByText('결제 가능 시간이 지나 예약이 취소됐어요')).toBeVisible();

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const [u] = await q<{ id: string }>(`SELECT id FROM users WHERE name = '밥'`);
  await ctxB.request.post(`${test.info().project.use.baseURL}/api/demo/login`, { data: { userId: u!.id } });
  await openListing(pageB, 'A홀', 45);
  await submit(pageB).click();
  await expect(pageB).toHaveURL(/\/pay\/fake\?/); // 같은 시간을 새 사용자가 가져갈 수 있다
  await ctxB.close();
});

test('승인은 됐는데 응답이 유실돼도(타임아웃) 사용자는 실패를 보지 않고, 확인이 끝나면 예약이 확정된다', async ({ page, context }) => {
  await login(context, '앨리스');
  await openListing(page, 'A홀', 46);
  await submit(page).click();
  await page.getByRole('button', { name: /응답이 유실됨/ }).click();

  await expect(page).toHaveURL(/\/bookings\//);
  await expect(notice(page)).toHaveCount(0); // 실패 안내가 뜨지 않는다
  await expect(page.getByText('예약이 확정되었어요')).toBeVisible({ timeout: 20_000 }); // 상태 조회가 PG 를 확인해 확정한다
  expect((await q(`SELECT status FROM payments`))[0].status).toBe('APPROVED');
  expect(await q(`SELECT 1 FROM ledger_transactions WHERE kind = 'PAYMENT_APPROVED'`)).toHaveLength(1);
});

test('성공 URL 의 금액을 브라우저에서 고쳐도 서버가 거절하고, 예약은 결제 대기로 남는다', async ({ page, context }) => {
  await login(context, '앨리스');
  await openListing(page, 'A홀', 47);
  await submit(page).click();
  await expect(page).toHaveURL(/\/pay\/fake\?/);
  const orderId = new URL(page.url()).searchParams.get('orderId')!;

  const auth = await context.request.post('/api/fake-pg/authorize', { data: { orderId, outcome: 'success' } });
  const { paymentKey } = await auth.json();
  await page.goto(`/pay/success?paymentKey=${paymentKey}&orderId=${orderId}&amount=1000`); // 10만 원짜리를 1천 원으로

  await expect(notice(page)).toContainText('결제 금액이 주문 금액과 일치하지 않아');
  expect((await q(`SELECT status FROM bookings`))[0].status).toBe('PENDING_PAYMENT');
  expect(await q(`SELECT 1 FROM ledger_transactions`)).toHaveLength(0);
  expect((await q(`SELECT payload FROM outbox WHERE topic = 'payment.anomaly'`)).some((r) => r.payload.type === 'CLIENT_AMOUNT_MISMATCH')).toBe(true);
});

test('이미 예약된 시간대는 화면에서 선택할 수 없고, 정리 시간(버퍼)도 막혀 있다', async ({ page, context, browser }) => {
  await login(context, '앨리스');
  await openListing(page, 'A홀', 48); // 10:00–12:00 + 정리 30분
  await submit(page).click();
  await expect(page).toHaveURL(/\/pay\/fake\?/);

  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();
  const [u] = await q<{ id: string }>(`SELECT id FROM users WHERE name = '밥'`);
  await ctxB.request.post(`${test.info().project.use.baseURL}/api/demo/login`, { data: { userId: u!.id } });
  await openListing(pageB, 'A홀', 48, { start: '14:00', minutes: 60 }); // 1시간 이용 기준
  // 09:00–10:00 은 비어 있어 보이지만 이용 뒤 정리 시간(30분)이 10:00 칸에 걸치므로 막혀야 한다
  await expect(pageB.locator('#start option[value="09:00"]')).toBeDisabled();
  await expect(pageB.locator('#start option[value="08:30"]')).toBeEnabled(); // 08:30–09:30 + 정리 30분 = 10:00 직전까지
  await expect(pageB.locator('#start option[value="10:00"]')).toBeDisabled();
  await expect(pageB.locator('#start option[value="12:00"]')).toBeDisabled(); // 앞 예약의 정리 시간(12:00–12:30)
  await expect(pageB.locator('#start option[value="12:30"]')).toBeEnabled();
  // 막힌 시간을 억지로 고를 수는 없지만, 이용 시간을 늘려 겹치게 만들면 경고가 뜬다
  await pageB.locator('#start').selectOption('08:30');
  await pageB.locator('#minutes').selectOption('120');
  await expect(notice(pageB).filter({ hasText: '이미 예약된 칸' })).toBeVisible();
  await ctxB.close();
});
