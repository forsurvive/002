-- 사용량 장부 — 끝난 AI 부르기를 날마다 · 비용 주체마다 · 회사 · 모델마다 한 줄로 모은다(명세: 사용량 장부).
-- 자세한 한 건 한 건은 generation_runs 에 그대로 있고, 이 표는 «얼마나 썼나»를 빨리 답하기 위한 합계다.
-- 채우는 것은 방아쇠 하나 — 부르기가 끝나는(running → 끝) 순간 한 번만 더한다. 어느 길로 기록되든 장부가 어긋나지 않게.
CREATE TABLE IF NOT EXISTS usage_ledger (
  day                   date NOT NULL,
  organization_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,
  owner_user_id         uuid REFERENCES users(id) ON DELETE CASCADE,   -- 작품 주인(개인 작품의 비용 주체를 가리는 데)
  credential_owner_type text NOT NULL DEFAULT '',                       -- organization | user | platform | ''(키를 못 연 부르기)
  provider              text NOT NULL DEFAULT '',
  model_id              text NOT NULL DEFAULT '',
  cost_source           text NOT NULL DEFAULT 'none',                   -- estimated | provider | subscription | none
  calls                 integer NOT NULL DEFAULT 0,
  failed                integer NOT NULL DEFAULT 0,
  input_tokens          bigint NOT NULL DEFAULT 0,
  output_tokens         bigint NOT NULL DEFAULT 0,
  cache_read_tokens     bigint NOT NULL DEFAULT 0,
  cache_write_tokens    bigint NOT NULL DEFAULT 0,
  cost_usd              numeric(14, 6) NOT NULL DEFAULT 0
);
-- 한 줄의 열쇠(NULL 도 같은 값으로 보게 coalesce)
CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_key ON usage_ledger (day, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), credential_owner_type, provider, model_id, cost_source);
CREATE INDEX IF NOT EXISTS usage_ledger_org ON usage_ledger (organization_id, day);
CREATE INDEX IF NOT EXISTS usage_ledger_owner ON usage_ledger (owner_user_id, day);

CREATE OR REPLACE FUNCTION se_usage_add() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;
BEGIN
  IF NEW.status = 'running' OR (TG_OP = 'UPDATE' AND OLD.status <> 'running') THEN RETURN NULL; END IF;
  SELECT owner_user_id INTO owner FROM projects WHERE id = NEW.project_id;
  INSERT INTO usage_ledger AS l (day, organization_id, owner_user_id, credential_owner_type, provider, model_id, cost_source,
                                 calls, failed, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
  VALUES ((NEW.started_at AT TIME ZONE 'UTC')::date, NEW.organization_id, owner, NEW.credential_owner_type, NEW.provider, NEW.model_id, NEW.cost_source,
          1, CASE WHEN NEW.status = 'succeeded' THEN 0 ELSE 1 END, NEW.input_tokens, NEW.output_tokens, NEW.cache_read_tokens, NEW.cache_write_tokens, coalesce(NEW.cost_usd, 0))
  ON CONFLICT (day, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid),
               credential_owner_type, provider, model_id, cost_source)
  DO UPDATE SET calls = l.calls + 1, failed = l.failed + EXCLUDED.failed, input_tokens = l.input_tokens + EXCLUDED.input_tokens,
                output_tokens = l.output_tokens + EXCLUDED.output_tokens, cache_read_tokens = l.cache_read_tokens + EXCLUDED.cache_read_tokens,
                cache_write_tokens = l.cache_write_tokens + EXCLUDED.cache_write_tokens, cost_usd = l.cost_usd + EXCLUDED.cost_usd;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS generation_runs_usage ON generation_runs;
CREATE TRIGGER generation_runs_usage AFTER INSERT OR UPDATE OF status ON generation_runs FOR EACH ROW EXECUTE FUNCTION se_usage_add();

-- 이미 있는 기록을 한 번 옮겨 담는다(장부가 비어 있을 때만)
INSERT INTO usage_ledger (day, organization_id, owner_user_id, credential_owner_type, provider, model_id, cost_source,
                          calls, failed, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
SELECT (r.started_at AT TIME ZONE 'UTC')::date, r.organization_id, p.owner_user_id, r.credential_owner_type, r.provider, r.model_id, r.cost_source,
       count(*), sum(CASE WHEN r.status = 'succeeded' THEN 0 ELSE 1 END), sum(r.input_tokens), sum(r.output_tokens), sum(r.cache_read_tokens), sum(r.cache_write_tokens), coalesce(sum(r.cost_usd), 0)
  FROM generation_runs r JOIN projects p ON p.id = r.project_id
 WHERE r.status <> 'running' AND NOT EXISTS (SELECT 1 FROM usage_ledger)
 GROUP BY 1, 2, 3, 4, 5, 6, 7;
