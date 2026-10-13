// 서버 — 문 하나(POST /api {op,...})와 상태 하나(GET /api/state), 내려받기 하나, 그리고 web/ 정적 파일.
// 화면이 부르는 op 가 전부 OPS 한 곳(tools/ops.mjs)에 모여 있어야 한다(배선 시험이 이 표와 화면을 맞춰 본다).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import * as state from './state.mjs';
import * as model from './model.mjs';
import * as jobs from './jobs.mjs';
import * as engine from './engine.mjs';
import { prepareAgents, agentsReady, runStudy, STUDY_TITLE } from './agents.mjs';
import { killAllCalls, lastLimit, useQueueHook } from './call.mjs';
import * as auth from './auth.mjs';
import { createOps } from './ops.mjs';
import { baseTemplate, templateKeyOf } from './workflow.mjs';
import { codexModels, codexLoggedIn, forgetCodexLogin, codexAccount } from './codex-cli.mjs';
import { authStatus, childEnv } from './claude-cli.mjs';
import { createLogin } from './login.mjs';
import { testKey, keyCompany, cleanKey } from './keytest.mjs';
import { CODEX, CLI, refreshCodex } from './call.mjs';
import { codexIntoFolder } from './usb-build.mjs';
import { geminiChoices, keyChoices } from './catalog-local.mjs';
import { normalizeProject, saveProject, newId, DATA_DIR } from './store.mjs';
import { acquire as lockData } from './datalock.mjs';
import { backupProjects } from './backup.mjs';
import { runKind } from '../core/generation/kinds.mjs';
import { resolveHosting, hostOf, originOk, gateOk, isNavigation, GATE_REALM } from './hosting.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(dirname(HERE), 'web');
// 어디에 어떻게 여는가 — 로컬 기본은 지금 그대로 127.0.0.1:8801(tools/hosting.mjs).
// 호스팅 플랫폼에서는 PORT · SE2_HOST · 허용 호스트 · 스테이징 출입 열쇠를 따른다.
export const HOSTING = resolveHosting(process.env);
const PORT = HOSTING.port;

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error) => ({ ok: false, error: String(error) });

// 준비가 온전히 끝났는가 — 프롬프트가 다 서 있고, 자료가 있다면 «자료 분석»까지 남았는가.
// 둘 중 하나라도 비면 화면이 [에이전트 준비 다시] 를 세운다.
const prepared = (p) => agentsReady(p) && !(p.agents && p.agents.__kind === '기본') && (!model.materialDocs(p).length || p.docs.some((d) => d.title === STUDY_TITLE));

// 작업은 «종류 + 매개변수»로 등록하고, 실제로 돌리는 것은 Core 의 작업 종류 표(core/generation/kinds.mjs)다.
// 개인판이 넣는 것: 저장(state) · 호출(callAsking — CLI · 한도 물음) · 에이전트 준비(agents.mjs).
async function prepareThenStudy(pid, ctx, request = '') {
  if (!agentsReady(state.get(pid))) {
    const r = await prepareAgents(pid, ctx, request);
    if (!r.ok) return r;
  }
  // «자료 분석» 문서가 이미 있으면 또 만들지 않는다(종류만 다시 가린 때 — core prepareThenStudy 와 같은 규칙)
  if ((state.get(pid) || { docs: [] }).docs.some((d) => d.title === STUDY_TITLE)) return { ok: true, skipped: true };
  return runStudy(pid, ctx, request);   // 이어서 자료를 한 번 읽는다
}
// 작품마다 제 용도의 단계 템플릿(이야기 만들기 · 전자책) — 적혀 있지 않은 작품은 이야기 만들기(지금까지의 모든 작품)
const workflowOf = async (pid) => baseTemplate(templateKeyOf(state.get(pid)));
// 모의 실행에서는 Codex 를 띄우지 않는다 — 고르기 화면을 시험하는 가짜 목록
const MOCK_MODELS = process.env.SE2_MOCK === '1' ? [{ id: 'mock-gpt', name: 'Mock GPT' }] : null;
const LOCAL_DEPS = { ...engine.LOCAL, prepare: prepareThenStudy, workflow: workflowOf };
jobs.useRunner((kind, params, ctx) => runKind(LOCAL_DEPS, kind, params, ctx));
// 호출 고삐에서 자리를 기다리는 작업 — 작업 줄에 «차례 기다림»(여러 작품이 온 차례대로 나눠 쓴다, DESIGN §6-5)
useQueueHook(jobs.queued);

