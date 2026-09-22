// 작업 실행기 — 좌측 메뉴 하단에 쌓이는 그 작업들.
// 한 번에 여러 작업이 돌 수 있다. 진행 표시는 «지금 하는 일 · 지난 시간» 한 줄뿐이다(막대·백분율 없음).

import { newId } from './store.mjs';
import * as state from './state.mjs';

const live = new Map(); // jobId → { controller, pid, paused, wake }

// 그 프로젝트의 작업일 때만 손잡이를 내어 준다.
//
// 전에는 live.get(jobId) 만 보아 pid 를 견주지 않았다. 사람이 하나일 때는 드러나지 않지만,
// 계정이 갈리면 **남의 jobId 하나로 남의 작업을 멈추고 abort 시킬 수 있다.**
// 문지기를 한 자리에 두어 pause·resume·stop 이 모두 이 문을 지나게 한다.
function mine(pid, jobId) {
  const h = live.get(jobId);
  return h && h.pid === pid ? h : null;
}

export const STATUS = { running: '진행 중', paused: '멈춤', done: '완료', stopped: '중지됨', failed: '실패' };

// 멈춤 — 돌던 호출 한 건은 끝까지 두고, 다음 호출 앞에서 선다.
// (호출을 중간에 끊으면 그 호출은 버려지고 구독만 나간다.)
export function pause(pid, jobId) {
  const h = mine(pid, jobId);
  if (!h) return { ok: false, error: '도는 작업이 아닙니다' };
  h.paused = true;
  state.update(pid, (p) => {
    const j = p.jobs.find((x) => x.id === jobId);
    if (j && j.status === 'running') j.status = 'paused';
  });
  return { ok: true };
}

export function resume(pid, jobId) {
  const h = mine(pid, jobId);
  if (!h) return { ok: false, error: '도는 작업이 아닙니다' };
  h.paused = false;
  if (h.wake) { const w = h.wake; h.wake = null; w(); }
  state.update(pid, (p) => {
    const j = p.jobs.find((x) => x.id === jobId);
    if (j && j.status === 'paused') { j.status = 'running'; j.stepAt = Date.now(); }
  });
  return { ok: true };
}

// 사람이 고른 것을 얹고 문지기를 풀어 준다. 고를 것: 'wait' | 'api' | 'stop'
export function answer(pid, jobId, choice) {
  const h = mine(pid, jobId);
  if (!h) return { ok: false, error: '도는 작업이 아닙니다' };
  const c = String(choice || '');
  if (c === 'stop') return stop(pid, jobId);
  h.answer = c;
  return resume(pid, jobId);
}

function put(pid, jobId, patch) {
  state.update(pid, (p) => {
    const j = p.jobs.find((x) => x.id === jobId);
    if (j) Object.assign(j, patch);
  });
}

/**
 * run(ctx) 를 띄우고 곧바로 jobId 를 돌려준다(기다리지 않는다).
 * ctx = { pid, signal, step(name), addDoc(id) }
 */
export function start(pid, { kind = 'call', title = '작업', targetId = '', run }) {
  const p = state.get(pid);
  if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };

  const id = newId('j');
  const now = Date.now();
  const job = {
    id, kind, title, targetId,
    status: 'running', step: '', stepAt: now, error: '',
    // 한도에 닿으면 여기에 물음이 매달린다 — { at, reason, resetsAt, canApi }.
    // 화면은 이것이 있으면 작업 줄에 고를 것을 세운다.
    ask: null,
    startedAt: now, endedAt: 0, docIds: [],
  };
  state.update(pid, (pr) => { pr.jobs.push(job); });

  const controller = new AbortController();
  const handle = { controller, pid, paused: false, wake: null, answer: null };
  live.set(id, handle);

  const ctx = {
    pid,
    jobId: id,
    signal: controller.signal,
    step(name) { put(pid, id, { step: String(name || ''), stepAt: Date.now() }); },
    // 호출과 호출 사이의 문지기 — 멈춰 두면 여기서 기다린다(돌던 호출 한 건은 끝까지 간다).
    async gate() {
      while (handle.paused && !controller.signal.aborted) {
        await new Promise((resolve) => { handle.wake = resolve; });
      }
      return !controller.signal.aborted;
    },
    // 한도에 닿았을 때 — 실패로 적지 않고 멈춤으로 돌리고 물음을 매달아 둔다.
    //
    // 문지기(gate)는 호출과 호출 «사이»에 선다. 소진된 호출은 이미 실패한 뒤이므로,
    // 사람이 고르면 engine 의 callAsking 이 **그 호출부터** 다시 부른다.
    // 합평회처럼 여러 호출로 된 일도 앞서 받은 것을 잃지 않는다(said[] 가 그대로 남는다).
    async askLimit(info = {}) {
      put(pid, id, {
        status: 'paused',
        // «API 로 갈아탈 수 있나»는 여기에 굳히지 않는다 — 물음이 매달린 뒤에 키를 넣을 수 있으므로
        // 화면이 지금의 auth 를 보고 판단한다(실측: 굳혀 두면 키를 넣어도 단추가 서지 않았다).
        ask: {
          at: Date.now(),
          reason: String(info.reason || ''),
          resetsAt: Number(info.resetsAt) || 0,
        },
        stepAt: Date.now(),
      });
      handle.paused = true;
      handle.answer = null;
      const alive = await ctx.gate();
      const choice = String(handle.answer || '');
      handle.answer = null;
      put(pid, id, { ask: null });
      return alive ? choice : '';
    },
    addDoc(docId) {
      state.update(pid, (pr) => {
        const j = pr.jobs.find((x) => x.id === id);
        if (j && docId && !j.docIds.includes(docId)) j.docIds.push(docId);
      });
    },
  };

  Promise.resolve()
    .then(() => run(ctx))
    .then((res) => {
      if (controller.signal.aborted) put(pid, id, { status: 'stopped', endedAt: Date.now(), step: '' });
      else if (res && res.ok === false) put(pid, id, { status: 'failed', error: String(res.error || ''), endedAt: Date.now(), step: '' });
      else put(pid, id, { status: 'done', endedAt: Date.now(), step: '' });
    })
    .catch((e) => {
      if (controller.signal.aborted) put(pid, id, { status: 'stopped', endedAt: Date.now(), step: '' });
      else put(pid, id, { status: 'failed', error: String((e && e.message) || e), endedAt: Date.now() });
    })
    .finally(() => { live.delete(id); });

  return { ok: true, jobId: id };
}

