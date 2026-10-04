// 호출 하나를 만드는 자리 — 프롬프트를 고르고, 구획을 채우고, 클로드를 부르고, 결과를 문서에 넣는다.
// 자동 집필과 손 작업이 모두 이 문을 지난다.

import { BUILTIN, haveBrain } from './prompts.mjs';
import { cleanResponse } from './assemble.mjs';
import { planCall } from '../core/reference/plan.mjs';
import { runClaudeCall } from './call.mjs';
import * as auth from './auth.mjs';
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

// 그 자리에 정해 둔 모델 — 없으면 빈 값(작품의 모델을 따른다). 프롬프트 고치기와는 따로 둔다:
// 모델만 바꾼 자리가 «고침»으로 보이거나, [되돌리기] 가 모델까지 걷어 가지 않게.
export function slotModel(project, code) {
  return String((project && project.slotModels && project.slotModels[code]) || '');
}

// 화면이 보여 줄 한 자리의 지금 값과, 작가가 고친 자리인지 여부
export function promptView(project, code) {
  return {
    code,
    ...promptFor(project, code),
    model: slotModel(project, code),                                    // 비었으면 작품의 모델
    edited: !!(project && project.prompts && project.prompts[code]),   // 작가가 고쳤다
    made: !!(project && project.agents && project.agents[code]),       // 프로젝트를 만들 때 지어졌다
  };
}

// 참조 조립(무엇을 어느 구획에 싣나)은 core/reference/plan.mjs 로 옮겼다 — 지금까지의 이름도 그대로 내보낸다.
export { docsByIds, finalDocs, materialItems } from '../core/reference/plan.mjs';

// 일하는 법(tools/prompts.data.json)을 읽지 못했으면 부르지 않는다.
// 그 파일 없이 부르면 구독만 태우고 빈 자리로 쓴 글이 나온다 — 폴더를 옮기다 빠뜨린 때가 그렇다.
// **부르는 문마다 이 하나를 본다** — callOnce 도, 그 문을 지나지 않고 곧장 부르는 에이전트 준비도.
// 막을 까닭이 없으면 null, 있으면 그대로 돌려줄 실패 한 벌.
export function promptsMissing() {
  if (haveBrain()) return null;
  return { ok: false, error: '내장 프롬프트를 읽지 못했습니다 — 폴더를 통째로 다시 옮겨 주십시오', reason: 'prompts' };
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
  // **막히는 것은 새 호출뿐이다** — 읽기·내보내기·되짚기는 이 문을 지나지 않는다.
  const missing = promptsMissing();
  if (missing) return missing;

  const project = state.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  // 무엇을 어느 구획에 싣고 어느 모델로 부를지는 Core 의 계획이 정한다(core/reference/plan.mjs).
  const plan = planCall(project, {
    refIds, targetIds, agentIds, request, taskExtra, materials, allFinals, talk, prev, next,
    noCount, finalFirst, keepSeat, extraTargets, modelPick,
  }, { pr: promptFor(project, code), slotModel: slotModel(project, code) });

  const r = await runClaudeCall({ systemPrompt: plan.systemPrompt, prompt: plan.userPrompt, mockKey: code, signal, model: plan.model });
  // 사유(reason)와 한도(limit)를 떨어뜨리지 않는다 — 작업이 이것으로 «멈출까 실패할까»를 가른다.
  if (!r.ok) return { ok: false, error: r.error, reason: r.reason, limit: r.limit };
  const text = cleanResponse(r.text);
  if (!text) return { ok: false, error: '빈 응답', reason: 'empty', limit: r.limit };
  // planned — 무엇을 보고 만들었나(본문은 빼고 이름·길이만). 생성 기록(generation_runs)의 재료다.
  const planned = { model: plan.model, modelSource: plan.modelSource, inputs: plan.inputs.map(({ role, id, name, text: t }) => ({ role, id, name, chars: t.length })) };
  return { ok: true, text, usage: r.usage, limit: r.limit, authSource: r.authSource, planned };
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