// 프로젝트를 만든 직후 그 프로젝트 전용 에이전트를 짓는다(소설이면 판정만 남기고 끝난다).
function startAgentPrep(pid, request = '') {
  const p = state.get(pid);
  if (!p) return;
  jobs.start(pid, { kind: 'agents', title: '자료 분석', params: { request } });   // 화면 이름 «자료 분석»(2026-10-07) — 종류 판정 · 짓기 · 자료 분석을 묶은 한 작업
}

// 작품 파일 가져오기 — 늘 새 id 로 세운다(있는 작품을 덮어쓰지 않는다). 문서 · 판 · 참조 · 논의는 파일의 것 그대로.
function importProject(raw) {
  const p = normalizeProject({ ...structuredClone(raw), id: newId('p').replace(/[^A-Za-z0-9_-]/g, '') });
  if (!p) return { error: '작품 파일이 아닙니다' };
  p.jobs = [];
  saveProject(p);
  return { pid: p.id };
}

// ---- 화면에서 하는 로그인 · 키 등록(개인판 — docs/PERSONAL_USB.md §8-4)
// 로그인되어 있는가 — Claude 는 실행기에 묻고(5초 기억), ChatGPT 는 Codex 에 묻는다. 모의 실행에서는 실행기를 띄우지 않는다
const MOCK_RUN = process.env.SE2_MOCK === '1';
let claudeSeen = { at: 0, ok: false, account: '' };
async function claudeLoggedIn() {
  if (MOCK_RUN) return true;
  if (Date.now() - claudeSeen.at < 5000) return claudeSeen.ok;
  const st = await authStatus(CLI);
  claudeSeen = { at: Date.now(), ok: st.loggedIn, account: st.account || '' };
  return claudeSeen.ok;
}
const chatgptLoggedIn = async () => (MOCK_RUN ? false : codexLoggedIn(CODEX.cli));
const login = MOCK_RUN
  ? { start: (who) => ({ ok: true, login: { who, running: true, url: 'https://claude.ai/oauth/authorize?mock=1', needsCode: who === 'claude', done: false, ok: false, error: '' } }),
      code: () => ({ ok: true }), view: () => null }
  : createLogin({
    plans: {
      claude: { cli: CLI, args: ['auth', 'login', '--claudeai'], env: childEnv() },
      chatgpt: { cli: () => CODEX.cli, args: ['login'], env: process.env, prepare: () => (CODEX.found ? null : codexHere()),
        preparing: 'ChatGPT 실행기(Codex)를 이 폴더로 받는 중 — 처음 한 번, 몇 분 걸립니다',
        missing: 'ChatGPT 실행기(Codex)를 찾지 못했습니다' },
    },
    check: {
      claude: async () => { claudeSeen.at = 0; return claudeLoggedIn(); },
      // ChatGPT 로그인을 화면에서 마쳤으면 그 길로 돈다(사람이 ChatGPT 를 쓰려고 누른 것이다 — 구독이라 값이 새지 않는다)
      chatgpt: async () => { forgetCodexLogin(); const good = await chatgptLoggedIn(); if (good) auth.write({ mode: 'chatgpt' }); return good; },
    },
  });
