// 내장 작법 프롬프트 — 본문은 prompts.data.json 에 있다(따옴표·역따옴표가 섞인 긴 산문이라 자료로 따로 뒀다).
// 프롬프트 한 종 = { code, name, role, task, craft }.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const raw = JSON.parse(readFileSync(join(HERE, 'prompts.data.json'), 'utf8'));

export const BUILTIN = {};
for (const p of raw.prompts || []) BUILTIN[p.code] = { code: p.code, name: p.name, role: p.role, task: p.task, craft: p.craft };

// 기획 문서를 쓰는 여덟 관점(소설 기준). 비소설이면 종류 판정 호출이 같은 자리를 다른 이름으로 채운다.
export const PERSPECTIVES = [
  '주인공 중심', '세계 중심', '갈등 중심', '관계 중심',
  '구조·형식 중심', '정서 중심', '주제 중심', '독자 경험 중심',
];

// 비소설일 때 프롬프트를 새로 짓는 자리들(순서 = 파이프라인 순서. 앞뒤 이름을 이 차례로 잇는다).
export const AGENT_SLOTS = [
  'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11',
  'S12', 'S14', 'S15', 'S17', 'S18A', 'S18B', 'S18C', 'F-REVIEW', 'F-CONTRA',
];

// 실제로 앞뒤에 서는 자리. AGENT_SLOTS 는 «프롬프트를 지을 자리 목록»일 뿐이라 차례가 아니다.
// 회차마다·판마다 달라지는 자리는 부르는 쪽이 따로 알려 준다.
export const NEIGHBORS = {
  S02: ['', 'S03'], S03: ['S02', 'S04'], S04: ['S03', 'S05'], S05: ['S04', 'S06'], S06: ['S05', 'S07'],
  S07: ['S06', 'S08'], S08: ['S07', 'S09'], S09: ['S08', 'S10'], S10: ['S09', 'S11'], S11: ['S10', 'S12'],
  S12: ['S11', 'F-REVIEW'], 'F-REVIEW': ['S12', 'S14'], S14: ['F-REVIEW', 'S15'], S15: ['S14', 'F-REVIEW'],
  S17: ['F-REVIEW', 'S18A'], S18A: ['S17', 'S18B'], S18B: ['S18A', 'S18C'], S18C: ['S18B', 'F-CONTRA'],
  'F-CONTRA': ['S18C', ''],
};

// 그 자리가 파이프라인에서 하는 일 — 프롬프트를 새로 지을 때 실어 보낸다.
export const SLOT_DUTY = {
  S02: '접수된 자료와 집필 기준·요청사항을 읽고, 이 작업에 쓸 수 있도록 갈라 정리한 문서를 쓴다. 뒤의 모든 자리가 자료 원문 대신 이 문서를 본다.',
  S03: '자료 분석을 바탕으로 이 작업이 딛고 설 바탕(소설이라면 세계관에 해당하는 것)을 정리하고 빈 곳을 채운다.',
  S04: '바탕 위에서 실제로 쓸 만한 재료만 골라 정리한다. 버린 것도 적는다.',
  S05: '한 가지 관점을 끝까지 밀어붙인 기획 문서를 쓴다. 관점마다 따로 불리며, 편끼리 뚜렷이 달라야 값이 있다.',
  S06: '여러 기획 가운데 요청사항과 기준에 맞는 하나를 고르고, 고른 기획의 전문을 그대로 옮겨 적은 뒤 이유를 덧붙인다.',
  S07: '선정된 기획에 맞추어 바탕 문서를 처음부터 다시 쓴다.',
  S08: '이 작업에 설 수 있는 인물(또는 그에 해당하는 구성 요소)을 넉넉히 확보한다.',
  S09: '처음부터 끝까지의 큰 줄기를 잡는다. 아직 회차로 나누지 않는다.',
  S10: '큰 줄기를 실제로 밀고 갈 주요 인물(또는 핵심 구성 요소)을 골라낸다.',
  S11: '주요 인물 각각을 한 문서 안에 이름마다 절로 나누어 설계한다. 목소리와 말의 본보기를 남긴다.',
  S12: '앞뒤와 인과가 끝까지 서 있는 상세한 설계를 쓴다.',
  S14: '합평 지적을 반영해 상세 설계를 처음부터 끝까지 다시 쓴다(고칠 곳 목록이 아니라 완결된 문서를 낸다).',
  S15: '전체를 회차로 나눈 계획을 쓴다. 회차마다 일어나는 일과 넘기는 것을 적는다.',
  S17: '합평 지적을 반영해 회차 계획을 처음부터 끝까지 다시 쓴다. 이 문서가 뒤의 모든 집필이 따르는 확정본이 된다.',
  S18A: '한 회차를 장면 단위로 나눈 집필 계획을 쓴다.',
  S18B: '각 장면을 문단으로 쪼개고 문단마다 담길 내용을 짧게 적는다. 본문이 아니라 본문의 설계도다.',
  S18C: '설계를 따라 그 회차의 완성된 본문을 쓴다.',
  'F-REVIEW': '주어진 원고·문서의 완성도를 합평한다. 고쳐 쓰는 이가 그대로 쓸 수 있을 만큼 구체적으로.',
  'F-CONTRA': '문서들 사이에서 서로 어긋나는 자리를 찾아 인용과 함께 보인다. 확정본이 있으면 그것이 기준이다.',
};

export function has(code) { return !!BUILTIN[code]; }
export const CODES = Object.keys(BUILTIN);

// 제어 호출 셋은 답의 «꼴»이 정해져 있어 프로그램이 읽는다 — 손대면 읽지 못하므로 고치는 목록에서 뺀다.
export const CONTROL_CODES = ['F-KIND', 'F-AGENT', 'F-COUNT'];
export const EDITABLE_CODES = CODES.filter((c) => !CONTROL_CODES.includes(c));
