// 원클릭 실행기 — 「스토리 엔진 개인판.cmd」 더블클릭 한 번으로 로그인 확인부터 서버 기동·브라우저 열기까지.
//   1) Claude Code 실행기 탐색 — 없으면 USB 휴대판(폴더의 node 로 돈다)은 폴더 안으로 받아 오고, 그 밖은 앤트로픽 공식 설치기로 깐다
//   2) 로그인 상태 확인 → 안 되어 있으면 이 창에서 브라우저 로그인(그 PC 에서 처음 한 번). 건너뛰거나 실패해도 앱은 연다 —
//      화면의 [설정]에서 Claude · ChatGPT 로 로그인한다(사용자 지시 2026-10-17 — ChatGPT 계정만 있어도 들어갈 수 있게)
//   3) 서버 기동(tools/server.mjs) + 기본 브라우저 열기
// 콘솔 문구는 ASCII만 — 윈도우 cmd 창의 코드페이지에 따라 한글이 깨진다.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCliDetailed, childEnv, authStatus, installClaudeCode, INSTALL_URL } from './claude-cli.mjs';
import { resolveCodex, codexLoggedIn, codexLogin, codexAccount } from './codex-cli.mjs';
import { fetchClaude, codexIntoFolder } from './usb-build.mjs';
import * as auth from './auth.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SE2_PORT || 8801);
const line = (s = '') => console.log(s);

let R = resolveCliDetailed();

// USB 휴대판(폴더의 tools\node\node.exe 로 도는 창)인데 Claude Code 가 아직 폴더에 없으면 — PC 에 깔지 않고 **폴더 안으로** 받아 온다.
// 앱 묶음만 내려받아 USB 에 푼 첫날이 그때다(docs/PERSONAL_USB.md §5). 받는 곳 · 확인은 만들기 도구와 같다(npm 의 앤트로픽 윈도우 패키지 · sha512).
const portableNode = process.execPath.toLowerCase().startsWith(join(HERE, 'node').toLowerCase());
if (!R.found && portableNode && process.platform === 'win32' && process.arch === 'x64') {
  line('  ------------------------------------------------------------');
  line('   Claude Code is not in this folder yet. Downloading it into');
  line('   tools\\claude\\ (once - about 80MB, checked with sha512).');
  line('  ------------------------------------------------------------');
  try { await fetchClaude(dirname(HERE), 'latest', line); } catch (e) { line('  [WARN] ' + String((e && e.message) || e).replace(/[^\x20-\x7e]/g, '?')); }
  line();
  R = resolveCliDetailed();
}

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
  let C = resolveCodex();
  // Codex 가 없으면 PC 에 깔지 않고 이 폴더(tools\codex\)로 받아 온다 — 화면의 [ChatGPT 로그인]과 같은 길(usb-build codexIntoFolder)
  if (!C.found && process.platform === 'win32' && process.arch === 'x64') {
    line('  ------------------------------------------------------------');
    line('   ChatGPT (Codex) is not in this folder yet. Downloading it into');
    line('   tools\\codex\\ (once - about 460MB unpacked, checked with sha512).');
    line('  ------------------------------------------------------------');
    try { await codexIntoFolder(line); } catch (e) { line('  [WARN] ' + String((e && e.message) || e).replace(/[^\x20-\x7e]/g, '?')); }
    line();
    C = resolveCodex();
  }
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

// Gemini API 키로 돌면(설정 › 무엇으로) 실행기 로그인이 필요 없다 — 키가 없으면 앱이 첫 호출에서 이른다
const viaGemini = auth.read().mode === 'gemini' || auth.read().mode === 'openai';   // API 키 길(Gemini · ChatGPT)
if (viaGemini) line('  API key     : ' + (auth.read().mode === 'openai' ? 'ChatGPT ' + (auth.read().openaiKey ? 'set' : 'NOT SET - put it in Settings') : 'Gemini ' + (auth.read().geminiKey ? 'set' : 'NOT SET - put it in Settings')) + '\n');
let before = viaChatGPT || viaGemini ? { loggedIn: true } : await authStatus(R.cli);

