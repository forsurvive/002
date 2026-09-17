// 서버 — 문 하나(POST /api {op,...})와 상태 하나(GET /api/state), 내려받기 하나, 그리고 web/ 정적 파일.
// 화면이 부르는 op 가 전부 OPS 한 곳에 모여 있어야 한다(배선 시험이 이 표와 화면을 맞춰 본다).

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
import { prepareAgents, agentsReady } from './agents.mjs';
import { runAuto, canStart } from './auto.mjs';
import { killAllCalls } from './call.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(dirname(HERE), 'web');
const PORT = Number(process.env.SE2_PORT || 8801);

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error) => ({ ok: false, error: String(error) });
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// 프로젝트를 만든 직후 그 프로젝트 전용 에이전트를 짓는다(소설이면 판정만 남기고 끝난다).
function startAgentPrep(pid) {
  const p = state.get(pid);
  if (!p || agentsReady(p)) return;
  jobs.start(pid, { kind: 'agents', title: '에이전트 준비', run: (ctx) => prepareAgents(pid, ctx) });
}

const OPS = {
  // ---------------- 프로젝트
  'project.list': () => ok({ projects: state.list() }),

  'project.create': (b) => {
    const name = String(b.name || '').trim();
    const spec = b.spec || {};
    if (!name || !String(spec.outline || '').trim() || !String(spec.form || '').trim()) return bad('작품 규격 필요');
    const materials = arr(b.materials).filter((m) => m && String(m.text || '').trim());
    if (!materials.length) return bad('자료 필요');
    const p = state.create({ name, spec, standard: b.standard, request: b.request, materials });
    startAgentPrep(p.id);
    return ok({ pid: p.id });
  },

  'project.spec': (b) => state.update(b.pid, (p) => {
    if (b.name != null) p.name = String(b.name).trim() || p.name;
    if (b.spec) p.spec = { ...p.spec, ...b.spec };
    if (b.standard != null) p.standard = String(b.standard);
    if (b.request != null) p.request = String(b.request);
  }),

  'project.delete': (b) => {
    jobs.stopProject(b.pid);
    return state.remove(b.pid) ? ok() : bad('프로젝트를 찾을 수 없습니다');
  },

  // ---------------- 자료
  'material.add': (b) => state.update(b.pid, (p) => { model.materialAdd(p, b.name || model.firstLineName(b.text), b.text); }),
  'material.delete': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.materialDelete(p, id); }),

  // ---------------- 문서 · 모순 검사 · 합평회
  'doc.create': (b) => {
    let id = null;
    const r = state.update(b.pid, (p) => {
      id = model.docCreate(p, { kind: b.kind, title: b.title, body: b.body, categoryId: b.categoryId }).id;
    });
    return r.ok === false ? r : ok({ id });
  },

  'doc.write': (b) => state.update(b.pid, (p) => {
    model.docWrite(p, b.id, {
      title: b.title, body: b.body, request: b.request,
      refIds: b.refIds, targetIds: b.targetIds,
      categoryId: b.categoryId === undefined ? undefined : b.categoryId,
    });
  }),

  'doc.final': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.docSetFinal(p, id, !!b.on); }),

  'doc.delete': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.docDelete(p, id); }),

  'doc.restoreVersion': (b) => state.update(b.pid, (p) => { model.docRestoreVersion(p, b.id, Number(b.index)); }),

  'doc.update': (b) => {
    const p = state.get(b.pid);
    const d = p && model.findDoc(p, b.id);
    if (!d) return bad('문서를 찾을 수 없습니다');
    if (jobs.isTargetRunning(b.pid, d.id)) return bad('이미 도는 중입니다');
    return jobs.start(b.pid, { kind: 'update', title: d.title, targetId: d.id, run: (ctx) => engine.runUpdate(b.pid, b.id, ctx) });
  },

  // ---------------- 카테고리
  'cat.create': (b) => {
    let id = null;
    const r = state.update(b.pid, (p) => { id = model.categoryCreate(p, b.name).id; });
    return r.ok === false ? r : ok({ id });
  },
  'cat.delete': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.categoryDelete(p, id); }),

  // ---------------- 논의 스레드
  'thread.create': (b) => {
    let id = null;
    const r = state.update(b.pid, (p) => { id = model.threadCreate(p, { title: b.title, refIds: b.refIds }).id; });
    return r.ok === false ? r : ok({ id });
  },
  'thread.refs': (b) => state.update(b.pid, (p) => {
    const t = model.findThread(p, b.id);
    if (t) t.refIds = arr(b.refIds).slice();
  }),
  'thread.send': (b) => {
    const p = state.get(b.pid);
    const t = p && model.findThread(p, b.id);
    if (!t) return bad('스레드를 찾을 수 없습니다');
    if (!String(b.text || '').trim()) return bad('빈 말');
    return jobs.start(b.pid, { kind: 'talk', title: t.title, targetId: t.id, run: (ctx) => engine.runTalk(b.pid, b.id, String(b.text), ctx) });
  },
  'thread.edit': (b) => {
    const p = state.get(b.pid);
    const t = p && model.findThread(p, b.id);
    if (!t) return bad('스레드를 찾을 수 없습니다');
    let made = null;
    state.update(b.pid, (pr) => { made = model.threadEditMessage(pr, b.id, b.messageId, b.text); });
    if (!made) return bad('메시지를 찾을 수 없습니다');
    return jobs.start(b.pid, { kind: 'talk', title: t.title, targetId: t.id, run: (ctx) => engine.runTalk(b.pid, b.id, null, ctx) });
  },
  'thread.title': (b) => state.update(b.pid, (p) => {
    const t = model.findThread(p, b.id);
    if (t) t.title = String(b.title || '').trim() || t.title;
  }),
  'thread.head': (b) => state.update(b.pid, (p) => { model.threadSetHead(p, b.id, b.messageId); }),
  'thread.doc': (b) => {
    const p = state.get(b.pid);
    const t = p && model.findThread(p, b.id);
    if (!t) return bad('스레드를 찾을 수 없습니다');
    return jobs.start(b.pid, { kind: 'threaddoc', title: t.title, run: (ctx) => engine.runThreadDoc(b.pid, b.id, String(b.request || ''), ctx) });
  },
  'thread.delete': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.threadDelete(p, id); }),

  // ---------------- 휴지통
  'trash.restore': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.trashRestore(p, id); }),
  'trash.purge': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.trashPurge(p, id); }),

  // ---------------- 작업
  'job.stop': (b) => jobs.stop(b.pid, b.id),
  'job.remove': (b) => jobs.remove(b.pid, b.id),

  // ---------------- 자동 집필
  'auto.start': (b) => {
    const p = state.get(b.pid);
    if (!p) return bad('프로젝트를 찾을 수 없습니다');
    const gate = canStart(p);
    if (!gate.ok) return gate;
    if (jobs.isAutoRunning(b.pid)) return bad('이미 도는 중입니다');
    state.update(b.pid, (pr) => {
      pr.auto.feedbackRounds = Math.min(3, Math.max(1, Number(b.feedbackRounds) || 1));
      pr.auto.skipProse = !!b.skipProse;
    });
    return jobs.start(b.pid, { kind: 'auto', title: '자동 집필', run: (ctx) => runAuto(b.pid, ctx) });
  },
};

