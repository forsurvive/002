// 내장 작법 프롬프트 — 본문은 prompts.data.json 에 있다(따옴표·역따옴표가 섞인 긴 산문이라 자료로 따로 뒀다).
// 프롬프트 한 종 = { code, name, role, task, craft }.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const raw = JSON.parse(readFileSync(join(HERE, 'prompts.data.json'), 'utf8'));

export const BUILTIN = {};
for (const p of raw.prompts || []) BUILTIN[p.code] = { code: p.code, name: p.name, role: p.role, task: p.task, craft: p.craft };

// 프로그램이 부르는 집필 자리 일곱 — 자료 파일에는 이 일곱과 제어 둘, 모두 아홉만 있다.
export const EDITABLE_CODES = ['S02', 'F-UPDATE', 'F-TALK', 'F-THREADDOC', 'F-CONTRA', 'F-REVIEW', 'F-MERGE'];

// 답의 «꼴»이 정해져 있어 프로그램이 읽는 자리. 고칠 수는 있으나 꼴이 깨지면 그 작업만 실패한다.
export const CONTROL_CODES = ['F-KIND', 'F-AGENT'];

// 설정에서 열어 볼 수 있는 자리 — 짓는 자리와 제어 자리를 모두 본다(사용자 지시, 2026-09-20).
export const VIEW_CODES = [...EDITABLE_CODES, ...CONTROL_CODES];

// 비소설일 때 프롬프트를 새로 짓는 자리들.
export const AGENT_SLOTS = ['S02', 'F-REVIEW', 'F-CONTRA', 'F-MERGE'];

// 그 자리가 하는 일 — 프롬프트를 새로 지을 때 실어 보낸다.
export const SLOT_DUTY = {
  S02: '접수된 자료와 집필 기준·요청사항을 읽고, 이 작업에 쓸 수 있도록 갈라 정리한 문서를 쓴다.',
  'F-REVIEW': '주어진 원고·문서의 완성도를 합평한다. 고쳐 쓰는 이가 그대로 쓸 수 있을 만큼 구체적으로.',
  'F-CONTRA': '문서들 사이에서 서로 어긋나는 자리를 찾아 인용과 함께 보인다. 확정본이 있으면 그것이 기준이다.',
  'F-MERGE': '여러 사람이 따로 내놓은 합평을 읽고 하나의 합평 문서로 모은다. 새 지적을 보태지 않고, 엇갈리는 말은 갈린 까닭과 함께 세운다.',
};

