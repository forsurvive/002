// 단계형 작업 흐름의 템플릿을 읽는 자리 — 설정 파일(config/workflows/story_creation.json)을 한 번 읽어 둔다.
// 개인판은 이 파일 그대로 쓰고, 온라인판은 그 위에 운영자 · 기관이 고쳐 쓴 것을 얹는다(online/workflow.mjs).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTemplate } from '../core/workflow/stages.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_FILE = join(dirname(HERE), 'config', 'workflows', 'story_creation.json');

let cached = null;
export function baseTemplate() {
  if (cached) return cached;
  try {
    const t = JSON.parse(readFileSync(TEMPLATE_FILE, 'utf8'));
    cached = validateTemplate(t).ok ? t : null;
  } catch { cached = null; }
  return cached;
}
