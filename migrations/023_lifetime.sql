-- 023 — 평생 이용권(SE_BILLING=lifetime, docs/OPEN_EDITION.md §4-14). 결제 옵션 · 이용권 줄에 «무엇을 파는가»를 단다.
--   subscription — 월 정기결제(지금 것 · 기본) · lifetime — 그로블 단건 결제 한 번으로 기한 없이(갱신 · 해지 · 구독 취소가 없다).
-- 지금 줄은 모두 subscription — 지금 앱들은 바뀌지 않는다. 판 · 용도처럼 한 앱은 한 축만 쓰지만, 줄마다 적어 두어 섞여도 가린다.
-- Replit 게시가 이 칸을 운영 DB 에 먼저 지어 둘 수 있다 — 이미 있어도 넘어가게 쓴다(docs/REPLIT_DEPLOYMENT.md §5).
ALTER TABLE billing_plans ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription', 'lifetime'));
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'subscription' CHECK (kind IN ('subscription', 'lifetime'));
