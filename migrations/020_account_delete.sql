-- 계정 지우기(자유 가입판 — 본인이 «내 계정»에서, 2026-10-11 사용자 지시 · docs/OPEN_EDITION.md §4-11).
-- 지운 계정의 줄은 «빈 껍데기»로 남는다 — 아이디는 '_deleted-…'(가입 규칙으로는 만들 수 없는 꼴), 이메일 · 이름 · 비밀번호 · 설정은 비운다.
-- 껍데기를 남기는 까닭: 결제 기록(정기결제 · 받은 웹훅 · 환불 · 구독 취소)이 법정 보존 기간 동안 이 줄을 가리키고,
-- 계정을 지울 때 자동으로 접수한 구독 취소에 그로블 해지 웹훅이 이어 붙어야 한다(줄을 지우면 함께 사라진다 — ON DELETE CASCADE).
-- Replit 게시가 이 꼴을 운영 DB 에 먼저 지어 둘 수 있다 — 이미 있어도 넘어가게 쓴다(docs/REPLIT_DEPLOYMENT.md §5).
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 구글로 만든 계정(비밀번호 없음)은 구글로 한 번 더 확인하고 지운다 — 로그인 시작의 갈래에 'delete'
ALTER TABLE oauth_states DROP CONSTRAINT IF EXISTS oauth_states_mode_check;
ALTER TABLE oauth_states ADD CONSTRAINT oauth_states_mode_check CHECK (mode IN ('login', 'link', 'delete'));
