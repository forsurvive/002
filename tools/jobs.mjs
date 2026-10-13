// 작업 실행기 — 좌측 메뉴 하단에 쌓이는 그 작업들.
// 한 번에 여러 작업이 돌 수 있다. 진행 표시는 «지금 하는 일 · 지난 시간» 한 줄뿐이다(막대·백분율 없음).
// 작업은 화면이 아니라 이 프로세스에서 돈다 — 작품을 나가도 · 다른 작품을 열어도 그대로 돌고, 여러 작품의 작업이 함께 돈다.
// 다시 켜면 끊긴 작업을 그 기록(종류 + 매개변수 + 체크포인트)으로 다시 띄운다(DESIGN §6-5).

import { newId } from './store.mjs';
import * as state from './state.mjs';
import { threadAddMessage, findThread } from './model.mjs';

const live = new Map(); // jobId → { controller, pid, paused, wake }
const bySignal = new WeakMap();   // 호출 고삐가 «차례 기다림»을 알려 올 때 어느 작업인지 찾는다
const ends = [];                  // 작업이 끝날 때 부를 것(레일이 다음 걸음을 정한다)

// 다시 켜면 다시 띄우는 종류 — 매개변수만으로 처음부터(또는 체크포인트부터) 다시 돌 수 있는 것.
// 논의(talk)는 말이 이미 얹힌 것(askedId)만 — 말을 다시 얹지 않게.
export const REVIVE_KINDS = new Set(['agents', 'update', 'stage', 'threaddoc', 'talk', 'judge']);
const revivable = (j) => !!(j && j.params && REVIVE_KINDS.has(j.kind) && !(j.kind === 'talk' && j.params.text != null));

// 한도 물음에 아무도 답하지 않을 때 — 풀리는 시각(모르면 30분 뒤)에 저절로 «기다렸다 잇기». 시험이 줄인다
let autoWaitMs = 30 * 60 * 1000;
export function setAutoWait(ms) { autoWaitMs = Math.max(1, Number(ms) || autoWaitMs); }

export function onEnd(fn) { if (typeof fn === 'function') ends.push(fn); }

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

// 종류 + 매개변수로 등록된 작업을 실제로 돌리는 자리 — 서버가 꽂는다(core/generation/kinds.mjs 의 표 + 개인판의 저장·호출).
let runner = null;
export function useRunner(fn) { runner = typeof fn === 'function' ? fn : null; }

/**
 * 작업을 띄우고 곧바로 jobId 를 돌려준다(기다리지 않는다).
 * 작업은 «종류 + 매개변수»(params)로 등록한다 — 레코드에 그대로 남아 무엇을 하는 작업인지가 데이터로 보인다.
 * run(ctx) 를 직접 넘기는 길도 남겨 둔다(시험 · 일회성 일).
 * ctx = { pid, signal, step(name), addDoc(id) }
 */
export function start(pid, { kind = 'call', title = '작업', targetId = '', params = null, run = null, rail = false }) {
  const p = state.get(pid);
  if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  if (!run && (!params || !runner)) return { ok: false, error: '돌릴 길이 없는 작업입니다' };
  // 논의의 말은 작업 «앞»에 얹는다 — 다시 켜서 다시 띄워도 말이 한 번만 얹힌다(온라인판과 같은 꼴, DESIGN §6-5)
  if (!run && kind === 'talk') {
    let askedId = '';
    state.update(pid, (pr) => {
      const t = findThread(pr, params.threadId);
      if (!t) return;
      if (params.text != null) { const m = threadAddMessage(pr, params.threadId, 'user', String(params.text)); askedId = m ? m.id : ''; }
      else askedId = t.headId || '';   // 지난 말을 고쳐 돋은 가지 — 그 끝에 답한다
    });
    if (!askedId) return { ok: false, error: '스레드를 찾을 수 없습니다' };
    params = { ...params, text: null, askedId };
  }
  if (!run) run = (ctx) => runner(kind, params, ctx);

  const id = newId('j');
  const now = Date.now();
  const job = {
    id, kind, title, targetId,
    status: 'running', step: '', stepAt: now, error: '',
    // 한도에 닿으면 여기에 물음이 매달린다 — { at, reason, resetsAt, canApi }.
    // 화면은 이것이 있으면 작업 줄에 고를 것을 세운다.
    ask: null,
    startedAt: now, endedAt: 0, docIds: [],
    ...(params ? { params } : {}),
    ...(rail ? { rail: true } : {}),   // 전자책 레일이 띄운 걸음(호출 상한을 센다)
  };
  state.update(pid, (pr) => { pr.jobs.push(job); });
  launch(pid, id, run);
  return { ok: true, jobId: id };
}

