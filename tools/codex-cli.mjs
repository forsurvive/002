// ChatGPT 구독으로 부르는 길 — OpenAI 의 Codex CLI(`codex exec`)를 그대로 띄운다(docs/PERSONAL_USB.md §8).
// 클로드 실행기(claude-cli.mjs)와 같은 결: 실행기 찾기 · 로그인 확인 · 인자 짓기 · 출력 읽기. 띄우는 일은 call.mjs 가 한다(임시 폴더 · 고삐 · 끊기).
//
// 조사로 정한 것(2026-10-13, @openai/codex 0.162.1 — 로그인 없이 --help 와 빈 HOME 으로만 확인. 실제 호출은 확인 못 함):
//   · 프롬프트는 stdin(`-`), 끝 글은 `-o <파일>` 에 적힌다. `--json` 은 JSONL 사건(thread.started · item.completed · turn.completed{usage} · turn.failed · error).
//   · 시스템 프롬프트 깃발은 없다 — `-c model_instructions_file="<파일>"` 이 기본 지시문을 갈음한다.
//   · 도구를 끄는 깃발은 없다 — `--sandbox read-only` + 빈 임시 폴더(`-C`)로 둔다. `--ephemeral` 로 그 PC 에 대화 기록을 남기지 않는다.
//   · 로그인이 없으면 실패하지 않고 «다시 잇는 중»으로 오래 버틴다 — 그래서 부르기 전에 `codex login status`(0 = 로그인됨)를 먼저 본다.
//   · 로그인 정보는 그 PC 의 %USERPROFILE%\.codex\ (PC 마다 로그인 — 사용자 결정, 2026-10-13). 이 앱은 그 파일을 읽지 않는다.
//   · 모델은 사람이 고른다(2026-10-13 사용자 지시 «챗 지피티도 모델을 고를 수 있도록») — 고를 목록은 Codex 제 목록(`codex debug models` 의 visibility «list»)에서 받고,
//     고른 것은 data/auth.json 에만 둔다. 고르지 않으면 Codex 의 기본 모델. 모델 id 를 코드에 두지 않는다(CLAUDE.md 원칙 4).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// 폴더에 담아 온 것(USB — 만들기 도구가 tools/codex/ 에 푼다) → 그 PC 에 깔린 것(PATH 의 codex.exe · npm 으로 깐 것의 진짜 실행 파일) → PATH 의 codex.
// 윈도우에서 npm 으로 깐 «codex» 는 codex.cmd(셸 껍데기)라 그대로 띄울 수 없다 — 그 안의 codex.exe 를 찾아 쓴다.
// 로그인은 실행 파일이 아니라 그 PC 의 사용자 폴더(%USERPROFILE%\.codex)에 있으므로, 어느 것을 써도 그 PC 의 ChatGPT 로그인을 그대로 읽는다.
export function resolveCodex(env = process.env) {
  const win = process.platform === 'win32';
  const EXE = win ? 'codex.exe' : 'codex';
  const tried = [join(HERE, 'codex', 'bin', EXE), join(HERE, 'codex', EXE)];
  for (const p of tried) if (existsSync(p)) return { cli: p, found: true, via: 'portable (tools/codex)', tried };
  const pc = [];
  for (const d of String(env.PATH || env.Path || '').split(win ? ';' : ':').filter(Boolean)) pc.push(join(d, EXE));
  if (win && env.APPDATA) {
    const npm = join(env.APPDATA, 'npm', 'node_modules', '@openai');
    for (const pkg of [join(npm, 'codex-win32-x64'), join(npm, 'codex', 'node_modules', '@openai', 'codex-win32-x64'), join(npm, 'codex')]) {
      pc.push(join(pkg, 'vendor', 'x86_64-pc-windows-msvc', 'bin', EXE), join(pkg, 'vendor', 'x86_64-pc-windows-msvc', 'codex', EXE));
    }
  }
  for (const p of pc) { tried.push(p); if (existsSync(p)) return { cli: p, found: true, via: 'installed on this PC', tried }; }
  return { cli: 'codex', found: false, via: 'PATH', tried };
}

// TOML 기본 문자열 — 윈도우 경로의 \ 와 따옴표를 그대로 넘기려면 JSON 꼴이 그대로 맞는다
const toml = (s) => JSON.stringify(String(s));

