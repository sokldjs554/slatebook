-- slatebook 핵심 스키마 (PostgreSQL 16+)
--
-- 규칙
--   · 금액은 원 단위 bigint (float 금지)
--   · 시간 구간은 tstzrange 의 반열린 구간 '[)' — 10-12시와 12-14시는 겹치지 않는다
--   · "있어서는 안 되는 상태"는 앱 코드가 아니라 DB 가 거부한다
--       - 같은 자원·겹치는 시간 활성 슬롯      → EXCLUDE no_overbooking
--       - 합계가 0 이 아닌 원장 거래            → 지연 제약 트리거 (COMMIT 시점 검사)
--       - 원장 수정·삭제                         → append-only 트리거
--       - 정의되지 않은 상태 전이                → 상태 전이 트리거
--       - 같은 결제의 중복 정산                  → settlement_items UNIQUE (kind, source_id)

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ───────────────────────── 사용자 ─────────────────────────
CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  name        text NOT NULL,
  phone       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE host_profiles (
  user_id             uuid PRIMARY KEY REFERENCES users(id),
  business_type       text NOT NULL CHECK (business_type IN ('INDIVIDUAL','SOLE_PROPRIETOR','CORPORATION')),
  business_reg_no     text,
  kyc_status          text NOT NULL DEFAULT 'PENDING' CHECK (kyc_status IN ('PENDING','VERIFIED','REJECTED')),
  commission_rate_bp  int  NOT NULL DEFAULT 1000 CHECK (commission_rate_bp BETWEEN 0 AND 10000),
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payout_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id         uuid NOT NULL REFERENCES host_profiles(user_id),
  bank_code       text NOT NULL,
  account_no_enc  bytea NOT NULL,           -- 애플리케이션 레벨 암호화된 계좌번호
  holder_name     text NOT NULL,
  verified_at     timestamptz,
  is_default      boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_default_payout_account ON payout_accounts(host_id) WHERE is_default;

-- ───────────────────────── 상품 / 예약 가능한 자원 ─────────────────────────
CREATE TABLE listings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id         uuid NOT NULL REFERENCES host_profiles(user_id),
  kind            text NOT NULL CHECK (kind IN ('STUDIO','EQUIPMENT')),
  title           text NOT NULL,
  hourly_price    bigint NOT NULL CHECK (hourly_price > 0),
  buffer_minutes  int NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 240),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PAUSED')),
  rating_count    int NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  rating_sum      int NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 겹침을 막는 단위는 listing 이 아니라 물리적 자원이다.
-- 스튜디오 1개 = 1행, 같은 조명 5대 = 5행.
CREATE TABLE resources (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  uuid NOT NULL REFERENCES listings(id),
  label       text NOT NULL,
  active      boolean NOT NULL DEFAULT true
);
CREATE INDEX resources_by_listing ON resources(listing_id);

-- ───────────────────────── 예약 ─────────────────────────
CREATE TYPE booking_status AS ENUM (
  'PENDING_PAYMENT',      -- 홀드 중 (결제 대기)
  'PAYMENT_CONFIRMING',   -- PG 승인 호출 중이거나 결과 미확정 → 홀드가 지나도 슬롯을 풀지 않는다
  'CONFIRMED',
  'COMPLETED',
  'CANCELED',
  'EXPIRED',
  'PAYMENT_FAILED'        -- 위변조 등으로 결제 자체를 거부한 예약
);

