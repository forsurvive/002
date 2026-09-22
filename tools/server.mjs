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
import { prepareAgents, agentsReady, runStudy, STUDY_TITLE } from './agents.mjs';
import { killAllCalls, MODELS, lastLimit } from './call.mjs';
import * as auth from './auth.mjs';
import { bookList, BOOK_CATEGORY } from './books.mjs';
import { EDITABLE_CODES, VIEW_CODES } from './prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(dirname(HERE), 'web');
const PORT = Number(process.env.SE2_PORT || 8801);

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error) => ({ ok: false, error: String(error) });
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// 실행기가 아는 이름만 받는다. 모르는 것이 오면 지금 값을 지킨다.
const pickModel = (v, fallback) => (MODELS.includes(String(v || '')) ? String(v || '') : fallback);

// 준비가 온전히 끝났는가 — 프롬프트가 다 서 있고, 자료가 있다면 «자료 분석»까지 남았는가.
// 둘 중 하나라도 비면 화면이 [에이전트 준비 다시] 를 세운다.
const prepared = (p) => agentsReady(p) && (!(p.materials || []).length || p.docs.some((d) => d.title === STUDY_TITLE));

// 프로젝트를 만든 직후 그 프로젝트 전용 에이전트를 짓는다(소설이면 판정만 남기고 끝난다).
function startAgentPrep(pid, request = '') {
  const p = state.get(pid);
  if (!p) return;
  jobs.start(pid, {
    kind: 'agents', title: '에이전트 준비',
    run: async (ctx) => {
      if (!agentsReady(state.get(pid))) {
        const r = await prepareAgents(pid, ctx, request);
        if (!r.ok) return r;
      }
      return runStudy(pid, ctx, request);   // 이어서 자료를 한 번 읽는다
    },
  });
}