// Codex 가 없으면 이 폴더(tools/codex/)로 받는다 — 윈도우 x64 만(OpenAI 의 npm 윈도우 판). 동시에 두 벌 받지 않는다
let codexGetting = null;
function codexHere() {
  if (process.platform !== 'win32' || process.arch !== 'x64') return Promise.reject(new Error('ChatGPT 실행기(Codex)가 이 PC 에 없습니다 — npm i -g @openai/codex 로 깐 뒤 다시 눌러 주세요'));
  if (!codexGetting) {
    codexGetting = codexIntoFolder()
      .catch(() => { throw new Error('ChatGPT 실행기(Codex)를 받지 못했습니다 — 인터넷을 확인하고 다시 눌러 주세요'); })
      .then(() => { refreshCodex(); forgetCodexLogin(); if (!CODEX.found) throw new Error('ChatGPT 실행기(Codex)를 찾지 못했습니다'); })
      .finally(() => { codexGetting = null; });
  }
  return codexGetting;
}
async function loginStatus() {
  const [claude, chatgpt] = await Promise.all([claudeLoggedIn(), chatgptLoggedIn()]);
  // 어느 계정으로 도는지도 함께 — 남의 PC 에서 그 사람의 로그인으로 도는 것을 알아보게(2026-10-13 «등록된 계정 보이게»)
  return { login: login.view(), claude, chatgpt, claudeAccount: claude && !MOCK_RUN ? claudeSeen.account : '', chatgptAccount: chatgpt ? codexAccount() : '' };
}
// 붙여 넣은 키 — 앞머리로 회사를 알아보고 · 저장하고 · 값이 들지 않는 문으로 맞는지 본다. 키는 답에 싣지 않는다
async function keySet(raw) {
  const key = cleanKey(raw);
  const which = keyCompany(key);
  if (!which) return bad('Claude(sk-ant-…) · ChatGPT(sk-…) · Gemini(AIza…) API 키를 붙여 넣어 주세요');
  auth.write({ claude: { apiKey: key }, gemini: { geminiKey: key }, openai: { openaiKey: key } }[which]);
  const t = MOCK_RUN ? { verified: true } : await testKey(which, key);
  return ok({ company: which, verified: !!t.verified, reason: t.reason || '', auth: auth.view() });
}

const { OPS, stateOf, downloadOf } = createOps({ state, jobs, engine, auth, limit: lastLimit, prepared, startAgentPrep, workflow: workflowOf, importProject, purposeChoice: true,
  // ChatGPT 는 그 PC 의 Codex 가 아는 목록(없으면 빈 목록 — 화면은 «Codex 기본»만), Gemini 는 카탈로그
  login, loginStatus, keySet,
  authModels: async () => ({ chatgpt: MOCK_MODELS || await codexModels(CODEX.cli), gemini: geminiChoices(), openai: keyChoices('openai') }) });

export const OP_NAMES = Object.keys(OPS);

// ---------------------------------------------------------------- HTTP

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

// ---------------------------------------------------------------- 문지기
//
// 이 서버는 사장님 PC 안에서만 돈다 — 그런데 브라우저는 **아무 페이지에서나** 127.0.0.1 로 요청을 쏠 수 있다.
// 막지 않으면 사장님이 열어 둔 남의 페이지 하나가 auth.write 로 돈 나가는 길을 남의 키로 바꾸고,
// project.delete·trash.purge 로 원고를 지운다(실측: text/plain 한 방에 auth.json 이 바뀌었다).
//  · Host 가 제 이름(127.0.0.1·localhost)이 아니면 받지 않는다 — 남의 도메인을 이 자리로 돌려 원고를 읽는 길(DNS 재바인딩)을 막는다.
//  · POST /api 는 application/json 만 받는다 — text/plain 은 사전 확인(preflight) 없이 남의 페이지에서 날아온다.
//  · Origin 이 붙어 왔으면 제 자리의 것이어야 한다. **폰 중계기는 Origin 을 싣지 않는다**(노드 fetch) — 그대로 붙는다.
// 판정(hostOf · originOk)은 tools/hosting.mjs 에 있다. 로컬에서는 위 규칙 그대로이고,
// 호스팅 실행에서는 «허락한 호스트 이름»이 제 이름에 더해지고 그 앞에 스테이징 출입 열쇠가 선다.

const isJson = (req) => String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() === 'application/json';

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { s += c; });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve(null); } });
  });
}

// 열쇠 없이 온 요청 — 원고를 담은 것은 아무것도 내주지 않는다.
//  · 주소창으로 들어오는 브라우저(Sec-Fetch-Mode: navigate) → 401 + 로그인 창
//  · 그 밖의 GET / (플랫폼의 상태 검사는 첫 화면이 200 으로 빨리 답하기를 바란다) → 원고 없는 작은 안내 페이지
//  · 안내 페이지의 «들어가기»(/enter)와 나머지 → 401
const LANDING = '<!doctype html><html lang="ko"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>스토리 엔진</title></head>'
  + '<body style="font-family:-apple-system,system-ui,sans-serif;padding:64px 16px;text-align:center">'
  + '<p>스토리 엔진 — 시험 운영</p><p><a href="/enter">들어가기</a></p></body></html>';

