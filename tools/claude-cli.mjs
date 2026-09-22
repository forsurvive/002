// Claude Code 실행기 호출 공용 모듈 (구독 모드의 토대)
// 브리지와 엔진이 함께 쓴다. 직접 실행하면 탐색 결과를 진단용으로 출력한다.
//
// 실측 근거(2026-07-25):
//   · 데스크톱 앱은 Microsoft Store(MSIX) 패키지라 **폴더 가상화**가 걸린다.
//     - 앱 안쪽에서 본 경로:  %APPDATA%\Claude\claude-code\<버전>\claude.exe   (가상 화면)
//     - 실제 저장 위치:      %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude-code\<버전>\
//     탐색기에서 더블클릭한 창은 앱 바깥이라 앞의 경로가 보이지 않는다(실측 실패: spawn claude ENOENT).
//     → 두 곳을 모두 뒤진다.
//   · 버전 폴더는 업데이트로 바뀌므로 매번 최신을 고른다.
//   · `--bare` 금지 — OAuth·키체인 읽기를 건너뛰어 API 키를 요구한다(구독 인증이 깨진다).
//   · 부모가 물려준 CLAUDE_* 환경 변수를 지워야 더블클릭 실행과 동일 조건이 된다.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 이 파일이 있는 폴더(tools/) — 휴대용 실행기 탐색의 기준점
const HERE = dirname(fileURLToPath(import.meta.url));

function cmpVerDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return y - x;
  }
  return 0;
}

// claude-code 하위의 최신 버전 폴더에서 claude.exe를 찾는다
function newestInBase(base) {
  if (!base || !existsSync(base)) return null;
  let dirs;
  try {
    dirs = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return null; }
  for (const v of dirs.sort(cmpVerDesc)) {
    const p = join(base, v, 'claude.exe');
    if (existsSync(p)) return p;
  }
  return null;
}

