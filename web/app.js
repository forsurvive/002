'use strict';

// 화면 — 서버 상태를 받아 그대로 그린다. 조작은 모두 POST /api {op} 한 문으로 나간다.

const S = {
  pid: null, tab: '작업실', project: null, projects: [],
  open: null,      // 1겹 창
  pick: null,      // 2겹 참조/대상 선택
  confirm: null,   // 2겹 확인
  menu: false,
  sel: {},         // 구획 열쇠 → 체크된 id 집합
  all: {},         // 구획 열쇠 → 전체 선택 켜짐
  fold: {},        // 접힌 구획
  editMsg: null,
  draft: [],       // 프로젝트 생성 창에서 모은 자료
  autoSeen: {},    // 자동 집필 작업 상태(종료 알림용)
  doneWaiting: false,
  typed: {},       // 아직 저장되지 않은 입력값 — 다시 그려도 사라지지 않게 여기 둔다
  last: '',
};

const KIND_MARK = { check: '모순 검사', review: '합평회' };
const INBOX = '__inbox__';

// ---------------------------------------------------------------- 뼈대 도구

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'value') n.value = v;
      else if (k === 'checked' || k === 'disabled') n[k] = !!v;
      else n.setAttribute(k, v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return n;
}
const $ = (id) => document.getElementById(id);

// 입력란은 값을 DOM 이 아니라 S.typed 에 둔다 — 폴링이 다시 그려도 치던 글이 남는다.
function typedVal(id, fallback) { return id in S.typed ? S.typed[id] : (fallback == null ? '' : String(fallback)); }
function clearTyped(...ids) { for (const id of ids) delete S.typed[id]; }
function inputOf(tag, id, attrs = {}) {
  return h(tag, {
    ...attrs, id, value: typedVal(id, attrs.value),
    oninput: (e) => { S.typed[id] = e.target.value; },
  });
}
const textbox = (id, placeholder, value, attrs) => inputOf('input', id, { type: 'text', placeholder, value, ...attrs });
const area = (id, placeholder, value, attrs) => inputOf('textarea', id, { placeholder, value, ...attrs });
const stop = (e) => { e.stopPropagation(); };
const when = (t) => new Date(t).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function api(op, body = {}) {
  const r = await fetch('/api', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, pid: S.pid, ...body }),
  });
  const out = await r.json().catch(() => ({ ok: false, error: '응답 없음' }));
  await pull(true);
  return out;
}

function download(kind, id) {
  const a = h('a', { href: '/api/download?pid=' + encodeURIComponent(S.pid) + '&kind=' + kind + '&id=' + encodeURIComponent(id), download: '' });
  document.body.appendChild(a); a.click(); a.remove();
}

// ---------------------------------------------------------------- 상태 받아오기

async function pull(force) {
  const url = S.pid ? '/api/state?pid=' + encodeURIComponent(S.pid) : '/api/state';
  let d;
  try { d = await (await fetch(url)).json(); } catch { return; }
  if (d.projects) S.projects = d.projects;
  if (S.pid && d.ok === false) { S.pid = null; S.project = null; }
  else if (d.project) S.project = d.project;
  const sig = JSON.stringify([S.pid, S.projects, S.project]);
  if (!force && sig === S.last) return;
  S.last = sig;
  checkAutoDone();
  render();
}

function checkAutoDone() {
  const p = S.project;
  if (!p) return;
  for (const j of p.jobs || []) {
    if (j.kind !== 'auto') continue;
    const before = S.autoSeen[j.id];
    S.autoSeen[j.id] = j.status;
    if (before === 'running' && j.status === 'done') { if (S.open) S.doneWaiting = true; else S.open = { type: 'done' }; }
  }
}

// ---------------------------------------------------------------- 그리기

// 다시 그려도 보던 자리와 치던 자리를 지킨다 — 1.5초마다 도는 갱신이 화면을 흔들지 않도록.
const SCROLLERS = ['.main', '#layer1 .panel-body', '#layer2 .panel-body'];

