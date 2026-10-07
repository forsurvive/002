// 클로드 호출 하나 — 시스템 프롬프트 파일 + stdin 프롬프트 → stream-json 파싱 → 최종 텍스트.
// 계약: 절대 reject 하지 않는다. 모든 실패는 { ok:false, error, reason } 으로 돌아온다.
// SE2_MOCK=1 이면 실행기를 띄우지 않고 결정적 가짜 응답을 낸다(시험용 — 구독 소모 0).
//
// 실측으로 정한 것들(2026-09-22):
//
// · `--tools ''` 는 **내장 도구만** 끈다. 그대로 두면 MCP 커넥터가 준 도구가 그대로 실린다 —
//   이 PC 에서 재어 보니 도구 19개(전부 mcp__*)와 서버 여섯(Google Drive·Gmail·Calendar 포함),
//   스킬 28, 플러그인 1 이 붙었다. 남의 PC 에서 돌 프로그램이므로 남의 메일·드라이브 도구가
//   소설 집필 호출에 딸려 가는 셈이다. `--strict-mcp-config` 로 도구와 서버가 0 이 되고,
//   `--setting-sources ''` 로 스킬 18·플러그인 0 까지 내려간다. 쓰지도 않을 도구 정의가
//   입력 토큰에 실리는 낭비도 함께 사라지고, 사람마다 다른 결과가 나오던 것도 멎는다.
// · `cwd` 를 주지 않으면 그 자리의 CLAUDE.md·.claude/ 가 자동 발견된다 — 시스템 프롬프트 파일을
//   두려고 이미 만드는 빈 임시 폴더를 그대로 `cwd` 로 준다.
// · stream-json 에 `rate_limit_event` 가 흐른다. 한도를 문구로 긁을 필요가 없다 —
//   status('allowed'|'allowed_warning'|'rejected') · rateLimitType('five_hour'|'seven_day') ·
//   resetsAt(유닉스 초) · utilization(0~1) · unifiedWindows 가 구조화된 칸으로 온다.
//   성공한 호출에도 오므로 «닿기 전에» 남은 양을 알 수 있다.
// · `result` 이벤트에 `api_error_status`(402·401·429·404) · `terminal_reason` · `total_cost_usd` 가 있다.
//   `subtype` 은 «대화 루프가 어떻게 끝났나»이고 «왜 실패했나»가 아니므로 한도 판별에 쓰지 않는다.
// · 프롬프트 캐시는 잘 물린다 — 호출마다 새 임시 파일로 새 세션을 띄워도 이어진다
//   (실측: 첫 호출 캐시쓰기 39,283 · 둘째 호출 캐시읽기 38,851, 값이 16배 싸다).
//   처음에 0 으로 보인 것은 시험 프롬프트가 캐시 최소 길이 아래였던 탓이다. 그러니 이 방식을 바꾸지 않는다.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCliDetailed, childEnv } from './claude-cli.mjs';
import * as auth from './auth.mjs';

const R = resolveCliDetailed();
export const CLI = R.cli;
export const CLI_INFO = R;
export const MOCK = process.env.SE2_MOCK === '1';
export const CALL_TIMEOUT_MS = Math.max(60000, Number(process.env.SE2_CALL_TIMEOUT_MS) || 30 * 60 * 1000);

const LIVE = new Set();

export { MODELS } from './store.mjs';   // 고를 수 있는 모델 — 빈 값은 없다

// 실패의 «갈래». 화면과 작업이 이것으로 갈라 움직인다.
// error 문구에는 원고가 섞일 수 있다 — 이 PC 밖으로 내보내지 않는다. 어디로 알릴 일이 생기면 이 코드만 보낸다.
export const REASONS = [
  'quota-session',  // 다섯 시간 창을 다 썼다 — 곧 풀린다
  'quota-week',     // 주간 창을 다 썼다 — 오래 걸린다
  'rate',           // 잠깐 밀렸다 — 다시 부르면 된다
  'auth',           // 로그인이 필요하다
  'credit',         // API 크레딧이 모자라다
  'model',          // 그 모델을 쓸 수 없다
  'timeout',        // 시간을 넘겼다
  'stopped',        // 사람이 세웠다
  'empty',          // 보낼 것이 없다
  'other',
];

