-- 015 — 이용권(자유 가입판의 월 이용료) · 결제 대행 웹훅(그로블 정기결제). 설계: docs/OPEN_EDITION.md §4-4 · §4-6.
-- AI 비용(본인 키)과 이용료를 섞지 않는다(원칙 7) — 이 표들은 generation_runs · usage_ledger 와 잇지 않는다.
-- 교육기관판(SE_EDITION=school)에서는 비어 있다.

-- 결제창 링크에 붙이는 참조값(?ref=) — [결제하기]를 누를 때마다 무작위로 하나. 그로블은 그 정기결제의 갱신 · 실패 · 해지에 같은 값을 돌려준다
-- → 참조값 하나 = 정기결제 하나(같은 사람이 두 번 결제해도 둘이 섞이지 않는다). kind='email' 은 운영자가 이어 준 구매자 이메일(참조값 없이 온 결제를 다음부터 잇는다).
CREATE TABLE billing_refs (
  kind        text NOT NULL DEFAULT 'link' CHECK (kind IN ('link', 'email')),
  ref         text NOT NULL,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id     uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,                       -- 이 값으로 웹훅이 처음 닿은 때(쓰지 않은 값은 오래되면 걷는다)
  PRIMARY KEY (kind, ref)
);
CREATE INDEX billing_refs_user ON billing_refs (user_id, created_at DESC);

-- 결제 옵션(요금제) — [결제하기]에 거는 상품. 가격 · 상품 번호는 만든 뒤 바꾸지 않는다(그로블 정기결제는 판매된 옵션을 고칠 수 없다 —
-- 가격을 바꾸려면 새 줄을 넣고 옛 줄을 끈다. 꺼진 줄도 옛 구독자의 갱신을 맞춰 보는 데 쓴다).
CREATE TABLE billing_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  checkout_url  text NOT NULL,
  price         integer NOT NULL CHECK (price > 0),               -- 원
  cycle_months  integer NOT NULL DEFAULT 1 CHECK (cycle_months BETWEEN 1 AND 12),
  product_id    text NOT NULL DEFAULT '',                          -- 웹훅의 content.id(비우면 금액만 견준다)
  enabled       boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 이용권 — 정기결제 하나(사람 · 참조값)마다 한 줄. 운영자의 손 연장은 provider='manual', 가입 체험은 'trial'.
-- «새 AI 작업을 해도 되나» = 그 사람의 줄 가운데 paid_until 이 지금보다 뒤인 것이 있는가(또는 무료 이용 · 운영자).
CREATE TABLE subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           text NOT NULL DEFAULT 'groble' CHECK (provider IN ('groble', 'manual', 'trial')),
  ref                text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'ended' CHECK (status IN ('active', 'past_due', 'cancel_pending', 'ended')),
  paid_until         timestamptz,
  next_billing_date  date,
  service_ends_at    timestamptz,
  final_failure      boolean NOT NULL DEFAULT false,
  occurred_at        timestamptz,                -- 마지막으로 반영한 사건의 때 — 이보다 이른 상태 변경은 기록만(도착 순서를 믿지 않는다)
  plan_id            uuid REFERENCES billing_plans(id) ON DELETE SET NULL,
  last_paid_at       timestamptz,
  last_amount        integer,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, ref)
);
CREATE INDEX subscriptions_live ON subscriptions (user_id, paid_until DESC);

-- 받은 웹훅 — 원문 그대로(이름 · 이메일 · 전화가 들어 있다 — 운영 화면에서만, 가려서). 같은 Idempotency-Key 는 한 번만 처리한다.
-- review = «확인 필요»(연결 못 한 결제 · 금액이 다른 결제 · 읽지 못한 꼴 · 회차 환불 · 겹친 정기결제) — 운영자가 [이 계정에 연결] · [무시]로 닫는다.
CREATE TABLE billing_events (
  id               bigserial PRIMARY KEY,
  provider         text NOT NULL DEFAULT 'groble',
  idem_key         text,
  event_id         text NOT NULL DEFAULT '',
  type             text NOT NULL DEFAULT '',
  occurred_at      timestamptz,
  received_at      timestamptz NOT NULL DEFAULT now(),
  ref              text NOT NULL DEFAULT '',
  merchant_uid     text NOT NULL DEFAULT '',
  amount           integer,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  subscription_id  uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  result           text NOT NULL DEFAULT 'pending',
  note             text NOT NULL DEFAULT '',
  review           boolean NOT NULL DEFAULT false,
  resolved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, idem_key)
);
CREATE INDEX billing_events_time ON billing_events (received_at DESC);
CREATE INDEX billing_events_review ON billing_events (received_at DESC) WHERE review;
CREATE INDEX billing_events_user ON billing_events (user_id, received_at DESC);
CREATE INDEX billing_events_merchant ON billing_events (merchant_uid) WHERE merchant_uid <> '';

-- 고객 한 사람 — 무료 이용(운영자가 주는 계정 — 결제 없이) · 운영 메모
CREATE TABLE billing_customers (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  free        boolean NOT NULL DEFAULT false,
  memo        text NOT NULL DEFAULT '',
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 운영 설정 — 지금은 이용 규칙(가입 체험 일수 · 결제 실패 · 해지 뒤 여유 일수) 하나. 키 하나에 값 하나.
CREATE TABLE app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
