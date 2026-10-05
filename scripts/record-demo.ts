import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, request, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { Pool } from 'pg';
import { seedDemoData } from '../src/server/seed';

/**
 * 데모 영상(GIF)과 스크린샷을 만든다. 실행 중인 서버(가짜 PG 모드)에 실제 브라우저로 시나리오를 따라간다.
 *
 *   E2E_DATABASE_URL=.../slatebook_e2e E2E_BASE_URL=http://127.0.0.1:3100 npm run demo:record
 *
 * 서버는 E2E_DATABASE_URL 과 같은 DB 를 쓰고 있어야 한다. 시작할 때 그 DB 의 거래·후기를 비우고 데모 시드를 다시 채운다.
 * 결과: docs/images/demo.gif, demo.mp4 와 단계별 스크린샷 (ffmpeg 가 있어야 한다)
 */
const dbUrl = process.env.E2E_DATABASE_URL;
if (!dbUrl || !/e2e/.test(new URL(dbUrl).pathname)) {
  throw new Error('E2E_DATABASE_URL 이 필요하고 DB 이름에 "e2e" 가 들어 있어야 합니다 (데이터를 비웁니다)');
}
const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3100';
const OUT = path.resolve('docs/images');
const SIZE = { width: 960, height: 640 };

const OVERLAY = `(() => {
  const render = () => {
    const text = sessionStorage.getItem('__demoCaption');
    let el = document.getElementById('__demo_caption');
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_caption';
      el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:14px 24px;font:600 19px/1.45 -apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#fff;background:rgba(15,17,21,.9);text-align:center;pointer-events:none';
      document.documentElement.appendChild(el);
    }
    el.textContent = text;
  };
  const dot = () => {
    if (document.getElementById('__demo_dot')) return;
    const d = document.createElement('div');
    d.id = '__demo_dot';
    d.style.cssText = 'position:fixed;left:-50px;top:-50px;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(235,64,52,.85);border:2px solid #fff;box-shadow:0 0 0 2px rgba(0,0,0,.25);z-index:2147483647;pointer-events:none';
    document.documentElement.appendChild(d);
    window.addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
  };
  document.addEventListener('DOMContentLoaded', () => { render(); dot(); });
  window.__renderCaption = render;
})();`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kstDate = (daysAhead: number) => new Date(Date.now() + 9 * 3_600_000 + daysAhead * 86_400_000).toISOString().slice(0, 10);

async function caption(page: Page, text: string) {
  await page.evaluate((t) => {
    sessionStorage.setItem('__demoCaption', t);
    (window as unknown as { __renderCaption?: () => void }).__renderCaption?.();
  }, text);
}

/** 사람이 마우스를 움직여 누르는 것처럼 보이게 한다 */
async function click(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await sleep(250);
  await target.click();
  await page.mouse.move(SIZE.width - 26, 96, { steps: 10 }); // 커서가 글자·별을 가리지 않게 치워 둔다
}

async function shot(page: Page, name: string) {
  const toggle = (hidden: boolean) =>
    page.evaluate((h) => {
      for (const id of ['__demo_caption', '__demo_dot']) {
        const el = document.getElementById(id);
        if (el) el.style.visibility = h ? 'hidden' : 'visible';
      }
    }, hidden);
  await toggle(true);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await toggle(false);
}

/** 데모 안내 패널을 접고 상품 카드가 보이도록 스크롤한다 */
async function showListings(page: Page) {
  await page.evaluate(() => document.querySelector('details')?.removeAttribute('open'));
  await page.locator('.card.listing').first().scrollIntoViewIfNeeded();
  await sleep(500);
}

async function switchUser(page: Page, name: string) {
  const reloaded = page.waitForEvent('load');
  await page.locator('#demo-user').selectOption({ label: name });
  await reloaded;
  await sleep(500);
}

async function openListing(page: Page, title: string, daysAhead: number, start: string, minutes: number) {
  await page.goto('/');
  await click(page, page.locator('.card.listing', { hasText: title }).getByRole('link', { name: '예약하기' }));
  await page.locator('#date').fill(kstDate(daysAhead));
  await page.locator('.cells .cell').first().waitFor();
  await page.locator('#start').selectOption(start);
  await page.locator('#minutes').selectOption(String(minutes));
  await sleep(900);
}

