// 영속 작업 큐 — 작업은 jobs 표의 한 행(종류 + 매개변수). 설계: docs/JOB_SYSTEM.md.
//
// 웹은 넣기만 하고(enqueue · 손잡이 요청), worker 가 집어(claim) 돌린다. 둘이 다른 프로세스여도, 재시작 뒤에도 같은 행을 본다.
//   · claim 은 FOR UPDATE SKIP LOCKED — 한 행을 두 worker 가 잡지 않는다.
//   · lease + heartbeat — 도는 동안 worker 가 lease 를 민다. 죽으면 lease 가 지나고 회수(reap)가 다시 줄 세운다.
//   · 울타리(fencing) — 끝내기 · 미루기 · 내려놓기는 «지금도 내가 잡고 있는가»(locked_by · status='running')가 맞을 때만 된다.
//     lease 를 잃은 좀비 worker 가 나중에 돌아와도 상태를 덮어쓰지 못한다(작품 저장은 Core 가 store.update 로 하고, 결과는 새 판으로만 쌓인다).
//   · 대상 하나에 활성 작업 하나(jobs_one_active_per_target) · 같은 클릭 두 번(idempotency_key)은 DB 가 막는다.
// 화면은 개인판 작업 줄 꼴을 그대로 받는다(viewOf) — 상태 이름만 개인판 말로 옮긴다.

import { randomUUID } from 'node:crypto';

export const ACTIVE = ['queued', 'running', 'paused', 'waiting_for_user'];
export const LEASE_MS = 90 * 1000;

// 갈래별 자동 재시도 — JOB_SYSTEM §5
const RETRY = {
  rate: { max: 4, delays: [10, 30, 90, 270] },
  overloaded: { max: 4, delays: [10, 30, 90, 270] },
  timeout: { max: 1, delays: [30] },
  other: { max: 1, delays: [30] },
  worker_lost: { max: 1, delays: [30] },
};
export function retryPlan(reason, attempt, retryAfterSec = 0) {
  const r = RETRY[reason];
  if (!r || attempt > r.max) return null;   // attempt = 이번이 몇 번째 시도였나(1부터)
  const base = r.delays[Math.min(attempt - 1, r.delays.length - 1)];
  const jitter = 0.8 + Math.random() * 0.4;
  return { delayMs: Math.round(Math.max(base * jitter, Number(retryAfterSec) || 0) * 1000) };
}

