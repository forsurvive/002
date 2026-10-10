// 이어 쓰기 — 응답이 길이 한도(출력 상한 · 시간 초과 · 끊긴 연결)에 닿아 끊기면 끊긴 자리부터 잇는다.
// 2026-10-10 사용자 지시: «생성/참조되는 문서와 요청사항의 내용이 매우 길더라도 실패없이» · «생성 결과가 잘려서도 안돼» (docs/EBOOK_EDITION.md §5-1).
//
// call 을 감싼다 — 모양은 그대로 call(args, ctx). 부른 결과가 잘림(finishReason 'length')이면
// 같은 것을 싣고 «이미 쓴 부분»(끊긴 응답)을 더해 다시 부르고(core/reference/plan.mjs 의 continueFrom), 받은 것을 이어 붙인다.
//   · 끝(다 썼다)이 올 때까지 잇는다 — 횟수로 끊지 않는다. 나아가지 않고 같은 자리를 맴돌 때만 멈춘다(안전망).
//   · 잇다가 잠깐 밀리면(밀림 · 과부하 · 시간 초과 · 빈 응답 · 연결) 사이를 두고 다시 부른다.
//   · «이미 쓴 부분»까지 실어 한 번에 실리지 않으면 이미 쓴 부분의 끝쪽만 싣고 잇는다(통째 → 끝 20만 자 → 5만 자 → 1만 자).
//   · **잘린 글을 결과로 내지 않는다** — 끝내 잇지 못하면 실패로 돌려준다(기존 글은 그대로). 입력이 너무 길어서면(invalid)
//     바깥의 나눠 읽기(reading.mjs)가 입력을 줄여 처음부터 다시 쓴다. 이은 데까지는 체크포인트(cont)에 남아 다시 시도할 때 그 자리부터 잇는다.
// 사람이 세우면 그대로 멈춘다.

import { saveCheckpoint } from './reading.mjs';
import { continueTask, neutralize, writtenOf } from '../prompt/assemble.mjs';

