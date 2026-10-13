// 이야기 작품의 자동 실행(DESIGN.md §5-2, 사용자 결정 2026-10-13) — 걸음을 띄우고 끝난 걸음을 거두는 쪽.
// 무엇을 쓸지는 core/rail/story.mjs(순수)가 정한다. 여기는 «자동 실행» 카테고리에 문서를 세우고, 지금의 문서 생성 작업(update)을 레일 표를 달아 띄운다.
// 멈춤 · 되돌리기 · 호출 상한 · 다시 켰을 때 잇기는 tools/rail.mjs 가 전자책과 함께 맡는다(p.rail.kind = 'story').

import * as state from './state.mjs';
import * as jobs from './jobs.mjs';
import * as model from './model.mjs';
import { newId } from '../core/ids.mjs';
import { storyNext, storyProgress, cleanStorySettings, RAIL_CATEGORY, contraFound, lengthLine, withRailRequest } from '../core/rail/story.mjs';

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error) => ({ ok: false, error: String(error) });
const live = (j) => j && (j.status === 'running' || j.status === 'paused');

// 되돌리기가 레일의 셈을 되살릴 때 쓰는 것 — 쓴 걸음 · 문서 표 · 남은 소견
const keepOf = (r) => JSON.parse(JSON.stringify({ story: r.story || { docs: {}, done: [] }, notes: r.notes || [] }));
// 사람에게 알릴 끝 — 다 썼거나 · 멈춰서 사람을 기다리거나 · 실패했을 때(화면이 이 시각을 보고 한 번 알린다)
export const noticed = (r, extra = {}) => Object.assign(r, extra, { noticeAt: Date.now() });

// 시작할 수 있는가 — 작품 규격(형식)과 자료가 있어야 한다(사용자 지시 «작품 규격과 자료가 입력되지 않으면 자동실행은 시작되지 않는다»)
export function missing(p) {
  const miss = [];
  if (!String(((p && p.spec) || {}).form || '').trim()) miss.push('작품 규격(형식)');
  if (!model.materialDocs(p).length) miss.push('자료');
  return miss;
}

function fresh(settings) {
  return { kind: 'story', mode: 'auto', status: 'running', point: '', episode: 0, why: '', settings: cleanStorySettings(settings),
    calls: 0, story: { docs: {}, done: [] }, notes: [], steps: [], jobId: '', startedAt: Date.now(), endedAt: 0, noticeAt: 0 };
}

// 시작 · 이어 하기 · 처음부터(mode 'fresh' — 다 쓴 뒤 새로. 지난번 문서는 그대로 남는다)
export function start(pid, mode, settings = {}) {
  if (!['auto', 'fresh'].includes(mode)) return bad('이야기 작품의 자동 실행은 한 가지 진행입니다');
  const p = state.get(pid);
  const miss = missing(p);
  if (miss.length) return bad('자동 실행을 시작하려면 ' + miss.join(' · ') + '이 필요합니다');
  state.update(pid, (pr) => {
    const r = pr.rail && pr.rail.kind === 'story' ? pr.rail : null;
    if (r && (r.status === 'running' || r.status === 'waiting') && mode !== 'fresh') {
      r.settings = cleanStorySettings(settings, r.settings);
      if (r.status === 'waiting') Object.assign(r, { status: 'running', why: '' });
    } else if (r && mode !== 'fresh' && r.status !== 'done') {
      Object.assign(r, { status: 'running', why: '', point: '', endedAt: 0, settings: cleanStorySettings(settings, r.settings) });
    } else pr.rail = fresh(settings);
    // 자동 실행의 산출물은 모두 이 카테고리에(사용자 지시 — 시작하기 전에 세운다)
    if (!pr.categories.some((c) => c.name === RAIL_CATEGORY)) model.categoryCreate(pr, RAIL_CATEGORY);
  });
  return ok();
}

export function settings(pid, s = {}) {
  state.update(pid, (p) => { p.rail.settings = cleanStorySettings(s, p.rail.settings); });
  return ok();
}

// 다음 걸음 — tools/rail.mjs 의 tick 이 레일이 «진행 중»이고 레일 걸음 · 에이전트 구성이 돌지 않을 때 부른다
export function tick(pid) {
  const p = state.get(pid);
  const r = p.rail;
  const s = storyNext(p, r, { busy: (docId) => jobs.isTargetRunning(pid, docId) });
  if (s.do === 'wait') return;
  if (s.do === 'done') { state.update(pid, (pr) => noticed(pr.rail, { status: 'done', point: '', why: '', endedAt: Date.now() })); return; }
  if (s.do === 'stuck') { state.update(pid, (pr) => noticed(pr.rail, { status: 'waiting', point: '', why: s.why, jobId: '' })); return; }
  if (r.settings && r.settings.cap > 0 && (Number(r.calls) || 0) >= r.settings.cap) {
    state.update(pid, (pr) => noticed(pr.rail, { status: 'waiting', point: '', why: '호출 상한(' + r.settings.cap + ')에 닿았습니다 — 상한을 늘리고 이어 하기', jobId: '' }));
    return;
  }
  const got = launch(pid, s);
  if (!got.ok) state.update(pid, (pr) => noticed(pr.rail, { status: 'failed', why: got.error }));
}

