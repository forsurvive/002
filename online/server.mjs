// 온라인 서버 — 개인판과 같은 화면(web/)과 같은 문(POST /api {op} · GET /api/state · GET /api/download)을,
// 앱 계정으로 로그인한 사람에게 PostgreSQL 위에서 연다. 문 표는 개인판과 한 벌이다(tools/ops.mjs).
//
// 개인판과 다른 것:
//   · 로그인(앱 자체 계정 · HttpOnly 쿠키). 로그인하지 않은 /api 는 401 { code: 'login' } — 화면이 /login 으로 보낸다.
//   · 프로젝트 격리: pid 가 오는 모든 문은 «이 사람의 프로젝트인가»를 서버가 먼저 본다. 아니면 404(있는지도 흘리지 않는다).
//   · 키는 화면으로 받지 않는다(auth.write 거절). 돈 나가는 길은 서버의 자격증명만 쓴다(docs/SECURITY.md).
//   · AI 작업은 영속 작업 큐에 넣고(online/jobs.mjs) worker 가 돌린다(online/worker.mjs). 키는 서버의 자격증명만 쓴다.
//     프로젝트를 만들면 개인판처럼 에이전트 준비(종류 판정 · 자리 짓기 · 자료 분석) 작업이 곧바로 선다.
// 실행: DATABASE_URL=… SE2_HOST=0.0.0.0 node online/server.mjs   (docs/REPLIT_DEPLOYMENT.md · 콘솔은 ASCII 만)

import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
import { materialsToDocs, materialDocs, findThread, threadAddMessage } from '../core/domain/model.mjs';
import { agentsReady, STUDY_TITLE } from '../core/generation/agents.mjs';
import { AGENT_SLOTS } from '../tools/prompts.mjs';
import { createJobQueue } from './jobs.mjs';
import { createTenancy, SAY } from './tenancy.mjs';
import { createEdu } from './edu.mjs';
import { createWorkflowSource } from './workflow.mjs';
import { createWorker } from './worker.mjs';
import { createOnlineCall } from './call.mjs';
import { buildAi } from './ai.mjs';
import { resolveHosting, hostOf, originOk, gateOk } from '../tools/hosting.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(dirname(HERE), 'web');
const MAX_BODY = 5 * 1024 * 1024;   // 원고 한 편이 넉넉히 드는 크기. 넘으면 413
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error, code) => ({ ok: false, error: String(error), ...(code ? { code } : {}) });
const NOT_FOUND = '프로젝트를 찾을 수 없습니다';

// pid 없이 부르는 문 — 나머지는 모두 «이 사람의 프로젝트»여야 한다
const NO_PID = new Set(['project.list', 'project.create', 'auth.read', 'auth.write']);
// 읽기만 하는 문 — 열람 권한(강사 · 정책이 허락한 기관 관리자)으로도 부를 수 있다
const READ_OPS = new Set(['peek', 'prompt.read']);

/**
 * 호스팅 계획 — 개인판과 같은 해석(포트 · 붙을 주소 · 허락한 호스트 이름)을 쓴다.
 * 다만 온라인판은 앱 계정(아이디 · 비밀번호)이 문을 지킨다 — 출입 열쇠는 쓰지 않는다(2026-10-05 사용자 결정).
 * SE2_ACCESS_KEY 가 플랫폼 비밀값에 남아 있어도 무시한다. 굳이 한 겹 더 세우려면 SE2_ONLINE_GATE=1 을 함께 적는다.
 */
export function onlinePlan(env = process.env) {
  const gateOn = String(env.SE2_ONLINE_GATE || '') === '1';
  const plan = resolveHosting({ ...env, SE2_ALLOW_OPEN: '1', SE2_ACCESS_KEY: gateOn ? env.SE2_ACCESS_KEY || '' : '' });
  plan.notes = plan.notes.filter((n) => !/SE2_ALLOW_OPEN|saved as files/.test(n));
  return plan;
}