const SAY = {
  'quota-session': '구독 한도를 다 썼습니다',
  'quota-week': '주간 구독 한도를 다 썼습니다',
  rate: '잠시 밀렸습니다',
  auth: '클로드 로그인이 필요합니다',
  credit: 'API 크레딧이 모자랍니다',
  model: '그 모델을 쓸 수 없습니다',
  timeout: '응답 없음',
  stopped: '중지됨',
  empty: '빈 프롬프트',
};

// 마지막으로 본 한도 — 화면이 «남은 양»을 보여 줄 재료. 호출이 흐르는 동안만 갱신된다.
let LAST_LIMIT = null;
export function lastLimit() { return LAST_LIMIT; }
export function forgetLimit() { LAST_LIMIT = null; }   // 시험이 쓴다

// 동시에 띄우는 호출 수에 고삐를 둔다.
// 앤트로픽 약관이 「Advertised usage limits … assume ordinary, individual usage」라고 적었고,
// 지금까지는 상한이 아예 없었다 — 문서 열 개를 골라 [생성]을 누르면 claude.exe 열 개가 동시에 떴다.
// (jobs.mjs 의 ctx.gate() 는 [멈춤] 단추를 눌렀을 때만 서므로 동시성 장치가 아니다.)
export const MAX_CALLS = Math.max(1, Number(process.env.SE2_MAX_CALLS) || 3);
const WAITING = [];
let running = 0;

export function callsRunning() { return running; }
export function callsWaiting() { return WAITING.length; }

function acquire(signal) {
  if (running < MAX_CALLS) { running += 1; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const entry = { resolve, signal, done: false };
    const take = (got) => { if (!entry.done) { entry.done = true; resolve(got); } };
    entry.take = take;
    WAITING.push(entry);
    if (signal) {
      signal.addEventListener('abort', () => {
        const i = WAITING.indexOf(entry);
        if (i >= 0) WAITING.splice(i, 1);
        take(false);
      }, { once: true });
    }
  });
}

function release() {
  running = Math.max(0, running - 1);
  while (WAITING.length && running < MAX_CALLS) {
    const e = WAITING.shift();
    if (e.signal && e.signal.aborted) { e.take(false); continue; }
    running += 1;
    e.take(true);
  }
}

export function buildCallArgs(systemPromptFile, model) {
  const m = String(model || '').trim();
  return [
    '-p',
    '--system-prompt-file', systemPromptFile,
    '--output-format', 'stream-json', '--verbose',
    ...(m ? ['--model', m] : []),
    // 남의 것이 딸려 오지 않게 — 커넥터·설정·스킬·플러그인을 걷는다(위 머리글의 실측 근거).
    '--strict-mcp-config',
    '--setting-sources', '',
    '--tools', '',            // 값을 여럿 받는 깃발이라 반드시 맨 뒤에 둔다
  ];
}

export function killTree(p) {
  try { p.kill(); } catch {}
  if (process.platform === 'win32' && p.pid) {
    try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  }
}

export function killAllCalls() {
  for (const p of LIVE) killTree(p);
  LIVE.clear();
}

