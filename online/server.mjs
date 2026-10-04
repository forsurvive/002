// 온라인 서버 — 개인판과 같은 화면(web/)과 같은 문(POST /api {op} · GET /api/state · GET /api/download)을,
// 앱 계정으로 로그인한 사람에게 PostgreSQL 위에서 연다. 문 표는 개인판과 한 벌이다(tools/ops.mjs).
//
// 개인판과 다른 것:
//   · 로그인(앱 자체 계정 · HttpOnly 쿠키). 로그인하지 않은 /api 는 401 { code: 'login' } — 화면이 /login 으로 보낸다.
//   · 프로젝트 격리: pid 가 오는 모든 문은 «이 사람의 프로젝트인가»를 서버가 먼저 본다. 아니면 404(있는지도 흘리지 않는다).
//   · 키는 화면으로 받지 않는다(auth.write 거절). 돈 나가는 길은 서버의 자격증명만 쓴다(docs/SECURITY.md).
//   · AI 작업은 영속 작업 큐(Sprint 9)와 함께 연다 — 그 전까지 작업을 여는 문은 «준비 중»으로 답한다(기존 글은 건드리지 않는다).
// 실행: DATABASE_URL=… SE2_HOST=0.0.0.0 node online/server.mjs   (docs/REPLIT_DEPLOYMENT.md · 콘솔은 ASCII 만)

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPool } from './db.mjs';
import { migrate } from './migrate.mjs';
import { createProjectStore } from './store.mjs';
import * as auth from './auth.mjs';
import { createOps } from '../tools/ops.mjs';
import * as pick from '../tools/prompt-pick.mjs';
import { materialsToDocs } from '../core/domain/model.mjs';
import { resolveHosting, hostOf, originOk, gateOk, GATE_REALM } from '../tools/hosting.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(dirname(HERE), 'web');
const MAX_BODY = 5 * 1024 * 1024;   // 원고 한 편이 넉넉히 드는 크기. 넘으면 413
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error, code) => ({ ok: false, error: String(error), ...(code ? { code } : {}) });
const NOT_FOUND = '프로젝트를 찾을 수 없습니다';
const AI_NOT_YET = '온라인판의 AI 작업은 준비 중입니다';

// pid 없이 부르는 문 — 나머지는 모두 «이 사람의 프로젝트»여야 한다
const NO_PID = new Set(['project.list', 'project.create', 'auth.read', 'auth.write']);

/**
 * 호스팅 계획 — 개인판과 같은 해석(포트 · 붙을 주소 · 허락한 호스트 이름)을 쓴다.
 * 다만 온라인판은 앱 계정이 문을 지키므로 «바깥에 열면 출입 열쇠가 있어야 한다»는 조건은 두지 않는다
 * (SE2_ACCESS_KEY 를 주면 그 앞에 한 겹 더 선다 — 시험 운영에서 낯선 사람을 아예 못 오게 할 때).
 */
export function onlinePlan(env = process.env) {
  const plan = resolveHosting({ ...env, SE2_ALLOW_OPEN: '1' });
  plan.notes = plan.notes.filter((n) => !/SE2_ALLOW_OPEN|saved as files/.test(n));
  return plan;
}

// 온라인판에서 문 표에 넣는 것 — 저장은 PostgreSQL, 작업은 아직 없음, 과금 갈래는 화면에 없다.
function depsFor(store, user) {
  const by = { userId: user.id };
  const state = {
    get: (pid) => store.get(pid),
    update: (pid, fn) => store.update(pid, fn, by),
    async create(fields) {
      const id = await store.create(fields, { ownerUserId: user.id });
      // 만들며 넣은 자료는 곧바로 «자료» 카테고리의 문서가 된다(개인판 state.create 와 같다)
      await store.update(id, (p) => { p.materials = fields.materials || []; materialsToDocs(p); }, by);
      return { id };
    },
    remove: (pid) => store.remove(pid),
    list: () => store.listFor(user.id),
  };
  const notRunning = () => bad('도는 작업이 아닙니다');
  const jobs = {
    start: () => bad(AI_NOT_YET),
    pause: notRunning, resume: notRunning, remove: notRunning, answer: notRunning,
    stopProject() {}, isTargetRunning: () => false, isKindRunning: () => false,
  };
  // 키도 갈래도 내려 주지 않는다 — modes 가 비면 화면이 «무엇으로» 칸을 세우지 않는다
  const view = () => ({ mode: 'online', modes: [], hasKey: false });
  return {
    state, jobs, engine: pick, auth: { view, write: view }, limit: () => null,
    prepared: () => true,           // 에이전트 준비는 AI 작업과 함께 연다
    startAgentPrep: async () => {},
  };
}