export function stop(pid, jobId) {
  const h = mine(pid, jobId);
  if (h) {
    h.controller.abort();
    h.paused = false;
    if (h.wake) { const w = h.wake; h.wake = null; w(); }   // 문지기에 갇혀 있으면 풀어 준다
  }
  // 이미 끝난 작업의 «완료»·«실패»를 «중지됨»으로 뒤집지 않는다.
  state.update(pid, (p) => {
    const j = p.jobs.find((x) => x.id === jobId);
    if (j && (j.status === 'running' || j.status === 'paused')) { j.status = 'stopped'; j.endedAt = Date.now(); j.step = ''; j.ask = null; }
  });
  return { ok: true };
}

// 그 프로젝트의 작업만 멈춘다 — 남의 프로젝트는 건드리지 않는다.
export function stopProject(pid) {
  for (const [id, h] of [...live]) if (h.pid === pid) { h.controller.abort(); live.delete(id); }
  return { ok: true };
}

export function isTargetRunning(pid, targetId) {
  const p = state.get(pid);
  return !!(p && p.jobs.some((j) => j.status === 'running' && j.targetId === targetId));
}

export function isKindRunning(pid, kind) {
  const p = state.get(pid);
  return !!(p && p.jobs.some((j) => j.kind === kind && (j.status === 'running' || j.status === 'paused')));
}

// 목록에서 지운다. 돌고 있으면 먼저 멈춘다. 산출 문서는 건드리지 않는다.
export function remove(pid, jobId) {
  stop(pid, jobId);
  state.update(pid, (p) => {
    const i = p.jobs.findIndex((x) => x.id === jobId);
    if (i >= 0) p.jobs.splice(i, 1);
  });
  return { ok: true };
}

export function aborted(ctx) { return !!(ctx && ctx.signal && ctx.signal.aborted); }

// 서버가 죽었다 살아나면 지난 실행의 «진행 중»·«멈춤»은 거짓이다 — 중지됨으로 내린다.
//
// 멈춘 자리에서 이어 가려면 메모리의 손잡이(controller·wake)가 있어야 하는데 재시작으로 사라졌다.
// 그래서 내리는 것이 맞다. 다만 **한도 때문에 멈춰 물음을 매달아 둔 작업**까지 함께 삼키므로,
// 왜 끊겼는지를 적어 둔다 — 적지 않으면 작가는 제 작업이 까닭 없이 사라진 줄로 안다.
export function healStale(pid) {
  state.update(pid, (p) => {
    for (const j of p.jobs) {
      if ((j.status === 'running' || j.status === 'paused') && !live.has(j.id)) {
        if (j.status === 'paused' && !j.error) j.error = '프로그램이 다시 떠서 멈춘 자리에서 잇지 못했습니다';
        j.status = 'stopped';
        j.endedAt = Date.now();
        j.step = '';
        j.ask = null;
      }
    }
  });
}

export function stopAll() {
  for (const [, h] of live) h.controller.abort();
  live.clear();
}
