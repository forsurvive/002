-- 003 — 작업이 가리키는 대상의 Core id(d_… · h_…)를 함께 둔다.
-- 화면은 작업 줄과 문서/스레드를 Core id 로 잇는다(개인판 job.targetId 와 같은 값). target_id(uuid)는 «대상 하나에 활성 작업 하나»를 DB 가 지키는 데 쓴다.
ALTER TABLE jobs ADD COLUMN target_legacy_id text NOT NULL DEFAULT '';
-- 회수(reaper)가 lease 가 지난 작업을 찾는 길
CREATE INDEX jobs_running_lease ON jobs (lease_expires_at) WHERE status = 'running';