function render() {
  const focus = document.activeElement;
  const keep = focus && focus.id ? { id: focus.id, value: focus.value, s: focus.selectionStart, e: focus.selectionEnd } : null;
  const tops = SCROLLERS.map((sel) => { const n = document.querySelector(sel); return n ? n.scrollTop : 0; });

  $('root').replaceChildren(S.pid && S.project ? app() : projectList());
  $('layer1').replaceChildren(...(S.open ? [layerOne()] : []));
  $('layer2').replaceChildren(...(S.pick ? [pickLayer()] : S.confirm ? [confirmLayer()] : []));

  SCROLLERS.forEach((sel, i) => { const n = document.querySelector(sel); if (n && tops[i]) n.scrollTop = tops[i]; });

  if (keep) {
    const n = $(keep.id);
    if (n && 'value' in n) {
      n.value = keep.value;
      n.focus();
      try { n.setSelectionRange(keep.s, keep.e); } catch {}
    }
  }
}

// ---------------------------------------------------------------- 프로젝트 목록

function projectList() {
  return h('div', { class: 'body' },
    h('div', { class: 'top', style: 'position:static;padding:0 0 18px;border:none' },
      h('div', { class: 'top-name', text: '스토리 엔진' }),
      h('button', { class: 'plus', text: '+', onclick: () => { S.draft = []; S.open = { type: 'newproject' }; render(); } })),
    h('div', { class: 'cards' }, S.projects.map((p) => h('div', {
      class: 'card', onclick: () => { S.pid = p.id; S.tab = '작업실'; S.project = null; pull(true); },
    },
    h('div', { class: 'name', text: p.name }),
    h('div', { class: 'when', text: when(p.updatedAt || p.createdAt) })))));
}

// ---------------------------------------------------------------- 프로젝트 안

function app() {
  const p = S.project;
  const running = (p.jobs || []).filter((j) => j.status === 'running');
  const autoRunning = running.some((j) => j.kind === 'auto');
  return h('div', { class: 'shell' },
    h('div', { class: 'side' },
      h('div', { class: 'side-top' }, h('div', { class: 'side-title', text: 'STORY ENGINE' })),
      ['작업실', '설정'].map((t) => h('button', {
        class: 'tab' + (S.tab === t ? ' on' : ''), text: t, onclick: () => { S.tab = t; render(); },
      })),
      h('div', { class: 'side-jobs' }, (p.jobs || []).map(jobRow)),
      h('div', { class: 'side-foot' }, h('button', {
        class: 'tab' + (S.tab === '휴지통' ? ' on' : ''), text: '휴지통', onclick: () => { S.tab = '휴지통'; render(); },
      }))),
    h('div', { class: 'main' },
      h('div', { class: 'top' },
        h('button', { class: 'top-name', text: p.name, onclick: () => { S.pid = null; S.project = null; S.tab = '작업실'; pull(true); } }),
        autoRunning
          ? h('button', { class: 'btn-red', text: '중지', onclick: () => api('job.stop', { id: running.find((j) => j.kind === 'auto').id }) })
          : h('button', { class: 'btn', text: '자동 집필', onclick: () => { S.open = { type: 'auto' }; render(); } })),
      h('div', { class: 'body' }, S.tab === '작업실' ? workshop() : S.tab === '설정' ? settings() : trash())));
}

function jobRow(j) {
  const st = j.status === 'running' ? (j.step || '진행 중') : j.status === 'done' ? '완료' : j.status === 'stopped' ? '중지됨' : '실패';
  return h('div', { class: 'job' },
    h('div', { class: 'job-name', text: j.title }),
    h('div', { class: 'job-step' + (j.status === 'failed' ? ' fail' : ''), text: j.status === 'failed' && j.error ? '실패 — ' + j.error.slice(0, 80) : st }),
    h('div', { class: 'job-acts' },
      j.status === 'running' ? h('button', { text: '중지', onclick: () => api('job.stop', { id: j.id }) }) : null,
      h('button', { text: '삭제', onclick: () => api('job.remove', { id: j.id }) })));
}