// 온라인판에서 문 표에 넣는 것 — 저장은 PostgreSQL, 작업은 영속 큐(online/jobs.mjs), 과금 갈래는 화면에 없다.
function depsFor(store, queue, worker, user, { tenancy = null, place = null, wfs = null, pool = null } = {}) {
  const by = { userId: user.id };
  const state = {
    // 작업 줄은 jobs 표가 맡는다 — 덩어리에 싣지 않고 읽을 때 붙인다(화면은 개인판과 같은 p.jobs 를 본다)
    async get(pid) {
      const p = await store.get(pid);
      if (p) p.jobs = await queue.list(pid);
      return p;
    },
    update: (pid, fn) => store.update(pid, fn, by),
    async create(fields) {
      // 수업 안에 만들면 그 기관 · 수업에 묶인다(비용 주체 ORGANIZATION — 기관 키로 돈다)
      const id = await store.create(fields, { ownerUserId: user.id, organizationId: place ? place.organizationId : null, classId: place ? place.classId : null });
      // 만들며 넣은 자료는 곧바로 «자료» 카테고리의 문서가 된다(개인판 state.create 와 같다)
      await store.update(id, (p) => { p.materials = fields.materials || []; materialsToDocs(p); }, by);
      return { id };
    },
    remove: (pid) => store.remove(pid),
    list: () => store.listFor(user.id),
  };
  const jobs = {
    async start(pid, { kind, title = '작업', targetId = '', params = {} }) {
      // 기관 프로젝트는 AI 작업을 넣을 때마다 라이선스를 다시 본다(worker 도 돌리기 직전에 한 번 더)
      if (tenancy) {
        const a = await tenancy.aiAllowed(pid);
        if (!a.ok) return bad(SAY[a.reason] || SAY.missing);
      }
      let p = { ...params };
      if (kind === 'talk') {
        // 작가의 말은 작업 «앞»에 저장한다 — 재시도 · 이어 하기에도 말이 한 번만 얹히고, 서버가 내려가도 말은 남는다
        if (await queue.isTargetActive(pid, targetId)) return bad('이미 도는 중입니다');
        let askedId = '';
        await store.update(pid, (pr) => {
          const t = findThread(pr, p.threadId);
          if (!t) return;
          if (p.text != null) { const m = threadAddMessage(pr, p.threadId, 'user', String(p.text)); askedId = m ? m.id : ''; }
          else askedId = t.headId || '';   // 지난 말을 고쳐 돋은 가지 — 그 끝에 답한다
        }, by);
        if (!askedId) return bad('스레드를 찾을 수 없습니다');
        p = { ...p, text: null, askedId };
      }
      const r = await queue.enqueue({ pid, requestedBy: user.id, kind, title, targetId, params: p });
      if (!r.ok) return bad(r.error);
      if (worker) worker.wake();
      return ok({ jobId: r.jobId });
    },
    pause: (pid, id) => queue.pause(pid, id),
    resume: async (pid, id) => { const r = await queue.resume(pid, id); if (r.ok && worker) worker.wake(); return r; },
    remove: (pid, id) => queue.dismiss(pid, id),
    answer: async (pid, id, choice) => { const r = await queue.answer(pid, id, choice); if (r.ok && worker) worker.wake(); return r; },
    stopProject: (pid) => queue.cancelProject(pid),
    isTargetRunning: (pid, id) => queue.isTargetActive(pid, id),
    isKindRunning: (pid, kind) => queue.isKindActive(pid, kind),
  };
  // 키도 갈래도 내려 주지 않는다 — modes 가 비면 화면이 «무엇으로» 칸을 세우지 않는다
  const view = () => ({ mode: 'online', modes: [], hasKey: false });
  return {
    state, jobs, engine: pick, auth: { view, write: view }, limit: () => null,
    // 단계 흐름 — 템플릿은 운영자 · 기관이 고쳐 쓴 것까지. 강의 카드는 기관 프로젝트면 기관 설정(기본 켬), 개인 프로젝트면 그 사람의 설정(기본 끔).
    workflow: (pid) => (wfs ? wfs.templateFor(pid) : null),
    cardsOn: async (p) => {
      const org = pool ? (await pool.query('SELECT o.settings FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = $1', [p.id])).rows[0] : null;
      return org ? (org.settings || {}).student_cards !== false : !!(p.workflow && p.workflow.cards);
    },
    // 준비가 온전히 끝났는가 — 개인판 서버와 같은 셈(프롬프트가 다 서 있고, 자료가 있다면 «자료 분석»까지)
    prepared: (p) => agentsReady(p, AGENT_SLOTS) && (!materialDocs(p).length || p.docs.some((d) => d.title === STUDY_TITLE)),
    // 프로젝트를 만든 직후 그 프로젝트 전용 에이전트를 짓는다(소설이면 판정만 남기고 끝난다)
    startAgentPrep: (pid, request = '') => jobs.start(pid, { kind: 'agents', title: '에이전트 준비', params: { request } }),
  };
}

