-- Anthropic 키가 워크스페이스에 묶이지 않은 경우, 부를 때 anthropic-workspace-id 헤더가 있어야 한다(2026-10-06 실제 오류).
-- 워크스페이스 ID 는 비밀이 아니다(키 없이는 아무것도 못 한다) — 봉인하지 않고 그대로 둔다. 빈 값 = 보내지 않음.
ALTER TABLE provider_credentials ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT '';
