// 생성 실행 — 문서 갱신(문서 · 모순 검사 · 합평회) · 합평 패널 · 논의 한 마디 · 논의 정리.
// tools/engine.mjs 의 run* 을 의미 그대로 옮겼다(온라인화 Phase 1 — Core 분리).
// 저장(store: get/update)과 호출(call: 재시도·한도 물음까지 맡은 한 번의 부르기)은 바깥이 넣어 준다 —
// 개인판은 state.mjs 와 engine.callAsking(CLI), 온라인판은 PostgreSQL 과 Provider worker 가 맡는다.

import * as model from '../domain/model.mjs';

const KIND_CODE = { doc: 'F-UPDATE', check: 'F-CONTRA', review: 'F-REVIEW' };

// 갱신 — 문서·모순 검사·합평회가 모두 이 길을 쓴다.
// modelPick 은 작가가 «어느 모델로 모을지»를 고른 값(비어 있으면 평소대로).
export async function runUpdate({ store, call }, pid, docId, ctx, { modelPick = '' } = {}) {
  const project = store.get(pid);
  const d = project && model.findDoc(project, docId);
  if (!d) return { ok: false, error: '문서를 찾을 수 없습니다' };
  if (ctx) ctx.step(d.title);

  const targetIds = d.kind === 'doc'
    ? (d.body.trim() ? [d.id] : [])
    : (d.targetIds || []).slice();
  const refIds = (d.refIds || []).filter((id) => id !== d.id);
  const agentIds = (d.agentIds || []).slice();
  const common = {
    pid, refIds, targetIds, request: d.request || '',
    finalFirst: d.kind === 'check', keepSeat: true, modelPick,
    signal: ctx && ctx.signal,
  };

  // 합평회에 여럿이 걸렸으면 각자 제 합평을 내고, 그 뒤에 한 자리가 그것들을 모은다(사용자 지시).
  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  const r = d.kind === 'review' && agentIds.length > 1
    ? await runPanelReview({ store, call }, pid, d, agentIds, common, ctx)
    : await call({ ...common, code: KIND_CODE[d.kind] || 'F-UPDATE', agentIds }, ctx);
  if (!r.ok) return r;
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };

  store.update(pid, (p) => { model.docWrite(p, docId, { body: r.text }); });
  if (ctx) ctx.addDoc(docId);
  return { ok: true };
}

// 합평회 — 걸린 사람마다 한 호출씩 제 합평을 내고, 마지막 한 호출이 그것들을 하나로 모은다.
async function runPanelReview({ store, call }, pid, d, agentIds, common, ctx) {
  const project = store.get(pid);
  const crew = model.agentsByIds(project, agentIds);
  if (crew.length < 2) return call({ ...common, code: 'F-REVIEW', agentIds }, ctx);

  const said = [];
  for (const one of crew) {
    if (ctx && ctx.gate) await ctx.gate();
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    if (ctx) ctx.step(d.title + ' — ' + one.name);
    const r = await call({ ...common, code: 'F-REVIEW', agentIds: [one.id] }, ctx);
    if (!r.ok) return r;
    said.push({ id: '', name: one.name + '의 합평', text: r.text });
  }

  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  if (ctx) ctx.step(d.title + ' — 모으기');
  // 모으는 자리에는 사람을 걸지 않는다 — 누구의 편도 들지 않아야 한다.
  return call({ ...common, code: 'F-MERGE', agentIds: [], extraTargets: said }, ctx);
}

// 논의 한 마디 — 작가의 말을 얹고, 답을 받아 얹는다.
// text 가 null 이면 말은 이미 얹힌 것이다(과거 메시지를 고쳐 가지가 갈라진 자리).
export async function runTalk({ store, call }, pid, threadId, text, ctx, { modelPick = '' } = {}) {
  let askedId = null;
  if (text != null) {
    store.update(pid, (p) => {
      const m = model.threadAddMessage(p, threadId, 'user', text);
      if (m) askedId = m.id;
    });
    if (!askedId) return { ok: false, error: '스레드를 찾을 수 없습니다' };
  } else {
    const p0 = store.get(pid);
    const t0 = p0 && model.findThread(p0, threadId);
    if (!t0) return { ok: false, error: '스레드를 찾을 수 없습니다' };
    askedId = t0.headId;
  }

  const project = store.get(pid);
  const t = model.findThread(project, threadId);
  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  if (ctx) ctx.step(t.title);
  // 대화는 «물은 그 자리»까지만 싣는다(기다리는 동안 작가가 다른 가지로 옮겨 가도 흔들리지 않는다).
  const path = model.threadPath(t, askedId);
  const talk = path.map((m) => ({ name: m.role === 'user' ? '작가' : '너', text: m.text }));

  const r = await call({
    pid, code: 'F-TALK', refIds: (t.refIds || []).slice(), agentIds: (t.agentIds || []).slice(), talk,
    keepSeat: true, modelPick, signal: ctx && ctx.signal,
  }, ctx);
  if (!r.ok) return r;
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  // 답은 «물은 그 말» 밑에 붙는다 — 기다리는 사이 머리가 옮겨 가도 엉뚱한 가지로 새지 않는다.
  // 그동안 작가가 다른 가지로 옮겨 갔으면 보던 자리를 빼앗지 않는다.
  store.update(pid, (p) => {
    const th = model.findThread(p, threadId);
    if (!th) return;
    // 기다리는 사이 같은 줄에서 말을 더 이었으면 그 줄 끝에 답한다(가지를 쪼개지 않는다).
    // 아주 다른 가지로 옮겨 갔을 때만 물은 자리 밑에 조용히 붙인다.
    const onSameLine = model.threadPath(th, th.headId).some((m) => m.id === askedId);
    const parent = onSameLine ? th.headId : askedId;
    model.threadAddMessage(p, threadId, 'assistant', r.text, parent, { moveHead: onSameLine });
  });
  return { ok: true };
}

// 논의 정리 문서 — 지금 보고 있는 가지만 대상으로 한다.
export async function runThreadDoc({ store, call }, pid, threadId, request, ctx, { modelPick = '' } = {}) {
  const project = store.get(pid);
  const t = project && model.findThread(project, threadId);
  if (!t) return { ok: false, error: '스레드를 찾을 수 없습니다' };
  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  if (ctx) ctx.step(t.title);
  const talk = model.threadPath(t).map((m) => ({ name: m.role === 'user' ? '작가' : '너', text: m.text }));

  const r = await call({
    pid, code: 'F-THREADDOC', refIds: (t.refIds || []).slice(), agentIds: (t.agentIds || []).slice(), talk, request,
    keepSeat: true, modelPick, signal: ctx && ctx.signal,
  }, ctx);
  if (!r.ok) return r;
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };

  let docId = null;
  store.update(pid, (p) => {
    const d = model.docCreate(p, { title: t.title, body: r.text });
    docId = d.id;
  });
  if (ctx) ctx.addDoc(docId);
  return { ok: true, docId };
}