async function main() {
  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  await pool.query(`TRUNCATE bookings, booking_slots, payments, refunds, pg_webhook_inbox, ledger_entries, ledger_transactions,
                    ledger_accounts, outbox, reviews, settlement_items, settlements, payouts RESTART IDENTITY CASCADE`);
  await pool.query(`UPDATE listings SET rating_count = 0, rating_sum = 0`);
  await pool.query(`INSERT INTO ledger_accounts(code, owner_id) VALUES ('PG_RECEIVABLE', NULL), ('CUSTOMER_ESCROW', NULL), ('PLATFORM_FEE_REVENUE', NULL) ON CONFLICT (code, owner_id) DO NOTHING`);
  await seedDemoData(pool);

  mkdirSync(OUT, { recursive: true });
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'slatebook-demo-'));
  const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
  const context: BrowserContext = await browser.newContext({ baseURL, viewport: SIZE, recordVideo: { dir: tmp, size: SIZE }, locale: 'ko-KR', colorScheme: 'light' });
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();

  // ── ① 홈 ─────────────────────────────────────────────
  await page.goto('/');
  await page.getByRole('heading', { name: /스튜디오 · 장비 예약/ }).waitFor();
  await caption(page, '① 홈 — 이렇게 눌러 볼 수 있는 데모 시나리오 안내가 있어요');
  await sleep(2600);
  await shot(page, '01-home');
  await showListings(page);
  await caption(page, '상품 목록의 평점은 실제 후기에서 계산돼요 (후기가 많을수록 위로)');
  await sleep(2600);
  await shot(page, '01b-listings');
  // ── ② 밥이 A홀 14:00–16:00 을 고르는 중 ─────────────────
  await switchUser(page, '밥');
  await openListing(page, 'A홀', 9, '14:00', 120);
  await caption(page, '② 밥이 A홀 14:00–16:00 을 골랐어요 (지금은 비어 있어요)');
  await sleep(2200);
  await shot(page, '02-listing');

  // 화면 밖에서: 그 사이 앨리스가 같은 시간을 먼저 잡는다 (밥의 화면에 보이는 예약 현황은 이미 낡았다)
  const alice = await request.newContext({ baseURL });
  const aliceId = (await pool.query(`SELECT id FROM users WHERE name = '앨리스' AND email LIKE '%@demo.slatebook.local'`)).rows[0].id as string;
  await alice.post('/api/demo/login', { data: { userId: aliceId } });
  const listing = (await pool.query(`SELECT id FROM listings WHERE title LIKE 'A홀%'`)).rows[0].id as string;
  const startIso = new Date(`${kstDate(9)}T14:00:00+09:00`).toISOString();
  const endIso = new Date(new Date(startIso).getTime() + 2 * 3_600_000).toISOString();
  const held = await alice.post('/api/bookings', {
    data: { listingId: listing, start: startIso, end: endIso },
    headers: { 'Idempotency-Key': `demo-${Date.now()}-alice-held-booking` },
  });
  if (!held.ok()) throw new Error(`앨리스의 예약 생성 실패: ${held.status()}`);
  const bookingId = (await held.json()).booking.id as string;

  // ── ③ 밥이 누르는 순간 ────────────────────────────────
  await click(page, page.getByRole('button', { name: /예약하고 결제하기/ }));
  await page.locator('p[role="alert"]').filter({ hasText: '먼저 예약' }).waitFor();
  await caption(page, '③ 그 사이 앨리스가 먼저 잡았어요 — 중복 예약은 없어요 (DB 의 EXCLUDE 제약이 최종 방어선)');
  await sleep(3200);
  await shot(page, '04-slot-taken');
  await caption(page, '화면의 예약 현황도 최신으로 바뀌어요 (빨간 칸 = 예약됨)');
  await sleep(2400);

  // ── ④ 앨리스가 남은 시간 안에 결제 ───────────────────────
  await switchUser(page, '앨리스');
  await page.goto(`/bookings/${bookingId}`);
  await page.getByText('결제 대기 중').waitFor();
  await caption(page, '④ 앨리스는 결제 대기 중 — 10분 안에 결제하면 돼요');
  await sleep(2000);
  await click(page, page.getByRole('button', { name: '결제하기' }));
  await page.waitForURL(/\/pay\/fake\?/);
  await sleep(1200);
  await shot(page, '03-payment');
  await click(page, page.getByRole('button', { name: /정상 승인/ }));
  await page.getByText('예약이 확정되었어요').waitFor();
  await caption(page, '결제 확정 — 예약·슬롯·정산 원장이 한 트랜잭션으로 기록돼요');
  await sleep(2600);
  await shot(page, '05-confirmed');
  await alice.dispose();

  // ── ⑤ 카드 거절 → 재결제 ─────────────────────────────
  await openListing(page, 'B홀', 10, '10:00', 120);
  await click(page, page.getByRole('button', { name: /예약하고 결제하기/ }));
  await page.waitForURL(/\/pay\/fake\?/);
  await caption(page, '⑤ 카드사 거절이 나면…');
  await sleep(1400);
  await click(page, page.getByRole('button', { name: /카드사 거절/ }));
  await page.locator('p[role="alert"]').filter({ hasText: '승인되지 않았어요' }).waitFor();
  await caption(page, '예약은 그대로 두고 다른 결제 수단으로 다시 결제할 수 있어요');
  await sleep(2400);
  await click(page, page.getByRole('link', { name: /다른 결제 수단으로 다시 결제/ }));
  await page.getByRole('button', { name: /다시 결제/ }).waitFor();
  await click(page, page.getByRole('button', { name: /다시 결제/ }));
  await page.waitForURL(/\/pay\/fake\?/);
  await click(page, page.getByRole('button', { name: /정상 승인/ }));
  await page.getByText('예약이 확정되었어요').waitFor();
  await sleep(1500);

  // ── ⑥ 승인은 됐는데 응답이 유실 ──────────────────────────
  await openListing(page, 'LED 조명', 11, '09:00', 60);
  await click(page, page.getByRole('button', { name: /예약하고 결제하기/ }));
  await page.waitForURL(/\/pay\/fake\?/);
  await caption(page, '⑥ PG 는 승인했는데 응답이 유실되면 (타임아웃)');
  await sleep(1500);
  await click(page, page.getByRole('button', { name: /응답이 유실됨/ }));
  await page.getByText('결제를 확인하고 있어요').waitFor();
  await caption(page, '실패라고 하지 않아요 — 슬롯은 유지한 채 서버가 PG 에 물어봐요');
  await sleep(2400);
  await page.getByText('예약이 확정되었어요').waitFor({ timeout: 20_000 });
  await caption(page, '확인이 끝나 예약이 확정됐어요 (돈은 빠졌는데 예약은 없는 상태가 남지 않아요)');
  await sleep(2600);
  await shot(page, '06-reconciled');

  // ── ⑦ 이용 완료 → 후기 → 평점 ───────────────────────────
  await page.goto(`/bookings/${bookingId}`);
  await page.getByText('예약이 확정되었어요').waitFor();
  await caption(page, '⑦ 이용이 끝나면 후기를 남길 수 있어요 (시연을 위해 버튼으로 시간을 되감아요)');
  await sleep(1600);
  await click(page, page.getByRole('button', { name: /이용 시간이 지난 것으로 만들기/ }));
  await page.getByText('이용 후기를 남겨 주세요').waitFor();
  await sleep(900);
  await click(page, page.locator('label:has(input[value="5"])'));
  await page.getByLabel('한줄 후기 (선택)').pressSequentially('채광이 좋고 결제도 간단했어요!', { delay: 55 });
  await sleep(500);
  await shot(page, '07-review-form');
  await click(page, page.getByRole('button', { name: '후기 등록' }));
  await page.getByText('내가 남긴 후기').waitFor();
  await caption(page, '후기와 상품 평점 집계는 한 트랜잭션으로 갱신돼요');
  await sleep(2200);
  await page.goto('/');
  await page.getByText(/\(8\)/).first().waitFor();
  await showListings(page);
  await caption(page, '홈의 평점에 바로 반영됐어요 (A홀 후기 7개 → 8개)');
  await sleep(2600);
  await shot(page, '08-home-rating');

  // ── ⑧ 호스트 화면: 원장에서 읽는 정산 내역 ───────────────
  await switchUser(page, '호스트(스튜디오 사장님)');
  await click(page, page.getByRole('link', { name: '호스트 화면' }));
  await page.getByText('정산 내역 (이용 완료)').waitFor();
  await caption(page, '⑧ 호스트 화면 — 정산액은 예약 화면 숫자가 아니라 원장(복식부기)에서 읽어요');
  await sleep(2600);
  await shot(page, '09-host-statement');
  await caption(page, 'github.com/sokldjs554/slatebook — 동시성 · 결제 예외 · 원장 · 테스트 검증');
  await sleep(2600);

  const videoPath = await page.video()!.path();
  await context.close();
  await browser.close();
  await pool.end();

  const webm = path.join(OUT, 'demo.webm');
  renameSync(videoPath, webm);
  rmSync(tmp, { recursive: true, force: true });

  const ff = (args: string[]) => {
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ffmpeg 실행에 실패했습니다');
  };
  const fps = Number(process.env.DEMO_FPS ?? 7);
  const width = Number(process.env.DEMO_WIDTH ?? 720);
  ff(['-i', webm, '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', path.join(OUT, 'demo.gif')]);
  ff(['-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '26', '-movflags', '+faststart', path.join(OUT, 'demo.mp4')]);
  rmSync(webm, { force: true });
  for (const f of ['demo.gif', 'demo.mp4']) console.log(`${f}: ${(statSync(path.join(OUT, f)).size / 1024 / 1024).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
