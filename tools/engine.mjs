// 호출 하나를 만드는 자리 — 프롬프트를 고르고, 구획을 채우고, 클로드를 부르고, 결과를 문서에 넣는다.
// 자동 집필과 손 작업이 모두 이 문을 지난다.

import { haveBrain } from './prompts.mjs';
import { cleanResponse, cleanPart } from './assemble.mjs';
import { planCall } from '../core/reference/plan.mjs';
import * as gen from '../core/generation/run.mjs';
import { localCliProvider } from '../ai/local-cli.mjs';
import { isProvider } from '../ai/provider.mjs';
import * as auth from './auth.mjs';
import * as state from './state.mjs';

// 자리마다 프롬프트 · 모델을 고르는 셈은 tools/prompt-pick.mjs 로 옮겼다(온라인 서버가 CLI 없이 쓴다) — 이름은 그대로 내보낸다.
export { promptFor, slotModel, promptView } from './prompt-pick.mjs';
import { promptFor, slotModel } from './prompt-pick.mjs';

// 참조 조립(무엇을 어느 구획에 싣나)은 core/reference/plan.mjs 로 옮겼다 — 지금까지의 이름도 그대로 내보낸다.
export { docsByIds, finalDocs, materialItems } from '../core/reference/plan.mjs';

// 부르는 자리 — Provider 계약(ai/provider.mjs)을 지키는 것 하나. 개인판은 CLI(구독/API 키)를 쓴다.
// 온라인판 · 시험은 다른 Provider 를 꽂을 수 있다. 모든 호출(갱신 · 논의 · 합평 · 준비)이 이 한 자리를 지난다.
let generator = localCliProvider;
export function useGenerator(p) { generator = isProvider(p) ? p : localCliProvider; }

// 한 번 부르기 — code 는 그 자리의 이름(모의 응답과 기록이 쓴다).
export function callModel({ systemPrompt, prompt, code = '', signal = null, model = '' }) {
  return generator.generate({ model, systemPrompt, userPrompt: prompt, signal, metadata: { code } });
}

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
  extraTargets = [], modelPick = '', digests = null, reading = null, targetPart = null, continueFrom = null,
}) {
  // **막히는 것은 새 호출뿐이다** — 읽기·내보내기·되짚기는 이 문을 지나지 않는다.
  const missing = promptsMissing();
  if (missing) return missing;

  const project = state.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  // 무엇을 어느 구획에 싣고 어느 모델로 부를지는 Core 의 계획이 정한다(core/reference/plan.mjs).
  const plan = planCall(project, {
    refIds, targetIds, agentIds, request, taskExtra, materials, allFinals, talk, prev, next,
    noCount, finalFirst, keepSeat, extraTargets, modelPick, digests, reading, targetPart, continueFrom,
  }, { pr: promptFor(project, code), slotModel: slotModel(project, code) });

  const r = await callModel({ systemPrompt: plan.systemPrompt, prompt: plan.userPrompt, code, signal, model: plan.model });
  // 사유(reason)와 한도(limit)를 떨어뜨리지 않는다 — 작업이 이것으로 «멈출까 실패할까»를 가른다.
  if (!r.ok) return { ok: false, error: r.error, reason: r.reason, limit: r.limit };
  // 이어 쓴 조각은 다듬지 않는다(잇는 자리) · 길이 한도에 닿은 응답은 끝을 다듬지 않는다(core/generation/continue.mjs)
  const text = continueFrom ? cleanPart(r.text) : cleanResponse(r.text, { keepEnd: r.finishReason === 'length' });
  if (!text.trim()) return { ok: false, error: '빈 응답', reason: 'empty', limit: r.limit };
  // planned — 무엇을 보고 만들었나(본문은 빼고 이름·길이만). 생성 기록(generation_runs)의 재료다.
  const planned = { model: plan.model, modelSource: plan.modelSource, inputs: plan.inputs.map(({ role, id, name, text: t }) => ({ role, id, name, chars: t.length })) };
  return { ok: true, text, usage: r.usage, costUsd: r.costUsd, limit: r.limit, authSource: r.authSource, planned, finishReason: r.finishReason || 'stop' };
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

// 실행 본체는 core/generation/run.mjs 에 있다. 개인판은 저장으로 state.mjs 를, 호출로 callAsking(CLI · 한도 물음)을 넣는다.
export const LOCAL = { store: state, call: (args, ctx) => callAsking(args, ctx) };

export const runUpdate = (pid, docId, ctx, opts) => gen.runUpdate(LOCAL, pid, docId, ctx, opts);
export const runTalk = (pid, threadId, text, ctx, opts) => gen.runTalk(LOCAL, pid, threadId, text, ctx, opts);
export const runThreadDoc = (pid, threadId, request, ctx, opts) => gen.runThreadDoc(LOCAL, pid, threadId, request, ctx, opts);