// images — 함께 보낼 그림 파일들(DESIGN §6-9). «--image» 는 값을 여럿 받는 깃발이라 «--image=<파일>» 꼴로 장마다 붙인다(뒤의 «-» 를 그림으로 삼키지 않게)
export function buildCodexArgs({ dir, systemPromptFile, outFile, model = '', webSearch = false, images = [] }) {
  const m = String(model || '').trim();
  return [
    'exec', '--json',
    ...(Array.isArray(images) ? images : []).map((f) => '--image=' + f),
    ...(m ? ['-m', m] : []),      // 사람이 고른 모델(설정 › 무엇으로 › ChatGPT 구독) — 없으면 Codex 의 기본
    '--skip-git-repo-check',      // 빈 임시 폴더는 깃 저장소가 아니다
    '--ephemeral',                // 대화 기록을 그 PC 에 남기지 않는다
    '--sandbox', 'read-only',     // 글만 쓴다 — 파일을 고치거나 명령을 돌리지 못하게
    '-C', dir,
    '-o', outFile,
    '-c', 'model_instructions_file=' + toml(systemPromptFile),
    // 작품의 «웹 검색»(DESIGN §6-6) — 켜면 live, 끄면 disabled 로 못 박는다(Codex 의 기본값에 기대지 않는다)
    '-c', 'web_search=' + toml(webSearch ? 'live' : 'disabled'),
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
    try { p = spawn(cli, args, { windowsHide: true, stdio }); } catch { return resolve({ code: -1, out: '', err: '' }); }
    let out = '', err = '';
    if (p.stdout) { p.stdout.setEncoding('utf8'); p.stdout.on('data', (s) => { out += s; }); }
    if (p.stderr) { p.stderr.setEncoding('utf8'); p.stderr.on('data', (s) => { err = (err + s).slice(-4000); }); }   // 결과는 stdout — stderr 는 로그인 상태 글을 읽을 때만 쓴다
    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);
    p.on('error', () => { clearTimeout(timer); resolve({ code: -1, out, err }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? -1 : code, out, err }); });
  });
}

// 로그인되어 있는가 — 된 것은 5분 기억한다(호출마다 띄우지 않게). 안 된 것은 기억하지 않는다(그새 로그인할 수 있다).
let okUntil = 0;
let seenAccount = '';
export async function codexLoggedIn(cli, { now = Date.now } = {}) {
  if (now() < okUntil) return true;
  const r = await run(cli, ['login', 'status']);
  if (r.code === 0) { okUntil = now() + 5 * 60 * 1000; seenAccount = codexAccountOf(r.out + '\n' + r.err); }
  else seenAccount = '';
  return r.code === 0;
}
export function forgetCodexLogin() { okUntil = 0; }
// 어느 계정인가 — `codex login status` 가 찍은 글에 이메일이 있을 때만. 로그인 파일(토큰)은 읽지 않는다.
// 0.162.1 은 «Logged in using ChatGPT» 만 찍고, `codex doctor --json` 도 계정을 가린다(2026-10-13 윈도우 실측) — 그래서 지금은 비어 있다
export function codexAccountOf(text) {
  return (String(text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] || '';
}
export const codexAccount = () => (okUntil ? seenAccount : '');

// 그 창에서 브라우저 로그인 — 실행기(launch.mjs)가 쓴다
export function codexLogin(cli) {
  return run(cli, ['login'], { timeoutMs: 15 * 60 * 1000, stdio: 'inherit' }).then((r) => r.code);
}

// 고를 수 있는 모델 — Codex 가 제 목록에서 «list» 로 내보이는 것만(숨긴 것 · 검토용은 빼고). 10분 기억한다.
// 이름(slug)은 그대로 실행기에 넘기는 값이고, 화면에는 display_name 을 보인다.
export const MODEL_SLUG = /^[A-Za-z0-9._-]{1,80}$/;
export function parseCodexModels(text) {
  let j;
  try { j = JSON.parse(String(text || '')); } catch { return []; }
  const list = Array.isArray(j) ? j : (j && Array.isArray(j.models) ? j.models : []);
  return list.filter((m) => m && MODEL_SLUG.test(String(m.slug || '')) && (m.visibility == null || m.visibility === 'list'))
    .map((m) => ({ id: String(m.slug), name: String(m.display_name || m.slug), note: String(m.description || '').slice(0, 120) }));
}
let modelsCache = { at: 0, list: [] };
export async function codexModels(cli, { now = Date.now } = {}) {
  if (modelsCache.list.length && now() - modelsCache.at < 10 * 60 * 1000) return modelsCache.list;
  const r = await run(cli, ['debug', 'models'], { timeoutMs: 30000 });
  const list = r.code === 0 ? parseCodexModels(r.out) : [];
  if (list.length) modelsCache = { at: now(), list };
  return list;
}
