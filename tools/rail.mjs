// 전자책 작품의 자동 실행(레일) — 반자동 · 완전 자동(DESIGN.md §5-1, 사용자 결정 2026-10-13).
// 레일은 단계 «위에» 얹은 순서다. 걸음마다 지금의 단계 작업(stage) 하나를 띄우고, 그 작업이 끝나면(jobs.onEnd) 다음을 정한다.
// 다음 걸음은 core/rail/next.mjs(순수)가 단계 상태 · 문서에서 그때그때 읽어 정한다 — 그래서 사람이 손으로 승인 · 다시 생성해도 따르고, 다시 켜도 잇는다.
// 반자동은 도장에서 멈춰 사람을 기다리고(작업을 붙잡지 않는다), 완전 자동은 편집장(judge 작업)이 판단한다.

import * as state from './state.mjs';
import * as jobs from './jobs.mjs';
import * as model from './model.mjs';
import * as wf from '../core/workflow/stages.mjs';
import { nextStep, POINTS, CRITERIA, revisionPlan, reviseRequest } from '../core/rail/next.mjs';
import { baseTemplate, templateKeyOf } from './workflow.mjs';

export const MODES = ['semi', 'auto'];
export const ON_FAIL = ['pass', 'stop'];
const DEFAULTS = { cap: 0, stopEachChapter: false, rounds: 2, onFail: 'pass', criteria: '' };
const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error) => ({ ok: false, error: String(error) });

const tplOf = (p) => (p && templateKeyOf(p) === 'ebook' ? baseTemplate('ebook') : null);
const live = (j) => j && (j.status === 'running' || j.status === 'paused');

function cleanSettings(s = {}, base = DEFAULTS) {
  const out = { ...DEFAULTS, ...base };
  if (s.cap !== undefined) out.cap = Math.max(0, Math.floor(Number(s.cap) || 0));
  if (s.stopEachChapter !== undefined) out.stopEachChapter = !!s.stopEachChapter;
  if (s.rounds !== undefined) out.rounds = Math.min(5, Math.max(0, Math.floor(Number(s.rounds) || 0)));
  if (s.onFail !== undefined && ON_FAIL.includes(s.onFail)) out.onFail = s.onFail;
  if (s.criteria !== undefined) out.criteria = String(s.criteria || '').slice(0, 4000);
  return out;
}

function fresh(mode, settings) {
  return { mode, status: 'running', point: '', episode: 0, why: '', settings: cleanSettings(settings), calls: 0, rounds: {}, revise: null,
    notes: [], wrote: [], acked: 0, unreviewed: false, jobId: '', verdict: null, startedAt: Date.now(), endedAt: 0 };
}

// 기다림으로 세운다 — point: 도장 열쇠 · 'chapter' · ''(상한 · 막힘)
const waitAt = (r, point, why = '', episode = 0) => Object.assign(r, { status: 'waiting', point, why, episode, jobId: '' });

// ---------------------------------------------------------------- 문(ops 가 부른다 — 개인판만)

export function start(pid, mode, settings = {}) {
  const p = state.get(pid);
  if (!p) return bad('프로젝트를 찾을 수 없습니다');
  if (!tplOf(p)) return bad('자동 실행은 전자책 작품에서만 됩니다');
  if (!MODES.includes(mode)) return bad('반자동 또는 완전 자동을 골라 주세요');
  state.update(pid, (pr) => {
    const r = pr.rail;
    // 도는 중 · 기다리는 중이면 진행 방식과 설정만 바꾼다(센 것 · 소견은 그대로) — 끝났거나 멈췄으면 새로 시작한다(쓴 글은 그대로, 레일은 단계에서 다시 읽는다)
    if (r && (r.status === 'running' || r.status === 'waiting')) Object.assign(r, { mode, settings: cleanSettings(settings, r.settings) });
    else pr.rail = { ...fresh(mode, settings), calls: r ? r.calls || 0 : 0, notes: r ? r.notes || [] : [] };
    if (pr.rail.status === 'waiting' && pr.rail.point !== 'chapter' && mode === 'auto') pr.rail.status = 'running';   // 완전 자동으로 바꾸면 기다리던 도장을 편집장이 맡는다
  });
  tick(pid);
  return ok();
}

