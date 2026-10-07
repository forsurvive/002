// 화면이 부르는 문(op) 표 — 개인판 서버(tools/server.mjs)와 온라인 서버(online/server.mjs)가 같은 표를 쓴다.
// 문의 이름과 응답 꼴은 폰 동반 프로그램이 기댄다(CLAUDE.md 원칙 9) — 두 서버가 따로 지으면 언젠가 어긋난다.
// 저장 · 작업 · 과금 갈래처럼 «어디서 도는가»에 따라 다른 것은 바깥이 넣는다(createOps 의 d).
// 넣는 것은 동기여도 비동기여도 된다 — 문마다 기다린다(개인판은 메모리, 온라인판은 PostgreSQL).

import * as model from './model.mjs';
import { makeBundle, readBundle } from './bundle.mjs';
import { MODELS } from '../core/ids.mjs';
import { bookList, BOOK_CATEGORY } from './books.mjs';
import { EDITABLE_CODES, VIEW_CODES } from './prompts.mjs';
import * as wf from '../core/workflow/stages.mjs';

const ok = (extra = {}) => ({ ok: true, ...extra });
const bad = (error) => ({ ok: false, error: String(error) });
const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
// 실행기가 아는 이름만 받는다. 모르는 것이 오면 지금 값을 지킨다.
// 글이 아닌 것(바이너리 — NUL 글자)은 자료 · 문서로 받지 않는다(명세 §63 — 업로드는 txt · md 먼저). 화면도 먼저 거른다.
const NOT_TEXT = '글이 아닌 파일은 넣을 수 없습니다 — txt · md 파일을 넣어 주세요';
const binary = (s) => String(s || '').includes('\u0000');
const pickModel = (v, fallback) => (MODELS.includes(String(v || '')) ? String(v || '') : fallback);

/**
 * d = { state, jobs, engine, auth, limit, prepared, startAgentPrep }
 *   state  : get · update · create · remove · list (tools/state.mjs 꼴)
 *   jobs   : start · pause · resume · remove · answer · stopProject · isTargetRunning · isKindRunning
 *   engine : promptView · promptFor · slotModel
 *   auth   : view · write — 무엇으로 돈이 나가는가(키는 내려 주지 않는다)
 *   limit  : () => 마지막으로 본 한도
 *   prepared(p) · startAgentPrep(pid, request)
 *   workflow(pid) : 그 프로젝트에 쓸 단계 템플릿(개인판은 설정 파일, 온라인은 고쳐 쓴 것까지) — 없으면 단계 기능이 서지 않는다
 *   cardsOn(p)    : 작업 중 강의 카드를 보이는가(개인판 기본 꺼짐 · 기관 프로젝트는 기관 설정)
 */
