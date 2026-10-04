-- 002 — Core 의 «프로젝트 덩어리»와 표를 잇는 자리.
-- Core(core/domain/model.mjs)는 d_… · c_… · h_… · g_… 같은 제 id 로 일한다. 표의 기본 키(uuid)와 따로,
-- 그 id 를 legacy_id 에 두고 **프로젝트 안에서 유일**하게 지킨다(가져온 개인판 프로젝트도 같은 길).
-- 휴지통은 개인판처럼 «언제 · 어느 기능에서 · 무엇이» 항목으로 남기고, 지워진 행은 deleted_at 으로 남긴다(생성 기록이 가리킬 수 있으므로).

CREATE UNIQUE INDEX categories_legacy ON categories (project_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX documents_legacy ON documents (project_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX agents_legacy ON agents (project_id, legacy_id) WHERE legacy_id IS NOT NULL;
CREATE UNIQUE INDEX threads_legacy ON threads (project_id, legacy_id) WHERE legacy_id IS NOT NULL;
ALTER TABLE thread_messages ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
CREATE UNIQUE INDEX thread_messages_legacy ON thread_messages (project_id, legacy_id) WHERE legacy_id IS NOT NULL;
-- 스레드와 말의 차례 — 같은 밀리초에 쌓인 말도, 휴지통에서 돌아와 맨 뒤에 선 스레드도 덩어리의 차례 그대로 되짓는다.
ALTER TABLE threads ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE thread_messages ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

-- 문서의 지난 판 하나하나에 «개인판에서 그 판이 쌓인 시각»(versions[].at)을 함께 둔다 — 덩어리를 되지을 때 그대로 돌려준다.
ALTER TABLE document_versions ADD COLUMN at_ms bigint;

CREATE TABLE trash_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  legacy_id    text NOT NULL,                         -- t_…
  kind         text NOT NULL CHECK (kind IN ('doc', 'category', 'thread')),
  from_label   text NOT NULL DEFAULT '',
  title        text NOT NULL DEFAULT '',
  at_ms        bigint NOT NULL,
  target_id    text NOT NULL DEFAULT '',               -- 지운 것의 Core id(d_… · c_… · h_…)
  member_ids   jsonb NOT NULL DEFAULT '[]'::jsonb,     -- 카테고리를 지울 때 «새로 추가된 문서»로 돌아간 문서들
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,     -- 되살릴 때 쓸 꼴(개인판과 같은 가벼운 짐 — 판 본문은 표에 따로 남아 있다)
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, legacy_id)
);
