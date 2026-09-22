// 비소설 대응 — 프로젝트 전용 에이전트를 즉석으로 짓는다(기획서 중요사항 하나).
// **프로젝트를 만든 직후** 그 프로젝트가 어떤 글을 쓰려는지 판단하고, 비소설이면 자리마다 프롬프트를 새로 짓는다.
// 소설이면 아무것도 만들지 않고 내장 세트를 쓴다. 이미 지어 둔 자리는 다시 짓지 않는다.
// 프롬프트를 다 지으면 이어서 자료를 한 번 읽어 «자료 분석» 문서를 남긴다.

import { BUILTIN, AGENT_SLOTS, SLOT_DUTY } from './prompts.mjs';
import { buildSystem, buildUser, cleanResponse } from './assemble.mjs';
import { runClaudeCall } from './call.mjs';
import { promptFor, callWithRetry, callAsking } from './engine.mjs';
import * as state from './state.mjs';
import * as model from './model.mjs';

export const CRAFT_MIN = 2000; // 기획서가 못 박은 하한. 위쪽 상한은 두지 않는다.

// 같은 프로젝트를 두 벌로 짓지 않는다(구독 사용량이 두 배로 나가고 나중 것이 앞 것을 덮는다).
// 이미 짓는 중이면 그 일이 끝나기를 기다렸다가 그 결과를 같이 쓴다.
const building = new Map();

function ctl(code, extraTask, project, { materials = true, refs = [], request = '' } = {}) {
  const pr = promptFor(project, code);
  return {
    // 제어 호출에도 싣는다 — 작가의 말이 «모든 에이전트가 매 호출마다»이기 때문이다(사용자 지시).
    systemPrompt: buildSystem({ prompt: pr, withFinalRule: false, withNoCount: project.noCount !== false }),
    prompt: buildUser({
      project,
      materials: materials ? (project.materials || []).map((m) => ({ id: m.id, name: m.name, text: m.text })) : [],
      refs,
      request,
      task: [pr.task, extraTask].filter(Boolean).join('\n'),
      noCount: project.noCount !== false,
    }),
  };
}

// 첫 줄의 «분류: …» 한 줄만 읽는다. 그 밖의 줄에서 무엇을 추측하지 않는다.
export function readKind(text) {
  const lines = cleanResponse(text).split('\n');
  const head = (lines[0] || '').trim();
  const m = head.match(/^분류\s*[:：]\s*(.+)$/);
  const kind = m ? m[1].trim() : '';
  return { kind, fiction: kind === '소설' };
}

// 형식대로 온 한 덩이를 다섯 칸으로 가른다. 형식이 깨지면 본문 전체를 작법으로 본다.
export function readAgent(text, code) {
  const t = cleanResponse(text);
  const pick = (label) => {
    const m = t.match(new RegExp('^' + label + '\\s*[:：]\\s*(.+)$', 'm'));
    return m ? m[1].trim() : '';
  };
  const i = t.search(/^작법\s*[:：]\s*$/m);
  let craft = '';
  if (i >= 0) {
    const after = t.slice(i);
    craft = after.slice(after.indexOf('\n') + 1).trim();
  } else {
    craft = t;
  }
  const base = BUILTIN[code] || {};
  return {
    code,
    name: pick('이름') || base.name || '집필자',
    role: pick('역할') || base.role || '',
    task: pick('할 일') || base.task || '',
    craft,
  };
}

// 이 프로젝트의 에이전트가 이미 준비되었는가(소설로 판정된 경우도 준비된 것이다).
export function agentsReady(project) {
  const a = project && project.agents;
  if (!a || !a.__kind) return false;
  if (a.__kind === '소설') return true;
  return AGENT_SLOTS.every((c) => a[c] && a[c].craft);
}

/**
 * 프로젝트를 만든 직후 한 번. 준비가 끊겼으면 설정의 [에이전트 준비 다시]가 같은 문을 다시 지난다(이미 된 자리는 건너뛴다).
 * ctx 는 작업 맥락(step·signal). 돌려주는 값: { ok, fiction, kind, error }
 */
export async function prepareAgents(pid, ctx, request = '') {
  const project = state.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  if (building.has(pid)) {
    if (ctx) ctx.step('에이전트 준비');
    return building.get(pid);
  }
  const work = prepareAgentsInner(pid, ctx, project, request).finally(() => building.delete(pid));
  building.set(pid, work);
  return work;
}

