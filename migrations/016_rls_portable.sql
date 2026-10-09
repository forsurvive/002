-- DB 2차 격리(014)를 «복사해도 서는» 꼴로 — 행 정책 · 권한이 역할 이름(se_reader)을 품지 않게 한다.
-- 2026-10-09 Replit 게시에서 겪음: 개발 DB 를 운영 DB 로 복사(pg_dump → pg_restore)하면 «role "se_reader" does not exist» 로 멈췄다.
-- 역할은 DB 밖(클러스터)의 것이라 복사본에 실리지 않는데, 014 의 행 정책 14 · SELECT 권한 14 · 함수 · 스키마 권한이 그 이름을 품고 있었다.
--
-- 그래서 복사본에 실리는 것은 PUBLIC 에 건다. 누가 무엇을 읽나는 014 와 같다(주인 · 맡은 강사 · 열람이 켜진 기관 관리자):
--   · 행 정책은 PUBLIC 에 — 표의 주인(앱)은 RLS 를 지나가고(FORCE 없음), 주인이 아닌 역할은 모두 이 정책을 받는다.
--   · 읽기(SELECT)도 PUBLIC 에 — 행은 정책이 거른다(app.user_id 가 읽을 수 있는 작품의 행만, 없으면 0행). 쓰기 권한은 주지 않는다.
--   · se_reader 는 «주인이 아닌 역할로 바꿔 읽는» 이름일 뿐 — 복사본에 없으면 online/migrate.mjs 가 켤 때마다 다시 세운다.
-- 역할을 만들 수 없어 014 가 건너뛴 DB 에도 정책은 선다(그때 앱은 1차 판정만으로 돈다 — store.getAs 가 접는다).
DO $mig$
DECLARE
  tab text;
  tabs text[] := ARRAY['projects', 'documents', 'document_versions', 'document_links', 'document_agents', 'categories', 'agents',
                       'threads', 'thread_messages', 'thread_links', 'thread_agents', 'project_prompt_layers', 'project_slot_models', 'trash_entries'];
  -- project_id 가 있는 표
  kids text[] := ARRAY['documents', 'document_versions', 'document_links', 'categories', 'agents', 'threads', 'thread_messages',
                       'project_prompt_layers', 'project_slot_models', 'trash_entries'];
BEGIN
  -- 읽어도 되는가 — 014 와 같은 규칙. 표의 주인 권한으로 돈다(SECURITY DEFINER · 주인은 RLS 를 지나므로 정책이 정책을 부르는 맴돌이가 없다)
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
  GRANT EXECUTE ON FUNCTION se_can_read(uuid) TO PUBLIC;

  -- 014 가 se_reader 에 준 권한을 거둔다 — 그 역할은 PUBLIC 을 거쳐 같은 것을 받는다
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'se_reader') THEN
    REVOKE ALL ON FUNCTION se_can_read(uuid) FROM se_reader;
    REVOKE ALL ON SCHEMA public FROM se_reader;
    FOREACH tab IN ARRAY tabs LOOP
      EXECUTE format('REVOKE ALL ON %I FROM se_reader', tab);
    END LOOP;
  END IF;
  -- 스키마를 쓸 권리 — 보통은 이미 PUBLIC 에 있다(없는 DB 에서 주지 못해도 멈추지 않는다)
  BEGIN
    GRANT USAGE ON SCHEMA public TO PUBLIC;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'se_read: schema usage left as it is';
  END;

  FOREACH tab IN ARRAY tabs LOOP
    EXECUTE format('GRANT SELECT ON %I TO PUBLIC', tab);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('DROP POLICY IF EXISTS se_read ON %I', tab);
  END LOOP;
  CREATE POLICY se_read ON projects FOR SELECT USING (se_can_read(id));
  FOREACH tab IN ARRAY kids LOOP
    EXECUTE format('CREATE POLICY se_read ON %I FOR SELECT USING (se_can_read(project_id))', tab);
  END LOOP;
  -- 부모를 거쳐 가는 표
  CREATE POLICY se_read ON thread_links FOR SELECT USING (EXISTS (SELECT 1 FROM threads t WHERE t.id = thread_id AND se_can_read(t.project_id)));
  CREATE POLICY se_read ON thread_agents FOR SELECT USING (EXISTS (SELECT 1 FROM threads t WHERE t.id = thread_id AND se_can_read(t.project_id)));
  CREATE POLICY se_read ON document_agents FOR SELECT USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = document_id AND se_can_read(d.project_id)));
END
$mig$;
