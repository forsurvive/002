// 단계형 작업 흐름의 템플릿을 읽는 자리 — 설정 파일(config/workflows/<열쇠>.json)을 열쇠마다 한 번 읽어 둔다.
// 열쇠: story_creation(이야기 만들기 — 기본) · ebook(전자책 오토, docs/EBOOK_EDITION.md). 작품이 쓰는 열쇠는 p.workflow.template(없으면 기본).
// 개인판은 기본 파일 그대로 쓰고, 온라인판은 그 위에 운영자 · 기관이 고쳐 쓴 것을 얹는다(online/workflow.mjs).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTemplate } from '../core/workflow/stages.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_KEYS = ['story_creation', 'ebook'];
export const DEFAULT_TEMPLATE = 'story_creation';
const fileOf = (key) => join(dirname(HERE), 'config', 'workflows', key + '.json');
export const TEMPLATE_FILE = fileOf(DEFAULT_TEMPLATE);

// 모르는 열쇠 · 읽지 못한 파일 · 꼴이 틀린 파일이면 null — 단계 기능이 서지 않을 뿐 작품은 그대로 열린다
const cached = new Map();
export function baseTemplate(key = DEFAULT_TEMPLATE) {
  if (!TEMPLATE_KEYS.includes(key)) return null;
  if (cached.has(key)) return cached.get(key);
  let t = null;
  try {
    const x = JSON.parse(readFileSync(fileOf(key), 'utf8'));
    t = validateTemplate(x).ok && x.key === key ? x : null;
  } catch { t = null; }
  cached.set(key, t);
  return t;
}

// 작품이 쓰는 템플릿의 열쇠 — 적혀 있지 않거나 모르는 값이면 기본(이야기 만들기 — 지금까지의 모든 작품)
export const templateKeyOf = (p) => {
  const k = p && p.workflow && p.workflow.template;
  return TEMPLATE_KEYS.includes(k) ? k : DEFAULT_TEMPLATE;
};
