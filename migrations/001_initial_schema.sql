-- 001 — 온라인판 첫 스키마: 계정 · 기관 · 프로젝트 · 문서/판/참조 · 스레드 · 에이전트 · 작업 · 생성 기록 · 자격증명 · 감사 로그.
-- 설계: docs/ERD.md. 수업 · 라이선스 · 워크플로우는 다음 마이그레이션에서.
-- 원칙: 지금 JSON 의 개념을 바꾸지 않고 저장 자리만 나눈다. 지우기는 논리 삭제(deleted_at)가 먼저다.
-- 이 파일은 한 트랜잭션 안에서 돈다(online/migrate.mjs).

-- ---------------------------------------------------------------- 계정 · 기관

CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id         text NOT NULL UNIQUE CHECK (login_id = lower(login_id) AND length(login_id) BETWEEN 3 AND 64),
  email            text,
  display_name     text NOT NULL DEFAULT '',
  password_hash    text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_login_at    timestamptz
);

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,              -- 쿠키의 원문 토큰은 저장하지 않는다(SHA-256)
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip            text NOT NULL DEFAULT '',
  user_agent    text NOT NULL DEFAULT '',
  revoked_at    timestamptz
);
CREATE INDEX sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE organizations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  slug                 text NOT NULL UNIQUE,
  status               text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 허용 provider · 기본 tier · 학생 모델 선택 · 열람 정책 …
  max_concurrent_jobs  integer NOT NULL DEFAULT 5 CHECK (max_concurrent_jobs > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('organization_admin', 'instructor', 'student')),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, role)
);
CREATE INDEX organization_members_user ON organization_members (user_id);

-- ---------------------------------------------------------------- 프로젝트 · 문서 · 판 · 참조

CREATE TABLE projects (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid NOT NULL REFERENCES users(id),
  organization_id   uuid REFERENCES organizations(id),   -- NULL = 개인 프로젝트
  name              text NOT NULL,
  spec              jsonb NOT NULL DEFAULT '{"outline":"","form":"","length":""}'::jsonb,
  standard          text NOT NULL DEFAULT '',
  request           text NOT NULL DEFAULT '',            -- 작품 요청사항(지속 조건)
  model_policy      jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { provider?, tier?, alias? } — 개인판 별칭(opus …)은 alias 로 보존
  no_count          boolean NOT NULL DEFAULT true,
  agent_kind        text NOT NULL DEFAULT '',            -- project.agents.__kind
  materials_legacy  jsonb NOT NULL DEFAULT '[]'::jsonb,  -- 옛 판 p.materials(읽을 때 문서로 옮긴다 — 보통은 비어 있다)
  row_version       integer NOT NULL DEFAULT 1,
  legacy_id         text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE INDEX projects_owner ON projects (owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX projects_org ON projects (organization_id, owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  legacy_id   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX categories_project ON categories (project_id);

CREATE TABLE agents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            text NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'organization', 'platform')),
  project_id       uuid REFERENCES projects(id) ON DELETE CASCADE,
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  role             text NOT NULL DEFAULT '',
  craft            text NOT NULL DEFAULT '',
  model_policy     jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order       integer NOT NULL DEFAULT 0,
  legacy_id        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
);
CREATE INDEX agents_project ON agents (project_id) WHERE deleted_at IS NULL;

CREATE TABLE documents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id               uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  organization_id          uuid REFERENCES organizations(id),
  kind                     text NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc', 'check', 'review')),
  category_id              uuid REFERENCES categories(id),
  orphan_from_category_id  uuid REFERENCES categories(id),
  title                    text NOT NULL,          -- 현재 판의 제목(목록용 사본)
  current_version_id       uuid,                   -- 아래에서 FK
  is_final                 boolean NOT NULL DEFAULT false,
  finalized_at             timestamptz,
  finalized_by             uuid REFERENCES users(id),
  request                  text NOT NULL DEFAULT '',   -- 이 문서의 요청사항(지속)
  is_material              boolean NOT NULL DEFAULT false,
  src                      text NOT NULL DEFAULT '',   -- 작법서(가리키는 문서)
  sort_order               integer NOT NULL DEFAULT 0,
  row_version              integer NOT NULL DEFAULT 1,
  legacy_id                text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  deleted_at               timestamptz,              -- 휴지통
  deleted_by               uuid REFERENCES users(id),
  purged_at                timestamptz               -- 영구 삭제(생성 기록이 가리키는 판은 남는다)
);
CREATE INDEX documents_project ON documents (project_id) WHERE purged_at IS NULL;

