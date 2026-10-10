// 나눠 읽기 — 한 번에 실리지 않는 생성을 자르지 않고 해낸다(2026-10-08 사용자 지시:
// «문서를 쪼개서 작업하든 어떻게 하든 참조된 문서와 수정/생성할 문서, 요청사항 모두 결과에 반드시 반영되어야 해»,
// 2026-10-10 «반영이 안되거나 참조되지 않은 내용이 절대로 있어서는 안돼» · «성능을 최대한»).
//
// 처음에는 늘 통째로 부른다(실리면 아무것도 바꾸지 않는다 — 우리 쪽 사전 검사 · 상한이 없다). «입력이 너무 깁니다»(invalid)로 거절당하면:
//   ⓪ 회사가 보낸 · 받을 수 있는 토큰 수를 알려 주면(fit) 그 비율로 «원문 그대로 남길 수 있는 만큼»을 셈한다 — 넘치는 것만 나눠 읽는다.
//      모르면 조각 크기(PART_SIZES)로 차례로 줄인다.
//   ① 자료 · 참조 · 확정본 가운데 긴 것부터 조각으로 나눠 읽는다 — 조각마다 «나중에 할 일»과 요청사항을 보여 주고
//      반영할 것을 빠짐없이 뽑아 옮기게 한다(문구: core/prompt/assemble.mjs 의 readTask). 확정본은 맨 나중에, 짧은 문서는 원문 그대로 둔다.
//      합평 모으기가 받는 여러 합평(extra) · 논의의 앞선 대화(뒤쪽 마디는 원문 그대로)도 넘치면 같은 길로 읽는다.
//      그래도 실리지 않는 마지막 수단으로 아주 긴 요청사항 · 집필 기준 · 작품 요청사항 · 개요도 «지시 글»로 나눠 읽는다(지시는 원문 그대로 옮긴다).
//   ② 뽑아 옮긴 것까지 넘치면 그것을 다시 모은다(빠뜨리지 않고 겹친 것만 합친다).
//   ③ 모아 쓴다 — 뽑아 옮긴 것 + 고칠 원고 통째 + 요청사항 통째. 원고 자체가 한 번에 실리지 않으면 원고를 부분으로 나눠
//      부분마다 같은 참조 · 요청사항으로 쓰고 잇는다(보고서꼴 — 모순 검사 · 합평 — 은 부분마다 따로 보고 묶고, 마지막에 부분 사이를 견준다).
// 그래도 거절당하면 더 작게 처음부터 다시 한다. 읽은 조각은 기억해 두어(체크포인트) 다시 걸어도 다시 부르지 않는다.

import { planCall } from '../reference/plan.mjs';
import { ACROSS_TASK, digestNote } from '../prompt/assemble.mjs';

export const PART_SIZES = [60000, 30000, 15000];           // 받을 수 있는 크기를 모를 때 조각 하나의 글자 수 — 거절당하면 다음 것으로
const READ_ORDER = { material: 0, reference: 1, final: 2 };  // 나눠 읽는 차례 — 확정본은 되도록 원문 그대로 남긴다
const REPORT = new Set(['F-CONTRA', 'F-REVIEW', 'F-MERGE']);  // 원고를 고쳐 쓰지 않고 «보고»를 내는 자리
const SEAT = { task: '', name: '', role: '', craft: '' };    // 무엇이 실리는지만 볼 때 쓰는 빈 자리
const PIECE_MAX = 200000;                                    // 받을 수 있는 크기를 알 때도 조각 하나는 이만큼까지(뽑아 옮기는 호출이 원문을 고루 보게)
export const TOO_LONG = '나눠 읽어도 한 번에 실리지 않았습니다 — 다시 해 보세요';

const len = (t) => String(t || '').length;
const halted = (ctx) => !!(ctx && ctx.signal && ctx.signal.aborted);
const STOPPED = { ok: false, reason: 'stopped', error: '중지됨' };

// 문단 → 줄 → 문장 경계에서 자른다(경계가 너무 앞이면 글자 수로). 이어 붙이면 원문과 같다.
export function splitText(text, max) {
  const t = String(text || '');
  if (t.length <= max) return [t];
  const out = [];
  let i = 0;
  while (i < t.length) {
    if (t.length - i <= max) { out.push(t.slice(i)); break; }
    const win = t.slice(i, i + max);
    let cut = win.lastIndexOf('\n\n');
    if (cut < max / 2) cut = win.lastIndexOf('\n');
    if (cut < max / 2) cut = Math.max(win.lastIndexOf('. '), win.lastIndexOf('다. '), win.lastIndexOf('。'));
    cut = cut < max / 2 ? max : cut + 1;
    out.push(t.slice(i, i + cut));
    i += cut;
  }
  return out;
}

