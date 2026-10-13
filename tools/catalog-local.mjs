// 개인판이 읽는 모델 카탈로그 — config/models.json 한 곳(실제 model id 는 여기에만 — CLAUDE.md 원칙 4).
// 지금은 Gemini API 키 길(설정 › 무엇으로 › Gemini API 키)이 등급 → model id 를 바꾸는 데만 쓴다. 못 읽으면 빈 카탈로그(부르지 않고 까닭을 이른다).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatalog, TIERS } from '../ai/catalog.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CATALOG_FILE = join(dirname(HERE), 'config', 'models.json');

let cached = null;
export function localCatalog() {
  if (cached) return cached;
  let entries = [];
  try { entries = JSON.parse(readFileSync(CATALOG_FILE, 'utf8')).models || []; } catch { entries = []; }
  cached = createCatalog(entries);
  return cached;
}

// 화면에 보일 Gemini 고르기 — 등급마다 카탈로그의 표시 이름(model id 는 내려 주지 않는다)
export function geminiChoices() {
  const c = localCatalog();
  return Object.keys(TIERS).map((tier) => {
    const e = c.resolve('google', tier);
    return e ? { id: tier, name: e.displayName || TIERS[tier] } : null;
  }).filter(Boolean);
}
