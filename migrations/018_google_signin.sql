-- 구글 로그인(docs/OPEN_EDITION.md §4-9) — 바깥 계정(구글)과 우리 계정의 연결, 로그인 시작 때의 한 번용 값(state · nonce · PKCE).
-- 이메일이 같다고 저절로 잇지 않는다 — 연결은 «구글로 처음 가입» 또는 «로그인한 뒤 내 계정에서 연결» 두 길뿐.
-- Replit 게시가 이 표를 운영 DB 에 먼저 지어 둘 수 있다 — 이미 있어도 넘어가게 쓴다(docs/REPLIT_DEPLOYMENT.md §5).
CREATE TABLE IF NOT EXISTS user_identities (
  provider      text NOT NULL CHECK (provider IN ('google')),
  subject       text NOT NULL,                           -- 구글의 sub(바뀌지 않는 사용자 번호)
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email         text NOT NULL DEFAULT '',                -- 연결할 때 구글이 확인한 이메일(보여 주기용)
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities (user_id);

-- 로그인 시작 한 번에 한 줄 — 10분 안에, 한 번만 쓴다(돌아올 때 지운다). 쿠키에도 같은 state 가 있어야 받는다.
CREATE TABLE IF NOT EXISTS oauth_states (
  state      text PRIMARY KEY,
  nonce      text NOT NULL,
  verifier   text NOT NULL,                              -- PKCE code_verifier(S256 의 원문)
  mode       text NOT NULL CHECK (mode IN ('login', 'link')),
  user_id    uuid REFERENCES users(id) ON DELETE CASCADE, -- link 일 때 그 사람
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_created ON oauth_states (created_at);