const OPS = {
  // ---------------- 프로젝트
  'project.list': () => ok({ projects: state.list() }),

  // 필수는 셋뿐이다 — 이름·형식·자료(사용자 지시, 2026-09-19). 무엇이 빠졌는지 짚어서 돌려준다.
  'project.create': (b) => {
    const name = String(b.name || '').trim();
    const spec = b.spec || {};
    const materials = arr(b.materials).filter((m) => m && String(m.text || '').trim());
    const miss = [];
    if (!name) miss.push('이름');
    if (!String(spec.form || '').trim()) miss.push('형식');
    if (!materials.length) miss.push('자료');
    if (miss.length) return bad('필수 항목 누락 — ' + miss.join(' · '));
    const p = state.create({ name, spec, standard: b.standard, request: b.request, materials });
    // 작법서를 문서로 세워 둔다 — 본문은 베끼지 않고 가리키기만 한다. 걸고 싶을 때 참조로 걸고, 필요 없으면 지운다.
    const books = bookList();
    if (books.length) {
      state.update(p.id, (pr) => {
        const cat = model.categoryCreate(pr, BOOK_CATEGORY);
        for (const bk of books) model.docCreate(pr, { title: bk.title, src: bk.src, categoryId: cat.id });
      });
    }
    startAgentPrep(p.id);
    return ok({ pid: p.id });
  },

  'project.spec': (b) => state.update(b.pid, (p) => {
    if (b.name != null) p.name = String(b.name).trim() || p.name;
    if (b.spec) p.spec = { ...p.spec, ...b.spec };
    if (b.standard != null) p.standard = String(b.standard);
    if (b.request != null) p.request = String(b.request);
    if (b.model != null) p.model = MODELS.includes(String(b.model)) ? String(b.model) : p.model;
    if (b.noCount != null) p.noCount = !!b.noCount;
  }),

  // ---------------- 작법 프롬프트 고치기
  'prompt.read': (b) => {
    const p = state.get(b.pid);
    if (!p) return bad('프로젝트를 찾을 수 없습니다');
    if (!VIEW_CODES.includes(b.code)) return bad('없는 자리입니다');
    return ok({ one: engine.promptView(p, b.code) });
  },
  'prompt.write': (b) => {
    if (!VIEW_CODES.includes(b.code)) return bad('없는 자리입니다');
    return state.update(b.pid, (p) => {
      p.prompts = p.prompts || {};
      const cur = p.prompts[b.code] || {};
      for (const k of ['name', 'role', 'task', 'craft']) if (b[k] != null) cur[k] = String(b[k]);
      p.prompts[b.code] = cur;
    });
  },
  // 되돌리면 작가가 고친 겹만 걷힌다 — 지어진 자리는 «지은 것»으로, 그 밖은 내장으로 돌아간다.
  'prompt.reset': (b) => (VIEW_CODES.includes(b.code)
    ? state.update(b.pid, (p) => { if (p.prompts) delete p.prompts[b.code]; })
    : bad('없는 자리입니다')),

  // 판정이 어긋났거나 중지·재시작으로 준비가 끊긴 프로젝트를 구한다.
  // 자동 집필을 빼기 전에는 «자동 집필 시작»이 같은 문을 한 번 더 지났다 — 그 되돌리기를 여기로 옮겼다.
  'project.prepare': (b) => {
    const p = state.get(b.pid);
    if (!p) return bad('프로젝트를 찾을 수 없습니다');
    if (jobs.isKindRunning(b.pid, 'agents')) return bad('이미 도는 중입니다');
    if (prepared(p)) return bad('이미 준비되어 있습니다');
    startAgentPrep(b.pid, String(b.request || ''));
    return ok();
  },

  // 고르기 창에서 «이게 무슨 글이더라»를 그 자리에서 펼쳐 보는 문.
  // 문서·자료·에이전트 어느 것이든 id 하나로 본문을 내어 준다(폰도 이 문 하나로 족하다).
  'peek': (b) => {
    const p = state.get(b.pid);
    if (!p) return bad('프로젝트를 찾을 수 없습니다');
    const d = model.findDoc(p, b.id);
    if (d) return ok({ one: { id: d.id, name: d.title, text: model.bodyOf(d) } });
    const m = (p.materials || []).find((x) => x.id === b.id);
    if (m) return ok({ one: { id: m.id, name: m.name, text: m.text } });
    const a = model.findAgent(p, b.id);
    if (a) return ok({ one: { id: a.id, name: a.name, text: [a.role, a.craft].filter((x) => String(x || '').trim()).join('\n\n') } });
    return bad('없습니다');
  },

  'project.delete': (b) => {
    jobs.stopProject(b.pid);
    return state.remove(b.pid) ? ok() : bad('프로젝트를 찾을 수 없습니다');
  },

  // ---------------- 자료
  'material.add': (b) => state.update(b.pid, (p) => { model.materialAdd(p, b.name || model.firstLineName(b.text), b.text); }),
  'material.delete': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.materialDelete(p, id); }),

  // ---------------- 에이전트 (작가가 짓는다)
  // 사람마다 쓸 모델을 따로 둘 수 있다 — 빈 값이면 프로젝트에 정해 둔 것을 따른다.
  'agent.create': (b) => {
    let id = null;
    const r = state.update(b.pid, (p) => { id = model.agentCreate(p, { ...b, model: pickModel(b.model, '') }).id; });
    return r.ok === false ? r : ok({ id });
  },
  'agent.write': (b) => state.update(b.pid, (p) => {
    const cur = model.findAgent(p, b.id);
    model.agentWrite(p, b.id, { ...b, model: b.model == null ? undefined : pickModel(b.model, cur ? cur.model : '') });
  }),
  'agent.delete': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.agentDelete(p, id); }),

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
      refIds: b.refIds, targetIds: b.targetIds, agentIds: b.agentIds,
      categoryId: b.categoryId === undefined ? undefined : b.categoryId,
    });
  }),

  'doc.final': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.docSetFinal(p, id, !!b.on); }),

  'doc.delete': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.docDelete(p, id); }),
  // 차림표에서 만들어 놓고 아무것도 담지 않은 채 창을 닫았을 때 — 없던 일로 돌린다(휴지통에도 두지 않는다).
  // 비었는지는 서버가 잰다. 그 문서를 대상으로 도는 작업이 있으면 건드리지 않는다.
  'doc.discard': (b) => (jobs.isTargetRunning(b.pid, b.id)
    ? ok()
    : state.update(b.pid, (p) => { model.docDiscard(p, b.id); })),

  'doc.restoreVersion': (b) => state.update(b.pid, (p) => { model.docRestoreVersion(p, b.id, Number(b.index)); }),

  'doc.update': (b) => {
    const p = state.get(b.pid);
    const d = p && model.findDoc(p, b.id);
    if (!d) return bad('문서를 찾을 수 없습니다');
    if (jobs.isTargetRunning(b.pid, d.id)) return bad('이미 도는 중입니다');
    // 작가가 «어느 모델로 모을지»를 골라 보냈으면 그것으로 부른다.
    const modelPick = pickModel(b.model, '');
    return jobs.start(b.pid, { kind: 'update', title: d.title, targetId: d.id, run: (ctx) => engine.runUpdate(b.pid, b.id, ctx, { modelPick }) });
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
  'thread.agents': (b) => state.update(b.pid, (p) => {
    const t = model.findThread(p, b.id);
    if (t) t.agentIds = arr(b.agentIds).slice();
  }),
  'thread.send': (b) => {
    const p = state.get(b.pid);
    const t = p && model.findThread(p, b.id);
    if (!t) return bad('스레드를 찾을 수 없습니다');
    if (!String(b.text || '').trim()) return bad('빈 말');
    return jobs.start(b.pid, { kind: 'talk', title: t.title, targetId: t.id, run: (ctx) => engine.runTalk(b.pid, b.id, String(b.text), ctx, { modelPick: pickModel(b.model, '') }) });
  },
  'thread.edit': (b) => {
    const p = state.get(b.pid);
    const t = p && model.findThread(p, b.id);
    if (!t) return bad('스레드를 찾을 수 없습니다');
    let made = null;
    state.update(b.pid, (pr) => { made = model.threadEditMessage(pr, b.id, b.messageId, b.text); });
    if (!made) return bad('메시지를 찾을 수 없습니다');
    return jobs.start(b.pid, { kind: 'talk', title: t.title, targetId: t.id, run: (ctx) => engine.runTalk(b.pid, b.id, null, ctx, { modelPick: pickModel(b.model, '') }) });
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
    return jobs.start(b.pid, { kind: 'threaddoc', title: t.title, targetId: t.id, run: (ctx) => engine.runThreadDoc(b.pid, b.id, String(b.request || ''), ctx, { modelPick: pickModel(b.model, '') }) });
  },
  'thread.delete': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.threadDelete(p, id); }),
  // 갓 만들어 놓고 아무것도 담지 않은 채 창을 닫았을 때 — 없던 일로 돌린다(휴지통에도 두지 않는다).
  // 비었는지는 서버가 잰다. 답을 적으러 오는 작업이 돌고 있으면 건드리지 않는다.
  'thread.discard': (b) => (jobs.isTargetRunning(b.pid, b.id)
    ? ok()
    : state.update(b.pid, (p) => { model.threadDiscard(p, b.id); })),

  // ---------------- 휴지통
  'trash.restore': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.trashRestore(p, id); }),
  'trash.purge': (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.trashPurge(p, id); }),

  // ---------------- 작업
  // 중지는 두지 않는다 — 삭제가 멈추고 치운다(사용자 지시, 2026-09-19).
  'job.pause': (b) => jobs.pause(b.pid, b.id),
  'job.resume': (b) => jobs.resume(b.pid, b.id),
  'job.remove': (b) => jobs.remove(b.pid, b.id),
  // 한도에 닿아 멈춘 작업에 사람이 답한다 — 'wait' | 'api' | 'stop'
  'job.answer': (b) => jobs.answer(b.pid, b.id, b.choice),

  // 무엇으로 돈이 나가는가 — 사람이 고른다. 키는 내려 주지 않는다(들어 있는지만 이른다).
  'auth.read': () => ok({ auth: auth.view() }),
  'auth.write': (b) => ok({ auth: auth.write({ mode: b.mode, apiKey: b.apiKey }) }),
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
    crew: (p.crew || []).map((a) => ({ id: a.id, name: a.name, role: a.role, craft: a.craft, model: a.model || '' })),
    docs: p.docs.map((d) => ({
      // 가리키는 문서(작법서)는 본문을 내려 주지 않는다 — 펼쳐 볼 때 peek 이 푼다.
      id: d.id, kind: d.kind, title: d.title, body: d.src ? '' : d.body, src: d.src || '', chars: d.src ? model.bodyOf(d).length : 0,
      isFinal: d.isFinal,
      categoryId: d.categoryId, request: d.request, refIds: d.refIds, targetIds: d.targetIds,
      agentIds: d.agentIds || [],
      versions: (d.versions || []).map((v, i) => ({ i, at: v.at, title: v.title, body: v.body })),
      updatedAt: d.updatedAt,
    })),
    threads: p.threads.map((t) => ({
      id: t.id, title: t.title, refIds: t.refIds, agentIds: t.agentIds || [], messages: t.messages, headId: t.headId,
      path: model.threadPath(t).map((m) => m.id),
    })),
    trash: p.trash.map((e) => ({ id: e.id, at: e.at, kind: e.kind, from: e.from, title: e.title })),
    jobs: p.jobs,
    model: p.model || '',
    models: MODELS,
    noCount: p.noCount !== false,
    prompts: VIEW_CODES.map((code) => ({
      code,
      name: engine.promptFor(p, code).name,
      edited: !!(p.prompts && p.prompts[code]),
      made: !!(p.agents && p.agents[code]),
      control: !EDITABLE_CODES.includes(code),
    })),
    agentKind: (p.agents && p.agents.__kind) || '',
    // 무엇으로 돈이 나가는가 — 화면에 반드시 보여 준다.
    // 「구독으로 돕니다」라고 말하면서 물려받은 ANTHROPIC_API_KEY 때문에 말없이 종량 과금되면
    // 그것은 표시광고 문제다(실측으로 그럴 수 있음을 확인했다).
    auth: auth.view(),
    // 마지막으로 본 한도 — 닿기 전에 남은 양을 보여 줄 재료. 호출이 흐르는 동안만 갱신된다.
    // 문턱(0.75) 아래면 이벤트가 안 흐르므로 null 일 수 있다.
    limit: lastLimit(),
    // 준비가 끝났는가 — 끝나지 않았으면 화면이 «다시» 단추를 세운다.
    prepared: prepared(p),
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
