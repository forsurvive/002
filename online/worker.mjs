// worker — 영속 작업 큐(online/jobs.mjs)에서 작업을 집어 Core 의 작업 종류 표(core/generation/kinds.mjs)로 돌린다.
// 개인판 실행기(tools/jobs.mjs)와 같은 약속을 지킨다:
//   · 일시중지는 돌던 호출을 끝까지 두고 «다음 호출 앞»(ctx.gate)에서 선다 — 온라인은 거기서 작업을 내려놓는다(worker 를 붙잡지 않는다).
//   · 취소는 숨(heartbeat) 때 보고 진행 중 호출을 끊는다. 결과는 버리고 문서는 그대로.
//   · 실패해도 기존 글을 덮어쓰지 않는다 — Core 가 결과를 끝에 한 번, 새 판으로만 쓴다.
// 실패 갈래(JOB_SYSTEM §5): 잠깐 밀림 → 백오프로 다시 줄 · 키 없음 → 사람의 답을 기다림 · 나머지 → 실패(사람 말로).
// 쉴 때는 DB 를 두드리지 않는다 — 웹이 wake() 로 깨우고, 도는 작업이 있을 때만 숨과 회수를 한다(§8).

import { randomBytes } from 'node:crypto';
import { runKind } from '../core/generation/kinds.mjs';
import { prepareThenStudy } from '../core/generation/agents.mjs';
import { BUILTIN, AGENT_SLOTS, SLOT_DUTY } from '../tools/prompts.mjs';
import { promptFor, slotModel } from '../tools/prompt-pick.mjs';
import { baseTemplate } from '../tools/workflow.mjs';
import { retryPlan, LEASE_MS } from './jobs.mjs';
import { SAY as TENANCY_SAY } from './tenancy.mjs';

const PARK = Symbol('park');
const PROMPTS = { builtin: BUILTIN, slots: AGENT_SLOTS, duty: SLOT_DUTY, promptFor, slotModel };   // 다음 호출 앞에서 내려놓으라는 신호

// 사람에게 보일 실패 문구 — 어댑터 · Core 의 문구는 이미 사람 말이다. 갈래만 있고 문구가 없으면 이것으로.
const SAY = {
  credential: 'AI 연결이 필요합니다', auth: 'AI 키가 맞지 않습니다', credit: 'AI 사용 잔액이 없습니다', model: '쓸 수 있는 모델이 없습니다',
  invalid: '입력이 너무 깁니다 — 줄여서 다시 불러도 넘쳤습니다. 참조를 줄여 다시 해 보세요', safety: '안전 정책으로 답하지 않았습니다', empty: '빈 응답', timeout: '응답이 너무 오래 걸렸습니다', other: '실패', internal: '작업 중 오류가 났습니다 — 다시 해 보세요',
  org: '기관의 AI 연결에 문제가 있습니다 — 선생님(기관)께 알려 주세요',
};

/**
 * deps = { queue, store, call, prepare? }  — store 는 createProjectStore, call 은 createOnlineCall 의 결과
 * opts = { concurrency, heartbeatMs, idleMs, leaseMs, log, maxJobMs }
 */
