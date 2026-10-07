// 작업 종류 표 — 작업은 «종류 + 매개변수»라는 데이터다(클로저가 아니다).
// 그래서 같은 작업을 개인판의 프로세스 안 실행기도, 온라인판의 worker 도(다른 프로세스에서, 재시작 뒤에도) 돌릴 수 있다.
//
// deps = { store, call, prepare }
//   store   : 저장(get/update) — 개인판 state.mjs, 온라인 PostgreSQL
//   call    : 한 번의 부르기(재시도 · 한도 물음 포함) — 개인판 engine.callAsking(CLI), 온라인 Provider
//   prepare : 에이전트 준비(종류 판정 · 자리 짓기 · 자료 분석) — 아직 개인판 agents.mjs 가 맡는다(Provider 단계에서 옮긴다)
// ctx = 작업 맥락(pid · step · gate · askLimit · addDoc · signal) — jobs.mjs 가 만든다.

import { runUpdate, runTalk, runThreadDoc, runStage } from './run.mjs';
import { fitting } from './fit.mjs';

const pick = (v) => String(v || '');

export const JOB_KINDS = {
  agents: (deps, ctx, p) => deps.prepare(ctx.pid, ctx, pick(p.request)),
  update: (deps, ctx, p) => runUpdate(deps, ctx.pid, p.docId, ctx, { modelPick: pick(p.modelPick) }),
  // text 가 null 이면 말은 이미 얹혀 있다(지난 말을 고쳐 가지를 낸 자리)
  // askedId 가 있으면 이미 저장된 그 말에 답한다(온라인판)
  talk: (deps, ctx, p) => runTalk(deps, ctx.pid, p.threadId, p.text == null ? null : String(p.text), ctx, { modelPick: pick(p.modelPick), askedId: pick(p.askedId) }),
  threaddoc: (deps, ctx, p) => runThreadDoc(deps, ctx.pid, p.threadId, pick(p.request), ctx, { modelPick: pick(p.modelPick) }),
  // 단계형 작업 흐름의 한 단계(docs/WORKFLOW.md) — deps.workflow 가 템플릿을 준다
  stage: (deps, ctx, p) => runStage(deps, ctx.pid, { stageKey: pick(p.stageKey), episode: Number(p.episode) || 0, requestOnce: pick(p.requestOnce), modelPick: pick(p.modelPick) }, ctx),
};

export const KIND_NAMES = Object.keys(JOB_KINDS);

export async function runKind(deps, kind, params, ctx) {
  const fn = JOB_KINDS[kind];
  if (!fn) return { ok: false, error: '모르는 작업 종류입니다: ' + kind };
  // 길이로 거절당하면 줄여서 다시(fit.mjs). 자료 분석(agents)은 제 자리에서 자료를 줄여 다시 부른다.
  const d = kind === 'agents' || !deps.call ? deps : { ...deps, call: fitting(deps.call) };
  return fn(d, ctx, params || {});
}
