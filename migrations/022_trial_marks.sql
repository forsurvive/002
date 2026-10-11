-- 무료 체험은 한 사람에게 한 번 — 최소한의 막음(2026-10-11 사용자 지시: «같은 사람이 무료 이용 혜택을 반복 적용 받지 않게 할 수 있는 최소한의 조치»).
-- 체험을 받은 구글 계정의 표시 — HMAC-SHA256(서버 열쇠, 구글 계정 번호): 원래 번호로 되돌릴 수 없다. 계정을 지워도 남는다(같은 구글로 다시 가입해 체험을 또 받지 못하게).
-- 비밀번호 가입은 브라우저의 표시 쿠키(se_trial)로만 막는다(이름 · 연락처를 받지 않으므로 더 가릴 값이 없다). docs/OPEN_EDITION.md §4-13.
-- Replit 게시가 이 표를 운영 DB 에 먼저 지어 둘 수 있다 — 이미 있어도 넘어가게 쓴다(docs/REPLIT_DEPLOYMENT.md §5).
CREATE TABLE IF NOT EXISTS trial_marks (
  kind        text NOT NULL CHECK (kind IN ('google')),
  mark        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, mark)
);
