// 자동 집필 — 기획서의 스물한 걸음.
// 단계마다 «반드시 참조할 문서»가 정해져 있고(참조 행렬), 러너는 그 표대로만 싣는다.
// 러너가 스스로 켜는 확정본은 마지막 회차 계획 재작성 하나뿐이다.

import { BUILTIN, AGENT_SLOTS } from './prompts.mjs';
import { callWithRetry, promptFor } from './engine.mjs';
import { prepareAgents, perspectivesOf } from './agents.mjs';
import { buildSystem, buildUser, cleanResponse } from './assemble.mjs';
import { runClaudeCall } from './call.mjs';
import * as state from './state.mjs';
import * as model from './model.mjs';

export const EPISODE_CAP = 24;
export const AUTO_CATEGORY = '자동 실행';

// 작품 규격과 자료가 없으면 시작하지 않는다.
export function canStart(project) {
  if (!project) return { ok: false, error: '작품 규격과 자료 필요' };
  const sp = project.spec || {};
  const filled = String(project.name || '').trim() && String(sp.outline || '').trim() && String(sp.form || '').trim();
  if (!filled) return { ok: false, error: '작품 규격과 자료 필요' };
  if (!(project.materials || []).length) return { ok: false, error: '작품 규격과 자료 필요' };
  return { ok: true };
}

// 분량에 «N화» 가 **하나만** 적혀 있을 때만 그것을 회차 수로 본다.
// «1화당 5천 자, 모두 12화» 처럼 여럿이면 어느 쪽인지 지어내지 않고 물어본다.
export function specEpisodes(project) {
  const all = String((project.spec || {}).length || '').match(/(\d+)\s*화/g);
  if (!all || all.length !== 1) return null;
  const n = Number(all[0].match(/\d+/)[0]);
  return n >= 1 ? n : null;
}

// 앞뒤 이름은 «실제로 앞뒤에 선 자리»에서 온다. 합평·모순 검사처럼 여러 자리에서 불리는 것은 부르는 쪽이 알려 준다.
function neighborNames(project, code, prevCode, nextCode) {
  const nameOf = (c) => (c ? promptFor(project, c).name : '');
  if (prevCode || nextCode) return { prev: nameOf(prevCode), next: nameOf(nextCode) };
  const i = AGENT_SLOTS.indexOf(code);
  return { prev: nameOf(AGENT_SLOTS[i - 1]), next: nameOf(AGENT_SLOTS[i + 1]) };
}