/**
 * pool 과 계획을 받아 서버를 짓는다(시험이 같은 것을 띄운다).
 *   trustProxy : 앞단 프록시가 붙인 X-Forwarded-For 의 마지막 값을 사람의 주소로 믿는가(플랫폼 뒤에서만 켠다)
 *   denyFrames : 남의 페이지 안(iframe)에 싣지 못하게 한다 — 운영에서만 켠다(작업 공간의 미리보기 창이 iframe 이다, docs/SECURITY.md §6)
 */
export function createOnlineServer({ pool, plan = onlinePlan(), trustProxy = false, denyFrames = false } = {}) {
  const store = createProjectStore(pool);
  const secure = plan.exposed;   // 바깥에 열면 https 앞단 뒤 — 쿠키에 Secure 를 단다

  // 화면은 제 자리의 파일만 부른다 — 스크립트는 외부 파일만, 꾸밈은 style 속성을 쓰므로 인라인 꾸밈만 허락
  const csp = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:" + (denyFrames ? "; frame-ancestors 'none'" : '');
  const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, {
      'content-type': type, 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'content-security-policy': csp,
      ...(denyFrames ? { 'x-frame-options': 'DENY' } : {}),
      ...extra,
    });
    res.end(body);
  };
  const json = (res, code, obj, extra) => send(res, code, JSON.stringify(obj), 'application/json; charset=utf-8', extra);

  const ipOf = (req) => {
    if (trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (hops.length) return hops[hops.length - 1];
    }
    return req.socket.remoteAddress || '';
  };

  const readBody = (req) => new Promise((resolve) => {
    let s = ''; let n = 0; let over = false;
    req.setEncoding('utf8');
    req.on('data', (c) => { n += Buffer.byteLength(c); if (n > MAX_BODY) over = true; else s += c; });
    req.on('end', () => {
      if (over) return resolve({ tooBig: true });
      try { resolve({ body: JSON.parse(s || '{}') }); } catch { resolve({ body: null }); }
    });
  });

  const isJson = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';

  // 그 사람의 프로젝트인가 — 지운 것 · 남의 것 · 이상한 id 는 모두 «없음»으로 같게 답한다
  const owns = async (user, pid) => {
    if (!UUID.test(String(pid || ''))) return false;
    const r = await pool.query('SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL', [pid, user.id]);
    return r.rowCount > 0;
  };

  const staticFile = async (res, rel) => {
    const file = join(WEB, normalize(rel).replace(/^[\\/]+/, ''));
    if (!file.startsWith(WEB) || !existsSync(file)) return send(res, 404, '없음', 'text/plain; charset=utf-8');
    const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    return send(res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream');
  };

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
      if (plan.gate && !gateOk(req, plan.gate)) {
        return send(res, 401, '출입 열쇠가 필요합니다', 'text/plain; charset=utf-8', { 'www-authenticate': 'Basic realm="' + GATE_REALM + '", charset="UTF-8"' });
      }
      const host = hostOf(req, plan.allowedHosts);
      if (!host) return json(res, 403, bad('허락하지 않은 호스트 이름입니다'));

      // 쓰는 요청은 모두 같은 자리에서 온 JSON 이어야 한다(남의 페이지가 쿠키를 빌려 쏘는 길을 막는다)
      let body = null;
      if (req.method === 'POST') {
        if (!originOk(req, host)) return json(res, 403, bad('다른 곳에서 온 요청은 받지 않습니다'));
        if (!isJson(req)) return json(res, 415, bad('JSON 요청만 받습니다'));
        const got = await readBody(req);
        if (got.tooBig) return json(res, 413, bad('요청이 너무 큽니다'));
        body = got.body;
        if (!body || typeof body !== 'object') return json(res, 400, bad('JSON 이 아닙니다'));
      }

      // ---------------- 로그인 · 로그아웃
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const r = await auth.login(pool, { loginId: body.loginId, password: body.password, ip: ipOf(req), userAgent: req.headers['user-agent'] || '' });
        if (!r.ok) return json(res, r.code === 'rate_limited' ? 429 : 401, bad(r.error, r.code));
        return json(res, 200, ok(), { 'set-cookie': auth.sessionCookie(r.token, { secure }) });
      }
      const token = auth.readCookie(req);
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        await auth.logout(pool, token);
        return json(res, 200, ok(), { 'set-cookie': auth.sessionCookie('', { secure, clear: true }) });
      }

      const user = await auth.sessionUser(pool, token);
      const me = user ? { loginId: user.loginId, displayName: user.displayName } : null;

      if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login.html')) {
        if (user) return send(res, 302, '', 'text/plain; charset=utf-8', { location: '/' });
        return staticFile(res, 'login.html');
      }
      if (!user) {
        if (url.pathname.startsWith('/api')) return json(res, 401, bad('로그인이 필요합니다', 'login'));
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          return send(res, 302, '', 'text/plain; charset=utf-8', { location: '/login' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, ok({ me }));

      // ---------------- 문 하나 — 개인판과 같은 op 와 같은 응답 꼴
      if (req.method === 'POST' && url.pathname === '/api') {
        const op = String(body.op || '');
        if (!op) return json(res, 400, bad('op 없음'));
        if (op === 'auth.write') return json(res, 403, bad('온라인판에서는 키를 여기서 받지 않습니다'));
        const { OPS } = createOps(depsFor(store, user));
        const fn = OPS[op];
        if (!fn) return json(res, 404, bad('그런 문이 없습니다: ' + op));
        if (!NO_PID.has(op) && !(await owns(user, body.pid))) return json(res, 404, bad(NOT_FOUND));
        let out;
        try { out = await fn(body); } catch (e) { out = bad((e && e.message) || e); }
        if (out && out.ok !== false && (op === 'project.create' || op === 'project.delete')) {
          await auth.audit(pool, { actor: user.id, action: op, targetType: 'project', targetId: op === 'project.create' ? out.pid : body.pid, ip: ipOf(req) });
        }
        return json(res, 200, out || ok());
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const { stateOf } = createOps(depsFor(store, user));
        const projects = await store.listFor(user.id);
        const pid = url.searchParams.get('pid') || '';
        if (!pid) return json(res, 200, { ok: true, projects, me });
        const st = (await owns(user, pid)) ? await stateOf(pid) : null;
        if (!st) return json(res, 200, { ok: false, error: '없음', projects, me });
        return json(res, 200, { ok: true, project: st, projects, me });
      }

      if (req.method === 'GET' && url.pathname === '/api/download') {
        const pid = url.searchParams.get('pid');
        const { downloadOf } = createOps(depsFor(store, user));
        const d = (await owns(user, pid)) ? await downloadOf(pid, url.searchParams.get('kind'), url.searchParams.get('id')) : null;
        if (!d) return send(res, 404, '없음', 'text/plain; charset=utf-8');
        return send(res, 200, d.text, 'text/markdown; charset=utf-8', {
          'content-disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(d.name),
        });
      }

      if (req.method === 'GET' && !url.pathname.startsWith('/api')) {
        return staticFile(res, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
      }
      return send(res, url.pathname.startsWith('/api') ? 404 : 405, '', 'text/plain');
    } catch (e) {
      // 바깥에는 까닭을 흘리지 않는다(쿼리 · 경로 · 값이 오류 문구에 섞일 수 있다). 콘솔에는 이름만.
      console.log('  [ERROR] ' + ((e && e.code) || (e && e.name) || 'unknown'));
      try { json(res, 500, bad('서버 오류')); } catch { /* 이미 보냈다 */ }
    }
  }

  return createServer((req, res) => { handle(req, res); });
}

