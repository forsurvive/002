// 완전 자동의 편집장 판단 — 작업 종류 `judge`(core/generation/kinds.mjs). DESIGN.md §5-1.
// 도장(승인 지점)의 산출물을 그 지점의 기준과 책의 설계에 비추어 «승인 | 수정»으로 판단하고, 판단을 «판정 기록» 문서에 쌓는다.
// 무엇을 할지(승인 · 다시 생성 · 소견으로 넘김)는 레일(tools/rail.mjs)이 p.rail.verdict 를 읽어 정한다 — 여기는 판단과 기록뿐이다.

import * as model from '../domain/model.mjs';
import { STAGE_CATEGORY } from '../workflow/stages.mjs';
import { POINTS, readJudgement } from './next.mjs';

export const JUDGE_CODE = 'E-JUDGE';
export const LOG_TITLE = '판정 기록';

const format = (point) => '이번에 판단할 지점은 «' + (POINTS[point] || point) + '»이다. 대상 문서를 이번 요청사항의 기준과 책의 설계(헌장)에 비추어 판단한다.\n'
  + '답의 맨 첫 줄은 «판정: 승인» 또는 «판정: 수정» 한 줄이다. 그 아래 «까닭:» 구획에 기준마다 지켜졌는지와 그렇게 본 대상의 대목을 적는다.\n'
  + '«수정»이면 맨 끝에 «수정 요청:» 구획을 두고, 그 단계를 다시 쓸 사람이 그대로 따를 수 있는 한 단락을 적는다. 기준에 없는 취향으로 되돌리지 않는다.';

// params = { point, targetIds, refIds, agentIds, criteria } — 레일이 정해 넘긴다(작업 기록에 데이터로 남아 다시 켜도 같은 판단을 다시 부른다)
export async function runJudge({ store, call }, pid, params = {}, ctx) {
  const point = String(params.point || '');
  const agentIds = Array.isArray(params.agentIds) ? params.agentIds.slice() : [];
  if (ctx) ctx.step('편집장 판단 — ' + (POINTS[point] || point));
  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  // 앉힌 사람이 있으면 그 사람이 편집장 자리를 대신한다(keepSeat 끔) — 없으면 내장 편집장(tools/prompts.ebook.json)
  const ask = (more) => call({
    pid, code: JUDGE_CODE, targetIds: (params.targetIds || []).slice(), refIds: (params.refIds || []).slice(), agentIds,
    keepSeat: !agentIds.length, request: String(params.criteria || '') + more, taskExtra: format(point), signal: ctx && ctx.signal,
  }, ctx);
  let r = await ask('');
  if (!r.ok) return r;
  let v = readJudgement(r.text);
  if (!v.decision) {
    // 꼴이 어긋나면 한 번 더 묻는다 — 그래도면 판단 없음(레일이 멈추고 사람을 부른다)
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    r = await ask('\n\n답의 맨 첫 줄을 반드시 «판정: 승인» 또는 «판정: 수정»으로 시작한다.');
    if (!r.ok) return r;
    v = readJudgement(r.text);
  }
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  const by = 'agent:' + (agentIds[0] || JUDGE_CODE);
  let logId = '';
  await store.update(pid, (p) => {
    // «판정 기록» — 단계 카테고리의 문서 하나. 판단마다 끝에 덧붙여 새 판이 쌓인다(앞 판은 이력에)
    let log = p.docs.find((d) => d.title === LOG_TITLE && !d.material);
    if (!log) {
      let c = p.categories.find((x) => x.name === STAGE_CATEGORY);
      if (!c) c = model.categoryCreate(p, STAGE_CATEGORY);
      log = model.docCreate(p, { title: LOG_TITLE, categoryId: c.id });
    }
    const head = '## ' + (POINTS[point] || point) + ' — ' + (v.decision === 'approve' ? '승인' : v.decision === 'revise' ? '수정' : '판단 없음') + ' · ' + by;
    model.docWrite(p, log.id, { body: [String(log.body || '').trim(), head + '\n\n' + String(r.text || '').trim()].filter(Boolean).join('\n\n---\n\n') });
    logId = log.id;
    if (p.rail) p.rail.verdict = { point, decision: v.decision, reasons: v.reasons, request: v.request, by, at: Date.now() };
  });
  if (ctx && logId) ctx.addDoc(logId);
  return { ok: true, decision: v.decision };
}
