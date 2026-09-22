// 일꾼 아홉의 «일하는 법» — 본문은 자료 파일에 있다(따옴표·역따옴표가 섞인 긴 산문이라 따로 뒀다).
// 프롬프트 한 종 = { code, name, role, task, craft }.
//
// ── 두 곳에서 찾는다
//
//   ① tools/prompts.data.json   — 소스 판. 개발과 직접 받아 간 판이 이 길로 간다.
//   ② data/brain.json           — 상점이 열쇠와 함께 내려 준 것. 팔려 나간 판이 이 길로 간다.
//
// **파는 판에는 ①이 없다.** 이것이 베끼기에 대한 답이다 —
// 자바스크립트라 검사하는 줄은 고칠 수 있지만, 없는 글을 지어낼 수는 없다.
// 이 아홉이 없으면 소설도(내장을 그대로 쓰므로) 비소설도(짓는 일꾼이 이 안에 있으므로) 돌지 않는다.
//
// 자물쇠가 아니라 얼개다. 그리고 한 번 받아 두면 그대로 두므로
// **상점이 누워 있어도 작가는 쓴다** — 열쇠와 똑같은 유예를 받는다.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, writeJson } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const SRC_FILE = () => join(HERE, 'prompts.data.json');
export const BRAIN_FILE = () => join(DATA_DIR, 'brain.json');

export const BUILTIN = {};

function readRaw() {
  // 소스 곁에 있으면 그것이 먼저다 — 개발 중에 상점을 붙이지 않고도 돌아야 한다.
  try { return JSON.parse(readFileSync(SRC_FILE(), 'utf8')); } catch { /* 파는 판에는 없다 */ }
  try { return JSON.parse(readFileSync(BRAIN_FILE(), 'utf8')); } catch { /* 아직 안 받았다 */ }
  return null;
}

// 제자리에서 갈아 끼운다 — BUILTIN 을 이미 들고 있는 쪽이 다시 부르지 않아도 되게.
export function loadPrompts() {
  for (const k of Object.keys(BUILTIN)) delete BUILTIN[k];
  const raw = readRaw();
  for (const p of (raw && raw.prompts) || []) {
    BUILTIN[p.code] = { code: p.code, name: p.name, role: p.role, task: p.task, craft: p.craft };
  }
  return Object.keys(BUILTIN).length;
}

// 상점에서 받은 것을 적어 두고 곧바로 갈아 끼운다.
export function saveBrain(raw) {
  if (!raw || !Array.isArray(raw.prompts) || !raw.prompts.length) return 0;
  writeJson(BRAIN_FILE(), raw);
  return loadPrompts();
}

// 일할 줄을 아는가. 모르면 새 호출을 걸어도 아무것도 나오지 않는다.
export function haveBrain() { return Object.keys(BUILTIN).length > 0; }

loadPrompts();

// 프로그램이 부르는 집필 자리 일곱 — 자료 파일에는 이 일곱과 제어 둘, 모두 아홉만 있다.
export const EDITABLE_CODES = ['S02', 'F-UPDATE', 'F-TALK', 'F-THREADDOC', 'F-CONTRA', 'F-REVIEW', 'F-MERGE'];

// 답의 «꼴»이 정해져 있어 프로그램이 읽는 자리. 고칠 수는 있으나 꼴이 깨지면 그 작업만 실패한다.
export const CONTROL_CODES = ['F-KIND', 'F-AGENT'];

// 설정에서 열어 볼 수 있는 자리 — 짓는 자리와 제어 자리를 모두 본다(사용자 지시, 2026-09-20).
export const VIEW_CODES = [...EDITABLE_CODES, ...CONTROL_CODES];

// 비소설일 때 프롬프트를 새로 짓는 자리들 — 부르는 집필 자리 전부다(사용자 지시, 2026-09-20).
// 「이 프로젝트를 운영하고 프로그램을 쓰는 데 필요한 모든 에이전트의 기초를 다 닦아 놓는다.»
// 제어 둘(F-KIND·F-AGENT)은 짓지 않는다 — 짓는 쪽이 저를 다시 짓는 일이 되기 때문이다.
export const AGENT_SLOTS = [...EDITABLE_CODES];

// 그 자리가 하는 일 — 프롬프트를 새로 지을 때 실어 보낸다.
export const SLOT_DUTY = {
  S02: '접수된 자료와 집필 기준·요청사항을 읽고, 이 작업에 쓸 수 있도록 갈라 정리한 문서를 쓴다.',
  'F-UPDATE': '문서 하나의 본문을 통째로 새로 쓴다. 참조와 요청사항을 읽고, 대상이 이미 있으면 고쳐 쓰고 비어 있으면 처음부터 쓴다. 이 프로젝트에서 가장 자주 불리는 자리다.',
  'F-TALK': '작가와 주고받으며 생각을 여는 자리다. 문서를 지어 내밀지 않고 말 한 마디로 답한다. 짧게 쓴다.',
  'F-THREADDOC': '오간 말을 읽고 정해진 것과 아직 열려 있는 것을 갈라 담은 결론 문서를 쓴다. 대화록이 아니다.',
  'F-REVIEW': '주어진 원고·문서의 완성도를 합평한다. 고쳐 쓰는 이가 그대로 쓸 수 있을 만큼 구체적으로.',
  'F-CONTRA': '문서들 사이에서 서로 어긋나는 자리를 찾아 인용과 함께 보인다. 확정본이 있으면 그것이 기준이다.',
  'F-MERGE': '여러 사람이 따로 내놓은 합평을 읽고 하나의 합평 문서로 모은다. 새 지적을 보태지 않고, 엇갈리는 말은 갈린 까닭과 함께 세운다.',
};