// request 는 이번 한 번만 싣는 작가의 말이다(«다시» 를 누르며 적은 것). 저장하지 않는다.
async function prepareAgentsInner(pid, ctx, project, request = '') {
  if (ctx) ctx.step('에이전트 준비');

  // 판정은 프로젝트마다 한 번뿐이다 — 이미 내린 판정이 있으면 그대로 잇는다.
  let kindName = (project.agents && project.agents.__kind) || '';
  if (kindName === '소설') return { ok: true, fiction: true, kind: '소설' };

  if (!kindName) {
    let info = null;
    for (let attempt = 0; attempt < 2 && !info; attempt++) {
      const c = ctl('F-KIND', attempt ? '첫 줄은 반드시 «분류: » 로 시작해야 한다.' : '', project, { request });
      const r = await runClaudeCall({ ...c, mockKey: 'F-KIND', signal: ctx && ctx.signal, model: project.model });
      if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
      if (!r.ok) { if (attempt) return { ok: false, error: r.error }; continue; }
      const got = readKind(r.text);
      if (got.kind) info = got;
    }
    if (!info) return { ok: false, error: '종류 판정 형식이 어긋났습니다' };
    state.update(pid, (p) => {
      p.agents = p.agents || {};
      p.agents.__kind = info.fiction ? '소설' : info.kind;
    });
    if (info.fiction) return { ok: true, fiction: true, kind: '소설' };
    kindName = info.kind;
  }

  for (let i = 0; i < AGENT_SLOTS.length; i++) {
    const code = AGENT_SLOTS[i];
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    if (ctx && ctx.gate) await ctx.gate();
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    const cur = state.get(pid).agents || {};
    if (cur[code] && cur[code].craft) continue; // 이미 지은 자리는 건너뛴다

    const extra = [
      '이 프로젝트가 쓰려는 글의 종류: ' + kindName,
      '지금 만들 자리: ' + code + ' — ' + (SLOT_DUTY[code] || ''),
      '이 글의 종류에 맞는 실제 작법을 써라. 소설 작법을 그대로 옮기지 마라.',
      '작법 본문은 최소 ' + CRAFT_MIN + '자 이상이어야 한다. 넉넉히 써라.',
    ].join('\n');

    if (ctx) ctx.step('에이전트 준비 — ' + code);
    let made = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = ctl('F-AGENT', extra + (attempt ? '\n앞서 받은 작법이 ' + CRAFT_MIN + '자에 못 미쳤다. 훨씬 더 길고 촘촘하게 다시 써라.' : ''), state.get(pid), { request });
      const r = await runClaudeCall({ ...c, mockKey: 'F-AGENT', signal: ctx && ctx.signal, model: state.get(pid).model });
      if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
      if (!r.ok) { if (attempt) return { ok: false, error: r.error }; continue; }
      made = readAgent(r.text, code);
      if (made.craft.length >= CRAFT_MIN) break;
    }
    if (!made || !made.craft) return { ok: false, error: '에이전트 프롬프트를 만들지 못했습니다(' + code + ')' };
    state.update(pid, (p) => { p.agents = p.agents || {}; p.agents[code] = made; });
  }

  return { ok: true, fiction: false, kind: kindName };
}


// ---------------------------------------------------------------- 자료 분석
//
// 프로젝트를 만들고 에이전트가 준비되면, 이어서 자료를 한 번 읽어 «자료 분석» 문서를 남긴다.
// 「에이전트 준비」 작업의 끝에 붙는다 — 작가가 따로 누를 것이 없다.

export const STUDY_TITLE = '자료 분석';

export async function runStudy(pid, ctx, request = '') {
  const project = state.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  if (!(project.materials || []).length) return { ok: true, skipped: true };
  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  if (ctx) ctx.step(STUDY_TITLE);

  const r = await callAsking({ pid, code: 'S02', materials: true, allFinals: true, request, signal: ctx && ctx.signal }, ctx);
  if (!r.ok) return r;
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };

  let docId = null;
  state.update(pid, (p) => { docId = model.docCreate(p, { title: STUDY_TITLE, body: r.text }).id; });
  if (ctx) { ctx.addDoc(docId); ctx.step(''); }
  return { ok: true, docId };
}