// ---------------------------------------------------------------- 작업실

function selOf(key) { return (S.sel[key] = S.sel[key] || new Set()); }

function toggleSel(key, id) {
  const s = selOf(key);
  if (s.has(id)) s.delete(id); else s.add(id);
  render();
}

function toggleAll(key, ids) {
  const on = !S.all[key];
  S.all[key] = on;
  S.sel[key] = new Set(on ? ids : []);
  render();
}

function workshop() {
  const p = S.project;
  const byId = new Map(p.docs.map((d) => [d.id, d]));
  const cats = p.categories;
  return h('div', null,
    h('div', { style: 'display:flex;justify-content:flex-end' },
      h('button', { class: 'plus', text: '+', onclick: (e) => { stop(e); S.menu = !S.menu; render(); } })),
    S.menu ? plusMenu() : null,
    cats.map((c) => catSection(c, byId)),
    p.threads.length ? threadSection() : null);
}

function plusMenu() {
  const go = (fn) => { S.menu = false; fn(); };
  return h('div', { class: 'menu' },
    h('button', { text: '문서', onclick: () => go(() => { S.open = { type: 'newdoc' }; render(); }) }),
    h('button', { text: '카테고리', onclick: () => go(() => { S.open = { type: 'newcat' }; render(); }) }),
    h('button', { text: '논의 스레드', onclick: () => go(async () => { const r = await api('thread.create', { title: '논의' }); if (r.ok) { S.open = { type: 'thread', id: r.id }; render(); } }) }),
    h('button', { text: '모순 검사', onclick: () => go(() => newCheck('check', '모순 검사')) }),
    h('button', { text: '합평회', onclick: () => go(() => newCheck('review', '합평회')) }));
}

async function newCheck(kind, title) {
  const r = await api('doc.create', { kind, title });
  if (r.ok) { S.open = { type: 'doc', id: r.id }; render(); }
}

function catSection(c, byId) {
  const key = 'cat:' + c.id;
  const sel = selOf(key);
  const folded = S.fold[key];
  const docs = c.docIds.map((id) => byId.get(id)).filter(Boolean);
  return h('div', { class: 'sec' },
    h('div', { class: 'sec-head' },
      h('button', { class: 'ck' + (S.all[key] ? ' on' : ''), onclick: () => toggleAll(key, c.docIds) }),
      h('div', { class: 'name', text: c.name, onclick: () => { S.fold[key] = !folded; render(); } }),
      c.virtual ? null : h('button', { class: 'btn-text red', text: '삭제', onclick: () => api('cat.delete', { ids: [c.id] }) })),
    S.all[key] ? h('div', { class: 'bulk' },
      h('button', { class: 'btn-line', text: '확정본 지정', onclick: () => api('doc.final', { ids: [...sel], on: true }) }),
      h('button', { class: 'btn-line', text: '확정본 해제', onclick: () => api('doc.final', { ids: [...sel], on: false }) }),
      h('button', { class: 'btn-line', text: '다운로드', onclick: () => [...sel].forEach((id, i) => setTimeout(() => download('doc', id), i * 120)) }),
      h('button', { class: 'btn-red', text: '삭제', onclick: () => api('doc.delete', { ids: [...sel] }) })) : null,
    folded ? null : docs.map((d) => h('div', {
      class: 'row' + (d.isFinal ? ' final' : ''),
      onclick: () => { S.open = { type: 'doc', id: d.id }; render(); },
    },
    h('button', { class: 'ck' + (sel.has(d.id) ? ' on' : ''), onclick: (e) => { stop(e); toggleSel(key, d.id); } }),
    h('button', { class: 'tg' + (d.isFinal ? ' on' : ''), onclick: (e) => { stop(e); api('doc.final', { ids: [d.id], on: !d.isFinal }); } }),
    KIND_MARK[d.kind] ? h('span', { class: 'mark', text: KIND_MARK[d.kind] }) : null,
    h('div', { class: 'name', text: d.title }))));
}