export function createOps(d) {
  const { state, jobs, engine, auth, limit, prepared, startAgentPrep } = d;
  const workflow = d.workflow || (async () => null);
  const cardsOn = d.cardsOn || ((p) => !!(p.workflow && p.workflow.cards));

  const OPS = {
    // ---------------- 프로젝트
    'project.list': async () => ok({ projects: await state.list() }),

    // 작품 파일(story-project · 개인판 project.json)을 새 작품으로 — 있는 작품을 덮어쓰지 않는다(늘 새 id)
    'project.import': async (b) => {
      if (!d.importProject) return bad('여기서는 작품을 가져올 수 없습니다');
      const r = readBundle(b.bundle);
      if (r.error) return bad(r.error);
      const out = await d.importProject(r.project);
      return out && out.pid ? ok({ pid: out.pid, checked: out.checked !== false }) : bad((out && out.error) || '가져오지 못했습니다');
    },

    // 필수는 셋뿐이다 — 이름·형식·자료(사용자 지시, 2026-09-19). 무엇이 빠졌는지 짚어서 돌려준다.
    'project.create': async (b) => {
      const name = String(b.name || '').trim();
      const spec = b.spec || {};
      const materials = arr(b.materials).filter((m) => m && String(m.text || '').trim());
      const miss = [];
      if (!name) miss.push('이름');
      if (!String(spec.form || '').trim()) miss.push('형식');
      if (!materials.length) miss.push('자료');
      if (miss.length) return bad('필수 항목 누락 — ' + miss.join(' · '));
      if (materials.some((m) => binary(m.text))) return bad(NOT_TEXT);
      const p = await state.create({ name, spec, standard: b.standard, request: b.request, materials });
      // 작법서를 문서로 세워 둔다 — 본문은 베끼지 않고 가리키기만 한다. 걸고 싶을 때 참조로 걸고, 필요 없으면 지운다.
      const books = bookList();
      if (books.length) {
        await state.update(p.id, (pr) => {
          const cat = model.categoryCreate(pr, BOOK_CATEGORY);
          for (const bk of books) model.docCreate(pr, { title: bk.title, src: bk.src, categoryId: cat.id });
        });
      }
      await startAgentPrep(p.id);
      return ok({ pid: p.id });
    },

    'project.spec': async (b) => state.update(b.pid, (p) => {
      if (b.name != null) p.name = String(b.name).trim() || p.name;
      if (b.spec) p.spec = { ...p.spec, ...b.spec };
      if (b.standard != null) p.standard = String(b.standard);
      if (b.request != null) p.request = String(b.request);
      if (b.model != null) p.model = MODELS.includes(String(b.model)) ? String(b.model) : p.model;
      if (b.noCount != null) p.noCount = !!b.noCount;
      // 단계 흐름 설정 — 본문 단계 켜고 끄기 · 작업 중 강의 카드
      if (b.bodyStage != null) p.workflow = { ...(p.workflow || {}), body: !!b.bodyStage };
      if (b.stageCards != null) p.workflow = { ...(p.workflow || {}), cards: !!b.stageCards };
    }),

    // ---------------- 단계형 작업 흐름(docs/WORKFLOW.md) — 자유 문서 작업 위에 얹는다
    // 시작 = 결과 문서를 마련하고 고른 참조를 건 뒤, 지금의 갱신과 같은 작업으로 돌린다. 이번 요청사항은 작업에만 실린다(문서에 저장하지 않는다).
    'stage.start': async (b) => {
      const t = await workflow(b.pid);
      if (!t) return bad('단계 흐름을 쓸 수 없습니다');
      const s = wf.stageOf(t, b.key);
      if (!s) return bad('없는 단계입니다');
      const ep = s.output === 'perEpisode' ? Number(b.episode) || 0 : 0;
      const cur = await state.get(b.pid);
      const had = cur && wf.docOf(cur, t, b.key, ep);
      if (had && await jobs.isTargetRunning(b.pid, had.id)) return bad('이미 도는 중입니다');
      let made = null;
      // keepRequest — 이번 요청사항을 문서의 요청사항(지속)으로도 남긴다. 그러면 이번 작업에는 문서 쪽으로만 실린다(두 번 싣지 않게).
      const once = String(b.requestOnce || '');
      const keep = !!b.keepRequest && !!once.trim();
      const r = await state.update(b.pid, (p) => {
        made = wf.startStage(p, t, b.key, { episode: ep, refIds: Array.isArray(b.refIds) ? b.refIds : null });
        const dd = made && made.ok && keep ? model.findDoc(p, made.docId) : null;
        if (dd) model.docWrite(p, dd.id, { request: [dd.request, once].filter((x) => String(x || '').trim()).join('\n\n') });
      });
      if (r && r.ok === false) return r;
      if (!made || !made.ok) return bad((made && made.error) || '시작하지 못했습니다');
      const p2 = await state.get(b.pid);
      const d = model.findDoc(p2, made.docId);
      return jobs.start(b.pid, { kind: 'stage', title: d ? d.title : s.title, targetId: made.docId,
        params: { stageKey: s.key, episode: ep, requestOnce: keep ? '' : once, modelPick: pickModel(b.model, '') } });
    },
    'stage.approve': async (b) => {
      const t = await workflow(b.pid);
      if (!t) return bad('단계 흐름을 쓸 수 없습니다');
      let r = null;
      await state.update(b.pid, (p) => { r = wf.approveStage(p, t, b.key, { episode: Number(b.episode) || 0, final: !!b.final, by: d.who ? d.who() : '' }); });
      return r && r.ok ? ok() : bad((r && r.error) || '승인하지 못했습니다');
    },
    'stage.reopen': async (b) => {
      const t = await workflow(b.pid);
      let r = null;
      if (t) await state.update(b.pid, (p) => { r = wf.reopenStage(p, t, b.key, { episode: Number(b.episode) || 0 }); });
      return r && r.ok ? ok() : bad((r && r.error) || '없는 단계입니다');
    },
    'stage.skip': async (b) => {
      const t = await workflow(b.pid);
      let r = null;
      if (t) await state.update(b.pid, (p) => { r = wf.skipStage(p, t, b.key, { on: b.on !== false }); });
      return r && r.ok ? ok() : bad((r && r.error) || '건너뛸 수 없습니다');
    },

    // ---------------- 작법 프롬프트 고치기
    'prompt.read': async (b) => {
      const p = await state.get(b.pid);
      if (!p) return bad('프로젝트를 찾을 수 없습니다');
      if (!VIEW_CODES.includes(b.code)) return bad('없는 자리입니다');
      return ok({ one: engine.promptView(p, b.code) });
    },
    'prompt.write': async (b) => {
      if (!VIEW_CODES.includes(b.code)) return bad('없는 자리입니다');
      return await state.update(b.pid, (p) => {
        p.prompts = p.prompts || {};
        const cur = p.prompts[b.code] || {};
        for (const k of ['name', 'role', 'task', 'craft']) if (b[k] != null) cur[k] = String(b[k]);
        p.prompts[b.code] = cur;
      });
    },
    // 되돌리면 작가가 고친 겹만 걷힌다 — 지어진 자리는 «지은 것»으로, 그 밖은 내장으로 돌아간다.
    'prompt.reset': async (b) => (VIEW_CODES.includes(b.code)
      ? await state.update(b.pid, (p) => { if (p.prompts) delete p.prompts[b.code]; })
      : bad('없는 자리입니다')),
    // 그 자리(지어진 에이전트)가 쓸 모델. 빈 값이면 정해 둔 것을 걷어 작품의 모델을 따르게 한다.
    'prompt.model': async (b) => {
      if (!VIEW_CODES.includes(b.code)) return bad('없는 자리입니다');
      const m = String(b.model == null ? '' : b.model);
      if (m && !MODELS.includes(m)) return bad('그 모델을 쓸 수 없습니다');
      return await state.update(b.pid, (p) => {
        p.slotModels = p.slotModels || {};
        if (m) p.slotModels[b.code] = m; else delete p.slotModels[b.code];
      });
    },

    // 판정이 어긋났거나 중지·재시작으로 준비가 끊긴 프로젝트를 구한다.
    // 자동 집필을 빼기 전에는 «자동 집필 시작»이 같은 문을 한 번 더 지났다 — 그 되돌리기를 여기로 옮겼다.
    'project.prepare': async (b) => {
      const p = await state.get(b.pid);
      if (!p) return bad('프로젝트를 찾을 수 없습니다');
      if (await jobs.isKindRunning(b.pid, 'agents')) return bad('이미 도는 중입니다');
      if (prepared(p)) return bad('이미 준비되어 있습니다');
      // 종류를 끝내 못 읽어 내장으로 갔던 작품(«기본») — 다시 누르면 종류를 처음부터 다시 가린다(적은 요청사항을 실어)
      if (p.agents && p.agents.__kind === '기본') await state.update(b.pid, (x) => { delete x.agents.__kind; });
      await startAgentPrep(b.pid, String(b.request || ''));
      return ok();
    },

    // 고르기 창에서 «이게 무슨 글이더라»를 그 자리에서 펼쳐 보는 문.
    // 문서(자료도 문서다)·에이전트 어느 것이든 id 하나로 본문을 내어 준다(폰도 이 문 하나로 족하다).
    'peek': async (b) => {
      const p = await state.get(b.pid);
      if (!p) return bad('프로젝트를 찾을 수 없습니다');
      const d = model.findDoc(p, b.id);
      if (d) return ok({ one: { id: d.id, name: d.title, text: model.bodyOf(d) } });
      const a = model.findAgent(p, b.id);
      if (a) return ok({ one: { id: a.id, name: a.name, text: [a.role, a.craft].filter((x) => String(x || '').trim()).join('\n\n') } });
      return bad('없습니다');
    },

    'project.delete': async (b) => {
      await jobs.stopProject(b.pid);
      return await state.remove(b.pid) ? ok() : bad('프로젝트를 찾을 수 없습니다');
    },

    // ---------------- 자료 — 작업실 «자료» 카테고리의 문서로 들고 난다(지우면 휴지통)
    'material.add': async (b) => (binary(b.text) ? bad(NOT_TEXT) : state.update(b.pid, (p) => { model.materialAdd(p, b.name || model.firstLineName(b.text), b.text); })),
    'material.delete': async (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.materialDelete(p, id); }),

    // ---------------- 에이전트 (작가가 짓는다)
    // 사람마다 쓸 모델을 따로 둘 수 있다 — 빈 값이면 프로젝트에 정해 둔 것을 따른다.
    'agent.create': async (b) => {
      let id = null;
      const r = await state.update(b.pid, (p) => { id = model.agentCreate(p, { ...b, model: pickModel(b.model, '') }).id; });
      return r.ok === false ? r : ok({ id });
    },
    'agent.write': async (b) => state.update(b.pid, (p) => {
      const cur = model.findAgent(p, b.id);
      model.agentWrite(p, b.id, { ...b, model: b.model == null ? undefined : pickModel(b.model, cur ? cur.model : '') });
    }),
    'agent.delete': async (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.agentDelete(p, id); }),

    // ---------------- 문서 · 모순 검사 · 합평회
    'doc.create': async (b) => {
      if (binary(b.body)) return bad(NOT_TEXT);
      let id = null;
      const r = await state.update(b.pid, (p) => {
        id = model.docCreate(p, { kind: b.kind, title: b.title, body: b.body, categoryId: b.categoryId }).id;
      });
      return r.ok === false ? r : ok({ id });
    },

    // baseAt — 화면이 고치기 시작할 때 본 문서의 updatedAt(없으면 견주지 않는다 — 폰 동반 프로그램 등 옛 부르기 그대로).
    // 그 사이 다른 곳(다른 탭 · AI 작업)이 먼저 고쳤어도 지금 글을 쓴다 — 먼저 고친 글은 이력(판)에 남으므로 잃는 것이 없다.
    // 대신 conflict 를 돌려주어 화면이 «이력에 남았다»고 알린다.
    'doc.write': async (b) => {
      let conflict = false;
      const r = await state.update(b.pid, (p) => {
        const cur = model.findDoc(p, b.id);
        conflict = !!cur && b.baseAt != null && (b.body != null || b.title != null) && (cur.updatedAt || 0) > Number(b.baseAt);
        model.docWrite(p, b.id, {
          title: b.title, body: b.body, request: b.request,
          refIds: b.refIds, targetIds: b.targetIds, agentIds: b.agentIds,
          categoryId: b.categoryId === undefined ? undefined : b.categoryId,
        });
      });
      return conflict && (!r || r.ok !== false) ? { ...(r || ok()), conflict: true } : r;
    },

    'doc.final': async (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.docSetFinal(p, id, !!b.on); }),

    'doc.delete': async (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.docDelete(p, id); }),
    // 차림표에서 만들어 놓고 아무것도 담지 않은 채 창을 닫았을 때 — 없던 일로 돌린다(휴지통에도 두지 않는다).
    // 비었는지는 서버가 잰다. 그 문서를 대상으로 도는 작업이 있으면 건드리지 않는다.
    'doc.discard': async (b) => (await jobs.isTargetRunning(b.pid, b.id)
      ? ok()
      : await state.update(b.pid, (p) => { model.docDiscard(p, b.id); })),

    'doc.restoreVersion': async (b) => state.update(b.pid, (p) => { model.docRestoreVersion(p, b.id, Number(b.index)); }),

    'doc.update': async (b) => {
      const p = await state.get(b.pid);
      const d = p && model.findDoc(p, b.id);
      if (!d) return bad('문서를 찾을 수 없습니다');
      if (await jobs.isTargetRunning(b.pid, d.id)) return bad('이미 도는 중입니다');
      // 작가가 «어느 모델로 모을지»를 골라 보냈으면 그것으로 부른다.
      const modelPick = pickModel(b.model, '');
      return await jobs.start(b.pid, { kind: 'update', title: d.title, targetId: d.id, params: { docId: d.id, modelPick } });
    },

    // ---------------- 카테고리
    'cat.create': async (b) => {
      let id = null;
      const r = await state.update(b.pid, (p) => { id = model.categoryCreate(p, b.name).id; });
      return r.ok === false ? r : ok({ id });
    },
    'cat.delete': async (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.categoryDelete(p, id); }),

    // ---------------- 논의 스레드
    'thread.create': async (b) => {
      let id = null;
      const r = await state.update(b.pid, (p) => { id = model.threadCreate(p, { title: b.title, refIds: b.refIds }).id; });
      return r.ok === false ? r : ok({ id });
    },
    'thread.refs': async (b) => state.update(b.pid, (p) => {
      const t = model.findThread(p, b.id);
      if (t) t.refIds = arr(b.refIds).slice();
    }),
    'thread.agents': async (b) => state.update(b.pid, (p) => {
      const t = model.findThread(p, b.id);
      if (t) t.agentIds = arr(b.agentIds).slice();
    }),
    'thread.send': async (b) => {
      const p = await state.get(b.pid);
      const t = p && model.findThread(p, b.id);
      if (!t) return bad('스레드를 찾을 수 없습니다');
      if (!String(b.text || '').trim()) return bad('빈 말');
      return await jobs.start(b.pid, { kind: 'talk', title: t.title, targetId: t.id, params: { threadId: t.id, text: String(b.text), modelPick: pickModel(b.model, '') } });
    },
    'thread.edit': async (b) => {
      const p = await state.get(b.pid);
      const t = p && model.findThread(p, b.id);
      if (!t) return bad('스레드를 찾을 수 없습니다');
      let made = null;
      await state.update(b.pid, (pr) => { made = model.threadEditMessage(pr, b.id, b.messageId, b.text); });
      if (!made) return bad('메시지를 찾을 수 없습니다');
      return await jobs.start(b.pid, { kind: 'talk', title: t.title, targetId: t.id, params: { threadId: t.id, text: null, modelPick: pickModel(b.model, '') } });
    },
    'thread.title': async (b) => state.update(b.pid, (p) => {
      const t = model.findThread(p, b.id);
      if (t) t.title = String(b.title || '').trim() || t.title;
    }),
    'thread.head': async (b) => state.update(b.pid, (p) => { model.threadSetHead(p, b.id, b.messageId); }),
    'thread.doc': async (b) => {
      const p = await state.get(b.pid);
      const t = p && model.findThread(p, b.id);
      if (!t) return bad('스레드를 찾을 수 없습니다');
      return await jobs.start(b.pid, { kind: 'threaddoc', title: t.title, targetId: t.id, params: { threadId: t.id, request: String(b.request || ''), modelPick: pickModel(b.model, '') } });
    },
    'thread.delete': async (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.threadDelete(p, id); }),
    // 갓 만들어 놓고 아무것도 담지 않은 채 창을 닫았을 때 — 없던 일로 돌린다(휴지통에도 두지 않는다).
    // 비었는지는 서버가 잰다. 답을 적으러 오는 작업이 돌고 있으면 건드리지 않는다.
    'thread.discard': async (b) => (await jobs.isTargetRunning(b.pid, b.id)
      ? ok()
      : await state.update(b.pid, (p) => { model.threadDiscard(p, b.id); })),

    // ---------------- 휴지통
    'trash.restore': async (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.trashRestore(p, id); }),
    'trash.purge': async (b) => state.update(b.pid, (p) => { for (const id of arr(b.ids)) model.trashPurge(p, id); }),

    // ---------------- 작업
    // 중지는 두지 않는다 — 삭제가 멈추고 치운다(사용자 지시, 2026-09-19).
    'job.pause': async (b) => jobs.pause(b.pid, b.id),
    'job.resume': async (b) => jobs.resume(b.pid, b.id),
    'job.remove': async (b) => jobs.remove(b.pid, b.id),
    // 한도에 닿아 멈춘 작업에 사람이 답한다 — 'wait' | 'api' | 'stop'
    'job.answer': async (b) => jobs.answer(b.pid, b.id, b.choice),

    // 무엇으로 돈이 나가는가 — 사람이 고른다. 키는 내려 주지 않는다(들어 있는지만 이른다).
    'auth.read': async () => ok({ auth: auth.view() }),
    'auth.write': async (b) => ok({ auth: auth.write({ mode: b.mode, apiKey: b.apiKey }) }),
  };

  // ---------------------------------------------------------------- 상태

  async function stateOf(pid) {
    const p = await state.get(pid);
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
      limit: limit(),
      // 준비가 끝났는가 — 끝나지 않았으면 화면이 «다시» 단추를 세운다.
      prepared: prepared(p),
      // 단계 흐름 — 단계 목록과 상태 · 추천 참조 · (켜져 있으면) 강의 카드. 강사 메모는 싣지 않는다(강사 화면이 따로 받는다).
      workflow: await (async () => {
        const t = await workflow(pid);
        if (!t) return null;
        const bodyOn = !(p.workflow && p.workflow.body === false);
        const cards = !!(await cardsOn(p));
        const defs = new Map(t.stages.map((s) => [s.key, s]));
        return {
          title: t.title, bodyOn, cards,
          stages: wf.view(p, t, { bodyOn }).map((v) => {
            const s = defs.get(v.key);
            return { ...v, task: wf.stageTask(s, 0), ...(cards && s.card ? { card: s.card } : {}) };
          }),
        };
      })(),
    };
  }

  // ---------------------------------------------------------------- 내려받기

  async function downloadOf(pid, kind, id) {
    const p = await state.get(pid);
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
    // 작품 통째로 — 문서 · 판 이력 · 확정 · 참조 · 논의 · 에이전트 · 단계 · 휴지통까지(다른 판에서 «가져오기»로 연다)
    if (kind === 'project') {
      return { name: model.safeFileName(p.name || '작품') + '.story-project.json', text: JSON.stringify(makeBundle(p)), type: 'application/json; charset=utf-8' };
    }
    return null;
  }

  return { OPS, stateOf, downloadOf };
}
