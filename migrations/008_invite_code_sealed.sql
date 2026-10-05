-- 초대 코드를 목록에서 다시 보이게(2026-10-05 사용자 지시 «초대 코드 목록에 코드 자체를 표시해야지»)
-- 원문은 여전히 DB 에 두지 않는다 — AI 키와 같은 마스터 키(CREDENTIALS_KEY_V*)로 봉해 둔다. 맞춰 보기는 지금처럼 code_hash 로.
-- 이 칸이 비어 있는 옛 코드는 다시 보일 수 없다(만들 때 한 번만 보였다).
ALTER TABLE invites ADD COLUMN IF NOT EXISTS code_sealed jsonb;