function threadSection() {
  const p = S.project;
  const key = 'threads';
  const sel = selOf(key);
  const ids = p.threads.map((t) => t.id);
  return h('div', { class: 'sec' },
    h('div', { class: 'sec-head' },
      h('button', { class: 'ck' + (S.all[key] ? ' on' : ''), onclick: () => toggleAll(key, ids) }),
      h('div', { class: 'name', text: '논의 스레드', onclick: () => { S.fold[key] = !S.fold[key]; render(); } })),
    S.all[key] ? h('div', { class: 'bulk' },
      h('button', { class: 'btn-line', text: '다운로드', onclick: () => [...sel].forEach((id, i) => setTimeout(() => download('thread', id), i * 120)) }),
      h('button', { class: 'btn-red', text: '삭제', onclick: () => api('thread.delete', { ids: [...sel] }) })) : null,
    S.fold[key] ? null : p.threads.map((t) => h('div', {
      class: 'row', onclick: () => { S.open = { type: 'thread', id: t.id }; render(); },
    },
    h('button', { class: 'ck' + (sel.has(t.id) ? ' on' : ''), onclick: (e) => { stop(e); toggleSel(key, t.id); } }),
    h('div', { class: 'name', text: t.title }))));
}

// ---------------------------------------------------------------- 설정

function settings() {
  const p = S.project;
  const save = async () => {
    const body = {
      name: $('set-name').value, standard: $('set-standard').value, request: $('set-request').value,
      spec: { outline: $('set-outline').value, form: $('set-form').value, length: $('set-length').value },
    };
    clearTyped('set-name', 'set-standard', 'set-request', 'set-outline', 'set-form', 'set-length');
    await api('project.spec', body);
  };
  const field = (id, label, value, big) => h('div', null,
    h('div', { class: 'lab', text: label }),
    big ? area(id, label, value, { onblur: save }) : textbox(id, label, value, { onblur: save }));
  return h('div', null,
    h('div', { class: 'grid2' },
      field('set-name', '이름', p.name),
      field('set-form', '형식', p.spec.form)),
    field('set-outline', '개요', p.spec.outline, true),
    h('div', { class: 'grid2' }, field('set-length', '분량', p.spec.length), h('div')),
    field('set-standard', '집필 기준', p.standard, true),
    field('set-request', '요청사항', p.request, true),
    h('div', null,
      h('div', { class: 'lab', text: '자료' }),
      p.materials.map((m) => h('div', { class: 'mat' },
        h('div', { class: 'name', text: m.name }),
        h('button', { class: 'btn-text red', text: '삭제', onclick: () => api('material.delete', { ids: [m.id] }) }))),
      h('div', { style: 'margin-top:10px' },
        area('set-mat', '자료'),
        h('div', { class: 'line', style: 'margin-top:8px' },
          h('button', {
            class: 'btn-line', text: '추가',
            onclick: () => { const t = $('set-mat').value; if (t.trim()) { clearTyped('set-mat'); api('material.add', { name: '붙여 넣은 글', text: t }); } },
          }),
          fileButton((name, text) => api('material.add', { name, text }))))),
    h('div', { style: 'padding-top:20px' },
      h('button', {
        class: 'btn-red', text: '프로젝트 삭제',
        onclick: () => { S.confirm = { text: '되돌릴 수 없음', run: async () => { await api('project.delete', {}); S.pid = null; S.project = null; S.confirm = null; pull(true); } }; render(); },
      })));
}

function fileButton(onRead) {
  const input = h('input', {
    type: 'file', style: 'display:none', multiple: true,
    onchange: (e) => {
      for (const f of e.target.files) {
        const rd = new FileReader();
        rd.onload = () => onRead(f.name, String(rd.result || ''));
        rd.readAsText(f, 'utf-8');
      }
      e.target.value = '';
    },
  });
  return h('span', null, input, h('button', { class: 'btn-line', text: '파일 선택', onclick: () => input.click() }));
}

