-- 005 — 단계형 작업 흐름(docs/WORKFLOW.md).
-- 단계 상태 · 흐름 설정은 프로젝트 덩어리의 칸(p.stages · p.workflow)이다 — 개인판 JSON 과 같은 꼴로 jsonb 에 둔다(Core 가 고친다).
ALTER TABLE projects ADD COLUMN stages jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN workflow jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 생성 기록에 «어느 단계의 생성이었나»
ALTER TABLE generation_runs ADD COLUMN workflow_stage text NOT NULL DEFAULT '';

-- 단계 고쳐 쓰기 — 설정 파일(원문) 위에 운영자(전체) · 기관 관리자(그 기관)가 덮어쓴 칸만 둔다.
-- 고칠 수 있는 칸은 core/workflow/stages.mjs 의 EDITABLE(이름 · 할 일 · 추천 참조 · 끌 수 있음 · 강의 카드 · 강사 메모)뿐.
CREATE TABLE workflow_overrides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key     text NOT NULL,
  scope            text NOT NULL CHECK (scope IN ('platform', 'organization')),
  organization_id  uuid REFERENCES organizations(id) ON DELETE CASCADE,
  stage_key        text NOT NULL,
  data             jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by       uuid REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'organization') = (organization_id IS NOT NULL))
);
CREATE UNIQUE INDEX workflow_overrides_one ON workflow_overrides (template_key, scope, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), stage_key);
