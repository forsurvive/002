// 에이전트 준비 · 자료 분석 — tools/agents.mjs 의 본체를 의미 그대로 옮겼다(온라인 worker 도 같은 일을 하도록).
// 프로젝트를 만든 직후 그 프로젝트가 어떤 글을 쓰려는지 판단하고(F-KIND), 비소설이면 자리마다 프롬프트를 새로 짓는다(F-AGENT).
// 소설이면 아무것도 만들지 않고 내장 세트를 쓴다. 이미 지어 둔 자리는 다시 짓지 않는다. 끝나면 자료를 한 번 읽어 «자료 분석»을 남긴다.
//
// deps = { store, call, raw, prompts }
//   store   : get/update(동기여도 비동기여도 된다)
//   call    : 계획을 거치는 한 번의 부르기(자료 분석 S02) — run.mjs 와 같은 것
//   raw     : 이미 지은 시스템 프롬프트 · 본문으로 곧장 부르기({ systemPrompt, prompt, code, signal, model }, ctx) — 판정 · 짓기
//   prompts : { builtin, slots, duty, promptFor(project, code), slotModel(project, code) } — 내장 프롬프트(파일)는 바깥이 읽어 넣는다

import * as model from '../domain/model.mjs';
import { buildSystem, buildUser, cleanResponse } from '../prompt/assemble.mjs';
import { materialItems } from '../reference/plan.mjs';
import { readingInParts } from './reading.mjs';

export const CRAFT_MIN = 2000; // 기획서가 못 박은 하한. 위쪽 상한은 두지 않는다.
export const STUDY_TITLE = '자료 분석';

function ctl(prompts, code, extraTask, project, { materials = true, refs = [], request = '' } = {}) {
  const pr = prompts.promptFor(project, code);
  return {
    // 제어 호출에도 싣는다 — 작가의 말이 «모든 에이전트가 매 호출마다»이기 때문이다(사용자 지시).
    systemPrompt: buildSystem({ prompt: pr, withFinalRule: false, withNoCount: project.noCount !== false }),
    prompt: buildUser({
      project,
      materials: materials ? materialItems(project) : [],
      refs,
      request,
      task: [pr.task, extraTask].filter(Boolean).join('\n'),
      noCount: project.noCount !== false,
    }),
  };
}