// 실패의 갈래를 가른다. **구조화된 칸을 먼저 보고, 문구는 마지막 수단이다** —
// 그래야 앤트로픽이 문구를 바꿔도 깨지지 않는다.
export function classify({ limitInfo = null, finalResult = null, stderr = '', aborted = false, timedOut = false } = {}) {
  if (aborted) return 'stopped';
  if (timedOut) return 'timeout';

  // ① 한도는 제 칸으로 온다
  if (limitInfo && limitInfo.status === 'rejected') {
    return limitInfo.rateLimitType === 'five_hour' ? 'quota-session' : 'quota-week';
  }

  // ② HTTP 상태로 거의 다 갈린다
  const st = Number(finalResult && finalResult.api_error_status) || 0;
  if (st === 402) return 'credit';
  if (st === 401 || st === 403) return 'auth';
  if (st === 404) return 'model';
  if (st === 429 || (st >= 500 && st < 600)) return 'rate';

  // ③ 그래도 안 갈리면 문구를 본다
  const t = String((finalResult && finalResult.result) || '') + ' ' + String(stderr || '');
  if (/credit balance/i.test(t)) return 'credit';
  if (/(usage|rate)\s*limit|한도|too many requests/i.test(t)) return 'quota-session';
  if (/invalid api key|invalid auth token|oauth token|not logged in|please run .?(\/)?login|authenticat/i.test(t)) return 'auth';
  if (/overloaded/i.test(t)) return 'rate';
  return 'other';
}

// 가짜 응답 — 시험이 자동 집필을 끝까지 돌 수 있도록 단계별 구조를 흉내낸다.
// globalThis.__SE2_MOCK_FN 을 두면 시험이 단계별 응답을 직접 정한다.
// 문자열이 아니라 { text, reason, limit } 를 돌려주면 실패와 한도까지 흉내낼 수 있다.
export function mockResponse({ mockKey, prompt, systemPrompt, model }) {
  if (typeof globalThis.__SE2_MOCK_FN === 'function') {
    const r = globalThis.__SE2_MOCK_FN({ mockKey, prompt, systemPrompt, model });
    if (typeof r === 'string') return r;
    if (r && typeof r === 'object') return r;
  }
  const k = String(mockKey || 'mock');
  // 제어 호출은 형식이 정해져 있다 — 모의로 돌려도 그 형식을 지킨다.
  if (k === 'F-KIND') return '분류: 소설\n모의 판정.';
  if (k === 'F-AGENT') return '이름: 모의 집필자\n역할: 그 자리의 일을 한다\n할 일: 문서를 쓴다\n작법:\n' + '모의 작법. '.repeat(240);
  return '(모의) ' + k + ' — 받은 프롬프트 ' + String(prompt || '').length + '자에 대한 응답 본문.';
}

