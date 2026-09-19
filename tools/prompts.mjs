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

// 프로그램이 실제로 부르는 집필 자리 — 자동 집필을 뺀 뒤 남은 여섯이다.
// (자료 파일에는 지난 파이프라인의 프롬프트가 그대로 남아 있다. 되살릴 날을 위해 지우지 않았다.)
export const EDITABLE_CODES = ['S02', 'F-UPDATE', 'F-TALK', 'F-THREADDOC', 'F-CONTRA', 'F-REVIEW', 'F-MERGE'];

// 답의 «꼴»이 정해져 있어 프로그램이 읽는 자리 — 손대면 읽지 못하므로 고치는 목록에서 뺀다.
export const CONTROL_CODES = ['F-KIND', 'F-AGENT'];

// 비소설일 때 프롬프트를 새로 짓는 자리들.
export const AGENT_SLOTS = ['S02', 'F-REVIEW', 'F-CONTRA', 'F-MERGE'];

// 그 자리가 하는 일 — 프롬프트를 새로 지을 때 실어 보낸다.
export const SLOT_DUTY = {
  S02: '접수된 자료와 집필 기준·요청사항을 읽고, 이 작업에 쓸 수 있도록 갈라 정리한 문서를 쓴다.',
  'F-REVIEW': '주어진 원고·문서의 완성도를 합평한다. 고쳐 쓰는 이가 그대로 쓸 수 있을 만큼 구체적으로.',
  'F-CONTRA': '문서들 사이에서 서로 어긋나는 자리를 찾아 인용과 함께 보인다. 확정본이 있으면 그것이 기준이다.',
  'F-MERGE': '여러 사람이 따로 내놓은 합평을 읽고 하나의 합평 문서로 모은다. 새 지적을 보태지 않고, 엇갈리는 말은 갈린 까닭과 함께 세운다.',
};

export function has(code) { return !!BUILTIN[code]; }
export const CODES = Object.keys(BUILTIN);