// 걸음 하나 — 문서를 세우거나(지난번에 세워 둔 것이 있으면 그것) 다시 쓸 문서를 잡고, 문서 생성 작업을 띄운다.
// 걸음 기록에 «하기 직전»(본문 · 확정본 · 레일의 셈)을 남긴다 — 되돌리기(tools/rail.mjs)가 거꾸로 푼다
function launch(pid, s) {
  let docId = '';
  state.update(pid, (pr) => {
    const rr = pr.rail;
    rr.story = rr.story || { docs: {}, done: [] };
    const cat = pr.categories.find((c) => c.name === RAIL_CATEGORY) || model.categoryCreate(pr, RAIL_CATEGORY);
    let d = rr.story.docs[s.docKey] ? model.findDoc(pr, rr.story.docs[s.docKey]) : null;
    const step = { id: newId('s'), at: Date.now(), label: s.label, kind: s.mode === 'self' ? 'rewrite' : 'write', key: s.key,
      created: !d, prevBody: d ? String(d.body || '') : null, prevFinal: d ? !!d.isFinal : null, keep: keepOf(rr) };
    if (!d) {
      d = model.docCreate(pr, { title: s.title, kind: s.kind, categoryId: cat.id, request: s.request, refIds: s.refs, targetIds: s.targets,
        agentIds: s.agents, seatOff: s.agents.length > 0 });
      rr.story.docs[s.docKey] = d.id;
    } else if (s.mode === 'new') {
      // 지난번에 세웠지만 끝내지 못한 문서 — 그 사이 생긴 앞 문서까지 참조 · 대상을 다시 건다(요청사항 · 에이전트는 사람이 고쳤을 수 있으니 둔다)
      model.docWrite(pr, d.id, { refIds: s.refs, targetIds: s.targets });
    }
    step.docId = d.id;
    rr.steps = [...(rr.steps || []), step];
    docId = d.id;
  });
  const got = jobs.start(pid, { kind: 'update', title: s.title, targetId: docId, rail: true,
    params: { docId, modelPick: '', requestOnce: withRailRequest(((state.get(pid).rail || {}).settings || {}).request, s.once), extraRefIds: s.extraRefs || [], railTag: s.key, ...(s.final ? { railFinal: true } : {}), ...(s.check ? { railCheck: s.check } : {}) } });
  if (!got.ok) return got;
  state.update(pid, (pr) => Object.assign(pr.rail, { status: 'running', point: '', why: '', jobId: got.jobId }));
  return ok();
}

// 걸음이 끝났을 때 — 끝난 걸음을 적고, 걸음마다 따라 할 일을 한다
//   자료 분석 — 작품 규격의 분량이 비어 있으면 분석이 정한 «분량: …»을 옮겨 적는다(사용자 지시 «자율적으로 판단해서 지정한다»)
//   회차 계획 다시 — 확정본으로 켠다(뒤의 모든 집필 계획 · 모순 검사의 기준)
//   모순 검사 — 다시 쓸 횟수를 다 썼는데도 모순이 남으면 소견으로 남기고 넘어간다
export function after(pid, j) {
  const pa = j.params || {};
  const key = String(pa.railTag || '');
  if (!key) return;
  state.update(pid, (pr) => {
    const rr = pr.rail;
    rr.story = rr.story || { docs: {}, done: [] };
    if (!rr.story.done.includes(key)) rr.story.done.push(key);
    const d = model.findDoc(pr, pa.docId);
    const step = [...(rr.steps || [])].reverse().find((x) => x.key === key);
    if (key === 'analysis' && d && !String((pr.spec || {}).length || '').trim()) {
      const len = lengthLine(model.bodyOf(d));
      if (len) { if (step) step.prevLength = String((pr.spec || {}).length || ''); pr.spec = { ...(pr.spec || {}), length: len }; }
    }
    if (pa.railFinal && d) model.docSetFinal(pr, d.id, true);
    if (pa.railCheck && d && contraFound(model.bodyOf(d)) !== false && pa.railCheck.round >= ((rr.settings || {}).reruns || 0)) {
      rr.notes = [...(rr.notes || []), { at: Date.now(), point: 'check', text: pa.railCheck.range + ' — 다시 쓴 뒤에도 모순 검사가 짚은 것이 남았습니다(«' + d.title + '»)' }];
    }
  });
}

// 화면에 내려 줄 진행 표
export const progress = (p) => storyProgress(p, p.rail);
