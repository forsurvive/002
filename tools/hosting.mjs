// 어디에 어떻게 여는가 — 포트 · 붙을 주소 · 받아 줄 호스트 이름 · 스테이징 출입 열쇠.
//
// 로컬 개인판은 지금 그대로다: 127.0.0.1:8801 · Host 는 127.0.0.1/localhost 만 · 열쇠 없음.
// 폰 동반 프로그램이 8801 로 붙으므로 실행기(launch.mjs)는 SE2_PORT 를 못박아 띄운다 — PORT 가 끼어들 틈이 없다.
//
// 호스팅(Replit 같은 플랫폼)에 올릴 때만 달라진다:
//   · 포트 — SE2_PORT 가 먼저, 없으면 플랫폼이 주는 PORT, 그도 없으면 8801.
//   · 붙을 주소 — SE2_HOST(예: 0.0.0.0). 적지 않으면 127.0.0.1 — 저절로 바깥에 열리는 일은 없다.
//   · 받아 줄 호스트 이름 — 루프백 이름 + SE2_ALLOWED_HOSTS + 플랫폼이 알려 준 도메인(REPLIT_DOMAINS·REPLIT_DEV_DOMAIN).
//     그 밖의 이름으로 온 요청은 문지기가 돌려보낸다(DNS 재바인딩 방어는 바깥에서도 그대로).
//   · 출입 열쇠 — 바깥에 열면서 SE2_ACCESS_KEY 가 없으면 **서버가 뜨지 않는다.** 계정이 없는 지금 판을
//     누구나 두드리는 자리에 맨몸으로 세우지 않기 위해서다. 굳이 열려면 SE2_ALLOW_OPEN=1 을 적어야 한다.
//     이것은 사람 계정이 아니다 — 계정·세션이 들어오기 전까지 스테이징을 지키는 임시 울타리다.
//
// 이 파일은 순수하다(환경 변수 묶음을 받아 계획을 돌려준다). 바깥 일은 server.mjs 가 한다.

import { createHash, timingSafeEqual } from 'node:crypto';

export const LOCAL_NAMES = ['127.0.0.1', 'localhost'];
export const DEFAULT_PORT = 8801;
export const MIN_KEY_LENGTH = 16;

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// 'https://a.b:443/x' · 'a.b:443' · 'A.B' → 'a.b' (호스트 이름만, 소문자)
export function hostName(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'http://' + s).hostname.toLowerCase();
  } catch { return ''; }
}

// 이 주소에 붙으면 이 PC 밖에서는 닿지 않는가
export function isLoopback(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

// 포트 값 — 0~65535 의 정수만 받는다. 틀린 값이면 null(문제로 적는다).
function portOf(v) {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 65535 ? n : null;
}

/**
 * env 를 읽어 여는 계획을 짓는다. 던지지 않는다 — 막을 까닭은 problems 에 담는다(boot 가 보고 선다).
 * @returns {{ port: number, host: string, exposed: boolean, allowedHosts: string[],
 *             gate: null | { key: string }, open: boolean, problems: string[], notes: string[] }}
 */
export function resolveHosting(env = process.env) {
  const problems = [];
  const notes = [];

  // 포트 — SE2_PORT > PORT > 8801
  let port = DEFAULT_PORT;
  for (const name of ['SE2_PORT', 'PORT']) {
    if (env[name] == null || String(env[name]).trim() === '') continue;
    const n = portOf(env[name]);
    if (n == null) problems.push(name + ' is not a valid port: ' + JSON.stringify(String(env[name])));
    else port = n;
    break;
  }

  const host = String(env.SE2_HOST || '').trim() || '127.0.0.1';
  const exposed = !isLoopback(host);

  // 받아 줄 호스트 이름
  const allowed = new Set(LOCAL_NAMES);
  for (const v of [...list(env.SE2_ALLOWED_HOSTS), ...list(env.REPLIT_DOMAINS), ...list(env.REPLIT_DEV_DOMAIN)]) {
    const h = hostName(v);
    if (h) allowed.add(h);
  }

  // 출입 열쇠 — 바깥에 열 때만 묻는다. 로컬에서 적어 두면 로컬에도 건다(폰 중계기가 막히니 권하지 않는다).
  const key = String(env.SE2_ACCESS_KEY || '');
  const open = String(env.SE2_ALLOW_OPEN || '') === '1';
  let gate = null;
  if (key) {
    if (key.length < MIN_KEY_LENGTH) problems.push('SE2_ACCESS_KEY is too short (need ' + MIN_KEY_LENGTH + '+ characters)');
    else gate = { key };
  } else if (exposed && !open) {
    problems.push('SE2_HOST=' + host + ' opens the server beyond this machine, but SE2_ACCESS_KEY is not set'
      + ' (set it in the platform secrets, or SE2_ALLOW_OPEN=1 to run without it)');
  }

  if (exposed && allowed.size === LOCAL_NAMES.length) {
    notes.push('No public host name is allowed yet - set SE2_ALLOWED_HOSTS (requests by other names get 403)');
  }
  if (exposed && !gate && open) notes.push('Running WITHOUT an access key (SE2_ALLOW_OPEN=1) - anyone who can reach it can read and change projects');
  if (exposed) notes.push('Projects are saved as files on this machine. Hosted platforms may reset files on redeploy - use staging data only');

  return { port, host, exposed, allowedHosts: [...allowed], gate, open, problems, notes };
}

// ---------------------------------------------------------------- 문지기가 쓰는 판정

// Host 머리줄 → URL(받아 줄 이름일 때만). 없거나 낯선 이름이면 null.
export function hostOf(req, allowedHosts) {
  try {
    const u = new URL('http://' + String(req.headers.host || ''));
    return allowedHosts.includes(u.hostname.toLowerCase()) ? u : null;
  } catch { return null; }
}

// Origin 이 붙어 왔으면 제 자리의 것이어야 한다. 없으면(폰 중계기 · 같은 출처 GET) 통과.
//  · 루프백 이름으로 온 요청 — 지금까지 그대로: http · 루프백 이름 · 같은 포트.
//  · 허락한 이름으로 온 요청 — 같은 이름에서 온 것만. https 는 앞단(프록시)이 포트를 바꿔 달 수 있어 이름만 맞추고,
//    http 는 포트까지 맞춘다.
export function originOk(req, host) {
  const o = req.headers.origin;
  if (o == null) return true;
  try {
    const u = new URL(String(o));
    if (LOCAL_NAMES.includes(host.hostname)) {
      return u.protocol === 'http:' && LOCAL_NAMES.includes(u.hostname) && u.port === host.port;
    }
    if (u.hostname.toLowerCase() !== host.hostname.toLowerCase()) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && u.port === host.port;
  } catch { return false; }
}

const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();

// HTTP Basic 의 비밀번호 칸이 열쇠와 같은가 — 사용자 이름은 보지 않는다. 길이가 달라도 시간이 새지 않게 다이제스트로 견준다.
export function gateOk(req, gate) {
  if (!gate) return true;
  const m = /^Basic\s+([A-Za-z0-9+/=._~-]+)\s*$/i.exec(String(req.headers.authorization || ''));
  if (!m) return false;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  const pass = i >= 0 ? decoded.slice(i + 1) : '';
  return timingSafeEqual(digest(pass), digest(gate.key));
}

// 주소창에서 그 페이지로 옮겨 가는 길인가(브라우저가 붙이는 Fetch Metadata). 플랫폼의 상태 검사는 이것을 붙이지 않는다.
export const isNavigation = (req) => String(req.headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate';

export const GATE_REALM = 'Story Engine staging';
