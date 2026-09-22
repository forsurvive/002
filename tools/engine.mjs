// 호출 하나를 만드는 자리 — 프롬프트를 고르고, 구획을 채우고, 클로드를 부르고, 결과를 문서에 넣는다.
// 자동 집필과 손 작업이 모두 이 문을 지난다.

import { BUILTIN } from './prompts.mjs';
import { buildSystem, buildUser, cleanResponse } from './assemble.mjs';
import { runClaudeCall } from './call.mjs';
import * as auth from './auth.mjs';
import * as cloud from './cloud.mjs';
import * as state from './state.mjs';
import * as model from './model.mjs';

// 그 자리의 프롬프트를 찾는 순서는 셋이다 —
//   ① 작가가 설정에서 고친 것  ② 비소설이라 즉석으로 지은 것  ③ 내장
// 칸 하나하나마다 이 순서로 고른다(이름만 고치고 작법은 그대로 두는 일이 되도록).
export function promptFor(project, code) {
  const mine = (project && project.prompts && project.prompts[code]) || null;
  const made = (project && project.agents && project.agents[code]) || null;
  const base = BUILTIN[code] || { code, name: '집필자', role: '글을 쓴다', task: '', craft: '' };
  const pick = (k) => {
    const a = mine && String(mine[k] || '').trim();
    if (a) return mine[k];
    const b = made && String(made[k] || '').trim();
    if (b) return made[k];
    return base[k] || '';
  };
  return { code, name: pick('name'), role: pick('role'), task: pick('task'), craft: pick('craft') };
}

// 화면이 보여 줄 한 자리의 지금 값과, 작가가 고친 자리인지 여부
export function promptView(project, code) {
  return {
    code,
    ...promptFor(project, code),
    edited: !!(project && project.prompts && project.prompts[code]),   // 작가가 고쳤다
    made: !!(project && project.agents && project.agents[code]),       // 프로젝트를 만들 때 지어졌다
  };
}

const asItem = (d) => ({ id: d.id, name: d.title, text: model.bodyOf(d) });

export function docsByIds(project, ids = []) {
  const out = [];
  for (const id of ids) {
    const d = model.findDoc(project, id);
    if (d) out.push(asItem(d));
  }
  return out;
}

// 확정본은 호출 직전에 다시 읽는다 — 그래야 도중에 켠 것이 다음 호출부터 들어간다.
export function finalDocs(project, { onlyIds = null } = {}) {
  return project.docs
    .filter((d) => d.isFinal && (!onlyIds || onlyIds.includes(d.id)))
    .map(asItem);
}

export function materialItems(project) {
  return (project.materials || []).map((m) => ({ id: m.id, name: m.name, text: m.text }));
}

// 참조 목록에는 문서 id 와 자료 id 가 섞여 들어올 수 있다. 자료는 «■ 자료» 구획으로 간다.
export const isMaterialId = (id) => String(id || '').startsWith('m_');

export function materialsByIds(project, ids = []) {
  const out = [];
  for (const id of ids) {
    const m = (project.materials || []).find((x) => x.id === id);
    if (m) out.push({ id: m.id, name: m.name, text: m.text });
  }
  return out;
}

/**
 * 호출 하나. 돌려주는 값: { ok, text, error }
 * refIds/targetIds 는 문서 id. finals 를 따로 넘기면 그것을 쓰고, 아니면 고른 참조 중 확정본을 옮긴다.
 */