-- 판: 저장할 때마다 한 행. 현재 판도 한 행이다(documents.current_version_id). 화면의 «이력»은 현재 판을 뺀 나머지.
CREATE TABLE document_versions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id        uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq                integer NOT NULL CHECK (seq > 0),
  title              text NOT NULL,
  body               text NOT NULL DEFAULT '',
  body_sha256        text NOT NULL,
  char_count         integer NOT NULL DEFAULT 0,
  source             text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'ai', 'restore', 'import', 'system')),
  created_by         uuid REFERENCES users(id),
  generation_run_id  uuid,                     -- 아래에서 FK
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, seq)
);
ALTER TABLE documents ADD CONSTRAINT documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES document_versions(id) DEFERRABLE INITIALLY DEFERRED;

-- 참조/대상(refIds · targetIds) — 순서가 프롬프트 차례이므로 sort_order 를 지킨다. pinned_version_id 가 NULL 이면 늘 현재 판.
CREATE TABLE document_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('reference', 'target')),
  pinned_version_id   uuid REFERENCES document_versions(id),
  sort_order          integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_document_id, target_document_id, role)
);

CREATE TABLE document_agents (
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sort_order   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (document_id, agent_id)
);

CREATE TABLE project_prompt_layers (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code        text NOT NULL,
  layer       text NOT NULL CHECK (layer IN ('override', 'generated')),   -- 작가가 고친 것 / 지어진 것
  name        text NOT NULL DEFAULT '',
  role        text NOT NULL DEFAULT '',
  task        text NOT NULL DEFAULT '',
  craft       text NOT NULL DEFAULT '',
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, code, layer)
);

CREATE TABLE project_slot_models (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code          text NOT NULL,
  model_policy  jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (project_id, code)
);

-- ---------------------------------------------------------------- 논의 스레드

CREATE TABLE threads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title            text NOT NULL,
  head_message_id  uuid,
  legacy_id        text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX threads_project ON threads (project_id);

CREATE TABLE thread_messages (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id          uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id          uuid REFERENCES thread_messages(id),   -- 가지 구조 그대로
  role               text NOT NULL CHECK (role IN ('user', 'assistant')),
  text               text NOT NULL DEFAULT '',
  created_by         uuid REFERENCES users(id),
  generation_run_id  uuid,
  legacy_id          text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX thread_messages_thread ON thread_messages (thread_id, created_at);
ALTER TABLE threads ADD CONSTRAINT threads_head_fk
  FOREIGN KEY (head_message_id) REFERENCES thread_messages(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE thread_links (
  thread_id           uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  target_document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  pinned_version_id   uuid REFERENCES document_versions(id),
  sort_order          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, target_document_id)
);

CREATE TABLE thread_agents (
  thread_id   uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sort_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, agent_id)
);

-- ---------------------------------------------------------------- 작업 · 생성 기록

CREATE TABLE jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid REFERENCES organizations(id),
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requested_by         uuid REFERENCES users(id),
  kind                 text NOT NULL,
  title                text NOT NULL DEFAULT '',
  target_id            uuid,
  params               jsonb NOT NULL DEFAULT '{}'::jsonb,
  status               text NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued', 'running', 'paused', 'waiting_for_user', 'done', 'failed', 'cancelled')),
  step                 text NOT NULL DEFAULT '',
  step_at              timestamptz,
  ask                  jsonb,
  attempt              integer NOT NULL DEFAULT 0,
  max_attempts         integer NOT NULL DEFAULT 3,
  run_after            timestamptz NOT NULL DEFAULT now(),
  priority             integer NOT NULL DEFAULT 0,
  locked_by            text,
  locked_at            timestamptz,
  lease_expires_at     timestamptz,
  heartbeat_at         timestamptz,
  cancel_requested_at  timestamptz,
  pause_requested_at   timestamptz,
  checkpoint           jsonb,
  result               jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code           text NOT NULL DEFAULT '',
  error_message_safe   text NOT NULL DEFAULT '',
  idempotency_key      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  ended_at             timestamptz,
  dismissed_at         timestamptz
);
-- 활성 작업은 대상 하나에 하나뿐(개인판 isTargetRunning 을 DB 가 지킨다)
CREATE UNIQUE INDEX jobs_one_active_per_target ON jobs (project_id, target_id)
  WHERE status IN ('queued', 'running', 'paused', 'waiting_for_user') AND target_id IS NOT NULL;
