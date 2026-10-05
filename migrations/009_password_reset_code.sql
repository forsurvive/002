-- 비밀번호를 잊었을 때 — 관리자가 임시 비밀번호 대신 «재설정 코드»를 준다(2026-10-05 사용자 결정).
-- 본인이 로그인 화면 «비밀번호를 잊었어요»에서 아이디 + 코드 + 새 비밀번호를 넣는다 — 관리자는 남의 비밀번호를 끝내 모른다.
-- 맞춰 보기는 해시(reset_code_hash), 관리자가 다시 보는 사본은 마스터 키로 봉한 것(reset_code_sealed). 한 번 쓰면 · 기한이 지나면 지운다.
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_hash bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_code_sealed jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_expires_at timestamptz;
