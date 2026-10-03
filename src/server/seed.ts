import type { Pool } from 'pg';
import { loadConfig } from './config';
import type { AppContext } from './context';
import { withTx } from './db';
import { postPaymentApproved, postRevenueRecognition } from './ledger/ledger';
import { silentLogger } from './logger';
import { FakeGateway } from './payments/fake';
import { createReview } from './reviews/create';
import { calcQuote } from '../shared/quote';

/** 데모 사용자의 이메일은 @demo.slatebook.local 로 끝난다 (사용자 선택기에 나오는 사용자) */
const DEMO_DOMAIN = 'demo.slatebook.local';

const LISTINGS = [
  { title: 'A홀 (화이트 톤 스튜디오)', kind: 'STUDIO', price: 50_000, buffer: 30, units: 1 },
  { title: 'B홀 (시네마 스튜디오)', kind: 'STUDIO', price: 80_000, buffer: 60, units: 1 },
  { title: 'LED 조명 세트', kind: 'EQUIPMENT', price: 15_000, buffer: 0, units: 3 },
] as const;

/** [상품, 작성자, 완료된 지 며칠, 평점, 후기] — 같은 상품 안에서는 며칠 전이 서로 달라야 한다(같은 시간대를 겹쳐 예약할 수 없으므로) */
const HISTORY: Array<[string, string, number, number, string]> = [
  ['A홀 (화이트 톤 스튜디오)', '민지', 2, 5, '채광이 정말 좋아요. 화이트 톤이라 보정이 거의 필요 없었어요.'],
  ['A홀 (화이트 톤 스튜디오)', '준호', 4, 5, '정리 시간을 따로 잡아 둬서 앞 팀 짐이 남아 있는 일이 없었어요.'],
  ['A홀 (화이트 톤 스튜디오)', '서연', 6, 4, '넓고 깨끗해요. 주차만 조금 불편했어요.'],
  ['A홀 (화이트 톤 스튜디오)', '도윤', 8, 5, '호스트님이 친절하세요. 다음 촬영도 여기서 할게요.'],
  ['A홀 (화이트 톤 스튜디오)', '하은', 11, 4, '예약부터 결제까지 간단했어요.'],
  ['A홀 (화이트 톤 스튜디오)', '지우', 14, 3, '시설은 좋은데 에어컨이 조금 시끄러웠어요.'],
  ['A홀 (화이트 톤 스튜디오)', '시윤', 19, 5, '배경지 종류가 많아서 좋았어요!'],
  ['B홀 (시네마 스튜디오)', '민지', 3, 5, '시네마 조명 세팅이 훌륭해요. 영상 촬영에 딱이에요.'],
  ['B홀 (시네마 스튜디오)', '준호', 9, 4, '방음이 잘 돼요. 다만 대여 시간이 조금 빡빡했어요.'],
  ['B홀 (시네마 스튜디오)', '서연', 17, 5, '장비 상태가 좋아요.'],
  ['LED 조명 세트', '도윤', 5, 4, '밝기 조절이 편해요. 거치대가 하나 더 있으면 좋겠어요.'],
  ['LED 조명 세트', '하은', 12, 5, '가볍고 색온도 조절이 좋아요.'],
];

/** 이 스크립트가 만든 데이터인지 구분하는 표식 (여러 번 실행해도 과거 이력이 중복되지 않게) */
const HISTORY_MARKER = 'seed-history-1';