CREATE TABLE bookings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consumer_id             uuid NOT NULL REFERENCES users(id),
  listing_id              uuid NOT NULL REFERENCES listings(id),
  status                  booking_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  period                  tstzrange NOT NULL
    CHECK (NOT isempty(period) AND lower_inc(period) AND NOT upper_inc(period)),
  total_amount            bigint NOT NULL CHECK (total_amount > 0),
  price_snapshot          jsonb NOT NULL,   -- 예약 시점의 단가·수수료율·버퍼 (이후 가격이 바뀌어도 정산 근거 유지)
  cancel_policy_snapshot  jsonb NOT NULL,
  hold_expires_at         timestamptz,
  completed_at            timestamptz,
  idempotency_key         text NOT NULL,
  request_hash            text NOT NULL,    -- 같은 키로 다른 요청이 오면 거부하기 위한 지문
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consumer_id, idempotency_key),
  CHECK (status NOT IN ('PENDING_PAYMENT','PAYMENT_CONFIRMING') OR hold_expires_at IS NOT NULL)
);
CREATE INDEX bookings_hold_expiry ON bookings(hold_expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX bookings_by_consumer ON bookings(consumer_id, created_at DESC);

CREATE TABLE booking_slots (
  id           bigserial PRIMARY KEY,
  booking_id   uuid NOT NULL REFERENCES bookings(id),
  resource_id  uuid NOT NULL REFERENCES resources(id),
  blocked      tstzrange NOT NULL
    CHECK (NOT isempty(blocked) AND lower_inc(blocked) AND NOT upper_inc(blocked)),  -- [시작, 종료 + 정리 버퍼)
  state        text NOT NULL CHECK (state IN ('HELD','CONFIRMED','RELEASED')),
  -- 최종 보증: 같은 자원에서 겹치는 활성 구간은 어떤 코드 경로로도 존재할 수 없다
  CONSTRAINT no_overbooking
    EXCLUDE USING gist (resource_id WITH =, blocked WITH &&)
    WHERE (state <> 'RELEASED')
);
CREATE INDEX booking_slots_by_booking ON booking_slots(booking_id);

-- ───────────────────────── 결제 ─────────────────────────
CREATE TABLE payments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id              uuid NOT NULL REFERENCES bookings(id),
  order_id                text NOT NULL UNIQUE,         -- PG 에 넘기는 주문번호 (서버가 발급)
  provider                text NOT NULL,
  payment_key             text UNIQUE,                  -- PG 가 발급하는 결제 키
  amount                  bigint NOT NULL CHECK (amount > 0),   -- 서버가 계산한 금액 = 유일한 진실
  canceled_amount         bigint NOT NULL DEFAULT 0,
  status                  text NOT NULL CHECK (status IN
    ('READY','CONFIRMING','APPROVED','PARTIAL_CANCELED','CANCELED','FAILED','UNKNOWN')),
  method                  text,
  approved_at             timestamptz,
  failure_reason          text,
  raw                     jsonb,                        -- 마지막으로 확인한 PG 응답
  confirm_started_at      timestamptz,                  -- 승인 선점 시각 (미확정 결제의 경과 시간 기준)
  refund_pending          boolean NOT NULL DEFAULT false,  -- 승인됐지만 예약에 쓸 수 없어 환불해야 하는 결제 (내구성 있는 의도 기록)
  reconcile_attempts      int NOT NULL DEFAULT 0,
  reconcile_attempted_at  timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (canceled_amount BETWEEN 0 AND amount)
);
-- 예약 하나에 "살아 있는" 결제는 최대 1건 (실패한 결제는 제외하므로 재시도 가능)
CREATE UNIQUE INDEX one_live_payment_per_booking ON payments(booking_id)
  WHERE status IN ('READY','CONFIRMING','APPROVED','PARTIAL_CANCELED','UNKNOWN');
CREATE INDEX payments_unresolved ON payments(updated_at) WHERE status IN ('CONFIRMING','UNKNOWN');
CREATE INDEX payments_refund_pending ON payments(updated_at) WHERE refund_pending;