export async function runAuto(pid, ctx) {
  const made = new Map();   // 단계 열쇠 → 문서 id
  const order = [];         // 이번 실행이 만든 문서 id, 만든 차례대로
  const stopped = () => ctx && ctx.signal && ctx.signal.aborted;

  const ids = (keys) => keys.map((k) => made.get(k)).filter(Boolean);

  // 단계 하나 = 호출 하나 = 문서 하나
  async function write(key, { code, title, refs = [], targets = [], taskExtra = '', materials = false, finalFirst = false, kind = 'doc', prevCode = '', nextCode = '' }) {
    if (stopped()) return { ok: false, error: '중지됨' };
    if (ctx) ctx.step(title);
    const project = state.get(pid);
    const { prev, next } = neighborNames(project, code, prevCode, nextCode);
    const r = await callWithRetry({
      pid, code,
      refIds: ids(refs), targetIds: ids(targets),
      taskExtra, materials, allFinals: true, finalFirst,
      prev, next, signal: ctx && ctx.signal,
    });
    if (!r.ok) return r;
    if (stopped()) return { ok: false, error: '중지됨' };
    let docId = null;
    state.update(pid, (p) => {
      docId = model.docCreate(p, { kind, title, body: r.text, refIds: ids(refs), targetIds: ids(targets) }).id;
    });
    made.set(key, docId);
    order.push(docId);
    if (ctx) ctx.addDoc(docId);
    return { ok: true, docId };
  }

  // ---- S00 에이전트 준비 (비소설이면 자리마다 프롬프트를 새로 짓는다)
  const prep = await prepareAgents(pid, ctx);
  if (!prep.ok) return prep;
  if (stopped()) return { ok: false, error: '중지됨' };

  const project0 = state.get(pid);
  const K = Math.min(3, Math.max(1, Number((project0.auto || {}).feedbackRounds) || 1));
  const skipProse = !!(project0.auto || {}).skipProse;
  const views = perspectivesOf(project0);

  // ---- S02 자료 분석  (자료 원문이 실리는 자리)
  let r = await write('S02', { code: 'S02', title: '자료 분석', materials: true });
  if (!r.ok) return r;

  // ---- S03 세계관
  r = await write('S03', { code: 'S03', title: '세계관', refs: ['S02'] });
  if (!r.ok) return r;

  // ---- S04 서사 재료  (자료 원문이 실리는 마지막 자리)
  r = await write('S04', { code: 'S04', title: '서사 재료', refs: ['S02', 'S03'], materials: true });
  if (!r.ok) return r;

  // ---- S05 기획 — 관점마다 한 편
  const planKeys = [];
  for (let i = 0; i < views.length; i++) {
    const key = 'S05-' + i;
    r = await write(key, {
      code: 'S05', title: '기획 — ' + views[i], refs: ['S02', 'S03', 'S04'],
      taskExtra: '이번 관점: ' + views[i],
    });
    if (!r.ok) return r;
    planKeys.push(key);
  }

  // ---- S06 기획 선정 (고른 기획의 전문을 이 문서가 품는다 — 뒤 단계는 이것만 본다)
  r = await write('S06', { code: 'S06', title: '기획 선정', refs: planKeys });
  if (!r.ok) return r;

  // ---- S07 세계관 재작성
  r = await write('S07', { code: 'S07', title: '세계관 재작성', refs: ['S03', 'S04', 'S06'] });
  if (!r.ok) return r;

  // ---- S08~S12
  r = await write('S08', { code: 'S08', title: '인물 풀', refs: ['S06', 'S07'] });
  if (!r.ok) return r;
  r = await write('S09', { code: 'S09', title: '대략 플롯', refs: ['S06', 'S07', 'S08'] });
  if (!r.ok) return r;
  r = await write('S10', { code: 'S10', title: '주요 인물 선정', refs: ['S06', 'S08', 'S09'] });
  if (!r.ok) return r;
  r = await write('S11', { code: 'S11', title: '인물 설계', refs: ['S07', 'S09', 'S10'] });
  if (!r.ok) return r;
  r = await write('S12', { code: 'S12', title: '상세 플롯', refs: ['S07', 'S09', 'S11'] });
  if (!r.ok) return r;

  // ---- S13/S14 합평 → 재작성, 피드백 횟수만큼
  let plotKey = 'S12';
  for (let round = 1; round <= K; round++) {
    const rev = 'S13-' + round;
    r = await write(rev, { code: 'F-REVIEW', kind: 'review', title: '상세 플롯 합평', targets: [plotKey], refs: ['S11'], prevCode: 'S12', nextCode: 'S14' });
    if (!r.ok) return r;
    const next = 'S14-' + round;
    r = await write(next, { code: 'S14', title: '상세 플롯 재작성', targets: [plotKey], refs: [rev, 'S11'], prevCode: 'F-REVIEW', nextCode: 'S15' });
    if (!r.ok) return r;
    plotKey = next;
  }

  // ---- S15 회차 계획
  const specN = specEpisodes(state.get(pid));
  r = await write('S15', {
    code: 'S15', title: '회차 계획', refs: [plotKey, 'S11', 'S07'],
    taskExtra: specN ? ('회차 수는 ' + specN + '화로 고정한다.') : ('회차 수는 스스로 판단하되 ' + EPISODE_CAP + '화를 넘기지 않는다.'),
  });
  if (!r.ok) return r;

  // ---- S16/S17 합평 → 재작성. 마지막 재작성판만 확정본.
  let epKey = 'S15';
  for (let round = 1; round <= K; round++) {
    const rev = 'S16-' + round;
    r = await write(rev, { code: 'F-REVIEW', kind: 'review', title: '회차 계획 합평', targets: [epKey], refs: [plotKey], prevCode: 'S15', nextCode: 'S17' });
    if (!r.ok) return r;
    const next = 'S17-' + round;
    r = await write(next, {
      code: 'S17', title: '회차 계획 재작성', targets: [epKey], refs: [rev, plotKey], prevCode: 'F-REVIEW', nextCode: 'S18A',
      taskExtra: specN ? ('회차 수는 ' + specN + '화로 고정한다.') : '',
    });
    if (!r.ok) return r;
    epKey = next;
  }
  const planId = made.get(epKey);
  state.update(pid, (p) => { model.docSetFinal(p, planId, true); });

  // ---- 회차 수 확정 — 분량에 적혀 있으면 그대로, 아니면 물어본다(본문을 뒤져 추정하지 않는다)
  let N = specN;
  if (!N) {
    if (ctx) ctx.step('회차 수');
    const cr = await countEpisodes(pid, planId, ctx);
    if (!cr.ok) return cr;
    N = cr.count;
  }
  state.update(pid, (p) => { p.auto.episodes = N; });

  // ---- S18 회차마다 계획 → 세부 → 본문
  for (let e = 1; e <= N; e++) {
    if (stopped()) return { ok: false, error: '중지됨' };
    const prevTail = e > 1 ? (skipProse ? 'S18-' + (e - 1) + '-B' : 'S18-' + (e - 1) + '-C') : null;
    const aKey = 'S18-' + e + '-A';
    r = await write(aKey, {
      code: 'S18A', title: e + '화 집필 계획',
      refs: [epKey, 'S11', 'S07', ...(prevTail ? [prevTail] : [])],
      taskExtra: '이번 회차: ' + e + '화',
    });
    if (!r.ok) return r;

    const bKey = 'S18-' + e + '-B';
    r = await write(bKey, {
      code: 'S18B', title: e + '화 집필 계획 세부', refs: [aKey, epKey, 'S11'],
      taskExtra: '이번 회차: ' + e + '화',
    });
    if (!r.ok) return r;

    if (!skipProse) {
      const cKey = 'S18-' + e + '-C';
      r = await write(cKey, {
        code: 'S18C', title: e + '화', refs: [bKey, 'S11'],
        taskExtra: '이번 회차: ' + e + '화',
      });
      if (!r.ok) return r;
    }
  }

  // ---- S19 모순 검사 — 회차마다 «회차 계획 확정본 ↔ 그 회차 산출물» 한 번씩
  const parts = [];
  for (let e = 1; e <= N; e++) {
    if (stopped()) return { ok: false, error: '중지됨' };
    if (ctx) ctx.step('모순 검사 — ' + e + '화');
    const targetKey = skipProse ? 'S18-' + e + '-B' : 'S18-' + e + '-C';
    const project = state.get(pid);
    const { prev, next } = neighborNames(project, 'F-CONTRA', skipProse ? 'S18B' : 'S18C', '');
    const cr = await callWithRetry({
      pid, code: 'F-CONTRA',
      refIds: [], targetIds: [planId, ...ids([targetKey])],
      allFinals: true, finalFirst: true, prev, next,
      taskExtra: '이번 회차: ' + e + '화',
      signal: ctx && ctx.signal,
    });
    if (!cr.ok) return cr;
    parts.push('## ' + e + '화\n\n' + cr.text);
  }
  if (parts.length) {
    let contraId = null;
    const checked = [];
    for (let e = 1; e <= N; e++) {
      const id = made.get(skipProse ? 'S18-' + e + '-B' : 'S18-' + e + '-C');
      if (id) checked.push(id);
    }
    state.update(pid, (p) => {
      contraId = model.docCreate(p, {
        kind: 'check', title: '모순 검사', body: parts.join('\n\n'),
        targetIds: [planId, ...checked],
      }).id;
    });
    made.set('S19', contraId);
    order.push(contraId);
    if (ctx) ctx.addDoc(contraId);
  }

  // ---- S20 '자동 실행' 카테고리와 합본 (호출 없음)
  if (ctx) ctx.step('자동 실행 카테고리');
  state.update(pid, (p) => {
    const cat = model.categoryCreate(p, AUTO_CATEGORY);
    const bundle = order.map((id) => {
      const d = model.findDoc(p, id);
      return d ? '# ' + d.title + '\n\n' + d.body : '';
    }).filter(Boolean).join('\n\n');
    const merged = model.docCreate(p, { title: '자동 집필 합본', body: bundle });
    for (const id of [...order, merged.id]) {
      const d = model.findDoc(p, id);
      if (d) d.categoryId = cat.id;
    }
    order.push(merged.id);
  });
  if (ctx) ctx.step('');

  return { ok: true, docIds: order.slice() };
}

// 회차 수 확인 — 확정본 하나를 보여 주고 숫자만 받는다.
export async function countEpisodes(pid, planId, ctx) {
  const project = state.get(pid);
  const d = model.findDoc(project, planId);
  if (!d) return { ok: false, error: '회차 계획을 찾을 수 없습니다' };
  const pr = BUILTIN['F-COUNT'];
  const systemPrompt = buildSystem({ prompt: pr, withFinalRule: false, withNoCount: false });
  const prompt = buildUser({
    project, refs: [{ id: d.id, name: d.title, text: d.body }],
    task: pr.task, noCount: false,
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runClaudeCall({ systemPrompt, prompt, mockKey: 'F-COUNT', signal: ctx && ctx.signal });
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    if (!r.ok) { if (attempt) return { ok: false, error: r.error }; continue; }
    const m = cleanResponse(r.text).match(/\d+/);
    if (!m) { if (attempt) return { ok: false, error: '회차 수를 받지 못했습니다' }; continue; }
    let n = Number(m[0]);
    if (!(n >= 1) || n > EPISODE_CAP) n = EPISODE_CAP;
    return { ok: true, count: n };
  }
  return { ok: false, error: '회차 수를 받지 못했습니다' };
}
