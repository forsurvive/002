// 원클릭 실행기 — 더블클릭 한 번으로 로그인 확인부터 서버 기동·브라우저 열기까지.
//   1) Claude Code 실행기 탐색
//   2) 로그인 상태 확인 → 안 되어 있으면 이 창에서 브라우저 로그인(최초 한 번)
//   3) 서버 기동(tools/server.mjs) + 기본 브라우저 열기
// 콘솔 문구는 ASCII만 — 윈도우 cmd 창의 코드페이지에 따라 한글이 깨진다.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliDetailed, childEnv, authStatus } from './claude-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SE2_PORT || 8801);
const line = (s = '') => console.log(s);

let R = resolveCliDetailed();

// 없으면 **여기서 깐다.** 설치기가 이미 한 번 해 보지만, 그 뒤로 지워졌을 수도 있고
// 옛 방식으로 깐 사람이 바탕화면 파일만 눌렀을 수도 있다. 그때 「직접 깔아 오십시오」로 끝내면
// 그 사람의 하루가 거기서 멎는다. 받는 곳은 앤트로픽의 공식 자리 하나뿐이다.
if (!R.found) {
  line('  ------------------------------------------------------------');
  line('   Claude Code is not on this computer yet. Installing it now.');
  line('   Source: https://claude.ai/install' + (process.platform === 'win32' ? '.cmd' : '.sh'));
  line('  ------------------------------------------------------------');
  line();
  await new Promise((resolve) => {
    const p = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'curl -fsSL https://claude.ai/install.cmd -o "%TEMP%\\cc-install.cmd" && "%TEMP%\\cc-install.cmd" && del "%TEMP%\\cc-install.cmd"'], { stdio: 'inherit' })
      : spawn('bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'], { stdio: 'inherit' });
    p.on('error', () => resolve());
    p.on('close', () => resolve());
  });
  line();
  R = resolveCliDetailed();
}

if (!R.found) {
  line('  [ERROR] Could not find the Claude Code executable.');
  line('  Searched:');
  for (const t of R.tried) line('    [' + (t.found ? 'FOUND' : '  -  ') + '] ' + t.path);
  line();
  line('  FIX: install the Claude desktop app (it bundles Claude Code), or Claude Code itself.');
  process.exit(1);
}
line('  Claude Code : ' + R.cli + '  (via: ' + R.via + ')');
line();

const before = await authStatus(R.cli);
if (!before.loggedIn) {
  line('  ------------------------------------------------------------');
  line('   ONE-TIME LOGIN (first run on this computer)');
  line('   1) A browser page opens in a moment.');
  line('   2) Sign in with your claude.ai account and approve.');
  line('   3) Return here - the app starts automatically after login.');
  line('  ------------------------------------------------------------');
  line();
  const code = await new Promise((resolve) => {
    const p = spawn(R.cli, ['auth', 'login', '--claudeai'], { env: childEnv(), stdio: 'inherit' });
    p.on('error', (e) => { line('  [ERROR] ' + e.message); resolve(-1); });
    p.on('close', (c) => resolve(c));
  });
  line();
  const after = await authStatus(R.cli);
  if (!after.loggedIn) {
    line('  [NOT LOGGED IN] login exit code: ' + code);
    line('  Close this window and double-click the launcher again.');
    process.exit(1);
  }
  line('  [LOGIN OK] Starting the app...');
  line();
}

// 어느 계정에 이어져 있는지 한 줄로 보여 준다 — 「내 것이 맞나」를 창을 열기 전에 알 수 있게.
try {
  const v = (await import('./cloud.mjs')).view();
  if (v.linked) {
    line('  Store       : ' + v.site);
    line('  Account     : ' + (v.email || '-') + '  (' + (v.ok ? 'subscribed' : 'no subscription') + ')');
    line();
  }
} catch { /* 못 읽어도 프로그램은 뜬다 */ }

if (process.env.SE2_LAUNCH_CHECK_ONLY) {
  line('  [CHECK ONLY] Login OK. Server start skipped.');
  process.exit(0);
}

const server = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, SE2_OPEN_BROWSER: '1', SE2_PORT: String(PORT) },
});
server.on('close', (c) => process.exit(c == null ? 0 : c));
