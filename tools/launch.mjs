// 원클릭 실행기 — 「스토리 엔진 개인판.cmd」 더블클릭 한 번으로 로그인 확인부터 서버 기동·브라우저 열기까지.
//   1) Claude Code 실행기 탐색 — 없으면 앤트로픽 공식 설치기로 깐다
//   2) 로그인 상태 확인 → 안 되어 있으면 이 창에서 브라우저 로그인(그 PC 에서 처음 한 번)
//   3) 서버 기동(tools/server.mjs) + 기본 브라우저 열기
// 콘솔 문구는 ASCII만 — 윈도우 cmd 창의 코드페이지에 따라 한글이 깨진다.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliDetailed, childEnv, authStatus, installClaudeCode, INSTALL_URL } from './claude-cli.mjs';
import { resolveCodex, codexLoggedIn, codexLogin } from './codex-cli.mjs';
import * as auth from './auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SE2_PORT || 8801);
const line = (s = '') => console.log(s);

let R = resolveCliDetailed();

// 없으면 **여기서 깐다.** USB 로 옮겨 온 PC 의 첫날이 바로 그때다 —
// 폴더는 따라왔지만 Claude Code 는 그 PC 에 없다. 그때 「직접 깔아 오십시오」로 끝내면
// 그 사람의 하루가 거기서 멎는다. 받는 곳은 앤트로픽의 공식 자리 하나뿐이다.
if (!R.found) {
  line('  ------------------------------------------------------------');
  line('   Claude Code is not on this computer yet. Installing it now.');
  line('   Source: ' + INSTALL_URL);
  line('  ------------------------------------------------------------');
  line();
  // 따옴표를 셸에 그대로 넘기는 일은 claude-cli.mjs 한 곳이 맡는다(시험이 그 줄을 실제로 돌려 본다).
  const code = await installClaudeCode();
  if (code !== 0) line('  [WARN] installer exit code: ' + code);
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
// 폴더에 담아 온 실행기(USB 휴대판)는 스스로 고치지 않게 한다 — 저절로 고치면 새 판을 이 PC 의 사용자 폴더에 깔아 두고 간다.
// 새 판은 만들기 도구로 USB 에 다시 담는다(docs/PERSONAL_USB.md §4).
if (R.via.startsWith('portable')) process.env.DISABLE_AUTOUPDATER = '1';
line();

// ChatGPT 구독으로 돌게 골라 두었으면(설정 › 무엇으로) 클로드 대신 Codex 의 로그인을 본다(docs/PERSONAL_USB.md §8)
const viaChatGPT = auth.read().mode === 'chatgpt';
if (viaChatGPT) {
  const C = resolveCodex();
  line('  ChatGPT     : ' + C.cli + '  (via: ' + C.via + ')');
  if (!(await codexLoggedIn(C.cli))) {
    line('  ------------------------------------------------------------');
    line('   ONE-TIME CHATGPT LOGIN (first run on this computer)');
    line('   A browser page opens. Sign in with your ChatGPT account.');
    line('  ------------------------------------------------------------');
    const code = await codexLogin(C.cli);
    if (!(await codexLoggedIn(C.cli))) {
      line('  [NOT LOGGED IN] codex login exit code: ' + code);
      line('  The app starts anyway - AI calls will ask for the login again.');
      line('  To go back to Claude: Settings > (mode) in the app.');
    }
  }
  line();
}

const before = viaChatGPT ? { loggedIn: true } : await authStatus(R.cli);
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

if (process.env.SE2_LAUNCH_CHECK_ONLY) {
  line('  [CHECK ONLY] Login OK. Server start skipped.');
  process.exit(0);
}

const server = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  stdio: 'inherit',
  // 더블클릭으로 띄운 개인판은 늘 이 PC 안(127.0.0.1)에만 연다 — 남아 있던 호스팅 설정(SE2_HOST 따위)이 바깥에 열지 못하게
  env: { ...process.env, SE2_OPEN_BROWSER: '1', SE2_PORT: String(PORT), SE2_HOST: '127.0.0.1', SE2_ALLOW_OPEN: '' },
});
server.on('close', (c) => process.exit(c == null ? 0 : c));
