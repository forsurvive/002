-- 바뀌었다는 알림(LISTEN/NOTIFY) — 화면이 1.5초마다 묻는 대신, 바뀐 때만 다시 받게(명세 부록: 폴링 줄이기 · SSE).
-- 실을 것은 «무엇이 바뀌었나»의 id 뿐이다(p:<작품> · u:<주인>) — 본문 · 제목은 싣지 않는다.
CREATE OR REPLACE FUNCTION se_notify_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM pg_notify('se_change', 'p:' || OLD.id::text || '|u:' || OLD.owner_user_id::text);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at AND NEW.name IS NOT DISTINCT FROM OLD.name THEN
    RETURN NEW;
  END IF;
  PERFORM pg_notify('se_change', 'p:' || NEW.id::text || '|u:' || NEW.owner_user_id::text);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION se_notify_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('se_change', 'p:' || (CASE WHEN TG_OP = 'DELETE' THEN OLD.project_id ELSE NEW.project_id END)::text);
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS projects_notify ON projects;
CREATE TRIGGER projects_notify AFTER INSERT OR UPDATE OR DELETE ON projects FOR EACH ROW EXECUTE FUNCTION se_notify_project();
DROP TRIGGER IF EXISTS jobs_notify ON jobs;
-- 숨 쉬기(heartbeat · lease)만 바뀐 때는 알리지 않는다 — 화면에 보이는 것이 바뀐 때만
CREATE TRIGGER jobs_notify AFTER INSERT OR DELETE ON jobs FOR EACH ROW EXECUTE FUNCTION se_notify_job();
CREATE TRIGGER jobs_notify_upd AFTER UPDATE ON jobs FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.step IS DISTINCT FROM NEW.step OR OLD.step_at IS DISTINCT FROM NEW.step_at
        OR OLD.ask IS DISTINCT FROM NEW.ask OR OLD.result IS DISTINCT FROM NEW.result OR OLD.dismissed_at IS DISTINCT FROM NEW.dismissed_at
        OR OLD.error_message_safe IS DISTINCT FROM NEW.error_message_safe OR OLD.ended_at IS DISTINCT FROM NEW.ended_at)
  EXECUTE FUNCTION se_notify_job();
