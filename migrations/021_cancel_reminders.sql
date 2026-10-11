-- 구독 취소 알림 — 다시 알림(2026-10-11 사용자 지시: «어떤 경우든 구독 취소가 발생하면 즉시 메일로 알림, 당일 처리가 안 되었다면 그다음 날에 또 알림»).
-- 운영자가 처리해야 하는 것(구독 취소 · 환불 요청 · 구매자가 그로블에서 낸 취소 요청)은 처리될 때까지 다음 날부터 하루 한 번(한국 시각 아침) 다시 알린다.
-- reminded_at = 마지막으로 다시 알린 때 — 같은 날 두 번 보내지 않는다. docs/OPEN_EDITION.md §4-12.
-- Replit 게시가 이 꼴을 운영 DB 에 먼저 지어 둘 수 있다 — 이미 있어도 넘어가게 쓴다(docs/REPLIT_DEPLOYMENT.md §5).
ALTER TABLE cancel_requests ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
ALTER TABLE refund_requests ADD COLUMN IF NOT EXISTS reminded_at timestamptz;
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS reminded_at timestamptz;   -- payment.cancel_requested — 운영자가 [처리함]으로 닫을 때까지