export async function callOnce({
  pid, code, refIds = [], targetIds = [], agentIds = [], request = '', taskExtra = '',
  materials = false, allFinals = false, talk = [], prev = '', next = '',
  signal = null, noCount = null, finalFirst = false, keepSeat = false,
  extraTargets = [], modelPick = '',
}) {
  // 상점에 이었다면 구독이 살아 있어야 새로 부른다.
  // **잠기는 것은 여기뿐이다** — 읽기·내보내기·되짚기는 이 문을 지나지 않는다.
  // 잇지 않은 프로그램은 늘 통과한다(상점을 붙이기 전의 쓰임을 막지 않는다).
  const may = cloud.mayCall();
  if (!may.ok) return { ok: false, error: may.why, reason: 'sub' };

  const project = state.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  const pr = promptFor(project, code);

  // 참조에 섞여 온 자료를 갈라낸다 — 자료는 문서 자리가 아니라 «■ 자료» 구획에 선다.
  const pickedMats = materialsByIds(project, refIds.filter(isMaterialId));
  const docRefIds = refIds.filter((id) => !isMaterialId(id));

  // 한 문서는 한 구획에만 실린다.
  //  · 보통은 대상 > 확정본 > 참조 순서(합평할 원고가 확정본이어도 대상 자리에 남는다).
  //  · 모순 검사만 확정본 > 대상 > 참조 — 고른 문서 가운데 확정본이 있으면 그것이 기준이 되어야 한다.
  const finalsAll = allFinals ? finalDocs(project) : finalDocs(project, { onlyIds: [...docRefIds, ...targetIds] });
  const taken = new Set();
  let finals; let targets;
  // 고른 대상이 모두 확정본이면 기준으로 뺄 것이 없다 — 그때는 대상 자리에 그대로 둔다(구획이 사라지면 지시가 가리킬 곳이 없다).
  const allTargetsFinal = targetIds.length > 0 && targetIds.every((id) => finalsAll.some((d) => d.id === id));
  if (finalFirst && !allTargetsFinal) {
    finals = finalsAll;
    finals.forEach((d) => taken.add(d.id));
    targets = docsByIds(project, targetIds).filter((d) => !taken.has(d.id));
    targets.forEach((d) => taken.add(d.id));
  } else {
    targets = docsByIds(project, targetIds);
    targets.forEach((d) => taken.add(d.id));
    finals = finalsAll.filter((d) => !taken.has(d.id));
    finals.forEach((d) => taken.add(d.id));
  }
  const refs = docsByIds(project, docRefIds).filter((d) => !taken.has(d.id));
  // 문서가 아닌 것도 «대상» 자리에 설 수 있다(합평 모으기가 받는 여러 합평 같은 것).
  if (extraTargets.length) targets = [...targets, ...extraTargets];

  const task = [pr.task, taskExtra].filter((x) => String(x || '').trim()).join('\n');
  // 작가가 걸어 둔 사람들 — 있으면 이들이 «누가 쓰는가»를 대신한다.
  // keepSeat 이면 그 자리의 사람이 맨 앞에 그대로 남고 걸린 사람은 거기에 더해진다(논의 스레드).
  // 자리의 작법은 «■ 작법» 첫 덩이로 이미 실리므로 여기서는 이름과 역할만 세운다.
  const picked = model.agentsByIds(project, agentIds);
  const crew = keepSeat ? [{ id: '', name: pr.name, role: pr.role, craft: '', model: '' }, ...picked] : picked;
  // 쓸 모델 — 부르는 쪽이 못 박았으면 그것이 먼저다(작가가 «어느 모델로 모을지»를 고른 때).
  // 아니면 «제 모델을 정해 둔 첫 사람», 그도 없으면 프로젝트의 것.
  const bringsModel = picked.find((c) => String(c.model || '').trim());
  const useModel = String(modelPick || '').trim() || (bringsModel ? bringsModel.model : project.model);
  // 부르는 쪽이 따로 정하지 않았으면 작품에 걸어 둔 토글을 따른다.
  const nc = noCount == null ? project.noCount !== false : !!noCount;
  const systemPrompt = buildSystem({ prompt: pr, prev, next, crew, withFinalRule: finals.length > 0, withNoCount: nc });
  const prompt = buildUser({
    project,
    // 자동 집필의 자료 단계는 자료를 통째로, 손으로 여는 자리는 «고른 자료»만 싣는다.
    materials: materials ? materialItems(project) : pickedMats,
    refs, finals, targets, talk, request, task, noCount: nc,
  });

  const r = await runClaudeCall({ systemPrompt, prompt, mockKey: code, signal, model: useModel });
  // 사유(reason)와 한도(limit)를 떨어뜨리지 않는다 — 작업이 이것으로 «멈출까 실패할까»를 가른다.
  if (!r.ok) return { ok: false, error: r.error, reason: r.reason, limit: r.limit };
  const text = cleanResponse(r.text);
  if (!text) return { ok: false, error: '빈 응답', reason: 'empty', limit: r.limit };
  return { ok: true, text, usage: r.usage, limit: r.limit, authSource: r.authSource };
}

