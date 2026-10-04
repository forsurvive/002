// 비소설 대응 — 프로젝트 전용 에이전트를 즉석으로 짓는다(기획서 중요사항 하나).
// 본체(판정 · 짓기 · 자료 분석)는 core/generation/agents.mjs 로 옮겼다 — 온라인 worker 도 같은 일을 한다.
// 이 파일은 개인판이 그것을 쓰는 자리다: 내장 프롬프트(파일) · 저장(state) · 부르기(CLI)를 넣고, 같은 프로젝트를 두 벌로 짓지 않게 막는다.

import { BUILTIN, AGENT_SLOTS, SLOT_DUTY } from './prompts.mjs';
import { promptFor, callAsking, promptsMissing, slotModel, callModel } from './engine.mjs';
import * as state from './state.mjs';
import * as core from '../core/generation/agents.mjs';

export const CRAFT_MIN = core.CRAFT_MIN;
export const STUDY_TITLE = core.STUDY_TITLE;
export const readKind = core.readKind;
export const readAgent = (text, code) => core.readAgent(text, code, BUILTIN);
export const agentsReady = (project) => core.agentsReady(project, AGENT_SLOTS);

// 개인판이 넣는 것. 에이전트를 지을 때도 그 자리의 모델을 쓴다 — slotModel(project, 'F-KIND') || project.model · slotModel(now, 'F-AGENT') || now.model
const PROMPTS = { builtin: BUILTIN, slots: AGENT_SLOTS, duty: SLOT_DUTY, promptFor, slotModel };
const DEPS = {
  store: state,
  call: (args, ctx) => callAsking(args, ctx),
  raw: (input) => callModel(input),
  prompts: PROMPTS,
};

// 같은 프로젝트를 두 벌로 짓지 않는다(구독 사용량이 두 배로 나가고 나중 것이 앞 것을 덮는다).
// 이미 짓는 중이면 그 일이 끝나기를 기다렸다가 그 결과를 같이 쓴다.
const building = new Map();

/**
 * 프로젝트를 만든 직후 한 번. 준비가 끊겼으면 설정의 [에이전트 준비 다시]가 같은 문을 다시 지난다(이미 된 자리는 건너뛴다).
 * ctx 는 작업 맥락(step·signal). 돌려주는 값: { ok, fiction, kind, error }
 */
export async function prepareAgents(pid, ctx, request = '') {
  const project = state.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  // 판정·짓기는 callOnce 를 지나지 않고 곧장 부른다 — 그래서 같은 문을 여기서 한 번 더 본다.
  // 안 보면 새 프로젝트마다 빈 자리 프롬프트로 구독을 태우고, 비소설이면 그 빈 것을 작품에 지어 넣는다.
  const missing = promptsMissing();
  if (missing) return missing;
  if (building.has(pid)) {
    if (ctx) ctx.step('에이전트 준비');
    return building.get(pid);
  }
  const work = core.prepareAgents(DEPS, pid, ctx, request).finally(() => building.delete(pid));
  building.set(pid, work);
  return work;
}

export const runStudy = (pid, ctx, request = '') => core.runStudy(DEPS, pid, ctx, request);