// ChatGPT 자동 등록(2026-10-13 사용자 지시 «챗지피티가 로그인되어 있다면 챗지피티 구독량 사용도 자동으로») —
// 아직 아무것도 고르지 않은 PC(«그대로»)에서 Claude 로그인은 없고 ChatGPT(Codex) 로그인이 있으면, 묻지 않고 ChatGPT 구독으로 돈다.
// 둘 다 로그인되어 있으면 Claude 그대로(지금까지와 같다). 사람이 고른 갈래(Claude 구독 · API 키)는 건드리지 않는다.
if (!before.loggedIn && auth.read().mode === 'auto') {
  const C = resolveCodex();
  if (C.found && (await codexLoggedIn(C.cli))) {
    auth.write({ mode: 'chatgpt' });
    line('  ChatGPT     : already signed in on this PC - using the ChatGPT subscription');
    line('                (change it any time: Settings in the app)');
    line();
    before = { loggedIn: true };
  }
}
// 이 PC 에 아무 로그인도 없다 — Claude 로그인을 권하되(Enter) 건너뛸 수 있다(S). 건너뛰면 앱을 열고 화면에서 로그인한다
// (사용자 지시 2026-10-17 «로그인이 안 되어 있어도 간단히 등록» — ChatGPT 계정만 있는 사람도 들어갈 수 있게)
async function askSkip() {
  // 점검용 — 답을 미리 주면(SE2_LAUNCH_ANSWER) 묻지 않는다(로그인 없는 PC 를 흉내 내는 점검이 쓴다)
  if (process.env.SE2_LAUNCH_ANSWER != null) return /^\s*s/i.test(process.env.SE2_LAUNCH_ANSWER);
  if (!process.stdin.isTTY) return false;   // 창 없이 띄웠으면 묻지 않는다(지금처럼 Claude 로그인)
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise((resolve) => rl.question('  Your choice (Enter = Claude login, S = skip): ', resolve));
  rl.close();
  return /^\s*s/i.test(String(a || ''));
}
let skipped = false;
if (!before.loggedIn) {
  line('  ------------------------------------------------------------');
  line('   NOT SIGNED IN ON THIS COMPUTER YET');
  line('   [Enter]  Sign in with Claude now - a browser page opens.');
  line('            Sign in with your claude.ai account and approve,');
  line('            then come back here - the app starts by itself.');
  line('   [S]      Skip - the app opens and you sign in there:');
  line('            Settings > Claude login  or  ChatGPT login.');
  line('  ------------------------------------------------------------');
  skipped = await askSkip();
  line();
}
if (!before.loggedIn && skipped) {
  line('  Skipped. The app opens - sign in from Settings (Claude or ChatGPT).');
  line();
}
if (!before.loggedIn && !skipped) {
  const code = await new Promise((resolve) => {
    const p = spawn(R.cli, ['auth', 'login', '--claudeai'], { env: childEnv(), stdio: 'inherit' });
    p.on('error', (e) => { line('  [ERROR] ' + e.message); resolve(-1); });
    p.on('close', (c) => resolve(c));
  });
  line();
  const after = await authStatus(R.cli);
  if (!after.loggedIn) {
    // 로그인이 안 됐어도 앱은 연다 — 화면의 [설정]에서 다시(Claude) 또는 ChatGPT 로 로그인한다
    line('  [NOT LOGGED IN] login exit code: ' + code);
    line('  The app opens anyway - sign in from Settings in the app');
    line('  (Claude login or ChatGPT login).');
    line();
  } else {
    line('  [LOGIN OK] Starting the app...');
    line();
    before = after;
  }
}

// 어느 계정으로 도는가 — 남의 PC 면 그 PC 주인의 로그인으로 돌 수 있다. 이메일만(ASCII) 한 줄(2026-10-13 «등록된 계정 보이게»)
const acct = String((auth.read().mode === 'chatgpt' ? codexAccount() : viaGemini ? '' : before.account) || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
if (acct) { line('  Signed in   : ' + acct[0]); line(); }

if (process.env.SE2_LAUNCH_CHECK_ONLY) {
  line('  [CHECK ONLY] ' + (before.loggedIn ? 'Login OK.' : 'Not signed in - the app would open and ask in Settings.') + ' Server start skipped.');
  process.exit(0);
}

const server = spawn(process.execPath, [join(HERE, 'server.mjs')], {
  stdio: 'inherit',
  // 더블클릭으로 띄운 개인판은 늘 이 PC 안(127.0.0.1)에만 연다 — 남아 있던 호스팅 설정(SE2_HOST 따위)이 바깥에 열지 못하게
  env: { ...process.env, SE2_OPEN_BROWSER: '1', SE2_PORT: String(PORT), SE2_HOST: '127.0.0.1', SE2_ALLOW_OPEN: '' },
});
server.on('close', (c) => process.exit(c == null ? 0 : c));
