// 여러 문서로 나눠 생성(사용자 지시 2026-10-14 — DESIGN §6-12). I/O 없음.
// 문서에 «여러 문서로»(multi)를 켜고 생성하면, 한 번의 호출이 결과를 여러 문서로 나눠 쓴다 — 문서마다 «@@@ 문서: 제목» 줄로 시작한다.
// 몇 개로 나눌지는 요청사항이 정했으면 따르고, 없으면 AI 가 내용을 보고 정한다.
// 나눈 문서는 그 문서와 같은 카테고리에 서고(그 문서의 partIds), 그 문서의 본문은 나눈 문서의 차례가 된다(앞 본문은 판으로 남는다).
// 다시 생성하면 나눈 문서들이 «대상»으로 실리고, 같은 제목은 그 문서의 새 판으로 · 새 제목은 새 문서로 선다. 빠진 문서는 지우지 않는다.

import * as model from '../domain/model.mjs';

export const PART_MAX = 30;
const MARK = /^[ \t>#*]*@@@\s*문서\s*[:：]\s*(.+?)\s*$/gm;

export const SPLIT_TASK = '이번 결과는 여러 문서로 나눠 쓴다. 몇 개의 문서로 나눌지는 요청사항이 정했으면 그대로 따르고, 정하지 않았으면 내용에 맞게 스스로 정한다(하나로 충분하면 하나).\n'
  + '문서마다 맨 앞에 «@@@ 문서: 제목» 한 줄을 두고 그 아래에 그 문서의 본문을 쓴다. 그 줄의 바깥에 다른 말을 붙이지 않는다.\n'
  + '«대상»에 이미 나눈 문서들이 있으면 같은 문서는 같은 제목을 지키며 고쳐 쓰고, 새로 나눌 것만 새 제목을 단다.';

// 응답을 문서들로 — 표가 하나도 없으면 빈 목록(부르는 쪽은 통째로 그 문서에 쓴다)
export function parseParts(text) {
  const t = String(text || '');
  const marks = [...t.matchAll(MARK)];
  if (!marks.length) return [];
  const out = [];
  const seen = new Map();
  for (let i = 0; i < marks.length && out.length < PART_MAX; i++) {
    const m = marks[i];
    const body = t.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : t.length).replace(/^\s*\n/, '').trim();
    let title = m[1].replace(/[*_«»"']/g, '').trim().slice(0, 80) || '문서';
    const n = (seen.get(title) || 0) + 1;
    seen.set(title, n);
    if (n > 1) title += ' (' + n + ')';
    out.push({ title, body });
  }
  return out;
}

// 그 문서의 본문 — 나눈 문서의 차례
export const indexBody = (titles) => '이 문서의 생성 결과는 아래 문서들에 나뉘어 있습니다.\n\n' + titles.map((t) => '- ' + t).join('\n');

// 나눈 문서를 세우거나 고친다(같은 제목은 새 판으로). 돌려주는 값: 손댄 문서 id 들(그 문서 포함)
export function applyParts(p, sourceId, parts) {
  const d = model.findDoc(p, sourceId);
  if (!d) return [];
  const had = (d.partIds || []).map((id) => model.findDoc(p, id)).filter(Boolean);
  const ids = [];
  for (const part of parts) {
    let x = had.find((h) => h.title === part.title && !ids.includes(h.id));
    if (x) model.docWrite(p, x.id, { body: part.body });
    else x = model.docCreate(p, { title: part.title, body: part.body, categoryId: d.categoryId || null });
    ids.push(x.id);
  }
  // 이번에 빠진 지난 문서도 목록에는 남긴다(지우지 않는다 — 다음 생성의 대상으로도 실린다)
  const keep = had.filter((h) => !ids.includes(h.id)).map((h) => h.id);
  d.partIds = [...ids, ...keep];
  model.docWrite(p, d.id, { body: indexBody(parts.map((x) => x.title)) });
  return [d.id, ...ids];
}

// 이번 생성의 대상 — 나눈 문서가 있으면 그것들, 없으면 그 문서의 본문(나눌 원고)
export function splitTargets(p, d) {
  const parts = (d.partIds || []).filter((id) => model.findDoc(p, id));
  return parts.length ? parts : String(d.body || '').trim() ? [d.id] : [];
}