// ---------------------------------------------------------------- 휴지통

function trash() {
  const p = S.project;
  const key = 'trash';
  const sel = selOf(key);
  const ids = p.trash.map((e) => e.id);
  return h('div', null,
    h('div', { class: 'sec' },
      h('div', { class: 'sec-head' },
        h('button', { class: 'ck' + (S.all[key] ? ' on' : ''), onclick: () => toggleAll(key, ids) }),
        h('div', { class: 'name', text: '휴지통' })),
      S.all[key] ? h('div', { class: 'bulk' },
        h('button', { class: 'btn-line', text: '복원', onclick: () => api('trash.restore', { ids: [...sel] }) }),
        h('button', { class: 'btn-red', text: '삭제', onclick: () => { S.confirm = { text: '되돌릴 수 없음', run: async () => { await api('trash.purge', { ids: [...sel] }); S.confirm = null; render(); } }; render(); } })) : null,
      p.trash.slice().reverse().map((e) => h('div', { class: 'row' },
        h('button', { class: 'ck' + (sel.has(e.id) ? ' on' : ''), onclick: () => toggleSel(key, e.id) }),
        h('div', { class: 'name', text: e.title }),
        h('div', { class: 'when', text: when(e.at) + ' · ' + e.from }),
        h('button', { class: 'btn-text', text: '복원', onclick: (ev) => { stop(ev); api('trash.restore', { ids: [e.id] }); } }),
        h('button', { class: 'btn-text red', text: '삭제', onclick: (ev) => { stop(ev); S.confirm = { text: '되돌릴 수 없음', run: async () => { await api('trash.purge', { ids: [e.id] }); S.confirm = null; render(); } }; render(); } })))));
}

// ---------------------------------------------------------------- 1겹 창

function layerOne() {
  const t = S.open.type;
  const close = () => {
    S.open = S.doneWaiting ? { type: 'done' } : null;
    S.doneWaiting = false;
    S.editMsg = null; S.typed = {};
    render();
  };
  const panel = t === 'doc' ? docPanel(close)
    : t === 'thread' ? threadPanel(close)
      : t === 'newproject' ? newProjectPanel(close)
        : t === 'newdoc' ? newDocPanel(close)
          : t === 'newcat' ? newCatPanel(close)
            : t === 'auto' ? autoPanel(close)
              : donePanel(close);
  return h('div', { class: 'layer', onclick: (e) => { if (e.target.classList.contains('layer')) close(); } }, panel);
}

function docPanel(close) {
  const d = (S.project.docs || []).find((x) => x.id === S.open.id);
  if (!d) return h('div', { class: 'panel narrow' }, h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '없음' }), h('button', { class: 'x', text: '×', onclick: close })));
  const byId = new Map(S.project.docs.map((x) => [x.id, x]));
  const saveFields = async () => {
    const body = { id: d.id, title: $('d-title').value, body: $('d-body').value, request: $('d-req').value };
    clearTyped('d-title', 'd-body', 'd-req');
    await api('doc.write', body);
  };

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      KIND_MARK[d.kind] ? h('span', { class: 'mark', text: KIND_MARK[d.kind] }) : null,
      textbox('d-title', '이름', d.title, { onblur: saveFields }),
      h('span', { class: 'lab', style: 'margin:0', text: '확정본' }),
      h('button', { class: 'tg' + (d.isFinal ? ' on' : ''), onclick: () => api('doc.final', { ids: [d.id], on: !d.isFinal }) }),
      h('button', { class: 'btn-text', text: '다운로드', onclick: () => download('doc', d.id) }),
      h('button', { class: 'btn-text red', text: '삭제', onclick: async () => { await api('doc.delete', { ids: [d.id] }); close(); } }),
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      area('d-body', '', d.body, { class: 'body-edit', onblur: saveFields }),
      h('div', null, h('div', { class: 'lab', text: '카테고리' }), h('div', { class: 'line' }, catPicker(d))),
      h('div', null, h('div', { class: 'lab', text: '요청사항' }), area('d-req', '요청사항', d.request, { onblur: saveFields })),
      d.kind === 'doc' ? null : refLine('대상', d.targetIds, byId, (ids) => api('doc.write', { id: d.id, targetIds: ids }), d.id),
      refLine('참조', d.refIds, byId, (ids) => api('doc.write', { id: d.id, refIds: ids }), d.id),
      h('div', null, h('button', {
        class: 'btn', text: '갱신',
        onclick: async () => { await saveFields(); await api('doc.update', { id: d.id }); },
      })),
      d.versions.length ? h('details', null,
        h('summary', { text: '이력' }),
        d.versions.slice().reverse().map((v) => h('div', { class: 'ver' },
          h('div', { class: 'when', text: when(v.at) + ' · ' + v.title }),
          h('button', { class: 'btn-text', text: '복원', onclick: () => api('doc.restoreVersion', { id: d.id, index: v.i }) })))) : null));
}