CREATE TABLE refunds (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id       uuid NOT NULL REFERENCES payments(id),
  amount           bigint NOT NULL CHECK (amount > 0),
  reason           text NOT NULL,
  status           text NOT NULL CHECK (status IN ('REQUESTED','DONE','FAILED')),
  idempotency_key  text NOT NULL UNIQUE,
  pg_cancel_key    text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- PG 웹훅 수신함: 같은 이벤트가 몇 번 와도 한 번만 처리한다
CREATE TABLE pg_webhook_inbox (
  id            bigserial PRIMARY KEY,
  provider      text NOT NULL,
  event_key     text NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  UNIQUE (provider, event_key)
);

-- ───────────────────────── 원장 (복식부기) ─────────────────────────
-- 차변 +, 대변 −. 한 거래의 합계는 반드시 0.
CREATE TABLE ledger_accounts (
  id        bigserial PRIMARY KEY,
  code      text NOT NULL,
  owner_id  uuid,                       -- 호스트별 미지급금 등 소유자 계정
  UNIQUE NULLS NOT DISTINCT (code, owner_id)
);

CREATE TABLE ledger_transactions (
  id               bigserial PRIMARY KEY,
  kind             text NOT NULL,
  ref_type         text NOT NULL,
  ref_id           uuid NOT NULL,
  idempotency_key  text NOT NULL UNIQUE,   -- 같은 사건을 두 번 분개하지 않는다
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id              bigserial PRIMARY KEY,
  transaction_id  bigint NOT NULL REFERENCES ledger_transactions(id),
  account_id      bigint NOT NULL REFERENCES ledger_accounts(id),
  amount          bigint NOT NULL CHECK (amount <> 0)
);
CREATE INDEX ledger_entries_by_tx ON ledger_entries(transaction_id);

-- ───────────────────────── 정산 ─────────────────────────
CREATE TABLE settlements (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id            uuid NOT NULL REFERENCES host_profiles(user_id),
  period_start       date NOT NULL,
  period_end         date NOT NULL,
  gross_amount       bigint NOT NULL,
  fee_amount         bigint NOT NULL,
  adjustment_amount  bigint NOT NULL DEFAULT 0,
  net_amount         bigint NOT NULL,
  status             text NOT NULL CHECK (status IN ('DRAFT','CONFIRMED','PAYING','PAID','FAILED','ON_HOLD')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (net_amount = gross_amount - fee_amount + adjustment_amount),
  UNIQUE (host_id, period_start, period_end)
);

CREATE TABLE settlement_items (
  id             bigserial PRIMARY KEY,
  settlement_id  uuid NOT NULL REFERENCES settlements(id),
  booking_id     uuid NOT NULL REFERENCES bookings(id),
  kind           text NOT NULL CHECK (kind IN ('SALE','REFUND_ADJUSTMENT')),
  source_id      uuid NOT NULL,            -- 결제 id 또는 환불 id
  gross          bigint NOT NULL,
  fee            bigint NOT NULL,
  net            bigint NOT NULL,
  CHECK (net = gross - fee),
  UNIQUE (kind, source_id)                 -- 같은 결제가 두 번 정산되지 않는다
);

CREATE TABLE payouts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id       uuid NOT NULL UNIQUE REFERENCES settlements(id),
  payout_account_id   uuid NOT NULL REFERENCES payout_accounts(id),
  amount              bigint NOT NULL CHECK (amount > 0),
  status              text NOT NULL CHECK (status IN ('REQUESTED','PROCESSING','DONE','FAILED')),
  provider_payout_id  text UNIQUE,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  failure_reason      text
);

-- ───────────────────────── 후기 ─────────────────────────
CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL UNIQUE REFERENCES bookings(id),   -- 예약당 후기 1건
  author_id   uuid NOT NULL REFERENCES users(id),
  listing_id  uuid NOT NULL REFERENCES listings(id),
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body        text,
  status      text NOT NULL DEFAULT 'PUBLISHED' CHECK (status IN ('PUBLISHED','HIDDEN')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── outbox ─────────────────────────
-- 상태 변경과 같은 트랜잭션에 이벤트를 기록해, 커밋된 사건의 알림이 유실되지 않게 한다
CREATE TABLE outbox (
  id            bigserial PRIMARY KEY,
  topic         text NOT NULL,
  payload       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz
);
CREATE INDEX outbox_unpublished ON outbox(id) WHERE published_at IS NULL;

-- ═════════════════════════ 불변식을 강제하는 트리거 ═════════════════════════

-- 원장: 거래별 합계 0 (COMMIT 시점에 검사 → 한 트랜잭션 안에서 여러 줄을 나눠 넣을 수 있다)
CREATE FUNCTION assert_ledger_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT sum(amount) FROM ledger_entries WHERE transaction_id = NEW.transaction_id) <> 0 THEN
    RAISE EXCEPTION 'ledger transaction % is not balanced', NEW.transaction_id USING ERRCODE = 'SB003';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- 원장: 추가 전용. 틀렸으면 지우지 말고 반대 분개로 정정한다.
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'SB004';
END $$;
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_transactions_append_only BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_touch BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 예약 상태 전이
--   PENDING_PAYMENT ─► PAYMENT_CONFIRMING ─► CONFIRMED ─► COMPLETED
--        │  ▲                 │   │  │                 └─► CANCELED
--        │  └─ (거절·미결제) ──┘   │  └─► PAYMENT_FAILED (위변조 등)
--        │                         └─► EXPIRED (홀드 만료 후 결제 실패 확정)
--        └─► EXPIRED / CANCELED / PAYMENT_FAILED
CREATE FUNCTION enforce_booking_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
       (OLD.status = 'PENDING_PAYMENT'    AND NEW.status IN ('PAYMENT_CONFIRMING','EXPIRED','CANCELED','PAYMENT_FAILED'))
    OR (OLD.status = 'PAYMENT_CONFIRMING' AND NEW.status IN ('CONFIRMED','PENDING_PAYMENT','EXPIRED','PAYMENT_FAILED'))
    OR (OLD.status = 'CONFIRMED'          AND NEW.status IN ('COMPLETED','CANCELED'))
  ) THEN
    RAISE EXCEPTION 'illegal booking transition % -> %', OLD.status, NEW.status USING ERRCODE = 'SB001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_transition BEFORE UPDATE OF status ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_transition();

