// 기본 브라우저 — Chrome 을 기본으로 두도록 이끈다(사용자 지시 2026-10-17 «크롬이 기본 브라우저가 아니면 크롬을 기본 브라우저로 설정할 수 있도록 유도»).
// 앱도, 로그인 페이지(claude auth login · codex login)도 «기본 브라우저»로 열린다 — 이미 로그인해 둔 Chrome 이 기본이면 승인 한 번으로 끝난다.
// 윈도우는 프로그램이 기본 브라우저를 바꾸는 것을 막아 두었다(UserChoice 는 해시로 지킨다) — 여기서는 읽기와 «Windows 설정의 그 화면 열기»까지만 한다.
// 바꾸는 마지막 클릭은 사람이 Windows 설정 창에서 한다. 윈도우가 아니면 아무것도 하지 않는다(supported: false).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
// ProgId → 화면에 보일 이름(모르는 것은 ProgId 그대로)
const NAMES = [
  [/^ChromeHTML/i, 'Google Chrome'], [/^MSEdge/i, 'Microsoft Edge'], [/^Firefox/i, 'Firefox'], [/^WhaleHTML/i, 'Naver Whale'],
  [/^BraveHTML/i, 'Brave'], [/^Opera/i, 'Opera'], [/^IE\./i, 'Internet Explorer'],
];
export const browserName = (progId) => (NAMES.find(([re]) => re.test(String(progId || ''))) || [null, String(progId || '')])[1];
export const isChromeProgId = (progId) => /^ChromeHTML/i.test(String(progId || ''));

// reg query 의 «ProgId    REG_SZ    ChromeHTML» 한 줄을 읽는다
export function parseProgId(text) {
  const m = String(text || '').match(/ProgId\s+REG_SZ\s+(\S+)/i);
  return m ? m[1] : '';
}

function reg(args) {
  try {
    const r = spawnSync('reg', args, { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? String(r.stdout || '') : '';
  } catch { return ''; }
}

// Chrome 이 깔린 자리 — 모든 사용자(Program Files) · 이 사용자(LocalAppData). 어디인지에 따라 Windows 설정의 열쇠가 다르다
export function chromeInstall(env = process.env) {
  const machine = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((d) => join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  for (const p of machine) if (existsSync(p)) return { path: p, scope: 'machine' };
  const user = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : '';
  if (user && existsSync(user)) return { path: user, scope: 'user' };
  const appPath = (reg(['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe', '/ve']).match(/REG_SZ\s+(.+chrome\.exe)/i) || [])[1];
  if (appPath && existsSync(appPath.trim())) return { path: appPath.trim(), scope: 'machine' };
  return null;
}

let seen = { at: 0, value: null };
// { supported, progId, name, isChrome, chrome } — 30초 기억한다(첫 화면이 자주 묻는다). fresh 면 다시 읽는다(설정 창에서 돌아왔을 때)
export function browserStatus({ fresh = false, platform = process.platform } = {}) {
  if (platform !== 'win32') return { supported: false };
  if (!fresh && seen.value && Date.now() - seen.at < 30000) return seen.value;
  const progId = parseProgId(reg(['query', KEY, '/v', 'ProgId']));
  const chrome = chromeInstall();
  const value = { supported: true, progId, name: browserName(progId) || '알 수 없음', isChrome: isChromeProgId(progId), chrome: !!chrome };
  seen = { at: Date.now(), value };
  return value;
}

// Windows 설정의 «기본 앱» — Chrome 의 화면으로 바로(윈도우 11: [기본값 설정] 단추가 있는 자리). 그 열쇠를 모르는 판은 기본 앱 첫 화면이 열린다
export function settingsUri(scope = 'machine') {
  return 'ms-settings:defaultapps?' + (scope === 'user' ? 'registeredAppUser' : 'registeredAppMachine') + '=Google Chrome';
}
export function openDefaultAppsSettings() {
  if (process.platform !== 'win32') return { ok: false, error: '윈도우에서만 됩니다' };
  const c = chromeInstall();
  if (!c) return { ok: false, error: 'Chrome 이 깔려 있지 않습니다' };
  try {
    spawn('explorer.exe', [settingsUri(c.scope)], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    seen.at = 0;   // 돌아오면 다시 읽는다
    return { ok: true };
  } catch { return { ok: false, error: 'Windows 설정을 열지 못했습니다' }; }
}