function catPicker(d) {
  const cats = [{ id: INBOX, name: '새로 추가된 문서' }, ...S.project.categories.filter((c) => !c.virtual)];
  const cur = d.categoryId || INBOX;
  return cats.map((c) => h('label', { class: 'line', style: 'gap:6px;cursor:pointer' },
    h('button', {
      class: 'ck' + (cur === c.id ? ' on' : ''),
      onclick: () => api('doc.write', { id: d.id, categoryId: c.id === INBOX ? null : c.id }),
    }),
    h('span', { text: c.name })));
}

function refLine(label, ids, byId, save, selfId) {
  return h('div', null,
    h('div', { class: 'lab', text: label }),
    h('div', { class: 'line' },
      (ids || []).map((id) => {
        const t = byId.get(id);
        return h('span', { class: 'chip' + (t && t.isFinal ? ' final' : '') },
          h('span', { text: t ? t.title : '없음' }),
          h('button', { text: '×', onclick: () => save((ids || []).filter((x) => x !== id)) }));
      }),
      h('button', { class: 'plus', style: 'width:26px;height:26px;font-size:16px', text: '+', onclick: () => { S.pick = { ids: (ids || []).slice(), save, selfId }; render(); } })));
}

function threadPanel(close) {
  const t = (S.project.threads || []).find((x) => x.id === S.open.id);
  if (!t) return h('div', { class: 'panel narrow' }, h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '없음' }), h('button', { class: 'x', text: '×', onclick: close })));
  const byId = new Map(S.project.docs.map((x) => [x.id, x]));
  const msgs = new Map(t.messages.map((m) => [m.id, m]));
  const flow = [];
  for (const id of t.path) {
    const m = msgs.get(id);
    if (!m) continue;
    const sibs = t.messages.filter((x) => x.parentId === m.parentId);
    if (sibs.length > 1) {
      flow.push(h('div', { class: 'branches' }, sibs.map((s2) => h('div', {
        class: 'branch' + (s2.id === id ? ' on' : ''), onclick: () => api('thread.head', { id: t.id, messageId: s2.id }),
      },
      h('span', { text: (s2.text || '').slice(0, 14) || '빈 말' })))));
    }
    if (m.role === 'user') {
      flow.push(S.editMsg === m.id
        ? h('div', { class: 'send', style: 'align-self:stretch' },
          area('m-edit', '', m.text),
          h('button', { class: 'btn', text: '보내기', onclick: async () => { const v = $('m-edit').value; S.editMsg = null; clearTyped('m-edit'); await api('thread.edit', { id: t.id, messageId: m.id, text: v }); } }))
        : h('div', { class: 'msg me', text: m.text, onclick: () => { S.editMsg = m.id; render(); } }));
    } else {
      flow.push(h('div', { class: 'msg ai', text: m.text }));
    }
  }
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('div', { class: 'name', text: t.title }),
      h('button', { class: 'btn-text', text: '다운로드', onclick: () => download('thread', t.id) }),
      h('button', { class: 'btn-text red', text: '삭제', onclick: async () => { await api('thread.delete', { ids: [t.id] }); close(); } }),
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      refLine('참조', t.refIds, byId, (ids) => api('thread.refs', { id: t.id, refIds: ids }), null),
      h('div', { class: 'talk' }, flow),
      h('div', { class: 'send' },
        area('t-say', '요청사항'),
        h('button', { class: 'btn', text: '보내기', onclick: async () => { const v = $('t-say').value; if (!v.trim()) return; clearTyped('t-say'); await api('thread.send', { id: t.id, text: v }); } }),
        h('button', { class: 'btn-line', text: '문서로 정리', onclick: async () => { const v = $('t-say').value; clearTyped('t-say'); await api('thread.doc', { id: t.id, request: v }); } }))));
}

