// 구글 로그인(OpenID Connect · 인가 코드 + PKCE) — 설계: docs/OPEN_EDITION.md §4-9. 자유 가입판에만, 구글 클라이언트가 Secrets 에 있을 때만.
//
// 지키는 것
//   · state(무작위 · 10분 · 한 번만 — 서버 표와 쿠키 둘 다 맞아야) · nonce · PKCE(S256). 받는 것은 openid email profile 만.
//   · 코드 교환은 서버가 구글과 직접(HTTPS · 클라이언트 시크릿) — 그렇게 받은 id_token 은 서명 대신 iss · aud · exp · nonce 를 본다
//     (구글 OpenID Connect 안내: 중간자 없는 HTTPS 로 구글에서 곧장 받은 토큰). 이메일은 email_verified 일 때만 쓴다.
//   · 클라이언트 시크릿은 Secrets(GOOGLE_CLIENT_SECRET)에만 — 화면 · 로그 · 오류 문구에 싣지 않는다. 오류는 이름만.

import { randomBytes, createHash } from 'node:crypto';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const STATE_MINUTES = 10;
export const CALLBACK_PATH = '/api/auth/google/callback';

// Secrets 에 둘 다 있을 때만 켠다(시험은 tokenUrl · authUrl 을 바꿔 가짜 구글로)
export function googleConfig(env = process.env) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  return clientId && clientSecret ? { clientId, clientSecret, authUrl: AUTH_URL, tokenUrl: TOKEN_URL } : null;
}

const b64u = (n) => randomBytes(n).toString('base64url');
// 로그인 시작 한 번의 값 — state · nonce · PKCE(verifier 원문은 서버 표에만, 구글에는 challenge 만)
export function freshStart() {
  const verifier = b64u(48);
  return { state: b64u(24), nonce: b64u(24), verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function authorizeUrl(cfg, { redirectUri, state, nonce, challenge }) {
  const u = new URL(cfg.authUrl || AUTH_URL);
  u.search = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
  }).toString();
  return u.toString();
}

/**
 * 코드 교환 — 서버가 구글 토큰 주소와 직접. 돌려주는 값: { ok, idToken } 또는 { ok:false, reason: token_http | token_shape | token_network }
 * (구글의 오류 본문 · 시크릿은 돌려주지 않는다)
 */
export async function exchangeCode(cfg, { code, verifier, redirectUri, fetchImpl = fetch, timeoutMs = 10000 }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(cfg.tokenUrl || TOKEN_URL, {
      method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ code: String(code || ''), client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri,
        grant_type: 'authorization_code', code_verifier: verifier }).toString(),
    });
    if (!r.ok) return { ok: false, reason: 'token_http', status: r.status };
    const j = await r.json().catch(() => null);
    return j && typeof j.id_token === 'string' ? { ok: true, idToken: j.id_token } : { ok: false, reason: 'token_shape' };
  } catch {
    return { ok: false, reason: 'token_network' };
  } finally {
    clearTimeout(t);
  }
}

/**
 * id_token 읽기 — 구글에서 곧장 받은 것만 넘긴다(위 exchangeCode). 서명 대신 발급자 · 받는 쪽 · 기한 · nonce 를 본다.
 * 돌려주는 값: { ok, sub, email(확인된 것만, 소문자), name } 또는 { ok:false, reason: malformed | issuer | audience | expired | nonce | subject }
 */
export function readIdToken(idToken, { clientId, nonce, now = Date.now() }) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  let p;
  try { p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!p || typeof p !== 'object') return { ok: false, reason: 'malformed' };
  if (!ISSUERS.includes(p.iss)) return { ok: false, reason: 'issuer' };
  if (!(Array.isArray(p.aud) ? p.aud : [p.aud]).includes(clientId)) return { ok: false, reason: 'audience' };
  if (!(Number(p.exp) * 1000 > now)) return { ok: false, reason: 'expired' };
  if (!nonce || p.nonce !== nonce) return { ok: false, reason: 'nonce' };
  if (!p.sub || typeof p.sub !== 'string' || p.sub.length > 255) return { ok: false, reason: 'subject' };
  const verified = p.email_verified === true || p.email_verified === 'true';
  const email = verified ? String(p.email || '').trim().toLowerCase() : '';
  return { ok: true, sub: p.sub, email: /^[^\s@]+@[^\s@]+$/.test(email) ? email.slice(0, 200) : '', name: String(p.name || '').replace(/\s+/g, ' ').trim().slice(0, 60) };
}

// 구글로 처음 가입한 사람의 아이디 후보 — 이메일 앞부분을 아이디 규칙(LOGIN_RE)에 맞게. 비면 g- + 무작위.
export function loginIdFrom(email) {
  const local = String(email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 40).replace(/[-._]+$/, '');
  return local.length >= 3 ? local : 'g-' + randomBytes(5).toString('hex');
}
