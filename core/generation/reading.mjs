// 나눠 읽기 — 한 번에 실리지 않는 생성을 자르지 않고 해낸다(2026-10-08 사용자 지시:
// «문서를 쪼개서 작업하든 어떻게 하든 참조된 문서와 수정/생성할 문서, 요청사항 모두 결과에 반드시 반영되어야 해»).
//
// 처음에는 늘 통째로 부른다(실리면 아무것도 바꾸지 않는다). «입력이 너무 깁니다»(invalid)로 거절당하면:
//   ① 자료 · 참조 · 확정본 가운데 긴 것부터 조각으로 나눠 읽는다 — 조각마다 «나중에 할 일»과 요청사항을 보여 주고
//      반영할 것을 빠짐없이 뽑아 옮기게 한다(문구: core/prompt/assemble.mjs 의 readTask). 확정본은 맨 나중에, 짧은 문서는 원문 그대로 둔다.
//   ② 뽑아 옮긴 것까지 넘치면 그것을 다시 모은다(빠뜨리지 않고 겹친 것만 합친다).
//   ③ 모아 쓴다 — 뽑아 옮긴 것 + 고칠 원고 통째 + 요청사항 통째. 원고 자체가 한 번에 실리지 않으면 원고를 부분으로 나눠
//      부분마다 같은 참조 · 요청사항으로 쓰고 잇는다(보고서꼴 — 모순 검사 · 합평 — 은 부분마다 따로 보고 묶는다).
// 그래도 거절당하면 조각을 반으로 줄여 처음부터 다시 한다. 읽은 조각은 기억해 두어(체크포인트) 다시 걸어도 다시 부르지 않는다.

import { planCall } from '../reference/plan.mjs';

export const PART_SIZES = [60000, 30000, 15000];           // 조각 하나의 글자 수 — 거절당하면 다음 것으로
const READ_ORDER = { material: 0, reference: 1, final: 2 };  // 나눠 읽는 차례 — 확정본은 되도록 원문 그대로 남긴다
const REPORT = new Set(['F-CONTRA', 'F-REVIEW', 'F-MERGE']);  // 원고를 고쳐 쓰지 않고 «보고»를 내는 자리
const SEAT = { task: '', name: '', role: '', craft: '' };    // 무엇이 실리는지만 볼 때 쓰는 빈 자리
export const TOO_LONG = '나눠 읽어도 한 번에 실리지 않았습니다 — 논의의 대화가 너무 길면 새 스레드로 이어 가 주세요';

const len = (t) => String(t || '').length;
const halted = (ctx) => !!(ctx && ctx.signal && ctx.signal.aborted);

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

// 체크포인트 — 다른 쓰임(합평 패널)과 서로 덮어쓰지 않게 합쳐서 남긴다
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

/**
 * call 을 감싼다 — 모양은 그대로 call(args, ctx). store 는 작품을 읽어 무엇이 실리는지 셈하는 데만 쓴다.
 */
export function readingInParts(call, store, { sizes = PART_SIZES } = {}) {
  const wrapped = async (args, ctx) => {
    const first = await call(args, ctx);
    if (first.ok || first.reason !== 'invalid' || args.reading || args.digests || args.targetPart || halted(ctx)) return first;
    const project = await store.get(args.pid);
    if (!project) return first;
    const plan = planCall(project, args, { pr: SEAT });
    let r = first;
    for (const size of sizes) {
      r = await inParts(call, plan, args, ctx, size);
      if (r.ok || r.reason !== 'invalid' || halted(ctx)) return r;
    }
    return { ...r, error: TOO_LONG };
  };
  return Object.assign(wrapped, call);   // call.raw 같은 곁문은 그대로
}