function newProjectPanel(close) {
  const add = (name, text) => { if (String(text || '').trim()) { S.draft.push({ name, text }); render(); } };
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '새 작품' }), h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      h('div', { class: 'grid2' },
        h('div', null, h('div', { class: 'lab', text: '이름' }), textbox('n-name', '이름')),
        h('div', null, h('div', { class: 'lab', text: '형식' }), textbox('n-form', '형식'))),
      h('div', null, h('div', { class: 'lab', text: '개요' }), area('n-outline', '개요')),
      h('div', { class: 'grid2' },
        h('div', null, h('div', { class: 'lab', text: '분량' }), textbox('n-length', '분량')),
        h('div')),
      h('div', null, h('div', { class: 'lab', text: '집필 기준' }), area('n-standard', '집필 기준')),
      h('div', null, h('div', { class: 'lab', text: '요청사항' }), area('n-request', '요청사항')),
      h('div', null,
        h('div', { class: 'lab', text: '자료' }),
        S.draft.map((m, i) => h('div', { class: 'mat' },
          h('div', { class: 'name', text: m.name }),
          h('button', { class: 'btn-text red', text: '삭제', onclick: () => { S.draft.splice(i, 1); render(); } }))),
        area('n-mat', '자료'),
        h('div', { class: 'line', style: 'margin-top:8px' },
          h('button', { class: 'btn-line', text: '추가', onclick: () => { const t = $('n-mat').value; clearTyped('n-mat'); add('붙여 넣은 글', t); } }),
          fileButton(add))),
      h('div', { style: 'padding-top:6px' }, h('button', {
        class: 'btn', text: '생성',
        onclick: async () => {
          const body = {
            name: $('n-name').value, standard: $('n-standard').value, request: $('n-request').value,
            spec: { outline: $('n-outline').value, form: $('n-form').value, length: $('n-length').value },
            materials: S.draft.slice(),
          };
          const r = await api('project.create', body);
          if (r.ok) { S.pid = r.pid; S.draft = []; S.open = null; S.project = null; S.typed = {}; pull(true); }
          else { S.open = { type: 'newproject', err: r.error }; render(); }
        },
      }), S.open.err ? h('span', { class: 'notice', style: 'margin-left:10px', text: S.open.err }) : null)));
}

function newDocPanel(close) {
  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '문서' }), h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      textbox('nd-name', '이름'),
      h('div', { class: 'line' },
        h('button', {
          class: 'btn', text: '생성',
          onclick: async () => {
            const r = await api('doc.create', { title: $('nd-name').value || '문서' });
            if (r.ok) { S.open = { type: 'doc', id: r.id }; render(); }
          },
        }),
        fileButton(async (name, text) => {
          const r = await api('doc.create', { title: name.replace(/\.[^.]+$/, ''), body: text });
          if (r.ok) { S.open = { type: 'doc', id: r.id }; render(); }
        }))));
}

function newCatPanel(close) {
  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '카테고리' }), h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      textbox('nc-name', '이름', '', {
        onkeydown: async (e) => { if (e.key === 'Enter' && e.target.value.trim()) { await api('cat.create', { name: e.target.value }); close(); } },
      }),
      h('button', { class: 'btn', text: '생성', onclick: async () => { if ($('nc-name').value.trim()) { await api('cat.create', { name: $('nc-name').value }); close(); } } })));
}