// 멈춤 — 지금 걸음은 끝까지 두고, 그 뒤로 잇지 않는다(그 자리부터 완전 수동)
export function stop(pid) {
  const r = (state.get(pid) || {}).rail;
  if (!r) return bad('자동 실행이 없습니다');
  state.update(pid, (p) => Object.assign(p.rail, { status: 'stopped', why: '', endedAt: Date.now() }));
  return ok();
}

export function resume(pid) {
  const r = (state.get(pid) || {}).rail;
  if (!r) return bad('자동 실행이 없습니다');
  if (r.status === 'running') return ok();
  state.update(pid, (p) => Object.assign(p.rail, { status: 'running', why: '', point: '', endedAt: 0 }));
  tick(pid);
  return ok();
}

export function settings(pid, s = {}) {
  const r = (state.get(pid) || {}).rail;
  if (!r) return bad('자동 실행이 없습니다');
  state.update(pid, (p) => {
    p.rail.settings = cleanSettings(s, p.rail.settings);
    if (s.mode !== undefined && MODES.includes(s.mode)) p.rail.mode = s.mode;
  });
  // 상한을 늘렸거나 «장마다 멈춤»을 껐으면 기다리던 자리에서 다시 따져 본다
  const now = state.get(pid).rail;
  if (now.status === 'waiting' && (now.point === '' || now.point === 'chapter' || now.mode === 'auto')) resume(pid);
  return ok();
}

// 반자동의 [승인] — 기다리던 도장을 사람이 승인한다(도장 ① 은 확정본으로도 — 화면이 기본 켬). 장마다 멈춤이면 [다음 장으로]와 같다
export function approve(pid, { final = false } = {}) {
  const p = state.get(pid);
  const r = p && p.rail;
  if (!r || r.status !== 'waiting') return bad('승인을 기다리는 자리가 없습니다');
  if (r.point === 'chapter') return next(pid);
  if (!POINTS[r.point]) return resume(pid);
  const t = tplOf(p);
  let out = null;
  state.update(pid, (pr) => {
    out = wf.approveStage(pr, t, r.point, { final: !!final, by: '' });
    if (out.ok && r.point === 'finish') pr.rail.unreviewed = false;
  });
  if (!out || !out.ok) return bad((out && out.error) || '승인하지 못했습니다');
  return resume(pid);
}

// 반자동의 [수정 요청] — 기다리던 걸음을 그 한 줄을 이번 요청사항으로 실어 새 판으로 다시 만든다 → 다시 기다린다
export function revise(pid, text) {
  const p = state.get(pid);
  const r = p && p.rail;
  const say = String(text || '').trim();
  if (!r || r.status !== 'waiting' || !POINTS[r.point]) return bad('수정을 요청할 자리가 없습니다');
  if (!say) return bad('필수 항목 누락 — 수정 요청');
  if (r.point === 'finish') return bad('완성은 고칠 문서가 하나가 아닙니다 — 문서를 열어 고친 뒤 승인하세요');
  const point = r.point;   // 아래 state.update 가 같은 물건(p.rail)의 point 를 비운다 — 먼저 쥔다
  const got = launchStage(pid, point, 0, { requestOnce: say, tag: 'fix:' + point });
  return got.ok ? ok() : got;   // 띄우지 못했으면 기다리던 자리 그대로(launchStage 가 상태를 바꾸지 않았다)
}

// 반자동 «장마다 멈춤»의 [다음 장으로]
export function next(pid) {
  const r = (state.get(pid) || {}).rail;
  if (!r || r.status !== 'waiting' || r.point !== 'chapter') return bad('기다리는 장이 없습니다');
  state.update(pid, (p) => Object.assign(p.rail, { acked: Math.max(Number(p.rail.acked) || 0, Number(r.episode) || 0) }));
  return resume(pid);
}

// 사람이 단계 창에서 손으로 승인 · 승인 풀기 · 건너뛰기를 했을 때 — 기다리던 도장이 풀렸으면 잇는다. 완성을 사람이 승인하면 «사람 검토 전»을 걷는다
export function poke(pid) {
  const p = state.get(pid);
  const r = p && p.rail;
  if (!r) return;
  const t = tplOf(p);
  const fin = t && wf.view(p, t).find((x) => x.key === 'finish');
  if (r.unreviewed && fin && fin.status === 'approved' && !String(fin.approvedBy || '').startsWith('agent:')) state.update(pid, (pr) => { pr.rail.unreviewed = false; });
  if (r.status === 'waiting' && POINTS[r.point]) {
    const row = t && wf.view(p, t).find((x) => x.key === r.point);
    if (row && (row.status === 'approved' || row.status === 'skipped')) resume(pid);
  }
}

