// 자리(작법 프롬프트)마다 지금 쓸 값을 고른다 — 작가가 고친 것 › 지어진 것 › 내장.
// 호출도 저장도 모른다. 개인판 엔진(tools/engine.mjs)과 문 표(tools/ops.mjs)가 함께 쓴다.

import { BUILTIN } from './prompts.mjs';

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