export const OP_NAMES = Object.keys(OPS);

// ---------------------------------------------------------------- 상태

function stateOf(pid) {
  const p = state.get(pid);
  if (!p) return null;
  return {
    id: p.id, name: p.name, spec: p.spec, standard: p.standard, request: p.request,
    materials: (p.materials || []).map((m) => ({ id: m.id, name: m.name, chars: String(m.text || '').length })),
    categories: model.categoriesView(p),
    docs: p.docs.map((d) => ({
      id: d.id, kind: d.kind, title: d.title, body: d.body, isFinal: d.isFinal,
      categoryId: d.categoryId, request: d.request, refIds: d.refIds, targetIds: d.targetIds,
      versions: (d.versions || []).map((v, i) => ({ i, at: v.at, title: v.title, body: v.body })),
      updatedAt: d.updatedAt,
    })),
    threads: p.threads.map((t) => ({
      id: t.id, title: t.title, refIds: t.refIds, messages: t.messages, headId: t.headId,
      path: model.threadPath(t).map((m) => m.id),
    })),
    trash: p.trash.map((e) => ({ id: e.id, at: e.at, kind: e.kind, from: e.from, title: e.title })),
    jobs: p.jobs,
    auto: p.auto,
    agentKind: (p.agents && p.agents.__kind) || '',
  };
}

