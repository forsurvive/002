// 호출 하나의 «계획» — 무엇을 어느 구획에 싣고, 누가 쓰고, 어느 모델로 부르는가.
// 부르지는 않는다(I/O 없음). 부르는 것은 바깥(개인판: engine.callOnce → CLI, 온라인: worker → Provider)이 한다.
//
// tools/engine.mjs 의 callOnce 앞부분을 의미 그대로 옮겼다(온라인화 Phase 1 — Core 분리).
// 계획이 «실은 것의 목록»(inputs)을 함께 돌려주므로, 생성 기록이 «이 결과는 무엇을 보고 만들었나»를 남길 수 있다.

import { buildSystem, buildUser } from '../prompt/assemble.mjs';
import * as model from '../domain/model.mjs';

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

// 만들 때 넣은 자료 — 이제는 작업실 «자료» 카테고리의 문서다(지금 본문으로 읽는다).
// 에이전트 준비(종류 판정 · 짓기 · «자료 분석»)만 이것을 통째로 «■ 자료» 구획에 싣는다.
export function materialItems(project) {
  return model.materialDocs(project).map(asItem);
}

// 자료가 모델이 받을 수 있는 길이를 넘을 때(«입력이 너무 깁니다») — 자료마다 같은 비율로 앞부분을 남기고 줄였다는 표를 단다.
// max 가 0 이면 그대로. 자료 분석(S02)이 길이로 거절당했을 때만 줄인 예산으로 다시 부른다(core/generation/agents.mjs).
export function fitMaterials(items, max = 0) {
  const total = items.reduce((n, m) => n + String(m.text || '').length, 0);
  if (!(max > 0) || total <= max) return items;
  const ratio = max / total;
  return items.map((m) => {
    const t = String(m.text || '');
    const keep = Math.max(200, Math.floor(t.length * ratio));
    return t.length <= keep ? m : { ...m, text: t.slice(0, keep) + '\n\n…(자료가 길어 여기까지만 실었다 — 원문 ' + t.length.toLocaleString('en-US') + '자 중 ' + keep.toLocaleString('en-US') + '자)' };
  });
}

/**
 * pr 은 그 자리의 프롬프트(작가 고침 > 지은 것 > 내장을 이미 고른 것), slotModel 은 그 자리에 정해 둔 모델(없으면 '').
 * 돌려주는 값: { systemPrompt, userPrompt, model, modelSource, inputs }
 *   inputs = [{ role: 'material'|'final'|'target'|'reference'|'extra'|'talk', id, name, text }] — 실린 차례 그대로
 */
export function planCall(project, {
  refIds = [], targetIds = [], agentIds = [], request = '', taskExtra = '',
  materials = false, allFinals = false, talk = [], prev = '', next = '',
  noCount = null, finalFirst = false, keepSeat = false,
  extraTargets = [], modelPick = '', materialsMax = 0,
} = {}, { pr, slotModel = '' } = {}) {
  // 자료도 보통 문서다 — 참조로 걸면 참조로, 확정본이면 확정본으로 실린다.
  // 다만 에이전트 준비(materials)가 자료를 통째로 «■ 자료» 구획에 실을 때는 그 문서들을 다른 구획에 겹쳐 싣지 않는다.
  const mats = materials ? fitMaterials(materialItems(project), materialsMax) : [];
  const matIds = new Set(mats.map((m) => m.id));

  // 한 문서는 한 구획에만 실린다.
  //  · 보통은 대상 > 확정본 > 참조 순서(합평할 원고가 확정본이어도 대상 자리에 남는다).
  //  · 모순 검사만 확정본 > 대상 > 참조 — 고른 문서 가운데 확정본이 있으면 그것이 기준이 되어야 한다.
  const finalsAll = (allFinals ? finalDocs(project) : finalDocs(project, { onlyIds: [...refIds, ...targetIds] }))
    .filter((d) => !matIds.has(d.id));
  const taken = new Set(matIds);
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
  // 문서가 아닌 것도 «대상» 자리에 설 수 있다(합평 모으기가 받는 여러 합평 같은 것).
  const docTargets = targets;
  if (extraTargets.length) targets = [...targets, ...extraTargets];

  const task = [pr.task, taskExtra].filter((x) => String(x || '').trim()).join('\n');
  // 작가가 걸어 둔 사람들 — 있으면 이들이 «누가 쓰는가»를 대신한다.
  // keepSeat 이면 그 자리의 사람이 맨 앞에 그대로 남고 걸린 사람은 거기에 더해진다(논의 스레드).
  // 자리의 작법은 «■ 작법» 첫 덩이로 이미 실리므로 여기서는 이름과 역할만 세운다.
  const picked = model.agentsByIds(project, agentIds);
  const crew = keepSeat ? [{ id: '', name: pr.name, role: pr.role, craft: '', model: '' }, ...picked] : picked;
  // 쓸 모델 — 부르는 쪽이 못 박았으면 그것이 먼저다(작가가 «어느 모델로 모을지»를 고른 때).
  // 아니면 «제 모델을 정해 둔 첫 사람», 그다음 그 자리(지어진 에이전트)에 정해 둔 것, 그도 없으면 프로젝트의 것.
  const bringsModel = picked.find((c) => String(c.model || '').trim());
  const pick = String(modelPick || '').trim();
  const useModel = pick || (bringsModel ? bringsModel.model : '') || slotModel || project.model;
  const modelSource = pick ? 'pick' : bringsModel ? 'agent' : slotModel ? 'slot' : 'project';
  // 부르는 쪽이 따로 정하지 않았으면 작품에 걸어 둔 토글을 따른다.
  const nc = noCount == null ? project.noCount !== false : !!noCount;
  const systemPrompt = buildSystem({ prompt: pr, prev, next, crew, withFinalRule: finals.length > 0, withNoCount: nc });
  const userPrompt = buildUser({
    project,
    // 에이전트 준비만 자료를 통째로 싣는다. 손으로 여는 자리에서 고른 자료는 참조 · 확정본 구획으로 간다.
    materials: mats,
    refs, finals, targets, talk, request, task, noCount: nc,
  });

  // 실린 것의 목록 — buildUser 의 구획 차례(자료 → 참조 → 확정본 → 대상 → 대화)대로.
  const tag = (role) => (d) => ({ role, id: d.id || '', name: d.name, text: String(d.text || '') });
  const inputs = [
    ...mats.map(tag('material')), ...refs.map(tag('reference')), ...finals.map(tag('final')),
    ...docTargets.map(tag('target')), ...extraTargets.map(tag('extra')), ...talk.map(tag('talk')),
  ];
  return { systemPrompt, userPrompt, model: useModel, modelSource, inputs };
}
