-- DB 2차 격리(RLS) — 화면이 작품 내용을 읽는 길(GET /api/state · 내려받기)은 «se_reader» 역할로 바꿔 읽는다.
-- 그 역할에는 행 정책이 걸려 있어, 서버의 판정(online/tenancy.mjs)에 실수가 있어도 DB 가 «남의 작품»의 행을 내주지 않는다.
-- 규칙은 tenancy.access 의 «읽기»와 같다: 주인 · 그 수업을 맡은 강사 · 열람이 켜진 기관의 기관 관리자. 운영자도 남의 작품은 못 읽는다.
--
-- 앱의 쓰기 길 · worker 는 지금처럼 앱 사용자(표의 주인)로 돈다 — 표의 주인은 RLS 를 지나간다(FORCE 를 걸지 않는다).
-- 역할을 만들 권한이 없는 DB 면 이 마이그레이션은 아무것도 하지 않고 지나간다(앱은 1차 판정만으로 그대로 돈다 — store.getAs 가 알아서 접는다).
DO $mig$
BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'se_reader') THEN
      CREATE ROLE se_reader NOLOGIN;
    END IF;
    EXECUTE format('GRANT se_reader TO %I', current_user);
  EXCEPTION WHEN insufficient_privilege OR invalid_grant_operation THEN
    RAISE NOTICE 'se_reader: cannot create or grant the role here - DB second layer skipped';
    RETURN;
  END;

  GRANT USAGE ON SCHEMA public TO se_reader;
  GRANT SELECT ON projects, documents, document_versions, document_links, document_agents, categories, agents,
                  threads, thread_messages, thread_links, thread_agents, project_prompt_layers, project_slot_models, trash_entries TO se_reader;

  -- 읽어도 되는가 — 표의 주인 권한으로 돈다(SECURITY DEFINER · 주인은 RLS 를 지나므로 정책이 정책을 부르는 맴돌이가 없다)
  CREATE OR REPLACE FUNCTION se_can_read(pid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
    SELECT EXISTS (
      SELECT 1 FROM projects p LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE p.id = pid AND p.deleted_at IS NULL AND (
         p.owner_user_id = nullif(current_setting('app.user_id', true), '')::uuid
         OR (p.organization_id IS NOT NULL AND p.class_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM class_members m WHERE m.class_id = p.class_id AND m.role = 'instructor'
                  AND m.user_id = nullif(current_setting('app.user_id', true), '')::uuid))
         OR (p.organization_id IS NOT NULL AND coalesce((o.settings->>'admin_can_read_projects')::boolean, false) AND EXISTS (
               SELECT 1 FROM organization_members om WHERE om.organization_id = p.organization_id AND om.status = 'active'
                  AND om.role = 'organization_admin' AND om.user_id = nullif(current_setting('app.user_id', true), '')::uuid))))
  $f$;
  REVOKE ALL ON FUNCTION se_can_read(uuid) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION se_can_read(uuid) TO se_reader;

  ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS se_read ON projects;
  CREATE POLICY se_read ON projects FOR SELECT TO se_reader USING (se_can_read(id));
  -- project_id 가 있는 표
  PERFORM 1;
  EXECUTE (SELECT string_agg(format('ALTER TABLE %1$I ENABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS se_read ON %1$I; '
                                    'CREATE POLICY se_read ON %1$I FOR SELECT TO se_reader USING (se_can_read(project_id));', t), ' ')
             FROM unnest(ARRAY['documents', 'document_versions', 'document_links', 'categories', 'agents', 'threads', 'thread_messages',
                               'project_prompt_layers', 'project_slot_models', 'trash_entries']) AS t);
  -- 부모를 거쳐 가는 표
  ALTER TABLE thread_links ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS se_read ON thread_links;
  CREATE POLICY se_read ON thread_links FOR SELECT TO se_reader USING (EXISTS (SELECT 1 FROM threads t WHERE t.id = thread_id AND se_can_read(t.project_id)));
  ALTER TABLE thread_agents ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS se_read ON thread_agents;
  CREATE POLICY se_read ON thread_agents FOR SELECT TO se_reader USING (EXISTS (SELECT 1 FROM threads t WHERE t.id = thread_id AND se_can_read(t.project_id)));
  ALTER TABLE document_agents ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS se_read ON document_agents;
  CREATE POLICY se_read ON document_agents FOR SELECT TO se_reader USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND se_can_read(d.project_id)));
END
$mig$;