// 기록 하나를 실제로 돌린다 — 새로 띄울 때도, 다시 켜서 다시 띄울 때도(paused · resume)
function launch(pid, id, run, { paused = false, resume = null } = {}) {
  const controller = new AbortController();
  const handle = { controller, pid, paused, wake: null, answer: null };
  live.set(id, handle);
  bySignal.set(controller.signal, { pid, id });

  const ctx = {
    pid,
    jobId: id,
    signal: controller.signal,
    // 체크포인트 — 나눠 읽은 조각 · 합평 패널의 앞 사람 · 이어 쓴 부분(core/generation/reading.mjs saveCheckpoint).
    // 작업 기록에 남겨 다시 켜면 거기서 잇는다. 화면에는 내려 주지 않는다(ops stateOf).
    resume,
    save(cp) { put(pid, id, { checkpoint: cp }); },
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
      // 아무도 고르지 않으면(작품을 나가 있거나 자리를 비웠으면) 풀리는 시각에 저절로 «기다렸다 잇기».
      // API 로 갈아타기는 돈이 나가므로 저절로 하지 않는다(DESIGN §6-5)
      const resetMs = (Number(info.resetsAt) || 0) * 1000;
      const delay = resetMs > Date.now() ? Math.max(autoWaitMs, resetMs - Date.now() + 60 * 1000) : autoWaitMs;
      const timer = setTimeout(() => { if (handle.paused && handle.answer == null && !controller.signal.aborted) answer(pid, id, 'wait'); }, delay);
      if (timer.unref) timer.unref();
      const alive = await ctx.gate();
      clearTimeout(timer);
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
    .finally(() => {
      live.delete(id);
      put(pid, id, { queued: false, checkpoint: undefined });   // 끝난 작업은 이을 일이 없다
      // 끝남 갈고리는 한 박자 뒤에 — 갈고리가 새 작업을 띄워도 이 작업의 마무리와 엉키지 않게
      setImmediate(() => { for (const f of ends) { try { f(pid, id); } catch { /* 갈고리의 실패가 작업 실행기를 멈추지 않는다 */ } } });
    });
}

// 호출 고삐(call.mjs)가 알려 온다 — 자리가 없어 기다리기 시작했다(on) / 자리를 얻었다(off). 작업 줄에 «차례 기다림»
export function queued(signal, on) {
  const w = signal && bySignal.get(signal);
  if (w && live.has(w.id)) put(w.pid, w.id, { queued: !!on });
}

// 그 작품에서 지금 돌고 있는(멈춤 포함) 작업 수 — 첫 화면의 작품 카드가 쓴다
export function liveCount(pid) {
  let n = 0;
  for (const [, h] of live) if (h.pid === pid) n++;
  return n;
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
  // 멈춘 작업도 그 문서에 결과를 쓸 것이다 — 고치기 잠금(doc.write) · 겹쳐 돌리기 막기 모두 «도는 중»으로 본다
  return !!(p && p.jobs.some((j) => (j.status === 'running' || j.status === 'paused') && j.targetId === targetId));
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
//
// 2026-10-13 부터(DESIGN §6-5) — 다시 띄울 수 있는 작업(종류 + 매개변수가 남은 것, REVIVE_KINDS)은 **그 기록 그대로 다시 띄운다.**
// 손잡이는 새로 만들고, 체크포인트가 있으면 거기서 잇는다. 사람이 멈춰 둔 것(물음 없이 «멈춤»)은 멈춘 채로 돌아온다.
// 다시 띄울 수 없는 것(매개변수가 없는 옛 기록 · 일회성 일)만 지금까지처럼 «중지됨»으로 내리고 까닭을 남긴다.
export function healStale(pid) {
  const back = [];
  state.update(pid, (p) => {
    for (const j of p.jobs) {
      if (!(j.status === 'running' || j.status === 'paused') || live.has(j.id)) continue;
      if (runner && revivable(j)) {
        const held = j.status === 'paused' && !j.ask;   // 사람이 멈춰 둔 것 — 한도 물음으로 멈춘 것은 다시 불러 본다
        Object.assign(j, { status: held ? 'paused' : 'running', ask: null, queued: false, step: '다시 잇는 중', stepAt: Date.now(), revived: (j.revived || 0) + 1 });
        back.push({ id: j.id, kind: j.kind, params: j.params, held, resume: j.checkpoint || null });
        continue;
      }
      if (j.status === 'paused' && !j.error) j.error = '프로그램이 다시 떠서 멈춘 자리에서 잇지 못했습니다';
      j.status = 'stopped';
      j.endedAt = Date.now();
      j.step = '';
      j.ask = null;
    }
  });
  for (const b of back) launch(pid, b.id, (ctx) => runner(b.kind, b.params, ctx), { paused: b.held, resume: b.resume });
  return back.length;
}

export function stopAll() {
  for (const [, h] of live) h.controller.abort();
  live.clear();
}