function autoPanel(close) {
  const p = S.project;
  const ready = p.name && p.spec.outline && p.spec.form && p.materials.length;
  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '자동 집필' }), h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      h('div', null, h('div', { class: 'lab', text: '피드백 횟수' }),
        textbox('a-rounds', '피드백 횟수', String(p.auto.feedbackRounds || 1))),
      h('label', { class: 'line', style: 'cursor:pointer' },
        h('button', { class: 'ck' + (p.auto.skipProse ? ' on' : ''), id: 'a-skip', onclick: (e) => { e.preventDefault(); e.currentTarget.classList.toggle('on'); } }),
        h('span', { text: '본문 집필 제외' })),
      ready ? null : h('div', { class: 'notice', text: '작품 규격과 자료 필요' }),
      h('button', {
        class: 'btn', text: '시작', disabled: !ready,
        onclick: async () => {
          await api('auto.start', { feedbackRounds: Number($('a-rounds').value) || 1, skipProse: $('a-skip').classList.contains('on') });
          close();
        },
      })));
}

function donePanel(close) {
  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '자동 집필 종료' }), h('button', { class: 'x', text: '×', onclick: close })));
}

// ---------------------------------------------------------------- 2겹 창

function pickLayer() {
  const p = S.project;
  const chosen = new Set(S.pick.ids);
  const flip = (id) => { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); S.pick.ids = [...chosen]; S.pick.save(S.pick.ids); render(); };
  const close = () => { S.pick = null; render(); };
  return h('div', { class: 'layer two', onclick: (e) => { if (e.target.classList.contains('layer')) close(); } },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '참조' }), h('button', { class: 'x', text: '×', onclick: close })),
      h('div', { class: 'panel-body' }, p.categories.map((c) => {
        const ids = c.docIds.filter((id) => id !== S.pick.selfId);
        if (!ids.length) return null;
        const allOn = ids.every((id) => chosen.has(id));
        return h('div', { class: 'sec' },
          h('div', { class: 'sec-head' },
            h('button', {
              class: 'ck' + (allOn ? ' on' : ''),
              onclick: () => { ids.forEach((id) => (allOn ? chosen.delete(id) : chosen.add(id))); S.pick.ids = [...chosen]; S.pick.save(S.pick.ids); render(); },
            }),
            h('div', { class: 'name', text: c.name })),
          ids.map((id) => {
            const d = p.docs.find((x) => x.id === id);
            return h('div', { class: 'row' + (d.isFinal ? ' final' : ''), onclick: () => flip(id) },
              h('button', { class: 'ck' + (chosen.has(id) ? ' on' : ''), onclick: (e) => { stop(e); flip(id); } }),
              KIND_MARK[d.kind] ? h('span', { class: 'mark', text: KIND_MARK[d.kind] }) : null,
              h('div', { class: 'name', text: d.title }));
          }));
      }))));
}

function confirmLayer() {
  const close = () => { S.confirm = null; render(); };
  return h('div', { class: 'layer two' },
    h('div', { class: 'panel narrow' },
      h('div', { class: 'panel-head' }, h('div', { class: 'name', text: S.confirm.text }), h('button', { class: 'x', text: '×', onclick: close })),
      h('div', { class: 'panel-body' }, h('button', { class: 'btn-red', text: '삭제', onclick: S.confirm.run }))));
}

// ---------------------------------------------------------------- 시작

document.addEventListener('click', (e) => {
  if (S.menu && !e.target.closest('.menu') && !e.target.closest('.plus')) { S.menu = false; render(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.pick) { S.pick = null; render(); } else if (S.confirm) { S.confirm = null; render(); } else if (S.open) { S.open = null; S.editMsg = null; render(); }
});

pull(true);
setInterval(() => pull(false), 1500);
