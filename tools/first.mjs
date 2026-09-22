// 첫 걸음 — 설치기가 딱 한 번 부르는 자리. (ASCII only on the console, D-024)
//
// 하는 일은 셋뿐이다.
//   --have-claude                클로드 코드가 이 PC 에 있는가 (0/1 로만 답한다)
//   --site --code                첫 열쇠를 진짜 브리지 열쇠로 바꿔 data/link.json 에 적는다
//   --node --desktop             바탕화면에 다음번에 누를 파일을 하나 둔다
//
// ── 왜 사람이 열쇠를 베껴 옮기지 않는가
// 내려받은 파일 안에 그 사람만의 짧은 표가 박혀 있다. 그것을 여기서 내밀면 상점이 바꿔 준다.
// 표는 삼십 분만 살고 한 번만 듣는다 — 내려받기 폴더에 남아도 곧 죽는다.
//
// ── 바탕화면 파일을 왜 ASCII 로만 적는가
// 사용자 이름이 한글이면 %LOCALAPPDATA% 를 펼친 경로에 한글이 들어간다.
// 배치 파일은 옛 코드페이지로 읽히므로 그 글자가 깨져 다음번에 아무것도 안 열린다.
// 그래서 **펼치지 않고 변수 그대로** 적는다.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCliDetailed } from './claude-cli.mjs';

const line = (s = '') => console.log(s);

export function argOf(argv, name) {
  const i = argv.indexOf('--' + name);
  return i > 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}

// ── 바탕화면에 둘 한 장. 다음번에는 이것만 누르면 된다.
//
// NODE 가 우리가 깐 것이면 변수로 적고, PATH 의 것이면 그냥 node 라고 적는다.
export function launcherText(nodeIsLocal) {
  const node = nodeIsLocal ? '"%NODEDIR%\\node.exe"' : 'node';
  return [
    '@echo off',
    'rem Story Engine - double-click to start. ASCII only.',
    'setlocal',
    'chcp 65001 >nul 2>&1',
    'title Story Engine (keep this window open)',
    'set "ROOT=%LOCALAPPDATA%\\StoryEngine"',
    'set "APP=%ROOT%\\app"',
    'set "NODEDIR=%ROOT%\\node"',
    'if not exist "%APP%\\tools\\launch.mjs" goto :gone',
    node + ' "%APP%\\tools\\launch.mjs"',
    'echo.',
    'echo   Stopped. You can close this window.',
    'pause',
    'goto :eof',
    ':gone',
    'echo.',
    'echo   [X] Story Engine is not installed in %APP%.',
    'echo       Sign in at the store and download the installer again.',
    'echo.',
    'pause',
    '',
  ].join('\r\n');
}

export function shLauncherText(nodeIsLocal) {
  const node = nodeIsLocal ? '"$HOME/.storyengine/node/bin/node"' : 'node';
  return [
    '#!/bin/bash',
    '# Story Engine - start.',
    'APP="$HOME/.storyengine/app"',
    '[ -f "$APP/tools/launch.mjs" ] || { echo "  [X] Story Engine is not installed."; exit 1; }',
    'exec ' + node + ' "$APP/tools/launch.mjs"',
    '',
  ].join('\n');
}

export function putLauncher(desktop, nodeExe) {
  if (!desktop) return { ok: false, why: 'no desktop' };
  const win = process.platform === 'win32';
  const local = /StoryEngine/i.test(nodeExe) || /\.storyengine/.test(nodeExe);
  try {
    // 내용이 모두 ASCII 라 latin1 로 적으면 BOM 없이 바이트 그대로 간다.
    if (win) writeFileSync(join(desktop, 'Story Engine.cmd'), launcherText(local), 'latin1');
    else writeFileSync(join(desktop, 'Story Engine.command'), shLauncherText(local), { mode: 0o755 });
    return { ok: true, name: 'Story Engine' + (win ? '.cmd' : '.command') };
  } catch (e) {
    return { ok: false, why: (e && e.message) || String(e) };
  }
}

// 첫 열쇠를 진짜 열쇠로 바꾼다.
export async function redeem(site, code) {
  try {
    const r = await fetch(site + '/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'setup.redeem', code }),
    });
    return await r.json();
  } catch {
    return { ok: false, error: 'unreachable', unreachable: true };
  }
}

export async function main(argv = process.argv) {
  if (argv.includes('--have-claude')) {
    const r = resolveCliDetailed();
    if (r.found) line('  Claude Code : ' + r.cli);
    return r.found ? 0 : 1;
  }

  const site = String(argOf(argv, 'site') || '').replace(/\/+$/, '');
  const code = String(argOf(argv, 'code') || '');
  const nodeExe = String(argOf(argv, 'node') || '');
  const desktop = String(argOf(argv, 'desktop') || '');

  if (!site) {
    line('  [ERROR] usage: first.mjs --site <url> [--code <code>]');
    return 2;
  }

  // **표 없이 받아 간 판** — 아직 누구의 것도 아니다.
  // 상점 주소만 적어 두고 물러난다. 프로그램이 뜨면 [구독하기] 가 그 주소로 데려가고,
  // 거기서 한 번 누르면 열쇠가 실려 돌아온다. 프로그램이 앞문이라는 것이 이런 뜻이다.
  if (!code) {
    const cloud = await import('./cloud.mjs');
    cloud.linkWrite({ site });
    line('  Store       : ' + site);
    line('  Not signed in yet - press the blue button in the program.');
    const put0 = putLauncher(desktop, nodeExe);
    if (put0.ok) line('  Desktop     : ' + put0.name);
    return 0;
  }

  const got = await redeem(site, code);
  if (got && got.unreachable) {
    line('  [ERROR] could not reach the store: ' + site);
    return 1;
  }
  if (!got || !got.ok || !got.token) {
    // 까닭은 상점이 한국말로 준다. 콘솔은 ASCII 라 그대로 싣지 않고 갈래만 이른다.
    line('  [ERROR] the setup link did not work (it may have expired).');
    return 1;
  }

  const cloud = await import('./cloud.mjs');
  const linked = await cloud.connect(site, got.token);
  const v = cloud.view();
  if (!linked || linked.ok === false) {
    // 이은 것 자체는 남는다(열쇠는 적혔다). 구독이 없어서 실패한 것일 수 있으므로 죽이지 않는다.
    line('  Store       : ' + v.site);
    line('  [note] linked, but the store did not hand out a licence yet.');
    putLauncher(desktop, nodeExe);
    return v.linked ? 0 : 1;
  }

  line('  Store       : ' + v.site);
  line('  Account     : ' + (v.email || '-'));
  line('  Subscription: ' + (v.ok ? 'ok' : 'none'));
  const put = putLauncher(desktop, nodeExe);
  if (put.ok) line('  Desktop     : ' + put.name);
  else if (desktop) line('  [note] could not put a file on the desktop: ' + put.why);
  return 0;
}

if (process.argv[1] && /[\\/]first\.mjs$/.test(process.argv[1])) {
  process.exit(await main(process.argv));
}