/**
 * pool 과 계획을 받아 서버를 짓는다(시험이 같은 것을 띄운다).
 *   trustProxy : 앞단 프록시가 붙인 X-Forwarded-For 의 마지막 값을 사람의 주소로 믿는가(플랫폼 뒤에서만 켠다)
 *   queue · worker : 작업 큐와 (같은 프로세스의) worker — 작업을 넣으면 worker 를 깨운다. worker 가 없으면 넣기만 한다(따로 띄운 worker 가 집는다)
 *   credentials : 자격증명 서비스(ai/credentials.mjs) — 처음 설정에서 AI 키를 봉해 넣을 때 쓴다
 *   denyFrames : 남의 페이지 안(iframe)에 싣지 못하게 한다 — 운영에서만 켠다(작업 공간의 미리보기 창이 iframe 이다, docs/SECURITY.md §6)
 */
export function createOnlineServer({ pool, plan = onlinePlan(), trustProxy = false, denyFrames = false, queue = createJobQueue(pool), worker = null, credentials = null, keyTester = null } = {}) {
  const store = createProjectStore(pool);
  const tenancy = createTenancy(pool);
  const wfs = createWorkflowSource(pool);
  const edu = createEdu({ pool, credentials, wfs, keyTester });
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

  // 읽을 수 있는 프로젝트인가 — 판정은 online/tenancy.mjs 한 곳(주인 · 맡은 수업의 강사 · 정책이 허락한 기관 관리자).
  // 지운 것 · 남의 것 · 이상한 id 는 모두 «없음»으로 같게 답한다.
  const canRead = async (user, pid) => (await tenancy.access(user, pid)).read;

  // 상태의 지문 — 질의 하나(덩어리를 짓는 열세 질의 대신). 남의 프로젝트면 지문을 내지 않는다(그 길은 «없음»으로 답한다).
  const fingerprint = async (user, pid) => {
    if (pid && !(await canRead(user, pid))) return '';
    const { rows } = await pool.query(
      `SELECT (SELECT updated_at::text FROM projects WHERE id = $1::uuid) AS p,
              (SELECT count(*)::text || ':' || coalesce(max(updated_at)::text, '') FROM projects WHERE owner_user_id = $2 AND deleted_at IS NULL)
                || '|' || (SELECT count(*)::text FROM class_members WHERE user_id = $2)
                || '|' || (SELECT count(*)::text FROM organization_members WHERE user_id = $2 AND status = 'active') AS mine,
              (SELECT coalesce(string_agg(id::text || status || step || coalesce(step_at::text, '') || coalesce(ended_at::text, '')
                        || coalesce(dismissed_at::text, '') || coalesce(ask::text, '') || error_message_safe || coalesce(result::text, ''), ',' ORDER BY id), '')
                 FROM jobs WHERE project_id = $1::uuid) AS jobs`, [pid || null, user.id]);
    return 'W/"' + createHash('sha256').update(user.id + '|' + pid + '|' + rows[0].p + '|' + rows[0].mine + '|' + rows[0].jobs).digest('base64url') + '"';
  };

  const staticFile = async (res, rel) => {
    const file = join(WEB, normalize(rel).replace(/^[\\/]+/, ''));
    if (!file.startsWith(WEB) || !existsSync(file)) return send(res, 404, '없음', 'text/plain; charset=utf-8');
    const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    return send(res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream');
  };

  // ---------------- 출입 열쇠(스테이징) — 쿠키 값은 열쇠에서 뽑은 지문(열쇠 원문은 쿠키에 없다)
  const GATE_COOKIE = 'se_gate';
  const gateMark = plan.gate ? createHash('sha256').update('se-gate|' + plan.gate.key).digest('base64url') : '';
  const gateCookieOk = (req) => {
    const got = Buffer.from(auth.readCookie(req, GATE_COOKIE));
    const want = Buffer.from(gateMark);
    return !!gateMark && got.length === want.length && timingSafeEqual(got, want);
  };
  const gateFails = new Map();   // ip → { n, until } — 열쇠 맞히기를 늦춘다
  async function passGate(req, res) {
    const ip = ipOf(req);
    const now = Date.now();
    const f = gateFails.get(ip);
    if (f && f.n >= 5 && f.until > now) return json(res, 429, bad('잠시 뒤에 다시 시도해 주세요', 'rate_limited'));
    const host = hostOf(req, plan.allowedHosts);
    if (!host) return json(res, 403, bad('허락하지 않은 호스트 이름입니다'));
    if (!originOk(req, host)) return json(res, 403, bad('다른 곳에서 온 요청은 받지 않습니다'));
    if (!isJson(req)) return json(res, 415, bad('JSON 요청만 받습니다'));
    const got = await readBody(req);
    const key = String((got.body && got.body.key) || '');
    const fake = { headers: { authorization: 'Basic ' + Buffer.from('gate:' + key).toString('base64') } };
    if (!key || !gateOk(fake, plan.gate)) {
      if (!f || f.until <= now) gateFails.set(ip, { n: 1, until: now + 15 * 60 * 1000 }); else f.n += 1;
      return json(res, 401, bad('출입 열쇠가 맞지 않습니다', 'gate'));
    }
    gateFails.delete(ip);
    const cookie = [GATE_COOKIE + '=' + gateMark, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + 30 * 86400, ...(secure ? ['Secure'] : [])].join('; ');
    return json(res, 200, ok(), { 'set-cookie': cookie });
  }

  // ---------------- 처음 설정 코드 — 바깥에 열었고 계정이 아직 없을 때. 서버를 켠 사람만 콘솔에서 본다(메모리에만, 켤 때마다 새로).
  const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const setupCode = plan.exposed && !plan.gate
    ? Array.from(randomBytes(12), (b, i) => (i && i % 4 === 0 ? '-' : '') + CODE_ABC[b % CODE_ABC.length]).join('') : '';
  const norm = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const setupCodeOk = (c) => {
    if (!setupCode) return false;
    const got = createHash('sha256').update(norm(c)).digest();
    return timingSafeEqual(got, createHash('sha256').update(norm(setupCode)).digest());
  };
  const setupFails = new Map();

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
      if (plan.gate && !gateOk(req, plan.gate) && !gateCookieOk(req)) {
        // 출입 열쇠는 브라우저의 뜻 모를 로그인 창 대신 로그인 화면에서 묻는다(열쇠를 넣으면 쿠키로 30일).
        // 열쇠 전에는 로그인 화면(원고 없는 파일 셋)과 열쇠 받기만 열린다.
        if (req.method === 'POST' && url.pathname === '/api/gate') return passGate(req, res, url);
        if (url.pathname.startsWith('/api')) return json(res, 401, bad('출입 열쇠가 필요합니다', 'gate'));
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 401, bad('출입 열쇠가 필요합니다', 'gate'));
        if (url.pathname === '/login.js' || url.pathname === '/style.css') return staticFile(res, url.pathname);
        return staticFile(res, 'login.html');
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
      // ---------------- 처음 설정 — 계정이 하나도 없을 때 한 번만. 운영자 계정(+ 그 계정의 AI 키)을 화면에서 만든다.
      // 이 컴퓨터 안(루프백)의 요청 · 출입 열쇠를 지나온 요청 · 서버 콘솔에 찍힌 «설정 코드»를 넣은 요청만 받는다
      // — 바깥에 연 서버를 낯선 사람이 먼저 차지하지 못하게.
      if (url.pathname === '/api/setup') {
        const empty = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n === 0;
        // 바깥에 열었으면(플랫폼 앞단을 거치면 소켓 주소가 루프백일 수 있다) 출입 열쇠만 믿는다
        const trusted = !!plan.gate || (!plan.exposed && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || ''));
        if (req.method === 'GET') return json(res, 200, ok({ needed: empty && (trusted || !!setupCode), code: empty && !trusted && !!setupCode, ai: !!credentials }));
        if (req.method !== 'POST') return json(res, 405, bad('POST 만 받습니다'));
        if (!empty) return json(res, 409, bad('이미 설정을 마쳤습니다 — 로그인해 주세요'));
        if (!trusted) {
          const ip = ipOf(req);
          const f = setupFails.get(ip);
          if (f && f.n >= 5 && f.until > Date.now()) return json(res, 429, bad('잠시 뒤에 다시 시도해 주세요', 'rate_limited'));
          if (!setupCodeOk(body.setupCode)) {
            if (!f || f.until <= Date.now()) setupFails.set(ip, { n: 1, until: Date.now() + 15 * 60 * 1000 }); else f.n += 1;
            return json(res, 403, bad('설정 코드가 맞지 않습니다 — 서버 콘솔(Console)에 찍힌 코드를 넣어 주세요', 'setup_code'));
          }
        }
        const made = await auth.createUser(pool, { loginId: body.loginId, password: body.password, displayName: body.displayName || '', isPlatformAdmin: true });
        if (!made.ok) return json(res, made.code === 'conflict' ? 409 : 422, bad(made.error, made.code));
        await auth.audit(pool, { actor: made.user.id, action: 'setup.first_admin', targetType: 'user', targetId: made.user.id, ip: ipOf(req) });
        let keyNote = '';
        const apiKey = String(body.apiKey || '').trim();
        if (apiKey && credentials) {
          const k = await credentials.set({ ownerType: 'user', ownerId: made.user.id, provider: 'anthropic', apiKey, createdBy: made.user.id });
          if (k.ok) await auth.audit(pool, { actor: made.user.id, action: 'credential.set', targetType: 'user', targetId: made.user.id, details: { provider: 'anthropic', ownerType: 'user', credentialId: k.credential.id } });
          else keyNote = 'AI 키를 저장하지 못했습니다 — 나중에 다시 넣어 주세요';
        }
        const r = await auth.login(pool, { loginId: body.loginId, password: body.password, ip: ipOf(req), userAgent: req.headers['user-agent'] || '' });
        return json(res, 200, ok({ note: keyNote }), r.ok ? { 'set-cookie': auth.sessionCookie(r.token, { secure }) } : {});
      }

      const token = auth.readCookie(req);
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        await auth.logout(pool, token);
        return json(res, 200, ok(), { 'set-cookie': auth.sessionCookie('', { secure, clear: true }) });
      }

      const user = await auth.sessionUser(pool, token);
      const me = user ? { loginId: user.loginId, displayName: user.displayName } : null;
      // 화면이 어느 단추를 세울지 — 관리(운영자 · 기관 관리자) · 내 수업. 단추는 편의일 뿐, 판정은 edu · tenancy 가 문마다 다시 한다.
      const withRoles = async () => {
        if (!me) return me;
        const r = (await pool.query(
          `SELECT bool_or(role = 'organization_admin') AS org_admin, count(*)::int AS n FROM organization_members WHERE user_id = $1 AND status = 'active'`, [user.id])).rows[0];
        const classes = (await pool.query('SELECT count(*)::int AS n FROM class_members WHERE user_id = $1', [user.id])).rows[0].n;
        // 새 작품을 만들 수 있는 수업 — 열려 있고 기관 이용 기간 안(화면의 «어디에 만들까요?»). 막는 것은 project.create 가 다시 본다.
        const open = (await pool.query(
          `SELECT c.id, c.name, c.organization_id, o.name AS org_name FROM class_members m JOIN classes c ON c.id = m.class_id
             JOIN organizations o ON o.id = c.organization_id
            WHERE m.user_id = $1 AND c.status = 'active' AND o.status = 'active' ORDER BY c.name`, [user.id])).rows;
        const places = [];
        for (const c of open) if ((await tenancy.licenseOf(c.organization_id)).ok) places.push({ classId: c.id, name: c.name, orgName: c.org_name });
        // 신분 — 화면 위쪽에 «아이디 · 신분»으로 보인다(여럿이면 모두). 막는 것은 문마다 서버가 다시 본다.
        const held = new Set((await pool.query(
          `SELECT role FROM organization_members WHERE user_id = $1 AND status = 'active'
            UNION SELECT role FROM class_members WHERE user_id = $1`, [user.id])).rows.map((x) => x.role));
        const roles = [...(user.isPlatformAdmin ? ['platform_admin'] : []), ...['organization_admin', 'instructor', 'student'].filter((x) => held.has(x))];
        return { ...me, manage: !!(user.isPlatformAdmin || r.org_admin), platformAdmin: !!user.isPlatformAdmin, classes, member: r.n > 0, places, roles };
      };

      if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/login.html')) {
        if (user) return send(res, 302, '', 'text/plain; charset=utf-8', { location: '/' });
        return staticFile(res, 'login.html');
      }
      // ---------------- 교육기관판의 일(기관 · 라이선스 · 수업 · 초대 · 수업 현황 · 기관 키) — online/edu.mjs
      // 초대 받기만 로그인 없이도 된다(새 계정을 만들며 들어온다). 나머지 권한은 edu 가 한 문씩 본다.
      if (req.method === 'POST' && url.pathname === '/api/edu') {
        const r = await edu.handle(user, body, ipOf(req));
        if (r.newUser) {
          const li = await auth.login(pool, { loginId: body.loginId, password: body.password, ip: ipOf(req), userAgent: req.headers['user-agent'] || '' });
          if (li.ok) return json(res, r.status, r.body, { 'set-cookie': auth.sessionCookie(li.token, { secure }) });
        }
        return json(res, r.status, r.body);
      }

      if (!user) {
        if (url.pathname.startsWith('/api')) return json(res, 401, bad('로그인이 필요합니다', 'login'));
        // 로그인 전에는 첫 화면(로그인 · 초대 코드 · 계정 만들기) 하나로 모은다.
        // «/» 는 옮기지 않고 그 자리에서 첫 화면을 200 으로 준다 — 게시(배포)의 상태 검사가 «/» 에 200 을 바란다.
        if (req.method === 'GET' && url.pathname === '/') return staticFile(res, 'login.html');
        if (req.method === 'GET' && ['/index.html', '/school.html', '/manage.html', '/account.html'].includes(url.pathname)) {
          return send(res, 302, '', 'text/plain; charset=utf-8', { location: '/login' });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/me') return json(res, 200, ok({ me: await withRoles() }));
      // 내 비밀번호 바꾸기 — 지금 비밀번호를 알아야 한다. 바꾸면 다른 세션은 모두 끊기고, 이 브라우저는 새로 들어온다.
      if (req.method === 'POST' && url.pathname === '/api/auth/password') {
        const r = await auth.changePassword(pool, user.id, { current: body.current, next: body.next });
        if (!r.ok) return json(res, r.code === 'validation' ? 422 : 403, bad(r.error, r.code));
        const li = await auth.login(pool, { loginId: user.loginId, password: body.next, ip: ipOf(req), userAgent: req.headers['user-agent'] || '' });
        return json(res, 200, ok(), li.ok ? { 'set-cookie': auth.sessionCookie(li.token, { secure }) } : {});
      }

      // ---------------- 문 하나 — 개인판과 같은 op 와 같은 응답 꼴
      if (req.method === 'POST' && url.pathname === '/api') {
        const op = String(body.op || '');
        if (!op) return json(res, 400, bad('op 없음'));
        if (op === 'auth.write') return json(res, 403, bad('온라인판에서는 키를 여기서 받지 않습니다'));
        // 수업 안에 만들기 — 그 수업의 멤버이고 라이선스가 유효할 때만(아니면 개인 프로젝트로 새지 않게 거절한다)
        let place = null;
        if (op === 'project.create' && body.classId) {
          place = await tenancy.canCreateInClass(user, body.classId);
          if (!place.ok) return json(res, place.reason === 'missing' ? 404 : 403, bad(SAY[place.reason] || NOT_FOUND, place.reason));
        }
        const { OPS } = createOps(depsFor(store, queue, worker, user, { tenancy, place, wfs, pool }));
        const fn = OPS[op];
        if (!fn) return json(res, 404, bad('그런 문이 없습니다: ' + op));
        if (!NO_PID.has(op)) {
          const acc = await tenancy.access(user, body.pid);
          if (!acc.read) return json(res, 404, bad(NOT_FOUND));
          if (!acc.write && !READ_OPS.has(op)) return json(res, 403, bad(SAY.read_only, 'read_only'));
        }
        let out;
        try { out = await fn(body); } catch (e) { out = bad((e && e.message) || e); }
        if (out && out.ok !== false && (op === 'project.create' || op === 'project.delete')) {
          await auth.audit(pool, { actor: user.id, action: op, targetType: 'project', targetId: op === 'project.create' ? out.pid : body.pid, ip: ipOf(req) });
        }
        return json(res, 200, out || ok());
      }

      if (req.method === 'GET' && url.pathname === '/api/state') {
        const pid = url.searchParams.get('pid') || '';
        // 화면은 1.5초마다 묻는다 — 바뀐 것이 없으면 프로젝트를 짓지 않고 304 로 답한다.
        // 지문 = 이 프로젝트의 updated_at(덩어리를 고치면 늘 바뀐다) · 내 프로젝트 목록 · 작업 줄(상태 · 지금 하는 일 · 물음)
        const etag = await fingerprint(user, pid);
        const cache = { etag, 'cache-control': 'private, no-cache' };
        if (etag && req.headers['if-none-match'] === etag) return send(res, 304, '', 'application/json; charset=utf-8', cache);
        const { stateOf } = createOps(depsFor(store, queue, worker, user, { tenancy, wfs, pool }));
        const projects = await store.listFor(user.id);
        if (!pid) return json(res, 200, { ok: true, projects, me: await withRoles() }, cache);
        const acc = await tenancy.access(user, pid);
        const st = acc.read ? await stateOf(pid) : null;
        if (st && !acc.write) st.readOnly = true;   // 강사 · 기관 관리자의 열람 — 화면이 고치기 단추를 숨길 근거(막는 것은 서버다)
        if (!st) return json(res, 200, { ok: false, error: '없음', projects, me });
        // 이 작품의 AI 회사 — 작품이 정한 것 · 비용 주체의 기본 · 키가 있는 회사들(화면의 «AI 회사» 칸)
        const ar = (await pool.query(
          `SELECT p.model_policy->>'provider' AS provider, p.organization_id, coalesce(o.settings->>'ai_provider', '') AS org_provider, coalesce(u.settings->>'ai_provider', '') AS user_provider,
                  (SELECT coalesce(array_agg(DISTINCT c.provider), '{}') FROM provider_credentials c WHERE c.status = 'active'
                     AND ((p.organization_id IS NOT NULL AND c.owner_type = 'organization' AND c.owner_id = p.organization_id::text)
                       OR (p.organization_id IS NULL AND c.owner_type = 'user' AND c.owner_id = p.owner_user_id::text))) AS keys
             FROM projects p LEFT JOIN organizations o ON o.id = p.organization_id LEFT JOIN users u ON u.id = p.owner_user_id WHERE p.id = $1`, [pid])).rows[0];
        // 온라인 화면은 등급만 보인다 — fable 은 opus 와 같은 High Reasoning 이라 고르는 칸에서 뺀다(이미 고른 작품은 남긴다).
        if (Array.isArray(st.models)) st.models = st.models.filter((m) => m !== 'fable' || st.model === 'fable');
        if (ar) st.ai = { provider: ar.provider || '', classWork: !!ar.organization_id, ownerDefault: ar.organization_id ? ar.org_provider : ar.user_provider, keys: ar.keys || [] };
        return json(res, 200, { ok: true, project: st, projects, me }, cache);
      }

      if (req.method === 'GET' && url.pathname === '/api/download') {
        const pid = url.searchParams.get('pid');
        const { downloadOf } = createOps(depsFor(store, queue, worker, user, { tenancy, wfs, pool }));
        const d = (await canRead(user, pid)) ? await downloadOf(pid, url.searchParams.get('kind'), url.searchParams.get('id')) : null;
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

  const server = createServer((req, res) => { handle(req, res); });
  server.setupCode = setupCode;   // main() 이 (계정이 없을 때) 콘솔에 찍는다
  return server;
}

// 직접 띄울 때 — 마이그레이션을 앞으로만 적용하고(SE_MIGRATE_ON_BOOT=0 이면 건너뜀) 연다.
/**
 * 띄우기 — 마이그레이션을 앞으로만 적용하고(SE_MIGRATE_ON_BOOT=0 이면 건너뜀) AI 배선 · worker · 웹을 연다.
 * online/start.mjs(Replit 의 Run)와 직접 실행이 함께 쓴다. 돌려주는 값: 서버(닫기용) — 서지 못하면 null.
 */
export async function main(env = process.env) {
  const plan = onlinePlan(env);
  if (plan.problems.length) { for (const p of plan.problems) console.log('  [STOP] ' + p); return null; }
  if (!env.DATABASE_URL) { console.log('  [STOP] DATABASE_URL is not set (create the database in the platform)'); return null; }
  const pool = createPool(env.DATABASE_URL);
  if (env.SE_MIGRATE_ON_BOOT !== '0') {
    const r = await migrate(pool);
    if (r.applied.length) console.log('  Migrations   : applied ' + r.applied.join(', '));
  }
  // AI — 카탈로그 · 자격증명 · 어댑터. 모자란 것이 있어도 서버는 선다(작업이 «연결 필요»·«모델 없음»으로 멈춘다).
  const ai = buildAi(pool, env);
  for (const p of ai.problems) console.log('  [NOTE] ' + p);
  const queue = createJobQueue(pool);
  const store = createProjectStore(pool);
  const call = createOnlineCall({ pool, store, generator: ai.generator, ...(ai.aliasTiers ? { aliasTiers: ai.aliasTiers } : {}) });
  // 같은 프로세스에서 worker 를 함께 돌린다(파일럿 — VM 하나). SE_WORKER=0 이면 웹만(worker 를 따로 띄울 때)
  const tenancyW = createTenancy(pool);
  const wfsW = createWorkflowSource(pool);
  const worker = env.SE_WORKER === '0' ? null : createWorker({ queue, store, call, allowed: (row) => tenancyW.aiAllowed(row.project_id), workflow: (pid) => wfsW.templateFor(pid) }, { log: (m) => console.log('  [worker] ' + m) });
  if (worker) await worker.start();
  const srv = createOnlineServer({ pool, plan, queue, worker, credentials: ai.credentials, keyTester: ai.keyTester, trustProxy: env.SE_TRUST_PROXY === '1', denyFrames: env.NODE_ENV === 'production' });
  await new Promise((resolve) => srv.listen(plan.port, plan.host, resolve));
  console.log('  Story Engine (online) : listening on ' + plan.host + ':' + plan.port);
  console.log('  Host names   : ' + plan.allowedHosts.join(', '));
  for (const n of plan.notes) console.log('  [NOTE] ' + n);
  const users = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (!users) console.log('  [NOTE] No account yet - open the app in a browser to finish the first-run setup');
  if (!users && srv.setupCode) console.log('  [SETUP] First-run setup code: ' + srv.setupCode + '  (type it on the setup screen; a new one each start)');
  const bye = async () => { srv.close(); if (worker) await worker.stop(); pool.end().finally(() => process.exit(0)); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
  return srv;
}

if (process.argv[1] && process.argv[1].endsWith(join('online', 'server.mjs'))) {
  if (!(await main(process.env))) process.exit(1);
}