// ---------------------------------------------------------------- 내려받기

function downloadOf(pid, kind, id) {
  const p = state.get(pid);
  if (!p) return null;
  if (kind === 'doc') {
    const d = model.findDoc(p, id);
    return d ? { name: model.safeFileName(d.title) + '.md', text: model.docToText(d) } : null;
  }
  if (kind === 'cat') {
    const view = model.categoriesView(p).find((c) => c.id === id);
    return view ? { name: model.safeFileName(view.name) + '.md', text: model.categoryToText(p, id) } : null;
  }
  if (kind === 'thread') {
    const t = model.findThread(p, id);
    return t ? { name: model.safeFileName(t.title) + '.md', text: model.threadToText(t) } : null;
  }
  return null;
}

// ---------------------------------------------------------------- HTTP

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', ...extra });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { s += c; });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve(null); } });
  });
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/api') {
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
      if (!pid) return send(res, 200, JSON.stringify({ ok: true, projects: state.list() }));
      const st = stateOf(pid);
      if (!st) return send(res, 200, JSON.stringify({ ok: false, error: '없음' }));
      return send(res, 200, JSON.stringify({ ok: true, project: st, projects: state.list() }));
    }
    if (req.method === 'GET' && url.pathname === '/api/download') {
      const d = downloadOf(url.searchParams.get('pid'), url.searchParams.get('kind'), url.searchParams.get('id'));
      if (!d) return send(res, 404, '없음', 'text/plain; charset=utf-8');
      return send(res, 200, d.text, 'text/markdown; charset=utf-8', {
        'content-disposition': 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(d.name),
      });
    }
    if (req.method === 'GET') {
      const rel = url.pathname === '/' ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^[\\/]+/, '');
      const file = join(WEB, rel);
      if (!file.startsWith(WEB) || !existsSync(file)) return send(res, 404, '없음', 'text/plain; charset=utf-8');
      const buf = await readFile(file);
      return send(res, 200, buf, TYPES[extname(file)] || 'application/octet-stream');
    }
    send(res, 405, '', 'text/plain');
  } catch (e) {
    send(res, 500, JSON.stringify(bad((e && e.message) || e)));
  }
});

export function boot(port = PORT) {
  for (const p of state.list()) jobs.healStale(p.id);
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e && e.code === 'EADDRINUSE') console.log('  [ERROR] port ' + port + ' is already in use. Close the other window first.');
      else console.log('  [ERROR] ' + ((e && e.message) || e));
      reject(e);
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  try { await boot(PORT); } catch { process.exit(1); }
  const addr = 'http://127.0.0.1:' + PORT;
  console.log('  Story Engine : ' + addr);
  if (process.env.SE2_OPEN_BROWSER === '1') {
    try { spawn('cmd', ['/c', 'start', '', addr], { windowsHide: true, detached: true, stdio: 'ignore' }).unref(); } catch {}
  }
  process.on('SIGINT', () => { killAllCalls(); process.exit(0); });
}