// 조각의 열쇠 — 같은 조각을 같은 일로 읽었으면 다시 부르지 않는다(합평 패널은 사람마다 같은 참조를 읽는다)
function hashOf(str) {
  let a = 0x811c9dc5; let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// 체크포인트 — 다른 쓰임(합평 패널 · 이어 쓰기)과 서로 덮어쓰지 않게 합쳐서 남긴다
export async function saveCheckpoint(ctx, patch) {
  if (!ctx || typeof ctx.save !== 'function') return;
  ctx.__cp = { ...(ctx.__cp || ctx.resume || {}), ...patch };
  await ctx.save(ctx.__cp);
}

function memo(ctx) {
  if (!ctx) return new Map();
  if (!ctx.__read) ctx.__read = new Map(Object.entries((ctx.resume && ctx.resume.reading) || {}));
  return ctx.__read;
}

// 실을 몫의 차례 — 받을 수 있는 크기를 알면(회사가 토큰 수를 알려 줌) 그 비율로 원문을 최대한 남기고, 모르면 조각 크기로.
// budget 은 이번 호출 전체(시스템 + 본문)에 실을 글자 수 — undefined 면 «문서만 조각 크기 안으로»(지금까지의 셈).
function ladderOf(fit, total, sizes) {
  const steps = [];
  if (fit && fit.tokens > 0 && fit.max > 0 && fit.tokens > fit.max) {
    const can = Math.floor(total * (fit.max / fit.tokens) * 0.85);   // 글자와 토큰의 비율이 구획마다 달라 넉넉히 덜어 둔다
    for (const k of [1, 0.6, 0.35]) {
      const budget = Math.floor(can * k);
      if (budget > sizes[0]) steps.push({ budget, piece: Math.min(PIECE_MAX, Math.max(sizes[0], Math.floor(budget / 2))) });
    }
  }
  return [...steps, ...sizes.map((s, i) => ({ piece: s, last: i === sizes.length - 1 }))];
}

/**
 * call 을 감싼다 — 모양은 그대로 call(args, ctx). store 는 작품을 읽어 무엇이 실리는지 셈하는 데만 쓴다.
 */
export function readingInParts(call, store, { sizes = PART_SIZES } = {}) {
  const wrapped = async (args, ctx) => {
    const first = await call(args, ctx);
    if (first.ok || first.reason !== 'invalid' || args.reading || args.digests || args.targetPart || args.talkCut || args.fixedDigests || args.extraDigests || halted(ctx)) return first;
    const project = await store.get(args.pid);
    if (!project) return first;
    const plan = planCall(project, args, { pr: SEAT });
    const total = len(plan.systemPrompt) + len(plan.userPrompt);
    // 가장 작은 조각보다 짧은 프롬프트의 거절은 길이 탓이 아니다(설정 · 모델 문제) — 회사의 까닭 그대로 돌려준다
    if (!first.fit && total <= sizes[sizes.length - 1]) return first;
    let r = first;
    for (const step of ladderOf(first.fit, total, sizes)) {
      r = await inParts(call, plan, project, args, ctx, step, wrapped);
      if (r.ok || r.reason !== 'invalid' || halted(ctx)) return r;
    }
    return { ...r, error: TOO_LONG };
  };
  return Object.assign(wrapped, call);   // call.raw 같은 곁문은 그대로
}

// 글 하나를 조각조각 읽어 뽑아 옮긴 것 하나로 만드는 것 — 나눠 읽기 · 에이전트 준비가 함께 쓴다.
// base() 는 읽는 호출이 받는 것(그 자리 · 사람 · 모델 · 요청사항 · 할 일). hold — 읽는 호출에 싣지 않을 지시 글(그것 자체를 따로 읽는 중일 때)
function makeReader({ call, ctx, ask, piece, base }) {
  const cache = memo(ctx);
  const remember = async (key, text) => { cache.set(key, text); await saveCheckpoint(ctx, { reading: Object.fromEntries(cache) }); };
  const readOne = async (doc, againRound = false, hold = null) => {
    const pieces = splitText(doc.text, piece);
    const outs = [];
    for (let i = 0; i < pieces.length; i++) {
      const key = hashOf(ask + '\u0001' + doc.id + '\u0001' + (againRound ? 'again' : '') + '\u0001' + pieces[i]);
      let got = cache.get(key);
      if (got == null) {
        if (ctx && ctx.gate) await ctx.gate();
        if (halted(ctx)) return STOPPED;
        if (ctx && ctx.step) ctx.step('나눠 읽기 — ' + doc.name + ' ' + (i + 1) + '/' + pieces.length);
        const b = base();
        const r = await call({ ...b, ...(hold ? { fixedDigests: { ...hold, ...(b.fixedDigests || {}) } } : {}), reading: { id: doc.id, role: doc.role, name: doc.name, k: i + 1, n: pieces.length, text: pieces[i], again: againRound } }, ctx);
        if (!r.ok) return r;
        got = r.text;
        await remember(key, got);
      }
      outs.push(pieces.length > 1 ? '〔' + (i + 1) + '/' + pieces.length + ' 부분에서〕\n' + got : got);
    }
    return { ok: true, text: outs.join('\n\n') };
  };
  return { readOne, cache, remember };
}

/**
 * 이미 지은 프롬프트로 곧장 부르는 자리(에이전트 준비의 판정 · 짓기)가 쓴다 — 자료(items)가 한 번에 실리지 않으면
 * 긴 것부터 나눠 읽어 옮긴 것으로 바꾼 목록을 돌려준다(자료 합이 size 안에 들 때까지 — 짧은 자료는 원문 그대로).
 * args = { pid, code, request, signal } — 읽는 호출의 자리 · 요청사항(«나중에 할 일»은 그 자리의 할 일)
 */
export async function digestItems(call, args, items, ctx, size) {
  const ask = 'items\u0001' + String(args.code || '') + '\u0001' + String(args.request || '');
  const { readOne } = makeReader({ call, ctx, ask, piece: size, base: () => ({ pid: args.pid, code: args.code, request: args.request, signal: args.signal, materials: false }) });
  const out = items.map((x) => ({ ...x }));
  const load = () => out.reduce((n, x) => n + len(x.text), 0);
  for (const x of [...out].sort((a, b) => len(b.text) - len(a.text))) {
    if (load() <= size) break;
    const orig = len(x.text);
    const g = await readOne({ id: x.id, role: 'material', name: x.name, text: x.text });
    if (!g.ok) return g;
    x.text = digestNote(orig) + g.text;
  }
  return { ok: true, items: out };
}

async function inParts(call, plan, project, args, ctx, { piece, budget, last = false }, again) {
  const ask = String(args.code || '') + '\u0001' + String(args.request || '') + '\u0001' + String(args.taskExtra || '');
  const fixedDigests = {};
  // 읽는 호출이 받는 것 — 그 자리 · 사람 · 모델 · 요청사항 · 할 일은 본래 호출과 같다
  const base = () => ({
    pid: args.pid, code: args.code, agentIds: args.agentIds, keepSeat: args.keepSeat, modelPick: args.modelPick, noCount: args.noCount,
    request: args.request, requestOnce: args.requestOnce, stageKey: args.stageKey, stageTier: args.stageTier,
    taskExtra: args.taskExtra, targetIds: args.targetIds, talk: args.talk, signal: args.signal,
    ...(Object.keys(fixedDigests).length ? { fixedDigests } : {}),
  });

  const { readOne, cache, remember } = makeReader({ call, ctx, ask, piece, base });

  // 실린 것들 — 부분마다 셈한다
  const docs = plan.inputs.filter((x) => x.id && x.role in READ_ORDER);
  const talk = Array.isArray(args.talk) ? args.talk : [];
  const extras = Array.isArray(args.extraTargets) ? args.extraTargets : [];
  const targets = plan.inputs.filter((x) => x.role === 'target' && x.id);
  const inputChars = plan.inputs.reduce((n, x) => n + len(x.text), 0);
  const fixedChars = len(plan.systemPrompt) + len(plan.userPrompt) - inputChars;   // 규격 · 집필 기준 · 요청사항 · 할 일 · 자리

  // ⓪ 마지막 수단 — 지시 글(요청사항 · 집필 기준 · 작품 요청사항 · 개요)이 그것만으로 몫을 넘치면 «지시 글»로 나눠 읽는다(지시는 원문 그대로 옮긴다)
  const fixedTexts = [
    ['request', '이번 요청사항', args.request],
    ['standard', '집필 기준', project.standard],
    ['projectRequest', '작품 요청사항', project.request],
    ['outline', '개요', (project.spec || {}).outline],
  ];
  const room = budget || piece;
  if (last || fixedChars > room * 0.6) {
    const huge = fixedTexts.filter(([, , text]) => len(text) > piece / 2);
    // 지시 글을 읽는 호출에는 아주 긴 지시 글들을 싣지 않는다(그것들을 지금 따로 읽는 중이다)
    const hold = Object.fromEntries(huge.map(([k]) => [k, '(이 글은 길어 따로 나눠 읽는 중이다)']));
    for (const [k, name, text] of huge) {
      const g = await readOne({ id: 'fixed:' + k, role: 'instruction', name, text }, false, hold);
      if (!g.ok) return g;
      fixedDigests[k] = g.text;
    }
  }

  // ① 긴 것부터 나눠 읽는다 — 실을 몫 안에 들 때까지. 짧은 문서는 원문 그대로 남는다.
  //    받을 수 있는 크기를 알면 몫 = 전체 몫 − (지시 · 대화 · 대상 · 보고), 모르면 문서만 조각 크기 안으로(지금까지의 셈).
  const digests = {};
  const talkLen = talk.reduce((n, m) => n + len(m.text), 0);
  const extrasLen = extras.reduce((n, x) => n + len(x.text), 0);
  const targetsLen = Math.min(targets.reduce((n, t) => n + len(t.text), 0), piece);
  const docRoom = budget ? Math.max(piece, budget - fixedChars - Math.min(talkLen, piece) - Math.min(extrasLen, piece) - targetsLen) : piece;
  const load = () => docs.reduce((n, d) => n + (digests[d.id] != null ? len(digests[d.id]) : len(d.text)), 0);
  const order = [...docs].sort((a, b) => READ_ORDER[a.role] - READ_ORDER[b.role] || len(b.text) - len(a.text));
  for (const d of order) {
    if (load() <= docRoom) break;
    const g = await readOne(d);
    if (!g.ok) return g;
    digests[d.id] = g.text;
  }
  // ② 뽑아 옮긴 것까지 넘치면 그것을 다시 모은다 — 두 번까지(그래도 넘치면 모아 쓰기가 거절당하고 더 작게 처음부터)
  for (let round = 0; round < 2 && load() > docRoom; round++) {
    for (const d of docs.filter((x) => digests[x.id] != null).sort((a, b) => len(digests[b.id]) - len(digests[a.id]))) {
      if (load() <= docRoom) break;
      const g = await readOne({ ...d, text: digests[d.id] }, true);
      if (!g.ok) return g;
      if (len(g.text) < len(digests[d.id])) digests[d.id] = g.text;
    }
  }

  // 합평 모으기가 받는 여러 합평(문서가 아닌 대상) — 넘치면 긴 것부터 나눠 읽는다
  const extraDigests = {};
  const extraLoad = () => extras.reduce((n, x, i) => n + (extraDigests[i] != null ? len(extraDigests[i]) : len(x.text)), 0);
  for (const i of extras.map((_, i) => i).sort((a, b) => len(extras[b].text) - len(extras[a].text))) {
    if (extraLoad() <= piece) break;
    const g = await readOne({ id: 'extra:' + i, role: 'extra', name: String(extras[i].name || '보고'), text: extras[i].text });
    if (!g.ok) return g;
    extraDigests[i] = g.text;
  }

  // 논의의 대화 — 넘치면 뒤쪽 마디(적어도 마지막 마디)는 원문 그대로, 앞쪽을 한 덩이로 나눠 읽는다
  let talkCut = null;
  if (talkLen > piece && talk.length > 1) {
    let keep = 0; let n = 0;
    for (let i = talk.length - 1; i >= 0; i--) { n += len(talk[i].text); if (keep && n > piece / 2) break; keep += 1; }
    const upto = talk.length - keep;
    if (upto > 0) {
      const text = talk.slice(0, upto).map((m) => '▷ ' + String(m.name || '') + '\n' + String(m.text || '')).join('\n\n');
      const g = await readOne({ id: 'talk:' + upto, role: 'talk', name: '앞선 대화', text });
      if (!g.ok) return g;
      talkCut = { upto, text: g.text };
    }
  }
  const more = {
    ...(Object.keys(extraDigests).length ? { extraDigests } : {}),
    ...(talkCut ? { talkCut } : {}),
    ...(Object.keys(fixedDigests).length ? { fixedDigests } : {}),
  };

  // ③ 모아 쓴다. 고칠 원고가 한 번에 실리지 않으면 부분씩.
  const big = targets.filter((t) => len(t.text) > piece);
  // 큰 원고가 여럿이면(모순 검사 · 합평의 대상) 가장 큰 것을 부분씩 보고, 나머지는 나눠 읽어 싣는다
  big.sort((a, b) => len(b.text) - len(a.text));
  for (const t of big.slice(1)) {
    const g = await readOne(t);
    if (!g.ok) return g;
    digests[t.id] = g.text;
  }
  const dg = Object.keys(digests).length ? digests : null;
  if (!big.length) {
    if (ctx && ctx.gate) await ctx.gate();
    if (halted(ctx)) return STOPPED;
    if (ctx && ctx.step) ctx.step('모아 쓰기');
    return call({ ...args, digests: dg, ...more }, ctx);
  }

  const T = big[0];
  const mode = REPORT.has(String(args.code || '')) ? 'report' : 'rewrite';
  const pieces = splitText(T.text, piece);
  const seen = hashOf(JSON.stringify([dg || {}, more]));
  const outs = [];
  let lastOk = null;
  for (let i = 0; i < pieces.length; i++) {
    const key = hashOf(ask + '\u0001part\u0001' + T.id + '\u0001' + seen + '\u0001' + pieces[i]);
    let got = cache.get(key);
    if (got == null) {
      if (ctx && ctx.gate) await ctx.gate();
      if (halted(ctx)) return STOPPED;
      if (ctx && ctx.step) ctx.step(T.name + ' — ' + (i + 1) + '/' + pieces.length + ' 부분');
      // 앞 부분은 이번에 새로 쓴 것의 끝을, 뒤 부분은 원문의 처음을 보여 준다(잇는 자리가 어긋나지 않게)
      const before = mode === 'rewrite' && outs.length ? outs[outs.length - 1].slice(-1500) : (pieces[i - 1] || '').slice(-1500);
      const after = (pieces[i + 1] || '').slice(0, 1500);
      const r = await call({ ...args, digests: dg, ...more, targetPart: { id: T.id, k: i + 1, n: pieces.length, text: pieces[i], mode, before, after } }, ctx);
      if (!r.ok) return r;
      lastOk = r;
      got = r.text;
      await remember(key, got);
    }
    outs.push(got);
  }
  if (mode === 'rewrite') return { ...(lastOk || {}), ok: true, text: outs.join('\n\n') };

  // 보고서꼴 — 부분 보고는 그대로 남기고, 마지막에 보고들을 견주어 부분 사이에 걸친 것을 더한다(부분 사이의 어긋남을 놓치지 않게)
  const reports = outs.map((t, i) => '## ' + T.name + ' — ' + (i + 1) + '/' + outs.length + ' 부분\n\n' + t).join('\n\n');
  if (pieces.length < 2) return { ...(lastOk || {}), ok: true, text: reports };
  const acrossKey = hashOf(ask + '\u0001across\u0001' + T.id + '\u0001' + hashOf(reports));
  let across = cache.get(acrossKey);
  if (across == null) {
    if (ctx && ctx.gate) await ctx.gate();
    if (halted(ctx)) return STOPPED;
    if (ctx && ctx.step) ctx.step(T.name + ' — 부분 사이 견주기');
    // 원고 대신 부분 보고들을 대상으로 — 이것도 넘치면 바깥의 나눠 읽기(again)가 보고를 나눠 읽는다
    const r = await again({
      pid: args.pid, code: args.code, agentIds: args.agentIds, keepSeat: args.keepSeat, modelPick: args.modelPick, noCount: args.noCount,
      request: args.request, stageKey: args.stageKey, stageTier: args.stageTier, signal: args.signal,
      targetIds: [], refIds: [], extraTargets: outs.map((t, i) => ({ id: '', name: T.name + ' — ' + (i + 1) + '/' + outs.length + ' 부분의 보고', text: t })),
      taskExtra: [args.taskExtra, ACROSS_TASK].filter((x) => String(x || '').trim()).join('\n\n'),
    }, ctx);
    if (!r.ok) return r;
    across = r.text;
    await remember(acrossKey, across);
  }
  return { ...(lastOk || {}), ok: true, text: reports + '\n\n## 부분 사이에 걸친 것\n\n' + across };
}
