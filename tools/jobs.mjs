// 작업 실행기 — 좌측 메뉴 하단에 쌓이는 그 작업들.
// 한 번에 여러 작업이 돌 수 있다. 진행 표시는 «지금 하는 일 · 지난 시간» 한 줄뿐이다(막대·백분율 없음).

import { newId } from './store.mjs';
import * as state from './state.mjs';

const live = new Map(); // jobId → { controller, pid }

export const STATUS = { running: '진행 중', done: '완료', stopped: '중지됨', failed: '실패' };

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
    startedAt: now, endedAt: 0, docIds: [],
  };
  state.update(pid, (pr) => { pr.jobs.push(job); });

  const controller = new AbortController();
  live.set(id, { controller, pid });

  const ctx = {
    pid,
    jobId: id,
    signal: controller.signal,
    step(name) { put(pid, id, { step: String(name || ''), stepAt: Date.now() }); },
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
  const h = live.get(jobId);
  if (h) h.controller.abort();
  // 이미 끝난 작업의 «완료»·«실패»를 «중지됨»으로 뒤집지 않는다.
  state.update(pid, (p) => {
    const j = p.jobs.find((x) => x.id === jobId);
    if (j && (j.status === 'running' || j.status === 'paused')) { j.status = 'stopped'; j.endedAt = Date.now(); j.step = ''; }
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
  return !!(p && p.jobs.some((j) => j.kind === kind && j.status === 'running'));
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

// 서버가 죽었다 살아나면 지난 실행의 «진행 중»은 거짓이다 — 중지됨으로 내린다.
export function healStale(pid) {
  state.update(pid, (p) => {
    // 'paused' 는 일시중지를 빼기 전에 저장된 옛 상태다 — 그대로 두면 화면이 «실패»라 쓴다.
    for (const j of p.jobs) if ((j.status === 'running' || j.status === 'paused') && !live.has(j.id)) { j.status = 'stopped'; j.endedAt = Date.now(); j.step = ''; }
  });
}

export function stopAll() {
  for (const [, h] of live) h.controller.abort();
  live.clear();
}
