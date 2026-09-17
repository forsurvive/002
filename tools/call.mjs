// 클로드 호출 하나 — 시스템 프롬프트 파일 + stdin 프롬프트 → stream-json 파싱 → 최종 텍스트.
// 계약: 절대 reject 하지 않는다. 모든 실패는 { ok:false, error } 로 돌아온다.
// SE2_MOCK=1 이면 실행기를 띄우지 않고 결정적 가짜 응답을 낸다(시험용 — 구독 소모 0).

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCliDetailed, childEnv } from './claude-cli.mjs';

const R = resolveCliDetailed();
export const CLI = R.cli;
export const CLI_INFO = R;
export const MOCK = process.env.SE2_MOCK === '1';
export const CALL_TIMEOUT_MS = Math.max(60000, Number(process.env.SE2_CALL_TIMEOUT_MS) || 30 * 60 * 1000);

const LIVE = new Set();

export function buildCallArgs(systemPromptFile) {
  return [
    '-p',
    '--system-prompt-file', systemPromptFile,
    '--output-format', 'stream-json', '--verbose',
    '--tools', '',
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

// 가짜 응답 — 시험이 자동 집필을 끝까지 돌 수 있도록 단계별 구조를 흉내낸다.
// globalThis.__SE2_MOCK_FN 을 두면 시험이 단계별 응답을 직접 정한다.
export function mockResponse({ mockKey, prompt, systemPrompt }) {
  if (typeof globalThis.__SE2_MOCK_FN === 'function') {
    const r = globalThis.__SE2_MOCK_FN({ mockKey, prompt, systemPrompt });
    if (typeof r === 'string') return r;
  }
  const k = String(mockKey || 'mock');
  // 제어 호출은 형식이 정해져 있다 — 모의로 돌려도 그 형식을 지킨다.
  if (k === 'F-KIND') return '분류: 소설\n모의 판정.';
  if (k === 'F-AGENT') return '이름: 모의 집필자\n역할: 그 자리의 일을 한다\n할 일: 문서를 쓴다\n작법:\n' + '모의 작법. '.repeat(240);
  if (k === 'F-COUNT') return '3';
  return '(모의) ' + k + ' — 받은 프롬프트 ' + String(prompt || '').length + '자에 대한 응답 본문.';
}

// 돌려주는 값: { ok, text, error, elapsedMs, usage }
export async function runClaudeCall({ systemPrompt, prompt, mockKey, signal } = {}) {
  const started = Date.now();
  const fail = (error) => ({
    ok: false, text: '', error: String(error || '알 수 없는 오류'),
    elapsedMs: Date.now() - started, usage: null,
  });
  if (!prompt || !String(prompt).trim()) return fail('빈 프롬프트');
  if (signal && signal.aborted) return fail('중지됨');

  if (MOCK) {
    await new Promise((r) => setTimeout(r, Number(process.env.SE2_MOCK_DELAY_MS) || 3));
    if (signal && signal.aborted) return fail('중지됨');
    return { ok: true, text: mockResponse({ mockKey, prompt, systemPrompt }), error: null, elapsedMs: Date.now() - started, usage: null };
  }

  let dir = null;
  let p = null;
  let stderr = '';
  let onAbort = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'se2-call-'));
    const spFile = join(dir, 'system-prompt.txt');
    writeFileSync(spFile, String(systemPrompt || ''), 'utf8');
    p = spawn(CLI, buildCallArgs(spFile), { env: childEnv(), windowsHide: true });
    LIVE.add(p);
    try { p.stdin.write(String(prompt), 'utf8'); } catch {}
    try { p.stdin.end(); } catch {}

    let buf = '';
    let finalResult = null;
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

    if (aborted) return fail('중지됨');
    if (timedOut) return fail('응답 없음 — ' + Math.round(CALL_TIMEOUT_MS / 60000) + '분 초과로 끊음');
    if (!finalResult) return fail((stderr || '결과 없음').slice(0, 1500));
    if (finalResult.is_error) return fail(String(finalResult.result || stderr || '오류').slice(0, 1500));

    const u = finalResult.usage || {};
    return {
      ok: true,
      text: String(finalResult.result || ''),
      error: null,
      elapsedMs: Date.now() - started,
      usage: {
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        cacheWrite: u.cache_creation_input_tokens || 0,
      },
    };
  } catch (e) {
    return fail((stderr ? stderr + ' | ' : '') + String((e && e.message) || e));
  } finally {
    if (signal && onAbort) { try { signal.removeEventListener('abort', onAbort); } catch {} }
    if (p) { LIVE.delete(p); killTree(p); }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
}
