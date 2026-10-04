-- 004 — 교육기관판: 라이선스 · 수업 · 수업 멤버 · 초대 코드. 설계: docs/ERD.md §3-1 · docs/SECURITY.md §4.
-- 라이선스는 AI 사용량이 아니라 «소프트웨어 사용권»이다(비용 주체와 섞지 않는다). AI 작업을 등록할 때마다 다시 본다.

CREATE TABLE licenses (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan                text NOT NULL DEFAULT 'trial',
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'expired', 'revoked')),
  starts_at           timestamptz NOT NULL DEFAULT now(),
  ends_at             timestamptz,
  seat_limit          integer CHECK (seat_limit IS NULL OR seat_limit > 0),
  allowed_providers   text[],
  allowed_model_tiers text[],
  features            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX licenses_org ON licenses (organization_id, status);

CREATE TABLE classes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             text NOT NULL,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  starts_at        timestamptz,
  ends_at          timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX classes_org ON classes (organization_id);

CREATE TABLE class_members (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id         uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('instructor', 'student')),
  joined_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (class_id, user_id)
);
CREATE INDEX class_members_user ON class_members (user_id);

-- 초대 코드 — 원문은 만들 때 한 번만 보여 주고 해시만 둔다
CREATE TABLE invites (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  class_id         uuid REFERENCES classes(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('organization_admin', 'instructor', 'student')),
  code_hash        bytea NOT NULL UNIQUE,
  expires_at       timestamptz NOT NULL,
  max_uses         integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  used_count       integer NOT NULL DEFAULT 0,
  revoked_at       timestamptz,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD COLUMN class_id uuid REFERENCES classes(id);
CREATE INDEX projects_class ON projects (class_id) WHERE deleted_at IS NULL;
