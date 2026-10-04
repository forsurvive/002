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
import { resolveHosting, hostOf, originOk, gateOk, isNavigation, GATE_REALM } from './hosting.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(dirname(HERE), 'web');
// 어디에 어떻게 여는가 — 로컬 기본은 지금 그대로 127.0.0.1:8801(tools/hosting.mjs).
// 호스팅 플랫폼에서는 PORT · SE2_HOST · 허용 호스트 · 스테이징 출입 열쇠를 따른다.
export const HOSTING = resolveHosting(process.env);
const PORT = HOSTING.port;

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error) => ({ ok: false, error: String(error) });
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// 실행기가 아는 이름만 받는다. 모르는 것이 오면 지금 값을 지킨다.
const pickModel = (v, fallback) => (MODELS.includes(String(v || '')) ? String(v || '') : fallback);

// 준비가 온전히 끝났는가 — 프롬프트가 다 서 있고, 자료가 있다면 «자료 분석»까지 남았는가.
// 둘 중 하나라도 비면 화면이 [에이전트 준비 다시] 를 세운다.
const prepared = (p) => agentsReady(p) && (!model.materialDocs(p).length || p.docs.some((d) => d.title === STUDY_TITLE));

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
  // 그 자리(지어진 에이전트)가 쓸 모델. 빈 값이면 정해 둔 것을 걷어 작품의 모델을 따르게 한다.
  'prompt.model': (b) => {
    if (!VIEW_CODES.includes(b.code)) return bad('없는 자리입니다');
    const m = String(b.model == null ? '' : b.model);
    if (m && !MODELS.includes(m)) return bad('그 모델을 쓸 수 없습니다');
    return state.update(b.pid, (p) => {
      p.slotModels = p.slotModels || {};
      if (m) p.slotModels[b.code] = m; else delete p.slotModels[b.code];
    });
  },

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
  // 문서(자료도 문서다)·에이전트 어느 것이든 id 하나로 본문을 내어 준다(폰도 이 문 하나로 족하다).
  'peek': (b) => {
    const p = state.get(b.pid);
    if (!p) return bad('프로젝트를 찾을 수 없습니다');
    const d = model.findDoc(p, b.id);
    if (d) return ok({ one: { id: d.id, name: d.title, text: model.bodyOf(d) } });
    const a = model.findAgent(p, b.id);
    if (a) return ok({ one: { id: a.id, name: a.name, text: [a.role, a.craft].filter((x) => String(x || '').trim()).join('\n\n') } });
    return bad('없습니다');
  },

  'project.delete': (b) => {
    jobs.stopProject(b.pid);
    return state.remove(b.pid) ? ok() : bad('프로젝트를 찾을 수 없습니다');
  },

  // ---------------- 자료 — 작업실 «자료» 카테고리의 문서로 들고 난다(지우면 휴지통)
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
      model: engine.slotModel(p, code),
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
  if (url.pathname.startsWith('/api')) return send(res, 401, JSON.stringify(bad('출입 열쇠가 필요합니다')), 'application/json; charset=utf-8', challenge);
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

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
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
  process.on('SIGINT', () => { killAllCalls(); process.exit(0); });
}