function refuse(req, res, url) {
  const challenge = { 'www-authenticate': 'Basic realm="' + GATE_REALM + '", charset="UTF-8"' };
  const look = req.method === 'GET' || req.method === 'HEAD';
  if (look && url.pathname === '/' && !isNavigation(req)) return send(res, 200, LANDING, 'text/html; charset=utf-8');
  // 화면 안의 요청(fetch)에는 로그인 창을 띄우지 않는다 — 화면이 code:'gate' 를 받으면 페이지를 다시 열어 그때 묻는다
  if (url.pathname.startsWith('/api')) return send(res, 401, JSON.stringify({ ...bad('출입 열쇠가 필요합니다'), code: 'gate' }), 'application/json; charset=utf-8', isNavigation(req) ? challenge : {});
  return send(res, 401, '출입 열쇠가 필요합니다', 'text/plain; charset=utf-8', challenge);
}

// 요청 하나 — plan 은 hosting.resolveHosting() 의 결과(어디에 어떻게 열었나).
async function handle(plan, req, res) {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    // 살아 있는가 — 플랫폼이 두드린다. 원고를 담지 않으므로 열쇠도 호스트 이름도 묻지 않는다.
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');
    if (plan.gate && !gateOk(req, plan.gate)) return refuse(req, res, url);
    const host = hostOf(req, plan.allowedHosts);
    if (!host) return send(res, 403, JSON.stringify(bad(plan.exposed ? '허락하지 않은 호스트 이름입니다' : '이 PC 안에서 연 화면만 받습니다')));
    // 안내 페이지의 «들어가기» — 열쇠를 넣고 돌아오면 첫 화면으로
    if (plan.gate && req.method === 'GET' && url.pathname === '/enter') return send(res, 302, '', 'text/plain; charset=utf-8', { location: '/' });
    if (req.method === 'POST' && url.pathname === '/api') {
      if (!originOk(req, host)) return send(res, 403, JSON.stringify(bad('다른 곳에서 온 요청은 받지 않습니다')));
      if (!isJson(req)) return send(res, 415, JSON.stringify(bad('JSON 요청만 받습니다')));
      const body = await readBody(req);
      if (!body || !body.op) return send(res, 400, JSON.stringify(bad('op 없음')));
      const fn = OPS[body.op];
      if (!fn) return send(res, 404, JSON.stringify(bad('그런 문이 없습니다: ' + body.op)));
      let out;
      try { out = await fn(body); } catch (e) { out = bad((e && e.message) || e); }
      return send(res, 200, JSON.stringify(out || ok()));
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const pid = url.searchParams.get('pid') || '';
      if (!pid) return send(res, 200, JSON.stringify({ ok: true, projects: listed() }));
      const st = await stateOf(pid);
      if (!st) return send(res, 200, JSON.stringify({ ok: false, error: '없음' }));
      return send(res, 200, JSON.stringify({ ok: true, project: st, projects: listed() }));
    }
    if (req.method === 'GET' && url.pathname === '/api/download') {
      const d = await downloadOf(url.searchParams.get('pid'), url.searchParams.get('kind'), url.searchParams.get('id'), url.searchParams.get('fmt') === 'txt' ? 'txt' : 'md');
      if (!d) return send(res, 404, '없음', 'text/plain; charset=utf-8');
      return send(res, 200, d.text, d.type || 'text/markdown; charset=utf-8', {
        // filename 은 한글을 못 읽는 브라우저를 위한 ASCII 대신 이름, filename* 이 진짜 이름
        'content-disposition': 'attachment; filename="' + (d.name.replace(/[^\x20-\x7e]|["\\]/g, '_')) + '"; filename*=UTF-8\'\'' + encodeURIComponent(d.name),
      });
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '');
      const file = join(WEB, rel);
      if (!file.startsWith(WEB) || !existsSync(file)) return send(res, 404, '없음', 'text/plain; charset=utf-8');
      const buf = await readFile(file);
      return send(res, 200, buf, TYPES[extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });   // 새로 받은 화면이 곧바로 보이게
    }
    send(res, 405, '', 'text/plain');
  } catch (e) {
    send(res, 500, JSON.stringify(bad((e && e.message) || e)));
  }
}

// 첫 화면의 작품 목록 — 작품마다 지금 도는 작업 수(나가도 돈다는 것이 보이게, DESIGN §6-5)
function listed() {
  return state.list().map((x) => ({ ...x, running: jobs.liveCount(x.id) }));
}

// 시험이 다른 계획(바깥에 연 꼴)으로 한 벌 더 띄워 볼 수 있게 계획을 받는다.
export function createAppServer(plan = HOSTING) {
  return createServer((req, res) => handle(plan, req, res));
}

export const server = createAppServer(HOSTING);

// 붙을 주소는 계획(HOSTING)이 정한다 — 부르는 쪽이 따로 넘기지 못하게 해서 «열쇠 없이 바깥에 열기»를 비켜 갈 길을 두지 않는다.
export function boot(port = PORT) {
  // 열면 안 되는 꼴이면 서지 않는다(바깥에 열면서 열쇠가 없는 따위). 까닭은 hosting.mjs 가 적어 준다. 콘솔은 ASCII 만.
  if (HOSTING.problems.length) {
    for (const p of HOSTING.problems) console.log('  [STOP] ' + p);
    return Promise.reject(new Error(HOSTING.problems[0]));
  }
  for (const p of state.list()) jobs.healStale(p.id);
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE') console.log('  [ERROR] port ' + port + ' is already in use. Close the other window first.');
      else console.log('  [ERROR] ' + ((e && e.message) || e));
      reject(e);
    });
    server.listen(port, HOSTING.host, () => resolve(server));
  });
}