CREATE UNIQUE INDEX jobs_idempotency ON jobs (requested_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX jobs_claim ON jobs (run_after, priority DESC, created_at) WHERE status = 'queued';
CREATE INDEX jobs_project ON jobs (project_id, created_at DESC);

CREATE TABLE provider_credentials (
  id               text PRIMARY KEY,                  -- ai/credentials.mjs 가 짓는 id(봉인의 AAD 에 묶인다)
  owner_type       text NOT NULL CHECK (owner_type IN ('user', 'organization', 'platform')),
  owner_id         text NOT NULL DEFAULT '',
  provider         text NOT NULL CHECK (provider IN ('anthropic', 'openai', 'google')),
  label            text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid', 'revoked')),
  key_hint         text NOT NULL DEFAULT '',
  sealed           jsonb NOT NULL,                     -- { keyVersion, nonce, ciphertext, tag } — 원문은 어디에도 없다
  last_verified_at timestamptz,
  last_error_code  text NOT NULL DEFAULT '',
  created_by       text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  revoked_at       timestamptz
);
CREATE UNIQUE INDEX credentials_one_active ON provider_credentials (owner_type, owner_id, provider) WHERE status = 'active';

-- 한 행 = 한 번의 provider 호출
CREATE TABLE generation_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                uuid REFERENCES jobs(id) ON DELETE SET NULL,
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  organization_id       uuid REFERENCES organizations(id),
  requested_by          uuid REFERENCES users(id),
  purpose               text NOT NULL DEFAULT '',
  prompt_key            text NOT NULL DEFAULT '',
  prompt_layer          text NOT NULL DEFAULT '',
  target_document_id    uuid REFERENCES documents(id) ON DELETE SET NULL,
  thread_id             uuid REFERENCES threads(id) ON DELETE SET NULL,
  request_text          text NOT NULL DEFAULT '',
  request_once_text     text NOT NULL DEFAULT '',
  credential_owner_type text NOT NULL DEFAULT '',
  credential_id         text,
  provider              text NOT NULL DEFAULT '',
  model_tier            text NOT NULL DEFAULT '',
  model_id              text NOT NULL DEFAULT '',
  model_source          text NOT NULL DEFAULT '',
  status                text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
  error_code            text NOT NULL DEFAULT '',
  finish_reason         text NOT NULL DEFAULT '',
  started_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  elapsed_ms            integer,
  input_tokens          integer NOT NULL DEFAULT 0,
  output_tokens         integer NOT NULL DEFAULT 0,
  cache_read_tokens     integer NOT NULL DEFAULT 0,
  cache_write_tokens    integer NOT NULL DEFAULT 0,
  reasoning_tokens      integer NOT NULL DEFAULT 0,
  cost_usd              numeric(14, 6),
  cost_source           text NOT NULL DEFAULT 'none',
  provider_request_id   text NOT NULL DEFAULT '',
  result_version_id     uuid REFERENCES document_versions(id),
  result_message_id     uuid REFERENCES thread_messages(id)
);
CREATE INDEX generation_runs_project ON generation_runs (project_id, started_at DESC);
CREATE INDEX generation_runs_org_time ON generation_runs (organization_id, started_at);
ALTER TABLE document_versions ADD CONSTRAINT document_versions_run_fk FOREIGN KEY (generation_run_id) REFERENCES generation_runs(id);
ALTER TABLE thread_messages ADD CONSTRAINT thread_messages_run_fk FOREIGN KEY (generation_run_id) REFERENCES generation_runs(id);

-- 참조 스냅샷 — «세계관 V7 을 보았다». 가리킨 판은 지우지 않는다(RESTRICT).
CREATE TABLE generation_run_inputs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id               uuid NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
  role                 text NOT NULL CHECK (role IN ('material', 'final', 'target', 'reference', 'extra', 'talk', 'agent')),
  document_id          uuid REFERENCES documents(id) ON DELETE SET NULL,
  document_version_id  uuid REFERENCES document_versions(id) ON DELETE RESTRICT,
  title                text NOT NULL DEFAULT '',
  content_sha256       text NOT NULL DEFAULT '',
  char_count           integer NOT NULL DEFAULT 0,
  sort_order           integer NOT NULL DEFAULT 0
);
CREATE INDEX generation_run_inputs_run ON generation_run_inputs (run_id);

-- ---------------------------------------------------------------- 감사 로그

CREATE TABLE audit_logs (
  id               bigserial PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  actor_user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  organization_id  uuid REFERENCES organizations(id) ON DELETE SET NULL,
  action           text NOT NULL,
  target_type      text NOT NULL DEFAULT '',
  target_id        text NOT NULL DEFAULT '',
  ip               text NOT NULL DEFAULT '',
  details          jsonb NOT NULL DEFAULT '{}'::jsonb   -- 가린 값만(키 · 비밀번호 · 원고 금지)
);
CREATE INDEX audit_logs_org_time ON audit_logs (organization_id, at);
