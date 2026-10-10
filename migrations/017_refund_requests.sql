-- 7일 환불(docs/OPEN_EDITION.md §4-8) — 환불 건과 그때의 판정. 사용자가 [환불 요청]을 누른 것(source user)과
-- 그로블에서 먼저 환불된 이번 회차(source groble — 환불 웹훅이 만든다)가 같은 줄로 «환불 · 해지 둘 다 됐나»를 추적한다.
-- 돈을 돌려주는 것 · 정기결제를 끊는 것은 그로블 판매 관리에서 한다(판매자 API 가 없다). 여기는 판정 근거와 확인 표시만 남긴다.
-- 판정 근거(결제 때 · 기한 · 결제 뒤 AI 작업 수)는 그때 그대로 남긴다 — 나중에 «7일 안이었나»를 다시 셀 필요가 없다.
-- Replit 게시가 이 표를 운영 DB 에 먼저 지어 둘 수 있다 — 이미 있어도 넘어가게 쓴다(docs/REPLIT_DEPLOYMENT.md §5).
CREATE TABLE IF NOT EXISTS refund_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  merchant_uid    text NOT NULL DEFAULT '',              -- 환불할 결제 건(이번 회차)
  amount          integer,
  paid_at         timestamptz NOT NULL,                  -- 그 결제의 때
  deadline        timestamptz NOT NULL,                  -- 환불 기한(결제한 날 + 환불 기간의 그날 끝)
  ai_runs         integer NOT NULL DEFAULT 0,            -- 요청 때 센 «결제 뒤 AI 작업» 수
  in_policy       boolean NOT NULL DEFAULT true,         -- 그때의 판정 — 규정(기간 안 · AI 작업 없음) 안이었나
  prev_paid_until timestamptz,                           -- 멈추기 전 기한 — [요청 되돌리기]가 되살린다
  source          text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'groble')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'withdrawn')),
  refunded_at     timestamptz,                           -- 그로블 환불 웹훅이 온 때
  cancelled_at    timestamptz,                           -- 그로블 해지(예고 · 완료) 웹훅이 온 때
  resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_requests_user ON refund_requests (user_id, created_at);
CREATE INDEX IF NOT EXISTS refund_requests_sub ON refund_requests (subscription_id);
CREATE INDEX IF NOT EXISTS refund_requests_status ON refund_requests (status, created_at);
