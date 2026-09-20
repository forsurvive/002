'use strict';

// 작법서 — 프로젝트를 만들 때 문서로 함께 선다(사용자 지시, 2026-09-20).
//
// 프로그램이 «이야기 작법»을 프롬프트 안에 교리로 품지 않는다. 작법은 문서로 서고,
// 작가가 읽고 지우고, 쓰고 싶을 때만 참조로 건다.
//
// 본문은 프로젝트 파일에 베껴 담지 않는다 — 문서에는 «가리키는 이름»(src)만 두고
// 글은 tools/books/ 의 .txt 에서 읽는다. 그래서 프로젝트 파일이 굵어지지 않고,
// 1.5초마다 도는 갱신에도 한 글자 늘지 않는다. 본문이 살아나는 때는 세 곳뿐이다 —
// 프롬프트에 실릴 때, 화면에서 펼쳐 볼 때, 내려받을 때.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, 'books');

export const BOOK_CATEGORY = '작법서';

// 쪽 넘김 자리의 빈 줄이 길게 이어져 있다 — 읽을 수 있게 줄인다. 글자는 한 자도 고치지 않는다.
function tidy(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n').map((ln) => ln.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 이름 → 글. 모듈이 올라올 때 한 번 읽는다(프롬프트 자료와 같은 결).
const BOOKS = new Map();
try {
  for (const f of readdirSync(DIR).sort()) {
    if (extname(f).toLowerCase() !== '.txt') continue;
    const text = tidy(readFileSync(join(DIR, f), 'utf8'));
    if (text) BOOKS.set(basename(f, extname(f)), text);
  }
} catch { /* 폴더가 없으면 작법서 없이 돈다 */ }

// 프로젝트를 만들 때 세울 문서들 — [{ src, title, chars }]
export function bookList() {
  return [...BOOKS].map(([src, text]) => ({ src, title: src, chars: text.length }));
}

// 가리키는 글. 없으면 빈 글 — 파일을 치웠어도 프로그램이 서지 않는다.
export function bookText(src) {
  return BOOKS.get(String(src || '')) || '';
}

export function isBook(src) { return BOOKS.has(String(src || '')); }
