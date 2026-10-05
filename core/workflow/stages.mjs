// 단계형 작업 흐름 — 자유 문서 작업 «위에» 데이터로 얹는다(docs/WORKFLOW.md). I/O 없음.
// 단계의 결과는 보통 문서다(판 · 참조 · 확정본 · 합평 · 모순 검사가 그대로 된다). 단계는 그 문서에 «이 단계의 산출물»이라는 표를 달 뿐이다.
// 단계 상태는 프로젝트 덩어리의 p.stages 에 산다: { [단계 열쇠]: { status: 'draft'|'approved'|'skipped', docId, approvedAt, generatedAt } }
//   · 회차마다 하는 단계(장면 · 본문)의 열쇠는 'scenes#3' 꼴.
//   · 승인(approved) ≠ 확정본(isFinal). 승인할 때 확정본 켜기는 부르는 쪽이 고른 경우에만.
//   · 강제 순서가 아니다 — 앞 단계가 승인 전이어도 시작할 수 있다(알리기만 한다).
//   · 승인한 단계의 앞 단계 문서가 그 뒤에 바뀌면 «앞 단계가 바뀜» 표만 단다. 다시 만들지 않는다.

import * as model from '../domain/model.mjs';

export const STAGE_CATEGORY = '단계';
const OUTPUTS = ['input', 'document', 'revision', 'perEpisode', 'final'];

// 템플릿이 쓸 수 있는 꼴인가 — 틀린 곳을 모두 적는다(운영자가 고치도록)
export function validateTemplate(t) {
  const problems = [];
  if (!t || !Array.isArray(t.stages) || !t.stages.length) return { ok: false, problems: ['no stages'] };
  const keys = new Set();
  for (const s of t.stages) {
    if (!s.key || keys.has(s.key)) problems.push('stage key missing or duplicated: ' + s.key);
    keys.add(s.key);
    if (!OUTPUTS.includes(s.output)) problems.push(s.key + ': unknown output ' + s.output);
    if ((s.output === 'document' || s.output === 'perEpisode') && !s.doc) problems.push(s.key + ': doc title missing');
    if (s.output === 'revision' && !s.reviseOf) problems.push(s.key + ': reviseOf missing');
  }
  for (const s of t.stages) {
    for (const k of s.inputs || []) if (!keys.has(k)) problems.push(s.key + ': unknown input ' + k);
    if (s.reviseOf && !keys.has(s.reviseOf)) problems.push(s.key + ': unknown reviseOf ' + s.reviseOf);
  }
  return { ok: problems.length === 0, problems };
}

export const stageOf = (t, key) => (t.stages || []).find((s) => s.key === key) || null;
export const slotKey = (key, episode) => (episode ? key + '#' + Number(episode) : key);
const epOf = (slot) => { const i = String(slot).indexOf('#'); return i < 0 ? 0 : Number(String(slot).slice(i + 1)) || 0; };
const stateOf = (p, slot) => (p.stages && p.stages[slot]) || null;
const livingDoc = (p, id) => (id ? model.findDoc(p, id) : null);

export function docTitle(stage, episode) {
  return String(stage.doc || stage.title).replace(/\{n\}/g, String(episode || ''));
}

// 그 단계(회차)의 결과 문서 — 수정 단계는 «고치는 그 문서»
export function docOf(p, t, key, episode = 0) {
  const s = stageOf(t, key);
  if (!s) return null;
  if (s.output === 'revision') return docOf(p, t, s.reviseOf, 0);
  const st = stateOf(p, slotKey(key, s.output === 'perEpisode' ? episode : 0));
  if (st) return livingDoc(p, st.docId);
  // 아직 단계로 시작하지 않았어도 같은 이름의 문서가 있으면 그것이 이 단계의 문서다(«자료 분석»처럼 준비 작업이 먼저 만든 것 · 손으로 만든 것)
  if (s.output === 'document') return p.docs.find((x) => x.title === docTitle(s, 0) && !x.material) || null;
  return null;
}