// 스토어 패키지의 실제 저장 위치들 (패키지 이름에 해시가 붙어 고정 경로가 아니다)
function packagedBases() {
  const out = [];
  const pkgRoot = join(process.env.LOCALAPPDATA || '', 'Packages');
  if (!existsSync(pkgRoot)) return out;
  let pkgs;
  try {
    pkgs = readdirSync(pkgRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^Claude_/i.test(d.name))
      .map((d) => d.name);
  } catch { return out; }
  for (const p of pkgs) {
    out.push(join(pkgRoot, p, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
    out.push(join(pkgRoot, p, 'LocalCache', 'Local', 'Claude', 'claude-code'));
  }
  return out;
}

// 탐색 순서와 결과를 함께 돌려준다 — 실패 시 사용자에게 무엇을 뒤졌는지 보여주기 위함
export function resolveCliDetailed() {
  // note는 콘솔에 출력되므로 ASCII만 쓴다(D-024 — 창 코드페이지에 따라 한글이 깨진다)
  const isWin = process.platform === 'win32';
  const EXE = isWin ? 'claude.exe' : 'claude';
  const candidates = [
    // 휴대용(USB 이동용): 앱 폴더 안에 동봉된 실행기 — 설치가 전혀 없는 PC에서도 동작한다
    { kind: 'exe', path: join(HERE, 'claude', EXE), note: 'portable (tools/claude)' },
    ...(isWin ? [
      { kind: 'base', path: join(process.env.APPDATA || '', 'Claude', 'claude-code'), note: 'desktop app (virtualized path)' },
      ...packagedBases().map((p) => ({ kind: 'base', path: p, note: 'desktop app (Store real path)' })),
      { kind: 'exe', path: join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe'), note: 'native install' },
      { kind: 'exe', path: join(process.env.LOCALAPPDATA || '', 'Programs', 'claude', 'claude.exe'), note: 'native install (alt)' },
    ] : [
      // macOS/리눅스 — 공식 설치 스크립트(~/.local/bin)와 홈브루 경로
      { kind: 'exe', path: join(process.env.HOME || '', '.local', 'bin', 'claude'), note: 'native install' },
      { kind: 'exe', path: '/usr/local/bin/claude', note: 'native install (alt)' },
      { kind: 'exe', path: '/opt/homebrew/bin/claude', note: 'homebrew' },
    ]),
  ];
  const tried = [];
  for (const c of candidates) {
    const found = c.kind === 'base' ? newestInBase(c.path) : (existsSync(c.path) ? c.path : null);
    tried.push({ ...c, found: !!found });
    if (found) return { cli: found, found: true, via: c.note, tried };
  }
  return { cli: 'claude', found: false, via: 'PATH 폴백', tried };
}

export function resolveCli() {
  return resolveCliDetailed().cli;
}

// 지우지 않는 CLAUDE_* — 클로드가 제 안에 갖춘 «로그인하는 길»이다.
//
// 상업 약관이 못박았다: 「The Claude Code binary must not be modified …
// customers may not remove, disable, or restrict any authentication method built into it」.
// 브리지를 상품으로 배포하는 순간 이 조항이 걸리므로, 인증에 쓰이는 변수는 통과시킨다.
// (전에는 CLAUDE_* 를 통째로 지워 CLAUDE_CODE_OAUTH_TOKEN 까지 함께 걷었다.)
const KEEP_CLAUDE = new Set(['CLAUDE_CODE_OAUTH_TOKEN']);

// 더블클릭 실행과 동일한 조건 — 부모가 물려준 CLAUDE_* 제거(인증 수단은 남긴다).
//
// auth 를 주면 «무엇으로 돈이 나가는가»를 사람이 고른 대로 따른다(tools/auth.mjs).
//   auto : 손대지 않는다. 그 PC 의 환경이 정하는 대로.
//   sub  : ANTHROPIC_API_KEY 를 지운다 — 「구독으로 돕니다」라고 말하면서 말없이 종량 과금되는 것을 막는다.
//          (실측: 그 변수가 있으면 apiKeySource 가 none → ANTHROPIC_API_KEY 로 바뀐다.)
//   api  : 담아 둔 키를 싣는다. 공식 문서: 「In non-interactive mode (-p), the key is always used when present」.
export function childEnv(auth = null) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith('CLAUDE_') && !KEEP_CLAUDE.has(k)) delete e[k];
  const mode = auth && auth.mode;
  if (mode === 'api' && auth.apiKey) e.ANTHROPIC_API_KEY = auth.apiKey;
  else if (mode === 'sub') delete e.ANTHROPIC_API_KEY;
  return e;
}

export function runCli(cli, args, { input, timeoutMs = 600000, onStdout } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cli, args, { env: childEnv(), windowsHide: true });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill(); }, timeoutMs);
    p.stdout.setEncoding('utf8'); // 멀티바이트 경계 안전 디코드
    p.stdout.on('data', (s) => {
      out += s;
      if (onStdout) onStdout(s);
    });
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message || e), timedOut }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, timedOut }); });
    if (input != null) p.stdin.write(input);
    p.stdin.end();
  });
}

export async function authStatus(cli) {
  const r = await runCli(cli, ['auth', 'status', '--text'], { timeoutMs: 60000 });
  return { loggedIn: r.code === 0, detail: (r.out + r.err).trim() };
}

// 직접 실행 시: 탐색 진단 출력 (ASCII만 — 콘솔 코드페이지 문제 회피, D-024)
if (process.argv[1] && process.argv[1].endsWith('claude-cli.mjs')) {
  const r = resolveCliDetailed();
  if (process.argv.includes('--diagnose')) {
    console.log('Claude Code executable search:');
    for (const t of r.tried) console.log('  [' + (t.found ? 'FOUND' : '  -  ') + '] ' + t.path);
    console.log('');
    console.log(r.found ? ('RESOLVED: ' + r.cli) : 'NOT FOUND - falling back to PATH ("claude")');
  } else {
    process.stdout.write(r.cli);
  }
}
