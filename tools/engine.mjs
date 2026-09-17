// 호출 하나를 만드는 자리 — 프롬프트를 고르고, 구획을 채우고, 클로드를 부르고, 결과를 문서에 넣는다.
// 자동 집필과 손 작업이 모두 이 문을 지난다.

import { BUILTIN } from './prompts.mjs';
import { buildSystem, buildUser, cleanResponse } from './assemble.mjs';
import { runClaudeCall } from './call.mjs';
import * as state from './state.mjs';
import * as model from './model.mjs';

// 그 단계의 프롬프트: 프로젝트 생성본이 있으면 그것, 없으면 내장. 찾는 순서는 이 둘뿐이다.
export function promptFor(project, code) {
  const made = project && project.agents && project.agents[code];
  if (made && made.craft) return { code, name: made.name, role: made.role, task: made.task, craft: made.craft };
  return BUILTIN[code] || { code, name: '집필자', role: '글을 쓴다', task: '', craft: '' };
}

const asItem = (d) => ({ id: d.id, name: d.title, text: d.body });

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

/**
 * 호출 하나. 돌려주는 값: { ok, text, error }
 * refIds/targetIds 는 문서 id. finals 를 따로 넘기면 그것을 쓰고, 아니면 고른 참조 중 확정본을 옮긴다.
 */
export async function callOnce({
  pid, code, refIds = [], targetIds = [], request = '', taskExtra = '',
  materials = false, allFinals = false, talk = [], prev = '', next = '',
  signal = null, noCount = true, finalFirst = false,
}) {
  const project = state.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  const pr = promptFor(project, code);

  // 한 문서는 한 구획에만 실린다.
  //  · 보통은 대상 > 확정본 > 참조 순서(합평할 원고가 확정본이어도 대상 자리에 남는다).
  //  · 모순 검사만 확정본 > 대상 > 참조 — 고른 문서 가운데 확정본이 있으면 그것이 기준이 되어야 한다.
  const finalsAll = allFinals ? finalDocs(project) : finalDocs(project, { onlyIds: [...refIds, ...targetIds] });
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
  const refs = docsByIds(project, refIds).filter((d) => !taken.has(d.id));

  const task = [pr.task, taskExtra].filter((x) => String(x || '').trim()).join('\n');
  const systemPrompt = buildSystem({ prompt: pr, prev, next, withFinalRule: finals.length > 0, withNoCount: noCount });
  const prompt = buildUser({
    project,
    materials: materials ? materialItems(project) : [],
    refs, finals, targets, talk, request, task, noCount,
  });

  const r = await runClaudeCall({ systemPrompt, prompt, mockKey: code, signal });
  if (!r.ok) return { ok: false, error: r.error };
  const text = cleanResponse(r.text);
  if (!text) return { ok: false, error: '빈 응답' };
  return { ok: true, text, usage: r.usage };
}

// 실패하면 한 번만 다시 부른다. 두 번째도 실패하면 그대로 실패다(지어내지 않는다).
export async function callWithRetry(args) {
  const first = await callOnce(args);
  if (first.ok) return first;
  if (args.signal && args.signal.aborted) return first;
  return callOnce(args);
}

// ---------------------------------------------------------------- 손 작업

const KIND_CODE = { doc: 'F-UPDATE', check: 'F-CONTRA', review: 'F-REVIEW' };

// 갱신 — 문서·모순 검사·합평회가 모두 이 길을 쓴다.
export async function runUpdate(pid, docId, ctx) {
  const project = state.get(pid);
  const d = project && model.findDoc(project, docId);
  if (!d) return { ok: false, error: '문서를 찾을 수 없습니다' };
  if (ctx) ctx.step(d.title);

  const targetIds = d.kind === 'doc'
    ? (d.body.trim() ? [d.id] : [])
    : (d.targetIds || []).slice();
  const refIds = (d.refIds || []).filter((id) => id !== d.id);

  const r = await callWithRetry({
    pid, code: KIND_CODE[d.kind] || 'F-UPDATE',
    refIds, targetIds, request: d.request || '',
    finalFirst: d.kind === 'check',
    signal: ctx && ctx.signal,
  });
  if (!r.ok) return r;
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };

  state.update(pid, (p) => { model.docWrite(p, docId, { body: r.text }); });
  if (ctx) ctx.addDoc(docId);
  return { ok: true };
}

// 논의 한 마디 — 작가의 말을 얹고, 답을 받아 얹는다.
// text 가 null 이면 말은 이미 얹힌 것이다(과거 메시지를 고쳐 가지가 갈라진 자리).
export async function runTalk(pid, threadId, text, ctx) {
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
  if (ctx) ctx.step(t.title);
  // 대화는 «물은 그 자리»까지만 싣는다(기다리는 동안 작가가 다른 가지로 옮겨 가도 흔들리지 않는다).
  const path = model.threadPath(t, askedId);
  const talk = path.map((m) => ({ name: m.role === 'user' ? '작가' : '너', text: m.text }));

  const r = await callWithRetry({
    pid, code: 'F-TALK', refIds: (t.refIds || []).slice(), talk,
    signal: ctx && ctx.signal,
  });
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
export async function runThreadDoc(pid, threadId, request, ctx) {
  const project = state.get(pid);
  const t = project && model.findThread(project, threadId);
  if (!t) return { ok: false, error: '스레드를 찾을 수 없습니다' };
  if (ctx) ctx.step(t.title);
  const talk = model.threadPath(t).map((m) => ({ name: m.role === 'user' ? '작가' : '너', text: m.text }));

  const r = await callWithRetry({
    pid, code: 'F-THREADDOC', refIds: (t.refIds || []).slice(), talk, request,
    signal: ctx && ctx.signal,
  });
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