// 이 단계에 추천하는 참조 — 앞 단계(inputs)의 결과 문서들. 회차 단계는 같은 회차의 앞 단계를 먼저 찾는다.
// 자료 분석처럼 자료를 통째로 읽는 단계는 자료 문서를 추천한다.
export function recommendRefs(p, t, key, episode = 0) {
  const s = stageOf(t, key);
  if (!s) return [];
  const out = [];
  const add = (d) => { if (d && !out.includes(d.id)) out.push(d.id); };
  for (const k of s.inputs || []) {
    const inp = stageOf(t, k);
    if (!inp) continue;
    if (inp.output === 'perEpisode') add(docOf(p, t, k, episode));
    else add(docOf(p, t, k, 0));
  }
  if (s.materials) for (const d of model.materialDocs(p)) add(d);
  // 수정 단계에서는 고치는 문서 자신이 «대상»이므로 참조에서 뺀다
  const self = s.output === 'revision' ? docOf(p, t, key) : null;
  return self ? out.filter((id) => id !== self.id) : out;
}

function inputDocs(p, t, s, episode) {
  const docs = [];
  for (const k of s.inputs || []) {
    const inp = stageOf(t, k);
    if (!inp) continue;
    const d = docOf(p, t, k, inp.output === 'perEpisode' ? episode : 0);
    if (d) docs.push(d);
  }
  return docs;
}

// 한 칸의 상태 — 'not_started' | 'draft' | 'approved' | 'skipped'
function statusOf(p, t, s, episode) {
  if (s.output === 'input') return (String((p.spec || {}).form || '').trim() && model.materialDocs(p).length) ? 'approved' : 'not_started';
  const st = stateOf(p, slotKey(s.key, s.output === 'perEpisode' ? episode : 0));
  if (!st) return s.output === 'document' && docOf(p, t, s.key, 0) ? 'draft' : 'not_started';
  if (st.status === 'skipped') return 'skipped';
  if (st.status === 'approved') return 'approved';
  return s.output === 'final' || docOf(p, t, s.key, episode) ? 'draft' : 'not_started';
}

/**
 * 화면이 그리는 단계 목록. opts.bodyOn — 본문 단계를 켰는가(기본 켬).
 * 각 칸: { key, n, title, output, optional, off, status, docId, docTitle, prevPending, upstreamChanged, refs, episodes? }
 */
export function view(p, t, { bodyOn = true } = {}) {
  const order = t.stages;
  return order.map((s, i) => {
    const off = !!s.optional && !bodyOn;
    const prev = order.slice(0, i).filter((x) => !(x.optional && !bodyOn) && x.output !== 'final');
    const prevPending = prev.some((x) => x.output !== 'perEpisode' && !['approved', 'skipped'].includes(statusOf(p, t, x, 0)));
    const one = (episode) => {
      const status = statusOf(p, t, s, episode);
      const d = docOf(p, t, s.key, episode);
      const st = stateOf(p, slotKey(s.key, s.output === 'perEpisode' ? episode : 0)) || {};
      // 승인한 뒤 앞 단계 문서가 바뀌었는가(문서가 마지막으로 손댄 시각으로 잰다)
      const changed = status === 'approved' && !!st.approvedAt && inputDocs(p, t, s, episode).some((x) => (x.updatedAt || 0) > st.approvedAt);
      return { status, docId: d ? d.id : '', docTitle: d ? d.title : (s.output === 'revision' ? '' : docTitle(s, episode)), upstreamChanged: changed };
    };
    const base = { key: s.key, n: s.n, title: s.title, output: s.output, optional: !!s.optional, off, prevPending };
    if (s.output !== 'perEpisode') return { ...base, ...one(0), refs: recommendRefs(p, t, s.key, 0) };
    // 회차 단계 — 손댄 회차들을 모아 보인다(몇 화까지 갈지는 회차 계획 문서가 정하고, 사람이 회차를 골라 시작한다)
    const eps = Object.keys(p.stages || {}).filter((k) => k.startsWith(s.key + '#')).map(epOf).filter(Boolean).sort((a, b) => a - b);
    const episodes = eps.map((e) => ({ episode: e, ...one(e), refs: recommendRefs(p, t, s.key, e) }));
    const done = episodes.filter((e) => e.status === 'approved').length;
    return { ...base, status: episodes.length ? (done === episodes.length ? 'approved' : 'draft') : 'not_started', docId: '', docTitle: '',
      upstreamChanged: episodes.some((e) => e.upstreamChanged), episodes, refs: [] };
  });
}