async function inParts(call, plan, args, ctx, size) {
  const cache = memo(ctx);
  const remember = async (key, text) => { cache.set(key, text); await saveCheckpoint(ctx, { reading: Object.fromEntries(cache) }); };
  // 읽는 호출이 받는 것 — 그 자리 · 사람 · 모델 · 요청사항 · 할 일은 본래 호출과 같다
  const base = {
    pid: args.pid, code: args.code, agentIds: args.agentIds, keepSeat: args.keepSeat, modelPick: args.modelPick, noCount: args.noCount,
    request: args.request, requestOnce: args.requestOnce, stageKey: args.stageKey, stageTier: args.stageTier,
    taskExtra: args.taskExtra, targetIds: args.targetIds, talk: args.talk, signal: args.signal,
  };
  const ask = String(args.code || '') + '\u0001' + String(args.request || '') + '\u0001' + String(args.taskExtra || '');

  // 문서 하나를 조각조각 읽어 뽑아 옮긴 것 하나로
  const readOne = async (doc, again = false) => {
    const pieces = splitText(doc.text, size);
    const outs = [];
    for (let i = 0; i < pieces.length; i++) {
      const key = hashOf(ask + '\u0001' + doc.id + '\u0001' + (again ? 'again' : '') + '\u0001' + pieces[i]);
      let got = cache.get(key);
      if (got == null) {
        if (ctx && ctx.gate) await ctx.gate();
        if (halted(ctx)) return { ok: false, reason: 'stopped', error: '중지됨' };
        if (ctx && ctx.step) ctx.step('나눠 읽기 — ' + doc.name + ' ' + (i + 1) + '/' + pieces.length);
        const r = await call({ ...base, reading: { id: doc.id, role: doc.role, name: doc.name, k: i + 1, n: pieces.length, text: pieces[i], again } }, ctx);
        if (!r.ok) return r;
        got = r.text;
        await remember(key, got);
      }
      outs.push(pieces.length > 1 ? '〔' + (i + 1) + '/' + pieces.length + ' 부분에서〕\n' + got : got);
    }
    return { ok: true, text: outs.join('\n\n') };
  };

  // ① 긴 것부터 나눠 읽는다 — 실을 몫(size) 안에 들 때까지. 짧은 문서는 원문 그대로 남는다.
  const docs = plan.inputs.filter((x) => x.id && x.role in READ_ORDER);
  const digests = {};
  const load = () => docs.reduce((n, d) => n + (digests[d.id] != null ? len(digests[d.id]) : len(d.text)), 0);
  const order = [...docs].sort((a, b) => READ_ORDER[a.role] - READ_ORDER[b.role] || len(b.text) - len(a.text));
  for (const d of order) {
    if (load() <= size) break;
    const g = await readOne(d);
    if (!g.ok) return g;
    digests[d.id] = g.text;
  }
  // ② 뽑아 옮긴 것까지 넘치면 그것을 다시 모은다 — 두 번까지(그래도 넘치면 모아 쓰기가 거절당하고 더 작은 조각으로 처음부터)
  for (let round = 0; round < 2 && load() > size; round++) {
    for (const d of docs.filter((x) => digests[x.id] != null).sort((a, b) => len(digests[b.id]) - len(digests[a.id]))) {
      if (load() <= size) break;
      const g = await readOne({ ...d, text: digests[d.id] }, true);
      if (!g.ok) return g;
      if (len(g.text) < len(digests[d.id])) digests[d.id] = g.text;
    }
  }

  // ③ 모아 쓴다. 고칠 원고가 한 번에 실리지 않으면 부분씩.
  const targets = plan.inputs.filter((x) => x.role === 'target' && x.id);
  const big = targets.filter((t) => len(t.text) > size);
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
    if (halted(ctx)) return { ok: false, reason: 'stopped', error: '중지됨' };
    if (ctx && ctx.step) ctx.step('모아 쓰기');
    return call({ ...args, digests: dg }, ctx);
  }

  const T = big[0];
  const mode = REPORT.has(String(args.code || '')) ? 'report' : 'rewrite';
  const pieces = splitText(T.text, size);
  const seen = hashOf(JSON.stringify(dg || {}));
  const outs = [];
  let last = null;
  for (let i = 0; i < pieces.length; i++) {
    const key = hashOf(ask + '\u0001part\u0001' + T.id + '\u0001' + seen + '\u0001' + pieces[i]);
    let got = cache.get(key);
    if (got == null) {
      if (ctx && ctx.gate) await ctx.gate();
      if (halted(ctx)) return { ok: false, reason: 'stopped', error: '중지됨' };
      if (ctx && ctx.step) ctx.step(T.name + ' — ' + (i + 1) + '/' + pieces.length + ' 부분');
      // 앞 부분은 이번에 새로 쓴 것의 끝을, 뒤 부분은 원문의 처음을 보여 준다(잇는 자리가 어긋나지 않게)
      const before = mode === 'rewrite' && outs.length ? outs[outs.length - 1].slice(-1500) : (pieces[i - 1] || '').slice(-1500);
      const after = (pieces[i + 1] || '').slice(0, 1500);
      const r = await call({ ...args, digests: dg, targetPart: { id: T.id, k: i + 1, n: pieces.length, text: pieces[i], mode, before, after } }, ctx);
      if (!r.ok) return r;
      last = r;
      got = r.text;
      await remember(key, got);
    }
    outs.push(got);
  }
  const text = mode === 'rewrite'
    ? outs.join('\n\n')
    : outs.map((t, i) => '## ' + T.name + ' — ' + (i + 1) + '/' + outs.length + ' 부분\n\n' + t).join('\n\n');
  return { ...(last || {}), ok: true, text };
}
