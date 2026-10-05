-- AI 회사 고르기(2026-10-05 사용자 지시 — «차례로 쓰지 말고 회사를 고르게»)
-- · 사람마다 기본 회사: users.settings.ai_provider
-- · 기관 기본 회사: organizations.settings.ai_provider(이미 있는 settings jsonb)
-- · 작품마다: projects.model_policy.provider(이미 있는 칸)
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