export const CONTINUE_GUARD = 24;                   // 안전망 — 한 번의 부르기를 이만큼 이어도 끝나지 않으면 맴도는 것으로 본다(128K 출력이면 수백만 자)
export const TAILS = [200000, 50000, 10000];         // 이미 쓴 부분이 통째로 실리지 않을 때 싣는 끝쪽의 길이(차례로)
const PASSING = new Set(['rate', 'overloaded', 'timeout', 'other', 'empty']);
const WAITS = [3000, 10000, 30000, 60000];
const halted = (ctx) => !!(ctx && ctx.signal && ctx.signal.aborted);
const STOPPED = { ok: false, reason: 'stopped', error: '중지됨' };
const pause = (ms, signal) => new Promise((done) => {
  if (!(ms > 0)) return done();
  const t = setTimeout(done, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
});

// 이 부르기의 열쇠 — 같은 부르기를 다시 할 때만 체크포인트의 이은 글을 쓴다(참조 · 요청사항이 바뀌었으면 처음부터)
function keyOf(args) {
  const { signal, continueFrom, ...rest } = args || {};
  const str = JSON.stringify(rest);
  let a = 0x811c9dc5; let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// 이어 붙인다 — 이어 쓴 조각이 앞 응답의 끝을 되풀이했으면 겹친 만큼 걷는다(20자 이상 겹칠 때만 — 우연히 같은 짧은 말은 그대로).
// 잇는 자리의 빈 줄은 둘까지만.
export function joinContinued(prev, next) {
  const a = String(prev || '');
  let b = String(next || '').replace(/\r\n/g, '\n');
  const tail = a.slice(-2000);
  for (let k = Math.min(tail.length, b.length); k >= 20; k--) {
    if (tail.endsWith(b.slice(0, k))) { b = b.slice(k); break; }
  }
  const joined = a + b;
  const at = a.length;
  // 잇는 자리 둘레에서만 세 줄 넘는 빈 줄을 줄인다(본문의 다른 곳은 손대지 않는다)
  const lo = Math.max(0, at - 4); const hi = Math.min(joined.length, at + 4);
  return joined.slice(0, lo) + joined.slice(lo, hi).replace(/\n{3,}/g, '\n\n') + joined.slice(hi);
}

/**
 * raw — 이미 지은 프롬프트로 곧장 부르는 문(에이전트 준비의 판정 · 짓기, { systemPrompt, prompt, … })을 감쌀 때.
 *       그때는 «이미 쓴 부분»과 이어 쓰기 할 일을 프롬프트 끝에 덧붙인다.
 */
export function continuing(call, { raw = false, guard = CONTINUE_GUARD, waits = WAITS, tails = TAILS } = {}) {
  const nextArgs = (args, text, n, tail) => (raw
    ? { ...args, continued: true, prompt: String(args.prompt || '') + '\n\n■ 이미 쓴 부분(끊긴 응답)\n' + neutralize(writtenOf(text, tail)) + '\n\n■ 이어 쓰기\n' + continueTask({ n, text }) }
    : { ...args, continueFrom: { text, n, tail } });

  const wrapped = async (args, ctx) => {
    if (args && (args.continueFrom || args.continued)) return call(args, ctx);   // 이미 잇는 부르기
    const key = keyOf(args);
    const kept = ctx && ctx.resume && ctx.resume.cont && ctx.resume.cont.key === key ? String(ctx.resume.cont.text || '') : '';
    const first = kept ? { ok: true, text: kept, finishReason: 'length' } : await call(args, ctx);
    if (!first.ok || first.finishReason !== 'length') return first;
    if (halted(ctx)) return STOPPED;

    let text = first.text;
    let last = first;
    let n = 0;
    let stuck = 0;
    while (last.finishReason === 'length') {
      // 받은 데까지를 먼저 남긴다 — 여기서 일시중지(gate)로 내려놓아도 이어 하기가 이 자리부터 잇는다
      await saveCheckpoint(ctx, { cont: { key, text } });
      if (ctx && ctx.gate) await ctx.gate();
      if (halted(ctx)) return STOPPED;
      // 맴돎은 다시 해도 같다 — 자동 재시도 갈래(other)가 아닌 runaway 로
      if (n >= guard) return { ok: false, reason: 'runaway', error: '이어 쓰기가 끝나지 않고 맴돌았습니다 — 요청을 나눠 다시 해 보세요' };
      n += 1;
      if (ctx && ctx.step) ctx.step('이어 쓰기 ' + n);
      let c = null;
      // 이미 쓴 부분은 통째(0)로 — 한 번에 실리지 않으면(invalid) 지금 글보다 짧은 끝쪽만 차례로. 잠깐의 실패는 사이를 두고 다시.
      for (const tail of [0, ...tails.filter((t) => t > 0 && t < text.length)]) {
        for (let i = 0; i <= waits.length; i++) {
          c = await call(nextArgs(args, text, n, tail), ctx);
          if (c.ok || halted(ctx) || !PASSING.has(c.reason || 'other')) break;
          if (i < waits.length) await pause(waits[i], ctx && ctx.signal);
        }
        if (c.ok || halted(ctx) || c.reason !== 'invalid') break;
      }
      if (halted(ctx) || c.reason === 'stopped') return STOPPED;
      // 끝내 잇지 못했다 — 잘린 글을 결과로 내지 않는다. 까닭(갈래) 그대로 바깥에(입력이 너무 길면 나눠 읽기가 받는다).
      if (!c.ok) return { ...c, ok: false, continued: n - 1 };
      const before = text.length;
      text = joinContinued(text, c.text);
      stuck = text.length - before < 20 ? stuck + 1 : 0;   // 거의 나아가지 않았다
      if (stuck >= 3) return { ok: false, reason: 'runaway', error: '이어 쓰기가 더 나아가지 않았습니다 — 요청을 나눠 다시 해 보세요' };
      last = c;
    }
    await saveCheckpoint(ctx, { cont: null });
    return { ...last, ok: true, text: text.replace(/\s+$/, ''), finishReason: last.finishReason || 'stop', continued: n };
  };
  return Object.assign(wrapped, call);   // call.raw 같은 곁문은 그대로
}
