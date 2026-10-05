-- 운영자가 직접 만든 계정의 비밀번호 — 기술 지원용으로 최상위 관리자가 다시 볼 수 있게(2026-10-05 사용자 결정)
-- 원문은 DB 에 없다: 마스터 키로 봉한 사본만. 본인이 바꾸면(내 계정 · 재설정 코드) 지운다 — 그때부터는 운영자도 모른다.
ALTER TABLE users ADD COLUMN IF NOT EXISTS known_password_sealed jsonb;
