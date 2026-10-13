// ChatGPT 구독으로 부르는 길 — OpenAI 의 Codex CLI(`codex exec`)를 그대로 띄운다(docs/PERSONAL_USB.md §8).
// 클로드 실행기(claude-cli.mjs)와 같은 결: 실행기 찾기 · 로그인 확인 · 인자 짓기 · 출력 읽기. 띄우는 일은 call.mjs 가 한다(임시 폴더 · 고삐 · 끊기).
//
// 조사로 정한 것(2026-10-13, @openai/codex 0.162.1 — 로그인 없이 --help 와 빈 HOME 으로만 확인. 실제 호출은 확인 못 함):
//   · 프롬프트는 stdin(`-`), 끝 글은 `-o <파일>` 에 적힌다. `--json` 은 JSONL 사건(thread.started · item.completed · turn.completed{usage} · turn.failed · error).
//   · 시스템 프롬프트 깃발은 없다 — `-c model_instructions_file="<파일>"` 이 기본 지시문을 갈음한다.
//   · 도구를 끄는 깃발은 없다 — `--sandbox read-only` + 빈 임시 폴더(`-C`)로 둔다. `--ephemeral` 로 그 PC 에 대화 기록을 남기지 않는다.
//   · 로그인이 없으면 실패하지 않고 «다시 잇는 중»으로 오래 버틴다 — 그래서 부르기 전에 `codex login status`(0 = 로그인됨)를 먼저 본다.
//   · 로그인 정보는 그 PC 의 %USERPROFILE%\.codex\ (PC 마다 로그인 — 사용자 결정, 2026-10-13). 이 앱은 그 파일을 읽지 않는다.
//   · 모델은 고르지 않는다(Codex 가 그 요금제의 기본 모델을 쓴다). 모델 id 를 코드에 두지 않는다(CLAUDE.md 원칙 4).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 폴더에 담아 온 것(USB — 만들기 도구가 tools/codex/ 에 푼다) → PATH 의 codex. 옆 폴더는 뒤지지 않는다.
export function resolveCodex() {
  const EXE = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const tried = [join(HERE, 'codex', 'bin', EXE), join(HERE, 'codex', EXE)];
  for (const p of tried) if (existsSync(p)) return { cli: p, found: true, via: 'portable (tools/codex)', tried };
  return { cli: 'codex', found: false, via: 'PATH', tried };
}

// TOML 기본 문자열 — 윈도우 경로의 \ 와 따옴표를 그대로 넘기려면 JSON 꼴이 그대로 맞는다
const toml = (s) => JSON.stringify(String(s));

export function buildCodexArgs({ dir, systemPromptFile, outFile }) {
  return [
    'exec', '--json',
    '--skip-git-repo-check',      // 빈 임시 폴더는 깃 저장소가 아니다
    '--ephemeral',                // 대화 기록을 그 PC 에 남기지 않는다
    '--sandbox', 'read-only',     // 글만 쓴다 — 파일을 고치거나 명령을 돌리지 못하게
    '-C', dir,
    '-o', outFile,
    '-c', 'model_instructions_file=' + toml(systemPromptFile),
    '-',                          // 프롬프트는 stdin
  ];
}

// JSONL 을 한 줄씩 읽어 끝 글 · 사용량 · 오류를 모은다(모르는 줄은 건너뛴다)
export function readCodexEvents(text) {
  const out = { said: '', usage: null, error: '' };
  for (const line of String(text || '').split('\n')) {
    let ev;
    try { ev = JSON.parse(line.trim()); } catch { continue; }
    if (!ev || typeof ev !== 'object') continue;
    if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message') out.said = String(ev.item.text || '');
    else if (ev.type === 'turn.completed' && ev.usage) out.usage = ev.usage;
    else if (ev.type === 'turn.failed') out.error = String((ev.error && ev.error.message) || 'turn failed');
    else if (ev.type === 'error') out.error = String(ev.message || 'error');
  }
  return out;
}

function run(cli, args, { timeoutMs = 30000, stdio = 'pipe' } = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cli, args, { windowsHide: true, stdio }); } catch { return resolve({ code: -1, out: '' }); }
    let out = '';
    if (p.stdout) { p.stdout.setEncoding('utf8'); p.stdout.on('data', (s) => { out += s; }); }
    if (p.stderr) { p.stderr.setEncoding('utf8'); p.stderr.on('data', (s) => { out += s; }); }
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.on('error', () => { clearTimeout(timer); resolve({ code: -1, out }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, out }); });
  });
}

// 로그인되어 있는가 — 된 것은 5분 기억한다(호출마다 띄우지 않게). 안 된 것은 기억하지 않는다(그새 로그인할 수 있다).
let okUntil = 0;
export async function codexLoggedIn(cli, { now = Date.now } = {}) {
  if (now() < okUntil) return true;
  const r = await run(cli, ['login', 'status']);
  if (r.code === 0) okUntil = now() + 5 * 60 * 1000;
  return r.code === 0;
}
export function forgetCodexLogin() { okUntil = 0; }

// 그 창에서 브라우저 로그인 — 실행기(launch.mjs)가 쓴다
export function codexLogin(cli) {
  return run(cli, ['login'], { timeoutMs: 15 * 60 * 1000, stdio: 'inherit' }).then((r) => r.code);
}