// 다시 부를 값이 있을 때만 다시 부른다.
// 전에는 사유를 몰라 한도 소진에도 한 번 더 불렀다 — 될 리 없는 호출에 구독을 두 번 태운 셈이다.
// 잠깐 밀린 것('rate')만 다시 부른다. 한도·로그인·크레딧·모델은 다시 불러도 같은 답이다.
export const RETRY_REASONS = new Set(['rate', 'other']);

export async function callWithRetry(args) {
  const first = await callOnce(args);
  if (first.ok) return first;
  if (args.signal && args.signal.aborted) return first;
  if (first.reason && !RETRY_REASONS.has(first.reason)) return first;
  return callOnce(args);
}

// 한도에 닿으면 죽이지 않고 물어본다(사용자 지시, 2026-09-22).
//
// 「구독 사용량을 모두 사용하고 나면 api로 전환할지, 클로드 크레딧을 구매해 이어갈지를 물어보는 기능」
//
// 고를 것 셋:
//   wait : 그 자리에서 다시 부른다. 풀렸으면 이어지고 아직이면 또 묻는다.
//          (크레딧을 사 오는 길도 이것이다 — 사 오면 구독으로 그냥 이어진다.)
//   api  : 담아 둔 API 키로 갈아탄다. **돈이 나가는 결정이므로 사람이 눌러야 한다.**
//   stop : 거기서 끝낸다.
//
// «그 자리에서» 다시 부르는 것이 값이다 — 합평회는 사람 수 + 1 번 부르는데,
// 가운데서 소진되어도 앞서 받은 합평들이 호출하는 쪽의 said[] 에 그대로 남는다.
// 물음을 기다리는 동안은 문지기에 갇혀 있으므로 헛돌지 않는다.
export async function callAsking(args, ctx) {
  for (;;) {
    const r = await callWithRetry(args);
    if (r.ok) return r;
    if (!String(r.reason || '').startsWith('quota')) return r;
    if (!ctx || typeof ctx.askLimit !== 'function') return r;
    const choice = await ctx.askLimit({
      reason: r.reason,
      resetsAt: (r.limit && r.limit.resetsAt) || 0,
    });
    // 키가 없으면 갈아탈 것이 없다 — 화면이 그 단추를 세우지 않지만 여기서도 한 번 더 본다.
    if (choice === 'api' && auth.canApi()) { auth.write({ mode: 'api' }); continue; }
    if (choice === 'api') continue;
    if (choice === 'wait') continue;
    return r;   // 세웠거나 답이 없다
  }
}

// ---------------------------------------------------------------- 손 작업

const KIND_CODE = { doc: 'F-UPDATE', check: 'F-CONTRA', review: 'F-REVIEW' };

// 갱신 — 문서·모순 검사·합평회가 모두 이 길을 쓴다.
// modelPick 은 작가가 «어느 모델로 모을지»를 고른 값(비어 있으면 평소대로).
export async function runUpdate(pid, docId, ctx, { modelPick = '' } = {}) {
  const project = state.get(pid);
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
    ? await runPanelReview(pid, d, agentIds, common, ctx)
    : await callAsking({ ...common, code: KIND_CODE[d.kind] || 'F-UPDATE', agentIds }, ctx);
  if (!r.ok) return r;
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };

  state.update(pid, (p) => { model.docWrite(p, docId, { body: r.text }); });
  if (ctx) ctx.addDoc(docId);
  return { ok: true };
}