// 단계를 시작한다 — 결과 문서를 마련하고(없으면 «단계» 카테고리에 만든다), 고른 참조를 문서에 건다.
// 생성(AI 부르기)은 부르는 쪽이 작업으로 돌린다. 돌려주는 값: { ok, docId, slot } 또는 { ok:false, error }
export function startStage(p, t, key, { episode = 0, refIds = null, now = Date.now() } = {}) {
  const s = stageOf(t, key);
  if (!s) return { ok: false, error: '없는 단계입니다' };
  if (s.output === 'input' || s.output === 'final') return { ok: false, error: '이 단계는 만들 글이 없습니다' };
  const ep = s.output === 'perEpisode' ? Math.max(1, Number(episode) || 0) : 0;
  if (s.output === 'perEpisode' && !Number(episode)) return { ok: false, error: '몇 화인지 골라 주세요' };
  let d = docOf(p, t, key, ep);
  if (s.output === 'revision' && !d) return { ok: false, error: '고칠 문서가 아직 없습니다 — 앞 단계를 먼저 만들어 주세요' };
  if (!d) {
    let c = p.categories.find((x) => x.name === STAGE_CATEGORY);
    if (!c) c = model.categoryCreate(p, STAGE_CATEGORY);
    // 같은 이름의 문서가 이미 있으면(자료 분석처럼 준비 작업이 먼저 만든 것) 그것을 이 단계의 문서로 삼는다
    d = p.docs.find((x) => x.title === docTitle(s, ep) && !x.material) || model.docCreate(p, { title: docTitle(s, ep), categoryId: c.id });
  }
  if (Array.isArray(refIds)) model.docWrite(p, d.id, { refIds: refIds.filter((id) => id !== d.id && model.findDoc(p, id)) });
  const slot = slotKey(key, ep);
  p.stages = p.stages || {};
  // 수정 단계는 고치는 문서를 가리키되, 그 단계의 상태는 따로 둔다
  const prev = p.stages[slot] || {};
  p.stages[slot] = { ...prev, status: 'draft', docId: d.id, startedAt: now, approvedAt: 0 };
  return { ok: true, docId: d.id, slot };
}

// 생성이 끝났을 때 — 상태는 초안(사람의 검토를 기다린다)
export function markGenerated(p, slot, { now = Date.now() } = {}) {
  p.stages = p.stages || {};
  if (p.stages[slot]) p.stages[slot] = { ...p.stages[slot], status: 'draft', generatedAt: now };
}

// 승인 — 이 단계의 산출물로 인정. final 이면 확정본도 켠다(부르는 쪽이 사람에게 물어 고른 경우에만).
export function approveStage(p, t, key, { episode = 0, final = false, now = Date.now() } = {}) {
  const s = stageOf(t, key);
  if (!s) return { ok: false, error: '없는 단계입니다' };
  if (s.output === 'input') return { ok: false, error: '이 단계는 작품을 만들 때 끝납니다' };
  const ep = s.output === 'perEpisode' ? Number(episode) || 0 : 0;
  const slot = slotKey(key, ep);
  const d = docOf(p, t, key, ep);
  if (s.output !== 'final' && !d) return { ok: false, error: '아직 만든 글이 없습니다' };
  p.stages = p.stages || {};
  p.stages[slot] = { ...(p.stages[slot] || {}), status: 'approved', docId: d ? d.id : '', approvedAt: now };
  if (final && d) model.docSetFinal(p, d.id, true);
  return { ok: true };
}

