// 요약하여 참조(사용자 지시 2026-10-13 — DESIGN §6-11).
// 문서의 «요약하여 참조»(sumRefIds)에 건 문서를 생성할 때마다 먼저 요약하고, 그 요약본을 참조 구획에 싣는다(id 'sum:<문서 id>').
// 요약본은 저장하지 않는다 — 문서도 판도 남기지 않고 이번 생성의 호출에만 실린다. 긴 문서는 조각마다 요약해 잇는다.
// 요약하는 호출은 그 문서를 쓰는 자리 · 사람 · 요청사항을 그대로 쓴다(나중에 할 일을 알아야 쓰일 것을 남긴다 — core/prompt/assemble.mjs 의 summaryTask).

import * as model from '../domain/model.mjs';
import { splitText } from './reading.mjs';

export const SUMMARY_PIECE = 60000;   // 한 번에 요약할 글자 수 — 넘으면 조각마다 요약해 잇는다
export const SUMMARY_MARK = ' (요약)';

// 이 문서가 요약하여 참조로 건 문서들 — 있고 · 자기 자신이 아니고 · 참조에도 걸리지 않은 것만
export function summaryDocs(project, d) {
  const refs = new Set(d.refIds || []);
  return (d.sumRefIds || []).filter((id) => id !== d.id && !refs.has(id)).map((id) => model.findDoc(project, id)).filter(Boolean);
}

/**
 * args — 본래의 호출에 쓸 것(pid · code · 참조 · 대상 · 요청사항 · 사람 …). 요약하는 호출은 거기에 summary 만 얹는다.
 * 돌려주는 값: { ok, refs: [{ id: 'sum:<문서 id>', name: '제목 (요약)', text }] } 또는 { ok: false, error }
 */
export async function summarizeRefs(call, project, d, args, ctx) {
  const out = [];
  for (const src of summaryDocs(project, d)) {
    const pieces = splitText(model.bodyOf(src), SUMMARY_PIECE);
    const said = [];
    for (let i = 0; i < pieces.length; i++) {
      if (!pieces[i].trim()) continue;
      if (ctx && ctx.gate) await ctx.gate();
      if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
      if (ctx) ctx.step('요약하여 참조 — ' + src.title + (pieces.length > 1 ? ' ' + (i + 1) + '/' + pieces.length : ''));
      const r = await call({ ...args, summary: { id: src.id, name: src.title, k: i + 1, n: pieces.length, text: pieces[i] } }, ctx);
      if (!r.ok) return r;
      said.push(String(r.text || '').trim());
    }
    out.push({ id: 'sum:' + src.id, name: src.title + SUMMARY_MARK, text: said.filter(Boolean).join('\n\n') });
  }
  return { ok: true, refs: out };
}