// 합평회 — 걸린 사람마다 한 호출씩 제 합평을 내고, 마지막 한 호출이 그것들을 하나로 모은다.
async function runPanelReview(pid, d, agentIds, common, ctx) {
  const project = state.get(pid);
  const crew = model.agentsByIds(project, agentIds);
  if (crew.length < 2) return callAsking({ ...common, code: 'F-REVIEW', agentIds }, ctx);

  const said = [];
  for (const one of crew) {
    if (ctx && ctx.gate) await ctx.gate();
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    if (ctx) ctx.step(d.title + ' — ' + one.name);
    const r = await callAsking({ ...common, code: 'F-REVIEW', agentIds: [one.id] }, ctx);
    if (!r.ok) return r;
    said.push({ id: '', name: one.name + '의 합평', text: r.text });
  }

  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  if (ctx) ctx.step(d.title + ' — 모으기');
  // 모으는 자리에는 사람을 걸지 않는다 — 누구의 편도 들지 않아야 한다.
  return callAsking({ ...common, code: 'F-MERGE', agentIds: [], extraTargets: said }, ctx);
}

// 논의 한 마디 — 작가의 말을 얹고, 답을 받아 얹는다.
// text 가 null 이면 말은 이미 얹힌 것이다(과거 메시지를 고쳐 가지가 갈라진 자리).
export async function runTalk(pid, threadId, text, ctx, { modelPick = '' } = {}) {
  let askedId = null;
  if (text != null) {
    state.update(pid, (p) => {
      const m = model.threadAddMessage(p, threadId, 'user', text);
      if (m) askedId = m.id;
    });
    if (!askedId) return { ok: false, error: '스레드를 찾을 수 없습니다' };
  } else {
    const p0 = state.get(pid);
    const t0 = p0 && model.findThread(p0, threadId);
    if (!t0) return { ok: false, error: '스레드를 찾을 수 없습니다' };
    askedId = t0.headId;
  }

  const project = state.get(pid);
  const t = model.findThread(project, threadId);
  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  if (ctx) ctx.step(t.title);
  // 대화는 «물은 그 자리»까지만 싣는다(기다리는 동안 작가가 다른 가지로 옮겨 가도 흔들리지 않는다).
  const path = model.threadPath(t, askedId);
  const talk = path.map((m) => ({ name: m.role === 'user' ? '작가' : '너', text: m.text }));

  const r = await callAsking({
    pid, code: 'F-TALK', refIds: (t.refIds || []).slice(), agentIds: (t.agentIds || []).slice(), talk,
    keepSeat: true, modelPick, signal: ctx && ctx.signal,
  }, ctx);
  if (!r.ok) return r;
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  // 답은 «물은 그 말» 밑에 붙는다 — 기다리는 사이 머리가 옮겨 가도 엉뚱한 가지로 새지 않는다.
  // 그동안 작가가 다른 가지로 옮겨 갔으면 보던 자리를 빼앗지 않는다.
  state.update(pid, (p) => {
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
export async function runThreadDoc(pid, threadId, request, ctx, { modelPick = '' } = {}) {
  const project = state.get(pid);
  const t = project && model.findThread(project, threadId);
  if (!t) return { ok: false, error: '스레드를 찾을 수 없습니다' };
  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  if (ctx) ctx.step(t.title);
  const talk = model.threadPath(t).map((m) => ({ name: m.role === 'user' ? '작가' : '너', text: m.text }));

  const r = await callAsking({
    pid, code: 'F-THREADDOC', refIds: (t.refIds || []).slice(), agentIds: (t.agentIds || []).slice(), talk, request,
    keepSeat: true, modelPick, signal: ctx && ctx.signal,
  }, ctx);
  if (!r.ok) return r;
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };

  let docId = null;
  state.update(pid, (p) => {
    const d = model.docCreate(p, { title: t.title, body: r.text });
    docId = d.id;
  });
  if (ctx) ctx.addDoc(docId);
  return { ok: true, docId };
}