const ms = (t) => (t ? new Date(t).getTime() : 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 표의 한 행 → 화면의 작업 줄(개인판 tools/jobs.mjs 의 job 레코드와 같은 꼴)
export function viewOf(r) {
  const status = r.status === 'queued' ? 'running'          // 기다리는 것도 «도는 중»으로 — 한 줄에 «대기 중»이라 적는다
    : r.status === 'waiting_for_user' ? 'paused'
      : r.status === 'cancelled' ? 'stopped' : r.status;
  return {
    id: r.id, kind: r.kind, title: r.title, targetId: r.target_legacy_id || '',
    status, step: r.status === 'queued' ? '대기 중' : r.step, stepAt: ms(r.step_at) || ms(r.created_at),
    error: r.status === 'failed' ? r.error_message_safe || '실패' : '',
    ask: r.status === 'waiting_for_user' ? r.ask || { reason: r.error_code, say: r.error_message_safe } : null,
    startedAt: ms(r.started_at) || ms(r.created_at), endedAt: ms(r.ended_at),
    docIds: (r.result && r.result.docIds) || [], params: r.params || {},
  };
}

// 한 사람이 줄에 세울 수 있는 만큼 — 고장 난 화면 · 되풀이 클릭 · 스크립트가 비용을 태우지 못하게(docs/SECURITY.md «비용»).
// 숫자는 화면에 보이지 않는다(학생은 횟수를 보지 않는다) — 넘치면 «잠시 뒤에» 만.
export const USER_LIMITS = { active: 8, perWindow: 40, windowMs: 10 * 60 * 1000 };

export function createJobQueue(pool, { userLimits = USER_LIMITS } = {}) {
  // Core id → 표의 키(문서 · 스레드). 없으면 null(대상이 없는 작업 — 에이전트 준비 등)
  async function targetOf(pid, legacy) {
    if (!legacy) return null;
    for (const t of ['documents', 'threads']) {
      const r = await pool.query(`SELECT id FROM ${t} WHERE project_id = $1 AND legacy_id = $2 AND deleted_at IS NULL`, [pid, legacy]);
      if (r.rows[0]) return r.rows[0].id;
    }
    return null;
  }

  return {
    // 넣기 — { ok, jobId } · 같은 대상에 도는 작업이 있으면 { ok:false, code:'conflict' } · 같은 키면 그 작업
    async enqueue({ pid, requestedBy = null, kind, title = '작업', targetId = '', params = {}, idempotencyKey = null, maxAttempts = 5 }) {
      const org = (await pool.query('SELECT organization_id FROM projects WHERE id = $1', [pid])).rows[0];
      if (!org) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
      const target = await targetOf(pid, targetId);
      // 같은 클릭이 다시 왔으면 그 작업 — 대상 겹침보다 먼저 본다(같은 클릭은 «이미 도는 중»이 아니라 «그것»이다)
      const same = async () => idempotencyKey
        ? (await pool.query('SELECT id FROM jobs WHERE requested_by IS NOT DISTINCT FROM $1 AND idempotency_key = $2', [requestedBy, idempotencyKey])).rows[0]
        : null;
      const before = await same();
      if (before) return { ok: true, jobId: before.id, again: true };
      if (requestedBy && userLimits) {
        const u = (await pool.query(
          `SELECT count(*) FILTER (WHERE status IN ('queued', 'running')) AS active,
                  count(*) FILTER (WHERE created_at > now() - make_interval(secs => $2)) AS recent
             FROM jobs WHERE requested_by = $1 AND (status IN ('queued', 'running') OR created_at > now() - make_interval(secs => $2))`,
          [requestedBy, userLimits.windowMs / 1000])).rows[0];
        if (Number(u.active) >= userLimits.active || Number(u.recent) >= userLimits.perWindow) {
          return { ok: false, code: 'busy', error: '작업이 많이 쌓여 있습니다 — 앞의 작업이 끝난 뒤 다시 해 주세요' };
        }
      }
      try {
        const { rows } = await pool.query(
          `INSERT INTO jobs (id, organization_id, project_id, requested_by, kind, title, target_id, target_legacy_id, params, idempotency_key, max_attempts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [randomUUID(), org.organization_id, pid, requestedBy, kind, String(title), target, String(targetId || ''), params, idempotencyKey, maxAttempts]);
        return { ok: true, jobId: rows[0].id };
      } catch (e) {
        const raced = e && e.code === '23505' ? await same() : null;   // 같은 클릭이 거의 동시에 둘
        if (raced) return { ok: true, jobId: raced.id, again: true };
        if (e && e.code === '23505') return { ok: false, code: 'conflict', error: '이미 도는 중입니다' };
        throw e;
      }
    },

    // 집기 — 차례(우선순위 · 먼저 온 것)대로 하나. 기관 동시 상한에 닿은 기관의 작업은 건너뛴다.
    async claim(workerId, { leaseMs = LEASE_MS } = {}) {
      const { rows } = await pool.query(
        `WITH busy AS (
           SELECT j.organization_id FROM jobs j JOIN organizations o ON o.id = j.organization_id
            WHERE j.status = 'running' GROUP BY j.organization_id, o.max_concurrent_jobs HAVING count(*) >= o.max_concurrent_jobs),
         next AS (
           SELECT id FROM jobs
            WHERE status = 'queued' AND run_after <= now()
              AND (organization_id IS NULL OR organization_id NOT IN (SELECT organization_id FROM busy))
            ORDER BY priority DESC, created_at
            FOR UPDATE SKIP LOCKED LIMIT 1)
         UPDATE jobs j SET status = 'running', locked_by = $1, locked_at = now(), heartbeat_at = now(),
                lease_expires_at = now() + make_interval(secs => $2), attempt = j.attempt + 1,
                started_at = coalesce(j.started_at, now()), step = '', step_at = now()
           FROM next WHERE j.id = next.id
         RETURNING j.*`, [workerId, leaseMs / 1000]);
      return rows[0] || null;
    },

    // 숨 — lease 를 밀고 손잡이 요청을 읽어 온다. 잃었으면 null(울타리 밖 — 더 하지 말 것)
    async heartbeat(jobId, workerId, { leaseMs = LEASE_MS } = {}) {
      const { rows } = await pool.query(
        `UPDATE jobs SET heartbeat_at = now(), lease_expires_at = now() + make_interval(secs => $3)
          WHERE id = $1 AND locked_by = $2 AND status = 'running'
          RETURNING cancel_requested_at, pause_requested_at`, [jobId, workerId, leaseMs / 1000]);
      if (!rows[0]) return null;
      return { cancel: !!rows[0].cancel_requested_at, pause: !!rows[0].pause_requested_at };
    },

    async step(jobId, workerId, text) {
      await pool.query(`UPDATE jobs SET step = $3, step_at = now() WHERE id = $1 AND locked_by = $2 AND status = 'running'`, [jobId, workerId, String(text || '')]);
    },

    async addDoc(jobId, workerId, docId) {
      await pool.query(
        `UPDATE jobs SET result = jsonb_set(result, '{docIds}', coalesce(result->'docIds', '[]'::jsonb) || to_jsonb($3::text))
          WHERE id = $1 AND locked_by = $2 AND status = 'running' AND NOT coalesce(result->'docIds', '[]'::jsonb) ? $3`, [jobId, workerId, String(docId)]);
    },

    // 체크포인트 — 여러 호출로 된 작업이 한 호출씩 끝날 때마다(합평 패널). 재시도 · 이어 하기 · 회수가 여기서 잇는다.
    async checkpoint(jobId, workerId, data) {
      const r = await pool.query(`UPDATE jobs SET checkpoint = $3 WHERE id = $1 AND locked_by = $2 AND status = 'running'`, [jobId, workerId, data]);
      return r.rowCount > 0;
    },

    // 끝내기 — done · failed · cancelled. 울타리가 맞을 때만(맞았으면 true)
    async finish(jobId, workerId, { status, errorCode = '', errorSafe = '' }) {
      const r = await pool.query(
        `UPDATE jobs SET status = $3, error_code = $4, error_message_safe = $5, ended_at = now(), step = '',
                locked_by = NULL, lease_expires_at = NULL, ask = NULL
          WHERE id = $1 AND locked_by = $2 AND status = 'running'`, [jobId, workerId, status, errorCode, errorSafe]);
      return r.rowCount > 0;
    },

    // 미루기 — 다시 줄 세운다(run_after 뒤에)
    async retryLater(jobId, workerId, { delayMs, errorCode = '', errorSafe = '' }) {
      const r = await pool.query(
        `UPDATE jobs SET status = 'queued', run_after = now() + make_interval(secs => $3), error_code = $4, error_message_safe = $5,
                locked_by = NULL, lease_expires_at = NULL, step = ''
          WHERE id = $1 AND locked_by = $2 AND status = 'running'`, [jobId, workerId, delayMs / 1000, errorCode, errorSafe]);
      return r.rowCount > 0;
    },

    // 내려놓기 — 멈춤(paused) 또는 사람의 답을 기다림(waiting_for_user). worker 를 붙잡지 않는다.
    async park(jobId, workerId, { status, ask = null, checkpoint = null }) {
      const r = await pool.query(
        `UPDATE jobs SET status = $3, ask = $4, checkpoint = coalesce($5, checkpoint), pause_requested_at = NULL,
                locked_by = NULL, lease_expires_at = NULL
          WHERE id = $1 AND locked_by = $2 AND status = 'running'`, [jobId, workerId, status, ask, checkpoint]);
      return r.rowCount > 0;
    },

    // 회수 — lease 가 지난 «도는 중»(worker 가 죽었다). 시도가 남았으면 다시 줄 세우고, 아니면 실패.
    async reap() {
      const { rows } = await pool.query(
        `UPDATE jobs SET
            status = CASE WHEN attempt < max_attempts AND cancel_requested_at IS NULL THEN 'queued'
                          WHEN cancel_requested_at IS NOT NULL THEN 'cancelled' ELSE 'failed' END,
            run_after = now() + interval '30 seconds',
            error_code = CASE WHEN cancel_requested_at IS NOT NULL THEN '' ELSE 'worker_lost' END,
            error_message_safe = CASE WHEN attempt < max_attempts OR cancel_requested_at IS NOT NULL THEN '' ELSE '작업하던 곳이 멈춰 잇지 못했습니다' END,
            ended_at = CASE WHEN attempt < max_attempts AND cancel_requested_at IS NULL THEN NULL ELSE now() END,
            locked_by = NULL, lease_expires_at = NULL, step = ''
          WHERE status = 'running' AND lease_expires_at < now()
          RETURNING id, status`);
      return rows;
    },

    // ---------------- 사람의 손잡이(웹이 부른다) — 그 프로젝트의 작업일 때만
    async cancel(pid, jobId) {
      if (!UUID.test(String(jobId || ''))) return { ok: false, error: '도는 작업이 아닙니다' };
      // 아직 아무도 잡지 않았으면 곧바로 끝내고, 도는 중이면 worker 에게 요청을 남긴다(heartbeat 때 끊는다)
      const r = await pool.query(
        `UPDATE jobs SET
            status = CASE WHEN status = 'running' THEN status ELSE 'cancelled' END,
            ended_at = CASE WHEN status = 'running' THEN ended_at ELSE now() END,
            cancel_requested_at = now(), ask = CASE WHEN status = 'running' THEN ask ELSE NULL END
          WHERE id = $1 AND project_id = $2 AND status = ANY($3)`, [jobId, pid, ACTIVE]);
      return { ok: true, changed: r.rowCount > 0 };
    },
    async pause(pid, jobId) {
      if (!UUID.test(String(jobId || ''))) return { ok: false, error: '도는 작업이 아닙니다' };
      const r = await pool.query(
        `UPDATE jobs SET status = CASE WHEN status = 'queued' THEN 'paused' ELSE status END,
                pause_requested_at = CASE WHEN status = 'running' THEN now() ELSE pause_requested_at END
          WHERE id = $1 AND project_id = $2 AND status IN ('queued', 'running')`, [jobId, pid]);
      return r.rowCount ? { ok: true } : { ok: false, error: '도는 작업이 아닙니다' };
    },
    async resume(pid, jobId) {
      if (!UUID.test(String(jobId || ''))) return { ok: false, error: '도는 작업이 아닙니다' };
      const r = await pool.query(
        `UPDATE jobs SET status = CASE WHEN status = 'running' THEN status ELSE 'queued' END,
                pause_requested_at = NULL, run_after = now(), ask = NULL
          WHERE id = $1 AND project_id = $2 AND (status IN ('paused', 'waiting_for_user') OR (status = 'running' AND pause_requested_at IS NOT NULL))`, [jobId, pid]);
      return r.rowCount ? { ok: true } : { ok: false, error: '도는 작업이 아닙니다' };
    },
    // 물음에 답한다 — 'stop' 이면 끝, 그 밖('wait' · 'api')은 다시 줄 세운다(온라인판은 키 갈래를 화면에서 고르지 않는다)
    async answer(pid, jobId, choice) {
      if (String(choice) === 'stop') return this.cancel(pid, jobId);
      return this.resume(pid, jobId);
    },
    // 목록에서 치운다 — 돌고 있으면 먼저 멈춘다. 산출 문서는 건드리지 않는다.
    async dismiss(pid, jobId) {
      if (!UUID.test(String(jobId || ''))) return { ok: true };
      await this.cancel(pid, jobId);
      await pool.query('UPDATE jobs SET dismissed_at = now() WHERE id = $1 AND project_id = $2', [jobId, pid]);
      return { ok: true };
    },
    async cancelProject(pid) {
      await pool.query(`UPDATE jobs SET cancel_requested_at = now(),
          status = CASE WHEN status = 'running' THEN status ELSE 'cancelled' END,
          ended_at = CASE WHEN status = 'running' THEN ended_at ELSE now() END
        WHERE project_id = $1 AND status = ANY($2)`, [pid, ACTIVE]);
    },
    async isTargetActive(pid, legacy) {
      const r = await pool.query('SELECT 1 FROM jobs WHERE project_id = $1 AND target_legacy_id = $2 AND status = ANY($3) LIMIT 1', [pid, String(legacy || ''), ACTIVE]);
      return r.rowCount > 0;
    },
    async isKindActive(pid, kind) {
      const r = await pool.query('SELECT 1 FROM jobs WHERE project_id = $1 AND kind = $2 AND status = ANY($3) LIMIT 1', [pid, kind, ACTIVE]);
      return r.rowCount > 0;
    },
    async list(pid, { limit = 50 } = {}) {
      const { rows } = await pool.query(
        `SELECT * FROM (SELECT * FROM jobs WHERE project_id = $1 AND dismissed_at IS NULL ORDER BY created_at DESC LIMIT $2) x ORDER BY created_at`, [pid, limit]);
      return rows.map(viewOf);
    },
    async get(jobId) {
      if (!UUID.test(String(jobId || ''))) return null;
      return (await pool.query('SELECT * FROM jobs WHERE id = $1', [jobId])).rows[0] || null;
    },
  };
}