// «분류: …» 줄을 읽는다 — 첫 줄이 먼저, 없으면 어느 줄이든(머리말 · 꾸밈표 · 따옴표가 붙어 와도). 그 밖의 줄에서 무엇을 추측하지 않는다.
export function readKind(text) {
  const lines = cleanResponse(text).split('\n').map((l) => l.replace(/^[\s>*#\-·•"'「『【\[]+|[\s*"'」』】\]]+$/g, '').trim());
  const hit = (l) => l.match(/^분류\s*[:：]\s*(.+)$/);
  const m = hit(lines[0] || '') || lines.map(hit).find(Boolean);
  const kind = m ? m[1].replace(/[.。]$/, '').trim().slice(0, 40) : '';
  return { kind, fiction: kind === '소설' };
}

// ---------------------------------------------------------------- 실패하지 않게(2026-10-07 사용자 지시 «이 단계가 절대 실패하지 않도록»)
// 잠깐의 실패(밀림 · 과부하 · 시간 초과 · 빈 응답 · 연결 끊김)는 사이를 두고 다시 부른다.
// 다시 불러도 같은 답인 것(키 없음 · 키 틀림 · 잔액 · 모델 · 한도 · 이용 기간)만 멈춘다 — 그때는 까닭을 말한다.
export const PASSING = new Set(['rate', 'overloaded', 'timeout', 'other', 'empty']);
const RETRY_MS = [3000, 10000, 30000];
const pause = (ms, signal) => new Promise((done) => {
  if (!(ms > 0)) return done();
  const t = setTimeout(done, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
});
async function persist(fn, ctx, delays = RETRY_MS) {
  let r = null;
  for (let i = 0; i <= delays.length; i++) {
    r = await fn(i);
    if (r.ok || (ctx && ctx.signal && ctx.signal.aborted) || !PASSING.has(r.reason || 'other')) return r;
    if (i < delays.length) await pause(delays[i], ctx && ctx.signal);
  }
  return r;
}
// 멈출 때 말 — 무엇을 하면 다시 되는지까지
const STOP_SAY = {
  credential: 'AI 키가 없어 자료 분석을 하지 못했습니다 — 키를 넣으면 다시 합니다',
  auth: 'AI 키가 맞지 않아 자료 분석을 하지 못했습니다 — 키를 확인해 주세요',
  credit: 'AI 잔액이 모자라 자료 분석을 하지 못했습니다',
};
const stopped = (r) => ({ ...r, ok: false, error: STOP_SAY[r.reason] || r.error || '자료 분석을 하지 못했습니다' });

// 형식대로 온 한 덩이를 다섯 칸으로 가른다. 형식이 깨지면 본문 전체를 작법으로 본다.
export function readAgent(text, code, builtin = {}) {
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
  const base = builtin[code] || {};
  return {
    code,
    name: pick('이름') || base.name || '집필자',
    role: pick('역할') || base.role || '',
    task: pick('할 일') || base.task || '',
    craft,
  };
}

// 이 프로젝트의 에이전트가 이미 준비되었는가(소설로 판정된 경우도 준비된 것이다).
export function agentsReady(project, slots) {
  const a = project && project.agents;
  if (!a || !a.__kind) return false;
  if (a.__kind === '소설' || a.__kind === '기본') return true;   // «기본» = 종류를 끝내 못 읽어 내장 에이전트로 간다
  return slots.every((c) => a[c] && a[c].craft);
}

// request 는 이번 한 번만 싣는 작가의 말이다(«다시» 를 누르며 적은 것). 저장하지 않는다.
export async function prepareAgents(deps, pid, ctx, request = '') {
  const { store, raw, prompts } = deps;
  const project = await store.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  if (ctx) ctx.step('글의 종류 가리기');

  // 판정은 프로젝트마다 한 번뿐이다 — 이미 내린 판정이 있으면 그대로 잇는다.
  let kindName = (project.agents && project.agents.__kind) || '';
  if (kindName === '소설' || kindName === '기본') return { ok: true, fiction: true, kind: kindName };
  const delays = deps.retryDelays || RETRY_MS;

  if (!kindName) {
    let info = null;
    // 꼴이 어긋나면 다시 묻는다(세 번까지). 잠깐의 실패는 그 안에서 사이를 두고 다시 부른다.
    for (let attempt = 0; attempt < 3 && !info; attempt++) {
      const c = ctl(prompts, 'F-KIND', attempt ? '첫 줄은 반드시 «분류: 종류» 한 줄로만 시작해야 한다. 예: 분류: 소설' : '', project, { request });
      const r = await persist(() => raw({ ...c, code: 'F-KIND', signal: ctx && ctx.signal, model: prompts.slotModel(project, 'F-KIND') || project.model }, ctx), ctx, delays);
      if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
      if (!r.ok) {
        if (!PASSING.has(r.reason || 'other')) return stopped(r);
        continue;   // 오래 밀렸다 — 다음 시도로
      }
      const got = readKind(r.text);
      if (got.kind) info = got;
    }
    // 끝내 종류를 못 읽었으면 멈추지 않고 내장 에이전트로 간다(«기본») — 자료 분석은 그대로 이어서 한다
    if (!info) info = { kind: '기본', fiction: true, guessed: true };
    await store.update(pid, (p) => {
      p.agents = p.agents || {};
      p.agents.__kind = info.guessed ? '기본' : info.fiction ? '소설' : info.kind;
    });
    if (info.fiction) return { ok: true, fiction: true, kind: info.guessed ? '기본' : '소설' };
    kindName = info.kind;
  }

  for (let i = 0; i < prompts.slots.length; i++) {
    const code = prompts.slots[i];
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    if (ctx && ctx.gate) await ctx.gate();
    if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
    const cur = (await store.get(pid)).agents || {};
    if (cur[code] && cur[code].craft) continue; // 이미 지은 자리는 건너뛴다

    const extra = [
      '이 프로젝트가 쓰려는 글의 종류: ' + kindName,
      '지금 만들 자리: ' + code + ' — ' + (prompts.duty[code] || ''),
      '이 글의 종류에 맞는 실제 작법을 써라. 소설 작법을 그대로 옮기지 마라.',
      '작법 본문은 최소 ' + CRAFT_MIN + '자 이상이어야 한다. 넉넉히 써라.',
    ].join('\n');

    if (ctx) ctx.step('에이전트 짓기 — ' + code);
    let made = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = await store.get(pid);
      const c = ctl(prompts, 'F-AGENT', extra + (attempt ? '\n앞서 받은 작법이 ' + CRAFT_MIN + '자에 못 미쳤다. 훨씬 더 길고 촘촘하게 다시 써라.' : ''), now, { request });
      const r = await persist(() => raw({ ...c, code: 'F-AGENT', signal: ctx && ctx.signal, model: prompts.slotModel(now, 'F-AGENT') || now.model }, ctx), ctx, delays);
      if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
      if (!r.ok) {
        if (!PASSING.has(r.reason || 'other')) return stopped(r);
        break;   // 오래 밀렸다 — 이 자리는 아래에서 내장으로 채운다
      }
      const got = readAgent(r.text, code, prompts.builtin);
      if (!made || got.craft.length > made.craft.length) made = got;   // 더 긴 쪽을 남긴다
      if (made.craft.length >= CRAFT_MIN) break;
    }
    // 끝내 못 지었으면 그 자리만 내장 프롬프트로 채우고 다음 자리로 간다(작업은 멈추지 않는다) — 표(fallback)를 남겨 둔다
    if (!made || !String(made.craft || '').trim()) {
      const b = (prompts.builtin && prompts.builtin[code]) || {};
      made = { code, name: b.name || '집필자', role: b.role || '', task: b.task || '', craft: b.craft || '이 자리의 일을 한다.', fallback: true };
    }
    await store.update(pid, (p) => { p.agents = p.agents || {}; p.agents[code] = made; });
  }

  return { ok: true, fiction: false, kind: kindName };
}

// 자료 분석 — 에이전트가 준비되면 이어서 자료를 한 번 읽어 «자료 분석» 문서를 남긴다(작가가 따로 누를 것이 없다).
export async function runStudy(deps, pid, ctx, request = '') {
  const { store, call } = deps;
  const project = await store.get(pid);
  if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  if (!materialItems(project).length) return { ok: true, skipped: true };
  if (ctx && ctx.gate) await ctx.gate();
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };
  if (ctx) ctx.step(STUDY_TITLE);

  const delays = deps.retryDelays || RETRY_MS;
  // 자료가 한 번에 실리지 않으면(invalid — «입력이 너무 깁니다») 자르지 않고 나눠 읽어 모은다(reading.mjs, 2026-10-08 사용자 지시)
  const readCall = readingInParts(call, store);
  const r = await persist(() => readCall({ pid, code: 'S02', materials: true, allFinals: true, request, signal: ctx && ctx.signal }, ctx), ctx, delays);
  if (!r.ok) return PASSING.has(r.reason || 'other') || r.reason === 'invalid' ? r : stopped(r);
  if (ctx && ctx.signal && ctx.signal.aborted) return { ok: false, error: '중지됨' };

  let docId = null;
  await store.update(pid, (p) => { docId = model.docCreate(p, { title: STUDY_TITLE, body: r.text }).id; });
  if (ctx) { ctx.addDoc(docId); ctx.step(''); }
  return { ok: true, docId };
}

// 준비가 끝났으면 자료를 읽는다 — 준비 작업(kind 'agents')의 본체
export async function prepareThenStudy(deps, pid, ctx, request = '') {
  if (!agentsReady(await deps.store.get(pid), deps.prompts.slots)) {
    const r = await prepareAgents(deps, pid, ctx, request);
    if (!r.ok) return r;
  }
  // «자료 분석» 문서가 이미 있으면 또 만들지 않는다(종류만 다시 가린 때 — 같은 문서가 두 벌 서지 않게)
  const now = await deps.store.get(pid);
  if (now && (now.docs || []).some((d) => d.title === STUDY_TITLE)) return { ok: true, skipped: true };
  return runStudy(deps, pid, ctx, request);
}