// 바깥에 열었는데(호스팅) 데이터베이스가 있으면 — 로그인 없는 개인판을 인터넷에 세우지 않는다. 온라인판(로그인)으로 간다.
// 어떤 실행 명령으로 띄워도 같다(플랫폼에 남은 옛 실행 설정이 tools/server.mjs 를 불러도). 내 PC(127.0.0.1)의 개인판은 그대로다.
const toOnline = !!(HOSTING.exposed && process.env.DATABASE_URL);
if (process.argv[1] && process.argv[1].endsWith('server.mjs') && toOnline) {
  console.log('  [NOTE] A database is set - starting the online edition (login required) instead of the personal edition');
  const { start } = await import(new URL('../online/start.mjs', import.meta.url).href);
  await start(process.env);
} else if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  // 같은 자료 상자를 다른 곳(다른 PC · 다른 창)에서 열어 두었으면 서지 않는다 — 두 서버가 서로의 저장을 덮어쓴다(datalock.mjs)
  const lock = lockData(DATA_DIR);
  if (!lock.ok) {
    console.log('  [STOP] This data folder is open ' + (lock.same ? 'in another window on this PC' : 'on another PC (' + String(lock.who.host).replace(/[^\x20-\x7e]/g, '?') + ')') + '.');
    console.log('         Close it there first. If that PC is off or the USB was pulled out, wait 3 minutes and try again.');
    process.exit(1);
  }
  if (lock.stale) console.log('  [NOTE] Took over a lock left by another PC (it stopped updating more than 3 minutes ago)');
  process.on('exit', lock.release);
  // 켤 때마다 작품 파일 한 벌을 data/backup/ 에 — 깨진 파일은 옮겨 적지 않고 이름만 알린다(backup.mjs)
  try {
    const b = backupProjects(DATA_DIR);
    for (const f of b.broken) console.log('  [WARN] Could not read data/projects/' + f + ' - the copy in data/backup/projects/ was kept');
  } catch (e) { console.log('  [WARN] Backup skipped: ' + String((e && e.code) || 'error')); }
  try { await boot(PORT); } catch { process.exit(1); }
  const addr = 'http://127.0.0.1:' + PORT;
  if (!HOSTING.exposed) console.log('  Story Engine : ' + addr);
  else {
    console.log('  Story Engine : listening on ' + HOSTING.host + ':' + PORT);
    console.log('  Host names   : ' + HOSTING.allowedHosts.join(', '));
    console.log('  Access key   : ' + (HOSTING.gate ? 'required (HTTP Basic - any user name, the key as password)' : 'NONE'));
  }
  for (const n of HOSTING.notes) console.log('  [NOTE] ' + n);
  if (process.env.SE2_OPEN_BROWSER === '1') {
    try { spawn('cmd', ['/c', 'start', '', addr], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
  // 창을 닫으면(윈도우 — SIGHUP · SIGBREAK) 잠금을 걷고 나간다. 걷지 못하고 꺼져도 3분 뒤면 버려진 잠금이 된다
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { killAllCalls(); process.exit(0); });
}