// 레일 작업의 호출 수를 센다(호출 상한 — 구독이라 돈이 아니라 호출 수). 서버가 부르기 자리에서 부른다
export function countCall(ctx) {
  if (!ctx || !ctx.pid || !ctx.jobId) return;
  const p = state.get(ctx.pid);
  const j = p && p.rail && p.jobs.find((x) => x.id === ctx.jobId);
  if (j && j.rail) state.update(ctx.pid, (pr) => { pr.rail.calls = (Number(pr.rail.calls) || 0) + 1; });
}

// 다시 켰을 때 — «진행 중»이던 레일을 그 자리에서 잇는다(끊긴 걸음 작업은 jobs.healStale 이 먼저 다시 띄운다)
export function boot() {
  for (const x of state.list()) {
    const p = state.get(x.id);
    if (p && p.rail && p.rail.status === 'running') tick(x.id);
  }
}

// 첫 화면 카드 — 승인을 기다리는가
export const waiting = (pid) => { const p = state.get(pid); return !!(p && p.rail && p.rail.status === 'waiting'); };

// ---------------------------------------------------------------- 작업이 끝날 때(jobs.onEnd)

export function onJobEnd(pid, id) {
  const p = state.get(pid);
  const r = p && p.rail;
  if (!r) return;
  const j = p.jobs.find((x) => x.id === id);
  if (id === r.jobId) {
    // 레일이 띄운 걸음을 사람이 지웠거나 중지했으면 레일도 선다(지운 걸음을 다시 띄우지 않는다)
    if (!j || j.status === 'stopped') { if (r.status === 'running') state.update(pid, (pr) => Object.assign(pr.rail, { status: 'stopped', jobId: '', why: '' })); return; }
    if (j.status === 'failed') { state.update(pid, (pr) => Object.assign(pr.rail, { status: 'failed', jobId: '', why: j.error || '걸음이 실패했습니다' })); return; }
    if (j.status === 'done') {
      const tag = String((j.params && j.params.railTag) || '');
      state.update(pid, (pr) => {
        const rr = pr.rail;
        rr.jobId = '';
        let m = tag.match(/^write:chapters#(\d+)$/);
        if (m && !rr.wrote.includes(Number(m[1]))) rr.wrote.push(Number(m[1]));
        m = tag.match(/^revise:(\d+)@(\d+)$/);
        if (m) {
          if (!rr.revise || rr.revise.at !== Number(m[2])) rr.revise = { at: Number(m[2]), done: [] };
          if (!rr.revise.done.includes(Number(m[1]))) rr.revise.done.push(Number(m[1]));
        }
      });
      if (j.kind === 'judge') { applyVerdict(pid); return; }
    }
  }
  tick(pid);
}

// 편집장의 판단을 적용한다 — 승인 · 다시 생성(지점마다 회차 상한) · 상한을 넘으면 소견으로 넘김 또는 멈춤
function applyVerdict(pid) {
  const p = state.get(pid);
  const r = p.rail;
  const t = tplOf(p);
  const v = r.verdict;
  const key = v && v.point;
  if (r.status !== 'running') return;
  if (!v || !POINTS[key] || !v.decision) {
    state.update(pid, (pr) => { waitAt(pr.rail, key && POINTS[key] ? key : '', '편집장의 판단을 읽지 못했습니다 — «판정 기록»을 보고 승인하거나 수정을 요청하세요'); pr.rail.verdict = null; });
    return;
  }
  const used = Number((r.rounds || {})[key]) || 0;
  const canFix = v.decision === 'revise' && key !== 'finish' && used < r.settings.rounds;
  if (canFix) {
    state.update(pid, (pr) => { pr.rail.rounds = { ...(pr.rail.rounds || {}), [key]: used + 1 }; pr.rail.verdict = null; });
    const got = launchStage(pid, key, 0, { requestOnce: v.request || v.reasons || '편집장의 판단을 따라 고친다', tag: 'fix:' + key });
    if (!got.ok) state.update(pid, (pr) => Object.assign(pr.rail, { status: 'failed', why: got.error }));
    return;
  }
  if (v.decision === 'revise' && r.settings.onFail === 'stop') {
    state.update(pid, (pr) => { waitAt(pr.rail, key, '편집장이 기준을 통과시키지 못했습니다 — «판정 기록»을 보고 고치거나 승인하세요'); pr.rail.verdict = null; });
    return;
  }
  // 승인 — 또는 회차를 다 써서 «남은 소견을 적고 넘어간다»(기본). 에이전트 승인은 approvedBy = agent:… 로 사람 승인과 갈린다
  state.update(pid, (pr) => {
    const rr = pr.rail;
    if (v.decision === 'revise') rr.notes = [...(rr.notes || []), { at: Date.now(), point: key, text: String(v.request || v.reasons || '').slice(0, 4000) }];
    wf.approveStage(pr, t, key, { final: key === 'design', by: v.by });
    if (key === 'finish') rr.unreviewed = true;
    rr.verdict = null;
  });
  tick(pid);
}

// ---------------------------------------------------------------- 다음 걸음

function capHit(r) { return r.settings && r.settings.cap > 0 && (Number(r.calls) || 0) >= r.settings.cap; }

export function tick(pid) {
  const p = state.get(pid);
  const r = p && p.rail;
  if (!r || r.status !== 'running') return;
  const t = tplOf(p);
  if (!t) { state.update(pid, (pr) => Object.assign(pr.rail, { status: 'failed', why: '전자책 단계를 읽지 못했습니다' })); return; }
  // 레일이 띄운 걸음 · 책을 만들 때 도는 준비(자료 분석)가 아직 돌면 그것이 끝나기를 기다린다(끝나면 onJobEnd 가 다시 부른다)
  if (p.jobs.some((j) => live(j) && (j.rail || j.kind === 'agents'))) return;
  const s = nextStep(p, t, r, { busy: (docId) => jobs.isTargetRunning(pid, docId) });
  if (s.do === 'wait') return;
  if (s.do === 'done') { state.update(pid, (pr) => Object.assign(pr.rail, { status: 'done', point: '', why: '', endedAt: Date.now() })); return; }
  if (s.do === 'stuck') { state.update(pid, (pr) => waitAt(pr.rail, '', s.why)); return; }
  if (s.do === 'chapter') { state.update(pid, (pr) => waitAt(pr.rail, 'chapter', '', s.episode)); return; }
  // 반자동의 도장은 부르지 않으므로 상한과 무관하다 — 상한은 호출을 띄우기 직전에만 본다
  if (s.do === 'point' && r.mode === 'semi') { state.update(pid, (pr) => waitAt(pr.rail, s.key)); return; }
  if (capHit(r)) { state.update(pid, (pr) => waitAt(pr.rail, '', '호출 상한(' + r.settings.cap + ')에 닿았습니다 — 상한을 늘리고 이어 하기')); return; }
  if (s.do === 'point') {
    const got = launchJudge(pid, s.key);
    if (!got.ok) state.update(pid, (pr) => Object.assign(pr.rail, { status: 'failed', why: got.error }));
    return;
  }
  if (s.do === 'run') {
    const opts = s.why === 'revise'
      ? { requestOnce: reviseRequest(s.episode, revisionPlan(model.bodyOf(wf.docOf(p, t, 'review', 0)))), tag: 'revise:' + s.episode + '@' + (s.planAt || 0), withReview: true }
      : { tag: 'write:' + s.key + (s.episode ? '#' + s.episode : '') };
    const got = launchStage(pid, s.key, s.episode, opts);
    if (!got.ok) state.update(pid, (pr) => Object.assign(pr.rail, { status: 'failed', why: got.error }));
  }
}

// 걸음 하나를 띄운다 — 단계 문서를 마련하고(stage.start 와 같은 길) 단계 작업을 레일 표를 달아 띄운다.
// 참조: 문서에 이미 걸린 것이 있으면 그대로(사람이 고른 것을 덮지 않는다), 없으면 앞 단계의 추천 + 앞 장(장 집필) — 개정은 전권 검토를 더한다
function launchStage(pid, key, episode = 0, { requestOnce = '', tag = '', withReview = false } = {}) {
  const p = state.get(pid);
  const t = tplOf(p);
  const s = t && wf.stageOf(t, key);
  if (!s) return bad('없는 단계입니다');
  const had = wf.docOf(p, t, key, episode);
  let refIds = null;
  if (!had || !(had.refIds || []).length) {
    refIds = wf.recommendRefs(p, t, key, episode);
    const prev = key === 'chapters' && episode > 1 ? wf.docOf(p, t, 'chapters', episode - 1) : null;
    if (prev && !refIds.includes(prev.id)) refIds.push(prev.id);
  }
  if (withReview) {
    const rv = wf.docOf(p, t, 'review', 0);
    const base = refIds || (had ? had.refIds.slice() : []);
    if (rv && !base.includes(rv.id)) base.push(rv.id);
    refIds = base;
  }
  let made = null;
  state.update(pid, (pr) => { made = wf.startStage(pr, t, key, { episode, refIds }); });
  if (!made || !made.ok) return bad((made && made.error) || '시작하지 못했습니다');
  const d = model.findDoc(state.get(pid), made.docId);
  const got = jobs.start(pid, { kind: 'stage', title: d ? d.title : s.title, targetId: made.docId, rail: true,
    params: { stageKey: key, episode, requestOnce, modelPick: '', railTag: tag } });
  if (!got.ok) return got;
  state.update(pid, (pr) => Object.assign(pr.rail, { status: 'running', point: '', why: '', jobId: got.jobId }));
  return ok();
}

// 편집장 판단을 띄운다 — 대상 · 참조 · 기준을 정해 매개변수로 넘긴다(작업 기록에 남아 다시 켜도 같은 판단을 다시 부른다)
function launchJudge(pid, key) {
  const p = state.get(pid);
  const t = tplOf(p);
  const doc = (k, ep = 0) => wf.docOf(p, t, k, ep);
  const ids = (...ds) => ds.filter(Boolean).map((d) => d.id);
  let targetIds;
  if (key === 'finish') {
    const eps = (wf.view(p, t).find((x) => x.key === 'chapters') || {}).episodes || [];
    targetIds = [...ids(doc('preface')), ...eps.map((e) => e.docId).filter(Boolean)];
  } else targetIds = ids(doc(key));
  const refIds = key === 'design' ? ids(doc('study'))
    : key === 'toc' ? ids(doc('design'), doc('study'))
      : key === 'review' ? ids(doc('design'), doc('toc'))
        : ids(doc('design'), doc('toc'), doc('review'));
  if (!targetIds.length) return bad('판단할 문서가 없습니다');
  const criteria = '이 지점의 기준: ' + CRITERIA[key] + (String(p.rail.settings.criteria || '').trim() ? '\n\n작가가 덧붙인 기준: ' + p.rail.settings.criteria.trim() : '');
  const agentIds = model.agentsByIds(p, ((p.positions || {})['E-JUDGE']) || []).map((a) => a.id);
  const got = jobs.start(pid, { kind: 'judge', title: '편집장 — ' + POINTS[key], targetId: targetIds[0], rail: true,
    params: { point: key, targetIds, refIds, agentIds, criteria } });
  if (!got.ok) return got;
  state.update(pid, (pr) => Object.assign(pr.rail, { status: 'running', point: '', why: '', jobId: got.jobId, verdict: null }));
  return ok();
}

// 화면에 내려 줄 꼴 — 판단 원문(verdict) · 작업 id 는 빼고
export function view(r) {
  if (!r) return null;
  const { verdict, jobId, ...rest } = r;
  return { ...rest, pointName: POINTS[r.point] || '' };
}

// 포지션에 사람을 앉힌다(빈 목록이면 내린다) — 그 템플릿의 포지션 · 이 작품의 에이전트만
export function seat(pid, position, agentIds = []) {
  const p = state.get(pid);
  const t = tplOf(p);
  if (!t) return bad('포지션은 전자책 작품에만 있습니다');
  if (!(t.positions || []).some((x) => x.key === position)) return bad('없는 포지션입니다');
  const ids = [...new Set((Array.isArray(agentIds) ? agentIds : []).filter((id) => model.findAgent(p, id)))];
  state.update(pid, (pr) => {
    pr.positions = { ...(pr.positions || {}) };
    if (ids.length) pr.positions[position] = ids; else delete pr.positions[position];
  });
  return ok();
}
