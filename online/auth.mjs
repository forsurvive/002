// 인증 — 앱 자체 계정(Replit 등 호스팅 계정과 독립, 명세 AH-9). 설계: docs/SECURITY.md §3.
//
// · 비밀번호: scrypt(Node 내장 표준 KDF — 암호를 새로 만들지 않는다). OWASP 권장 N=2^17, r=8, p=1.
//   저장 문자열에 매개변수를 함께 적어 두어 나중에 강도를 올릴 수 있다.
// · 세션: 32바이트 난수 토큰 → 쿠키(HttpOnly · SameSite=Lax · https 면 Secure)에 원문, DB 에는 SHA-256 만.
// · 로그인 실패는 한 가지 문구로(계정이 있는지 흘리지 않는다), 없는 계정도 같은 시간이 들게 가짜 해시로 견준다.
// · 같은 IP+계정의 거듭된 실패는 잠시 막는다(프로세스 메모리 — 인스턴스 하나 기준, 늘면 DB 로).

import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const N = 2 ** 17; const R = 8; const P = 1; const KEYLEN = 32;
const MAXMEM = 256 * 1024 * 1024;
export const SESSION_DAYS = 14;
export const COOKIE = 'se_session';
export const MIN_PASSWORD = 10;

// ---------------------------------------------------------------- 비밀번호

export async function hashPassword(password, { n = N } = {}) {
  const salt = randomBytes(16);
  const dk = await scrypt(String(password).normalize('NFC'), salt, KEYLEN, { N: n, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', n, R, P, salt.toString('base64'), dk.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const want = Buffer.from(hashB64, 'base64');
  const got = await scrypt(String(password).normalize('NFC'), Buffer.from(saltB64, 'base64'), want.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return got.length === want.length && timingSafeEqual(got, want);
}

// 없는 계정에도 같은 일을 시키는 가짜 해시(프로세스마다 한 번 만든다)
let dummyHash = null;
const dummy = async () => (dummyHash = dummyHash || await hashPassword(randomBytes(12).toString('hex')));

// ---------------------------------------------------------------- 계정

export const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;

export async function createUser(db, { loginId, password, displayName = '', email = null, isPlatformAdmin = false }) {
  const login = String(loginId || '').trim().toLowerCase();
  if (!LOGIN_RE.test(login)) return { ok: false, code: 'validation', error: '아이디는 영문 소문자·숫자·. _ - 로 3~64자' };
  if (String(password || '').length < MIN_PASSWORD) return { ok: false, code: 'validation', error: '비밀번호는 ' + MIN_PASSWORD + '자 이상' };
  const hash = await hashPassword(password);
  try {
    const { rows } = await db.query(
      `INSERT INTO users (login_id, email, display_name, password_hash, is_platform_admin)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, login_id, display_name, is_platform_admin, status`,
      [login, email, String(displayName || login), hash, !!isPlatformAdmin]);
    return { ok: true, user: rows[0] };
  } catch (e) {
    if (e && e.code === '23505') return { ok: false, code: 'conflict', error: '이미 있는 아이디입니다' };
    throw e;
  }
}

// ---------------------------------------------------------------- 실패 고삐

const FAIL_LIMIT = 5;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const fails = new Map();   // key → { n, until }

function throttled(key, now = Date.now()) {
  const f = fails.get(key);
  return !!(f && f.n >= FAIL_LIMIT && f.until > now);
}
function noteFail(key, now = Date.now()) {
  const f = fails.get(key);
  if (!f || f.until <= now) fails.set(key, { n: 1, until: now + FAIL_WINDOW_MS });
  else f.n += 1;
}
export function resetThrottle() { fails.clear(); }   // 시험이 쓴다

// ---------------------------------------------------------------- 세션

const tokenHash = (token) => createHash('sha256').update(String(token)).digest();

export async function audit(db, { actor = null, organizationId = null, action, targetType = '', targetId = '', ip = '', details = {} }) {
  await db.query(
    'INSERT INTO audit_logs (actor_user_id, organization_id, action, target_type, target_id, ip, details) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [actor, organizationId, action, targetType, String(targetId || ''), String(ip || ''), details]);
}

const SAME_FAILURE = { ok: false, code: 'unauthenticated', error: '아이디 또는 비밀번호가 맞지 않습니다' };

export async function login(db, { loginId, password, ip = '', userAgent = '' }) {
  const login = String(loginId || '').trim().toLowerCase();
  const key = ip + '|' + login;
  if (throttled(key)) return { ok: false, code: 'rate_limited', error: '잠시 뒤에 다시 시도해 주세요' };
  const { rows } = await db.query('SELECT id, password_hash, status FROM users WHERE login_id = $1', [login]);
  const u = rows[0];
  const good = await verifyPassword(password, u ? u.password_hash : await dummy());
  if (!u || !good || u.status !== 'active') {
    noteFail(key);
    await audit(db, { actor: u ? u.id : null, action: 'auth.login_failed', targetType: 'user', targetId: login, ip });
    return SAME_FAILURE;
  }
  fails.delete(key);
  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at, ip, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4, $5)`,
    [u.id, tokenHash(token), SESSION_DAYS, String(ip).slice(0, 64), String(userAgent).slice(0, 256)]);
  await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
  await audit(db, { actor: u.id, action: 'auth.login', targetType: 'user', targetId: u.id, ip });
  return { ok: true, token };
}

// 세션 토큰 → 사용자(살아 있을 때만). 마지막 본 시각은 5분에 한 번만 고친다.
export async function sessionUser(db, token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.last_seen_at, u.id, u.login_id, u.display_name, u.is_platform_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`,
    [tokenHash(token)]);
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60 * 1000) {
    await db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.session_id]);
  }
  return { id: r.id, loginId: r.login_id, displayName: r.display_name, isPlatformAdmin: r.is_platform_admin, sessionId: r.session_id };
}

export async function logout(db, token) {
  if (!token) return;
  await db.query('UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [tokenHash(token)]);
}

// 비밀번호를 바꾸면 그 사람의 모든 세션을 끊는다
export async function changePassword(db, userId, { current, next }) {
  const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) return { ok: false, code: 'unauthenticated', error: '지금 비밀번호가 맞지 않습니다' };
  if (String(next || '').length < MIN_PASSWORD) return { ok: false, code: 'validation', error: '비밀번호는 ' + MIN_PASSWORD + '자 이상' };
  // 본인이 바꾸면 운영자가 들고 있던 사본(known_password_sealed)도 지운다 — 그때부터는 본인만 안다
  await db.query('UPDATE users SET password_hash = $2, known_password_sealed = NULL, updated_at = now() WHERE id = $1', [userId, await hashPassword(next)]);
  await db.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await audit(db, { actor: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId });
  return { ok: true };
}

// ---------------------------------------------------------------- 쿠키

export function sessionCookie(token, { secure = true, clear = false } = {}) {
  return [
    COOKIE + '=' + (clear ? '' : token), 'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + (clear ? 0 : SESSION_DAYS * 86400), ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function readCookie(req, name = COOKIE) {
  for (const part of String((req.headers && req.headers.cookie) || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