export function reopenStage(p, t, key, { episode = 0 } = {}) {
  const s = stageOf(t, key);
  const slot = slotKey(key, s && s.output === 'perEpisode' ? episode : 0);
  if (!s || !p.stages || !p.stages[slot]) return { ok: false, error: '없는 단계입니다' };
  p.stages[slot] = { ...p.stages[slot], status: 'draft', approvedAt: 0 };
  return { ok: true };
}

export function skipStage(p, t, key, { on = true } = {}) {
  const s = stageOf(t, key);
  if (!s || s.output === 'input' || s.output === 'perEpisode') return { ok: false, error: '건너뛸 수 없는 단계입니다' };
  p.stages = p.stages || {};
  if (on) p.stages[key] = { ...(p.stages[key] || {}), status: 'skipped' };
  else if (p.stages[key]) p.stages[key] = { ...p.stages[key], status: p.stages[key].docId ? 'draft' : '' };
  if (!on && p.stages[key] && !p.stages[key].status) delete p.stages[key];
  return { ok: true };
}

// 생성에 쓸 «이번 단계에 할 일» — 회차 단계는 {n} 을 채운다
export function stageTask(stage, episode = 0) {
  return String(stage.task || '').replace(/\{n\}/g, String(episode || ''));
}

// ---------------------------------------------------------------- 고쳐 쓰기(관리 화면)
//
// 단계의 «기능»(이름 · 할 일 · 추천 참조 · 끌 수 있음)과 강의 카드 · 강사 메모를 덮어쓴다. 원문(설정 파일)은 그대로 남는다.
// 차례: 설정 파일 < 운영자(전체) < 기관 관리자(그 기관). 덮어쓴 칸만 바뀌고 나머지는 아래 층을 따른다.
// 열쇠(key) · 결과 꼴(output) · 고치는 문서(reviseOf) · 회차 여부는 고치지 못한다 — 바꾸면 이미 쌓인 단계 상태의 뜻이 바뀐다.
export const EDITABLE = ['title', 'task', 'inputs', 'optional', 'card', 'teachingNote', 'tier'];
// 단계의 기본 등급(온라인 — 화면 이름은 High Reasoning / Balanced / Fast). 실제 모델은 카탈로그가 정한다.
export const STAGE_TIERS = ['high_reasoning', 'balanced', 'fast'];

export function cleanOverride(t, key, o = {}) {
  const s = stageOf(t, key);
  if (!s) return null;
  const out = {};
  if (typeof o.title === 'string' && o.title.trim()) out.title = o.title.trim().slice(0, 60);
  if (typeof o.task === 'string') out.task = o.task.slice(0, 2000);
  if (Array.isArray(o.inputs)) {
    // 앞에 있는 단계만 추천 참조로 걸 수 있다(뒤 단계를 걸면 순환한다)
    const before = new Set(t.stages.filter((x) => x.n < s.n).map((x) => x.key));
    out.inputs = [...new Set(o.inputs.filter((k) => before.has(k)))];
  }
  if (typeof o.optional === 'boolean' && s.output !== 'input') out.optional = o.optional;
  if (o.card && typeof o.card === 'object') {
    out.card = {
      what: String(o.card.what || '').slice(0, 600),
      look: (Array.isArray(o.card.look) ? o.card.look : []).map((x) => String(x).slice(0, 200)).filter((x) => x.trim()).slice(0, 5),
      ask: String(o.card.ask || '').slice(0, 300),
    };
  }
  if (typeof o.teachingNote === 'string') out.teachingNote = o.teachingNote.slice(0, 1500);
  if (typeof o.tier === 'string' && STAGE_TIERS.includes(o.tier) && s.output !== 'input' && s.output !== 'final') out.tier = o.tier;
  return out;
}

// layers = [{ [stageKey]: override }, …] 아래에서 위로
export function applyOverrides(t, layers = []) {
  return {
    ...t,
    stages: t.stages.map((s) => {
      let out = { ...s };
      for (const layer of layers) {
        const o = layer && layer[s.key];
        if (!o) continue;
        for (const k of EDITABLE) if (o[k] !== undefined) out = { ...out, [k]: o[k] };
      }
      return out;
    }),
  };
}