// 직접 띄울 때 — 마이그레이션을 앞으로만 적용하고(SE_MIGRATE_ON_BOOT=0 이면 건너뜀) 연다.
if (process.argv[1] && process.argv[1].endsWith(join('online', 'server.mjs'))) {
  const plan = onlinePlan(process.env);
  if (plan.problems.length) { for (const p of plan.problems) console.log('  [STOP] ' + p); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.log('  [STOP] DATABASE_URL is not set (put it in the platform secrets)'); process.exit(1); }
  const pool = createPool(process.env.DATABASE_URL);
  if (process.env.SE_MIGRATE_ON_BOOT !== '0') {
    const r = await migrate(pool);
    if (r.applied.length) console.log('  Migrations   : applied ' + r.applied.join(', '));
  }
  const srv = createOnlineServer({ pool, plan, trustProxy: process.env.SE_TRUST_PROXY === '1', denyFrames: process.env.NODE_ENV === 'production' });
  srv.listen(plan.port, plan.host, () => {
    console.log('  Story Engine (online) : listening on ' + plan.host + ':' + plan.port);
    console.log('  Host names   : ' + plan.allowedHosts.join(', '));
    for (const n of plan.notes) console.log('  [NOTE] ' + n);
  });
  const bye = () => { srv.close(); pool.end().finally(() => process.exit(0)); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