// 돌려주는 값: { ok, text, error, reason, elapsedMs, usage, limit, authSource }
// authMode · cli 는 온라인판의 «운영자 구독» 길이 넘긴다(ai/subscription.mjs) — 개인판은 넘기지 않는다(그 PC 의 auth.json · 탐색한 실행기를 따른다).
export async function runClaudeCall({ systemPrompt, prompt, mockKey, signal, model, authMode = null, cli = null } = {}) {
  const started = Date.now();
  const fail = (error, reason = 'other', limit = null) => {
    const say = SAY[reason] || '';
    const detail = String(error || '').trim();
    return {
      ok: false,
      text: '',
      // 이 문구는 그 PC 안에서만 쓴다 — 밖으로 올리는 것은 reason 뿐이다.
      error: say ? (detail && detail !== say ? say + ' — ' + detail : say) : (detail || '알 수 없는 오류'),
      reason,
      elapsedMs: Date.now() - started,
      usage: null,
      limit,
      authSource: '',
    };
  };
  if (!prompt || !String(prompt).trim()) return fail('보낼 것이 없습니다', 'empty');
  if (signal && signal.aborted) return fail('', 'stopped');

  if (MOCK) {
    await new Promise((r) => setTimeout(r, Number(process.env.SE2_MOCK_DELAY_MS) || 3));
    if (signal && signal.aborted) return fail('', 'stopped');
    const m = mockResponse({ mockKey, prompt, systemPrompt, model });
    if (typeof m === 'object') {
      if (m.limit) LAST_LIMIT = m.limit;
      if (m.reason) return fail(m.error || '', m.reason, m.limit || null);
      return {
        ok: true, text: String(m.text || ''), error: null, reason: null,
        elapsedMs: Date.now() - started, usage: null, limit: m.limit || null, authSource: 'mock',
      };
    }
    return {
      ok: true, text: m, error: null, reason: null,
      elapsedMs: Date.now() - started, usage: null, limit: null, authSource: 'mock',
    };
  }

  // 고삐 — 자리가 날 때까지 기다린다(기다리는 동안 세우면 그대로 물러난다).
  const got = await acquire(signal);
  if (!got) return fail('', 'stopped');

  let dir = null;
  let p = null;
  let stderr = '';
  let onAbort = null;
  try {
    // **이 프로그램이 폴더 밖에 쓰는 것은 이 한 벌뿐이다** — 호출 하나가 끝나면(finally) 지운다.
    // 폴더 안(data\)에 두지 않는 까닭: cwd 가 이 폴더 아래면 클로드가 거슬러 올라가며
    // 이 폴더의 .claude/ 와 깃 저장소를 주워 싣는다. 아무것도 없는 빈 자리여야 한다.
    dir = mkdtempSync(join(tmpdir(), 'se2-call-'));
    const spFile = join(dir, 'system-prompt.txt');
    writeFileSync(spFile, String(systemPrompt || ''), 'utf8');
    // cwd 를 빈 임시 폴더로 못박는다 — 그 자리의 CLAUDE.md 가 딸려 오지 않게.
    // 고른 갈래를 따른다 — 구독인지 API 키인지는 사람이 정한다(tools/auth.mjs).
    p = spawn(cli || CLI, buildCallArgs(spFile, model), { env: childEnv(authMode ? { mode: authMode } : auth.read()), windowsHide: true, cwd: dir });
    LIVE.add(p);
    try { p.stdin.write(String(prompt), 'utf8'); } catch {}
    try { p.stdin.end(); } catch {}

    let buf = '';
    let finalResult = null;
    let limitInfo = null;
    let authSource = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'result') finalResult = ev;
        // 한도는 제 이벤트로 온다 — 성공한 호출에도 흐른다.
        else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
          limitInfo = ev.rate_limit_info;
          LAST_LIMIT = { ...limitInfo, at: Date.now() };
        }
        // 무엇으로 돈이 나갔는가 — 구독인지 API 키인지. 화면에 반드시 보여 준다.
        else if (ev.type === 'system' && ev.subtype === 'init') authSource = String(ev.apiKeySource || '');
      }
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (s) => { stderr += s; });

    let timedOut = false;
    let aborted = false;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { timedOut = true; killTree(p); }, CALL_TIMEOUT_MS);
      if (signal) {
        onAbort = () => { aborted = true; killTree(p); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      p.on('error', (e) => { stderr += String(e.message || e); clearTimeout(timer); resolve(); });
      p.on('close', () => { clearTimeout(timer); resolve(); });
    });

    const why = () => classify({ limitInfo, finalResult, stderr, aborted, timedOut });

    if (aborted) return fail('', 'stopped', limitInfo);
    if (timedOut) return fail(Math.round(CALL_TIMEOUT_MS / 60000) + '분 초과로 끊었습니다', 'timeout', limitInfo);
    if (!finalResult) return fail(String(stderr || '결과 없음').slice(0, 600), why(), limitInfo);
    if (finalResult.is_error) {
      return fail(String(finalResult.result || stderr || '').slice(0, 600), why(), limitInfo);
    }

    const u = finalResult.usage || {};
    return {
      ok: true,
      text: String(finalResult.result || ''),
      error: null,
      reason: null,
      elapsedMs: Date.now() - started,
      usage: {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
        // 「이번 달 당신의 소모」를 보여 줄 유일한 값 — 전에는 버리고 있었다.
        costUsd: Number(finalResult.total_cost_usd) || 0,
      },
      limit: limitInfo,
      authSource,
    };
  } catch (e) {
    return fail((stderr ? stderr + ' | ' : '') + String((e && e.message) || e), 'other');
  } finally {
    if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch {} }
    if (p) { LIVE.delete(p); killTree(p); }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
    release();
  }
}