-- 결제 상태 전이
CREATE FUNCTION enforce_payment_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NOT (
       (OLD.status = 'READY'            AND NEW.status IN ('CONFIRMING','FAILED','APPROVED','CANCELED'))
    OR (OLD.status = 'CONFIRMING'       AND NEW.status IN ('APPROVED','FAILED','UNKNOWN','CANCELED'))
    OR (OLD.status = 'UNKNOWN'          AND NEW.status IN ('APPROVED','FAILED','CANCELED'))
    OR (OLD.status = 'APPROVED'         AND NEW.status IN ('PARTIAL_CANCELED','CANCELED'))
    OR (OLD.status = 'PARTIAL_CANCELED' AND NEW.status = 'CANCELED')
    OR (OLD.status = 'FAILED'           AND NEW.status = 'CANCELED')   -- 실패 처리 후 뒤늦게 승인된 건을 환불
  ) THEN
    RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status USING ERRCODE = 'SB002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_transition BEFORE UPDATE OF status ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_payment_transition();

-- 슬롯: RELEASED 는 되살릴 수 없고, 자원·시간은 생성 후 바꿀 수 없다
CREATE FUNCTION enforce_slot_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_id <> OLD.resource_id OR NEW.blocked <> OLD.blocked OR NEW.booking_id <> OLD.booking_id THEN
    RAISE EXCEPTION 'booking_slots resource/period/booking are immutable' USING ERRCODE = 'SB005';
  END IF;
  IF OLD.state = 'RELEASED' AND NEW.state <> 'RELEASED' THEN
    RAISE EXCEPTION 'a RELEASED slot cannot be revived' USING ERRCODE = 'SB005';
  END IF;
  IF OLD.state = 'CONFIRMED' AND NEW.state = 'HELD' THEN
    RAISE EXCEPTION 'a CONFIRMED slot cannot go back to HELD' USING ERRCODE = 'SB005';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_slots_rules BEFORE UPDATE ON booking_slots
  FOR EACH ROW EXECUTE FUNCTION enforce_slot_rules();
