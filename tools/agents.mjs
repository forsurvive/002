// 비소설 대응 — 프로젝트 전용 에이전트를 즉석으로 짓는다(기획서 중요사항 하나).
// **프로젝트를 만든 직후** 그 프로젝트가 어떤 글을 쓰려는지 판단하고, 비소설이면 자리마다 프롬프트를 새로 짓는다.
// 소설이면 아무것도 만들지 않고 내장 세트를 쓴다. 이미 지어 둔 자리는 다시 짓지 않는다(자동 집필이 다시 불러도 건너뛴다).

import { BUILTIN, AGENT_SLOTS, SLOT_DUTY, PERSPECTIVES, NEIGHBORS } from './prompts.mjs';
import { buildSystem, buildUser, cleanResponse } from './assemble.mjs';
import { runClaudeCall } from './call.mjs';
import * as state from './state.mjs';

export const CRAFT_MIN = 2000; // 기획서가 못 박은 하한. 위쪽 상한은 두지 않는다.

// 같은 프로젝트를 두 벌로 짓지 않는다(구독 사용량이 두 배로 나가고 나중 것이 앞 것을 덮는다).
// 이미 짓는 중이면 그 일이 끝나기를 기다렸다가 그 결과를 같이 쓴다.
const building = new Map();

function ctl(code, extraTask, project, { materials = true, refs = [] } = {}) {
  const pr = BUILTIN[code];
  return {
    systemPrompt: buildSystem({ prompt: pr, withFinalRule: false, withNoCount: false }),
    prompt: buildUser({
      project,
      materials: materials ? (project.materials || []).map((m) => ({ id: m.id, name: m.name, text: m.text })) : [],
      refs,
      task: [pr.task, extraTask].filter(Boolean).join('\n'),
      noCount: false,
    }),
  };
}

// 첫 줄의 «분류: …» 한 줄만 읽는다. 그 밖의 줄에서 무엇을 추측하지 않는다.
export function readKind(text) {
  const lines = cleanResponse(text).split('\n');
  const head = (lines[0] || '').trim();
  const m = head.match(/^분류\s*[:：]\s*(.+)$/);
  const kind = m ? m[1].trim() : '';
  const views = [];
  for (const ln of lines) {
    const v = ln.trim().match(/^관점\s*[:：]\s*(.+)$/);
    if (v && v[1].trim()) views.push(v[1].trim());
  }
  return { kind, fiction: kind === '소설', views: views.slice(0, PERSPECTIVES.length) };
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
 * 프로젝트를 만든 직후 한 번(자동 집필도 시작할 때 한 번 더 부르지만 이미 된 자리는 건너뛴다).
 * ctx 는 작업 맥락(step·signal). 돌려주는 값: { ok, fiction, kind, error }
 */
export async function prepareAgents(pid, ctx) {
  const project = state.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  if (building.has(pid)) {
    if (ctx) ctx.step('에이전트 준비');
    return building.get(pid);
  }
  const work = prepareAgentsInner(pid, ctx, project).finally(() => building.delete(pid));
  building.set(pid, work);
  return work;
}

async function prepareAgentsInner(pid, ctx, project) {
  if (ctx) ctx.step('에이전트 준비');

  // 판정은 프로젝트마다 한 번뿐이다 — 이미 내린 판정이 있으면 그대로 잇는다.
  let kindName = (project.agents && project.agents.__kind) || '';
  if (kindName === '소설') return { ok: true, fiction: true, kind: '소설' };

  if (!kindName) {
    let info = null;
    for (let attempt = 0; attempt < 2 && !info; attempt++) {
      const c = ctl('F-KIND', attempt ? '첫 줄은 반드시 «분류: » 로 시작해야 한다.' : '', project);
      const r = await runClaudeCall({ ...c, mockKey: 'F-KIND', signal: ctx && ctx.signal });
      if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
      if (!r.ok) { if (attempt) return { ok: false, error: r.error }; continue; }
      const got = readKind(r.text);
      if (got.kind) info = got;
    }
    if (!info) return { ok: false, error: '종류 판정 형식이 어긋났습니다' };
    state.update(pid, (p) => {
      p.agents = p.agents || {};
      p.agents.__kind = info.fiction ? '소설' : info.kind;
      p.agents.__views = info.views.length === PERSPECTIVES.length ? info.views : PERSPECTIVES.slice();
    });
    if (info.fiction) return { ok: true, fiction: true, kind: '소설' };
    kindName = info.kind;
  }

  for (let i = 0; i < AGENT_SLOTS.length; i++) {
    const code = AGENT_SLOTS[i];
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    const cur = state.get(pid).agents || {};
    if (cur[code] && cur[code].craft) continue; // 이미 지은 자리는 건너뛴다

    const pair = NEIGHBORS[code] || ['', ''];
    const prev = pair[0];
    const next = pair[1];
    const sideOf = (c) => {
      if (!c) return '없음';
      const made = (state.get(pid).agents || {})[c];
      const duty = SLOT_DUTY[c] || '';
      // 아직 짓지 않은 자리에 소설용 이름을 실으면 «이 프로젝트만의 에이전트»가 아니게 된다.
      const who = made && made.name ? made.name + (made.role ? ' — ' + made.role : '') : '(아직 짓지 않았다)';
      return c + ' ' + who + (duty ? '\n    하는 일: ' + duty : '');
    };
    const extra = [
      '이 프로젝트가 쓰려는 글의 종류: ' + kindName,
      '지금 만들 자리: ' + code + ' — ' + (SLOT_DUTY[code] || ''),
      '앞자리: ' + sideOf(prev),
      '뒷자리: ' + sideOf(next),
      '이 글의 종류에 맞는 실제 작법을 써라. 소설 작법을 그대로 옮기지 마라.',
      '작법 본문은 최소 ' + CRAFT_MIN + '자 이상이어야 한다. 넉넉히 써라.',
    ].join('\n');

    if (ctx) ctx.step('에이전트 준비 — ' + code);
    let made = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = ctl('F-AGENT', extra + (attempt ? '\n앞서 받은 작법이 ' + CRAFT_MIN + '자에 못 미쳤다. 훨씬 더 길고 촘촘하게 다시 써라.' : ''), state.get(pid));
      const r = await runClaudeCall({ ...c, mockKey: 'F-AGENT', signal: ctx && ctx.signal });
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

export function perspectivesOf(project) {
  const v = project && project.agents && project.agents.__views;
  return Array.isArray(v) && v.length === PERSPECTIVES.length ? v : PERSPECTIVES;
}
