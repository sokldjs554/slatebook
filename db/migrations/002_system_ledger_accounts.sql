-- 시스템 원장 계정을 미리 만들어 둔다.
-- 계정을 "처음 쓸 때" 만들면, 서로 다른 종류의 분개(승인·환불·수익 인식)가 동시에 처음 실행될 때
-- 계정을 서로 반대 순서로 만들다 교착(deadlock)할 수 있다. 미리 있으면 INSERT 가 일어나지 않는다.
-- (호스트별 미지급금 계정은 호스트당 한 번만 만들어지고, 한 거래가 새 계정을 하나만 만들어 순환이 생길 수 없다.)
INSERT INTO ledger_accounts(code, owner_id) VALUES
  ('PG_RECEIVABLE', NULL),
  ('CUSTOMER_ESCROW', NULL),
  ('PLATFORM_FEE_REVENUE', NULL)
ON CONFLICT (code, owner_id) DO NOTHING;