export function createWorker({ queue, store, call, prepare = null, allowed = null, workflow = null }, {
  concurrency = Number(process.env.WORKER_CONCURRENCY) || 4, heartbeatMs = 15000, idleMs = 10 * 60 * 1000, leaseMs = LEASE_MS, log = () => {},
  // 작업 하나가 한 번에 도는 시간(JOB_SYSTEM §106 — 기본 2시간). 넘으면 실패로 끝내지 않고 «멈춤»으로 내려놓는다 —
  // 나눠 읽은 조각 · 이어 쓴 글은 체크포인트에 남아 [이어 하기]가 그 자리부터 잇는다(긴 글이 시간 때문에 실패하지 않게, EBOOK_EDITION §5-1). 문서는 그대로.
  maxJobMs = Number(process.env.JOB_MAX_DURATION_MS) || 2 * 60 * 60 * 1000,
} = {}) {
  const id = 'w-' + process.pid + '-' + randomBytes(3).toString('hex');
  const running = new Map();   // jobId → { controller }
  let stopped = false;
  let ticking = null;
  let idleTimer = null;

  async function runOne(row) {
    const controller = new AbortController();
    let lost = false; let cancelled = false;
    const pending = [];
    running.set(row.id, { controller });
    const params = row.params || {};
    const userId = row.requested_by;

    const check = async () => {
      const h = await queue.heartbeat(row.id, id, { leaseMs });
      if (!h) { lost = true; controller.abort(); return null; }
      if (h.cancel) { cancelled = true; controller.abort(); }
      return h;
    };
    const beat = setInterval(() => { check().catch(() => {}); }, heartbeatMs);
    let overdue = false;
    const cap = setTimeout(() => { overdue = true; controller.abort(); }, maxJobMs);

    // 작업마다 저장은 «누가 고쳤나»(판의 created_by)를 그 작업을 맡긴 사람으로 남긴다
    // 바로 앞의 성공한 부르기 — 그 뒤의 저장에서 생긴 판 · 메시지가 그 생성 기록에 잇닿는다(판 source='ai')
    let lastRun = null;
    const jobStore = { get: (pid) => store.get(pid), update: (pid, fn) => store.update(pid, fn, { userId, runId: lastRun }) };
    const seen = (r) => { if (r && r.ok && r.runId) lastRun = r.runId; return r; };
    const traced = Object.assign(async (args, c) => seen(await call(args, c)), call, call.raw ? { raw: async (args, c) => seen(await call.raw(args, c)) } : {});
    const deps = {
      store: jobStore,
      call: traced,
      // 에이전트 준비 · 자료 분석 — Core 의 본체에 온라인 저장 · 부르기(call.raw 는 판정 · 짓기용)를 넣는다
      prepare: prepare || ((pid, c, request) => prepareThenStudy({ store: jobStore, call: traced, raw: traced.raw, prompts: PROMPTS }, pid, c, request)),
      // 단계 생성 — 그 프로젝트에 쓸 템플릿(운영자 · 기관이 고쳐 쓴 것까지)
      workflow: workflow || (async () => baseTemplate()),
    };
    const ctx = {
      pid: row.project_id, jobId: row.id, userId, threadId: params.threadId || '', signal: controller.signal,
      // 체크포인트 — 지난 시도가 남긴 것(resume)과 이번에 남기기(save). 울타리 밖이면 남기지 않는다.
      resume: row.checkpoint || null,
      save: async (data) => { await queue.checkpoint(row.id, id, data); },
      // Core 는 이 둘을 기다리지 않는다 — 끝내기 전에 모두 닿게 모아 둔다(끝낸 뒤에 오면 울타리에 막혀 산출 문서를 잃는다)
      step: (text) => { pending.push(queue.step(row.id, id, text).catch(() => {})); },
      addDoc: (docId) => { pending.push(queue.addDoc(row.id, id, docId).catch(() => {})); },
      // 호출과 호출 사이 — 손잡이 요청을 읽는다. 멈추라 했으면 여기서 내려놓는다.
      async gate() {
        const h = await check();
        if (h && h.pause && !controller.signal.aborted) throw PARK;
        return !controller.signal.aborted;
      },
    };

    let res;
    try {
      // 돌리기 직전에 한 번 더 — 줄에 서 있던 사이 기관 라이선스가 끝났을 수 있다(사람 말은 tenancy 가 정한다)
      const gate = allowed ? await allowed(row) : { ok: true };
      res = gate.ok ? await runKind(deps, row.kind, params, ctx) : { ok: false, reason: gate.reason === 'subscription_inactive' ? gate.reason : 'license', error: TENANCY_SAY[gate.reason] || TENANCY_SAY.missing };
    } catch (e) {
      // 예외로 끝난 작업 — 화면에는 «실패» 한 마디가 아니라 무슨 일인지를, 로그에는 원인을 남긴다(2026-10-07 «실패 — 실패»).
      // 로그에는 ASCII 만 · 짧게(원고가 섞일 수 있는 글자는 걷는다). 한 번은 다시 해 본다(other 와 같은 갈래).
      res = e === PARK ? PARK : { ok: false, reason: 'other', error: SAY.internal };
      if (e !== PARK) log('job ' + row.id + ' threw ' + ((e && e.name) || 'error') + ((e && e.code) ? ' ' + e.code : '') + ': ' + String((e && e.message) || '').replace(/[^\x20-\x7e]/g, '?').slice(0, 160));
    } finally {
      clearInterval(beat);
      clearTimeout(cap);
      await Promise.all(pending);
      running.delete(row.id);
    }

    if (lost) return;   // 울타리 밖 — 이미 다른 worker 가 맡았거나 회수됐다. 아무것도 쓰지 않는다.
    if (res === PARK) return queue.park(row.id, id, { status: 'paused' });
    // 이 worker 가 내려가느라 끊은 것 — 취소가 아니다. 곧바로 다시 줄 세운다(다른 worker · 다시 뜬 worker 가 잇는다).
    if (overdue && !cancelled) {
      await queue.step(row.id, id, '오래 걸려 잠시 멈췄습니다 — [이어 하기]로 읽은 데부터 잇습니다').catch(() => {});
      return queue.park(row.id, id, { status: 'paused' });
    }
    if (stopped && !cancelled) return queue.retryLater(row.id, id, { delayMs: 0, errorCode: 'worker_stopped' });
    if (cancelled || controller.signal.aborted) return queue.finish(row.id, id, { status: 'cancelled' });
    if (res && res.ok !== false) return queue.finish(row.id, id, { status: 'done' });

    const reason = String((res && res.reason) || 'other');
    // 수업 작품(기관 키)의 키 · 잔액 · 모델 문제는 학생이 고칠 수 없다 — 누구에게 알릴지만 말한다(키 · 잔액 이야기를 학생에게 하지 않는다)
    const orgSide = !!row.organization_id && ['auth', 'credit', 'credential', 'model'].includes(reason);
    const say = orgSide ? SAY.org : String((res && res.error) || SAY[reason] || SAY.other).slice(0, 200);
    if (reason === 'credential') return queue.park(row.id, id, { status: 'waiting_for_user', ask: { reason, say: orgSide ? SAY.org : SAY.credential } });
    const again = retryPlan(reason, row.attempt, (res.retryAfterMs || 0) / 1000);
    if (again && row.attempt < row.max_attempts) return queue.retryLater(row.id, id, { delayMs: again.delayMs, errorCode: reason, errorSafe: say });
    return queue.finish(row.id, id, { status: 'failed', errorCode: reason, errorSafe: say });
  }

  // 빈 슬롯만큼 집는다. 집을 것이 없으면 쉰다(안전망 시계만 남긴다).
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      try {
        while (!stopped && running.size < concurrency) {
          const row = await queue.claim(id, { leaseMs });
          if (!row) break;
          runOne(row).catch((e) => log('job ' + row.id + ' finish failed ' + ((e && e.code) || (e && e.name) || '')))
            .finally(() => { if (!stopped) tick(); });
        }
      } finally {
        ticking = null;
      }
      arm();
    })();
    return ticking;
  }

  // 도는 것이 있으면 회수를 자주(죽은 동료의 작업), 없으면 긴 안전망 하나만
  function arm() {
    if (stopped) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { queue.reap().catch(() => {}).finally(() => tick()); }, running.size ? Math.min(leaseMs, idleMs) : idleMs);
  }

  return {
    id,
    // 웹이 작업을 넣은 뒤 부른다(같은 프로세스). 여러 대가 되면 LISTEN/NOTIFY 로 바꾼다.
    wake() { if (!stopped) tick(); },
    async start() { await queue.reap(); await tick(); },
    // 새로 집지 않고, 도는 호출에 유예를 준다. 못 끝내면 끊는다(lease 가 지나면 회수가 다시 줄 세운다).
    async stop({ graceMs = 25000 } = {}) {
      stopped = true;
      clearTimeout(idleTimer);
      const until = Date.now() + graceMs;
      while (running.size && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      for (const [, h] of running) h.controller.abort();
    },
    get busy() { return running.size; },
  };
}