export async function seedDemoData(pool: Pool): Promise<{ users: number; listings: number; reviews: number }> {
  const user = async (email: string, name: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO users(email, name) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [email, name],
      )
    ).rows[0]!.id;

  const host = await user(`host@${DEMO_DOMAIN}`, '호스트(스튜디오 사장님)');
  await pool.query(
    `INSERT INTO host_profiles(user_id, business_type, kyc_status, commission_rate_bp)
     VALUES ($1, 'SOLE_PROPRIETOR', 'VERIFIED', 1000) ON CONFLICT (user_id) DO NOTHING`,
    [host],
  );
  for (const [email, name] of [[`alice@${DEMO_DOMAIN}`, '앨리스'], [`bob@${DEMO_DOMAIN}`, '밥'], [`chris@${DEMO_DOMAIN}`, '크리스']] as const) {
    await user(email, name);
  }

  const listingIds = new Map<string, string>();
  for (const l of LISTINGS) {
    const found = await pool.query<{ id: string }>('SELECT id FROM listings WHERE host_id = $1 AND title = $2', [host, l.title]);
    let id = found.rows[0]?.id;
    if (!id) {
      id = (
        await pool.query<{ id: string }>(
          `INSERT INTO listings(host_id, kind, title, hourly_price, buffer_minutes) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [host, l.kind, l.title, l.price, l.buffer],
        )
      ).rows[0]!.id;
      for (let i = 1; i <= l.units; i++) {
        await pool.query('INSERT INTO resources(listing_id, label) VALUES ($1, $2)', [id, l.units === 1 ? l.title : `${l.title} #${i}`]);
      }
    }
    listingIds.set(l.title, id);
  }

  const already = await pool.query('SELECT 1 FROM bookings WHERE idempotency_key = $1', [HISTORY_MARKER]);
  let reviews = 0;
  if (!already.rowCount) {
    const ctx: AppContext = {
      pool,
      gateway: new FakeGateway(),
      config: loadConfig({ DATABASE_URL: 'seed', PAYMENT_GATEWAY: 'fake', LOG_LEVEL: 'silent' }),
      log: silentLogger,
      clock: () => new Date(),
    };
    let n = 0;
    for (const [title, reviewer, daysAgo, rating, body] of HISTORY) {
      n += 1;
      const listingId = listingIds.get(title)!;
      const spec = LISTINGS.find((l) => l.title === title)!;
      const author = await user(`${reviewer}@reviewer.${DEMO_DOMAIN}`, reviewer); // 선택기에는 나오지 않는 후기 작성자
      const quote = calcQuote({ hourlyPrice: spec.price, minutes: 120, commissionRateBp: 1000, bufferMinutes: spec.buffer });
      const bookingId = await withTx(pool, async (tx) => {
        const resource = (await tx.query<{ id: string }>('SELECT id FROM resources WHERE listing_id = $1 ORDER BY id LIMIT 1', [listingId])).rows[0]!.id;
        const b = await tx.query<{ id: string }>(
          `INSERT INTO bookings(consumer_id, listing_id, status, period, total_amount, price_snapshot, cancel_policy_snapshot,
                                completed_at, idempotency_key, request_hash)
           VALUES ($1, $2, 'COMPLETED', tstzrange(now() - make_interval(days => $3, hours => 3), now() - make_interval(days => $3, hours => 1), '[)'),
                   $4, $5::jsonb, '{}'::jsonb, now() - make_interval(days => $3), $6, 'seed')
           RETURNING id`,
          [author, listingId, daysAgo, quote.amount, JSON.stringify({ ...quote, currency: 'KRW' }), n === 1 ? HISTORY_MARKER : `seed-history-${n + 1}`],
        );
        const id = b.rows[0]!.id;
        await tx.query(
          `INSERT INTO booking_slots(booking_id, resource_id, blocked, state)
           VALUES ($1, $2, tstzrange(now() - make_interval(days => $3, hours => 3), now() - make_interval(days => $3, hours => 1) + make_interval(mins => $4), '[)'), 'CONFIRMED')`,
          [id, resource, daysAgo, spec.buffer],
        );
        const pay = await tx.query<{ id: string }>(
          `INSERT INTO payments(booking_id, order_id, provider, payment_key, amount, status, method, approved_at, raw)
           VALUES ($1, $2, 'fake', $3, $4, 'APPROVED', '카드', now() - make_interval(days => $5, hours => 4), '{"seeded":true}'::jsonb) RETURNING id`,
          [id, `seed_order_${n}`, `seed_pk_${n}`, quote.amount, daysAgo],
        );
        await postPaymentApproved(tx, { paymentId: pay.rows[0]!.id, amount: quote.amount });
        await postRevenueRecognition(tx, { bookingId: id, hostId: host, gross: quote.amount, fee: quote.feeAmount });
        return id;
      });
      await createReview(ctx, author, bookingId, { rating, body });
      // 후기는 이용이 끝난 다음 날 쓴 것처럼 보이게 한다
      await pool.query(`UPDATE reviews SET created_at = (SELECT completed_at + interval '20 hours' FROM bookings WHERE id = $1) WHERE booking_id = $1`, [bookingId]);
      reviews += 1;
    }
  }

  const users = (await pool.query(`SELECT count(*)::int AS n FROM users WHERE email LIKE '%@${DEMO_DOMAIN}'`)).rows[0].n as number;
  return { users, listings: LISTINGS.length, reviews };
}
