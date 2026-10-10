-- 환불 요청 · 구독 취소의 «이유»와 운영자 알림 메일(2026-10-10 사용자 지시 — docs/OPEN_EDITION.md §4-8).
-- 구독 시작(첫 결제) 뒤 7일 안에는 [환불 요청] — 누르면 운영자에게 메일이 가고 운영자가 그로블에서 처리한다.
-- 그 뒤에는 [구독 취소] — 이유를 묻고 받는다. 그로블에 판매자 해지 API 가 없어 해지는 그로블 판매 관리에서 한다 —
-- 여기는 요청 · 이유 · 알림 메일 · «그로블에서 해지가 확인됐나» · «해지 전에 다시 결제됐나»를 남긴다.
-- Replit 게시가 이 표를 운영 DB 에 먼저 지어 둘 수 있다 — 이미 있어도 넘어가게 쓴다(docs/REPLIT_DEPLOYMENT.md §5).
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '';       -- 고른 이유(코드)
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS detail text NOT NULL DEFAULT '';       -- 적은 말(500자까지)
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS mailed_at timestamptz;                 -- 운영자에게 알림 메일을 보낸 때
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS mail_error text NOT NULL DEFAULT '';   -- 보내지 못한 까닭의 이름(키 · 주소는 싣지 않는다)

CREATE TABLE IF NOT EXISTS cancel_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  reason          text NOT NULL DEFAULT '',
  detail          text NOT NULL DEFAULT '',
  next_billing    date,                                  -- 그때의 다음 결제일 — 이 날 전에 그로블에서 해지해야 다시 청구되지 않는다
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'withdrawn')),
  confirmed_at    timestamptz,                           -- 그로블 해지(예고 · 완료) 웹훅이 온 때 — 오면 done
  charged_at      timestamptz,                           -- 요청 뒤 갱신 결제가 온 때(그로블 해지가 늦었다 — 환불할 것)
  mailed_at       timestamptz,
  mail_error      text NOT NULL DEFAULT '',
  resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cancel_requests_user ON cancel_requests (user_id, created_at);
CREATE INDEX IF NOT EXISTS cancel_requests_sub ON cancel_requests (subscription_id);
CREATE INDEX IF NOT EXISTS cancel_requests_status ON cancel_requests (status, created_at);
