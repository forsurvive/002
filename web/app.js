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
  typed: {},       // 아직 저장되지 않은 입력값 — 다시 그려도 사라지지 않게 여기 둔다
  newCat: false,   // 카테고리 이름을 그 자리에서 받는 중
  peek: null,      // 지금 들여다보는 옛 판 { docId, i }
  saveOpen: null,  // 지금 열린 창이 «닫기 전에 저장할 것»을 여기 걸어 둔다
  focusNext: '',   // 다시 그린 뒤 이 칸에 커서를 둔다
  redrawing: false,// 다시 그리는 중 — 그때 떨어지는 포커스는 저장이 아니다
  last: '',
};

const KIND_MARK = { check: '모순 검사', review: '합평회' };
const INBOX = '__inbox__';
const BODY_HINT = '직접 입력하거나 아래의 요청사항을 작성해주세요..';

// 처음 쓰는 사람을 위한 작업 순서 — 설정 탭에 접어 둔다.
const GUIDE = [
  ['① 작품을 만든다', '첫 화면 오른쪽 위 [+]. 이름·형식과 자료만 있으면 됩니다(개요와 분량은 비워 두어도 됩니다). 만들고 나면 왼쪽 «에이전트 준비»가 돌며 자료를 한 번 읽어 «자료 분석»을 남깁니다.'],
  ['② 문서를 짓는다', '작업실 [+] → 문서. 이름만 짓고 [생성]을 누르면 요청사항과 참조를 보고 씁니다. 본문을 직접 치셔도 됩니다. 한 호출이 십 분을 넘기기도 하니 작업 줄의 지난 시간을 보고 기다리십시오.'],
  ['③ 참조를 건다', '문서 창의 «참조»에 자료와 다른 문서를 겁니다. 확정본(빨간 토글)을 켜 두면 그 문서가 «최우선 사실»로 실려 다른 글을 다스립니다.'],
  ['④ 에이전트를 건다', '설정에서 이름·역할·작법·쓸 모델로 사람을 짓고, 문서 창의 «에이전트»에 걸어 둡니다. 그 문서를 짓고 고칠 때 그 사람이 씁니다.'],
  ['⑤ 고쳐 간다', '본문이나 요청사항을 고치고 [갱신]. 옛 판은 «이력»에 남아 언제든 되돌립니다.'],
  ['⑥ 검사하고 듣는다', '[+] → 모순 검사로 앞뒤를 맞추고, 합평회로 평을 듣습니다. 둘 다 «대상»에 볼 문서를 걸어 줍니다.'],
  ['⑦ 묻는다', '[+] → 논의 스레드. 답이 마음에 들면 [문서로 정리]를 누릅니다.'],
  ['⑧ 꺼낸다', '문서 창의 [다운로드]. 구획을 통째로 고르면 한 파일로 받습니다.'],
];

const guideBlock = () => h('details', { open: S.fold['guide'] ? 'open' : null },
  h('summary', { text: '처음 쓰신다면 — 작업 순서', onclick: () => { S.fold['guide'] = !S.fold['guide']; } }),
  GUIDE.map(([name, txt]) => h('div', { class: 'guide-step' },
    h('div', { class: 'name', text: name }),
    h('div', { class: 'txt', text: txt }))));

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
// 지난 시간 — 막대도 백분율도 쓰지 않는다. 얼마나 되었는지만 말한다.
function since(t) {
  const sec = Math.max(0, Math.floor((Date.now() - (t || Date.now())) / 1000));
  if (sec < 60) return sec + '초';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + '분';
  return Math.floor(min / 60) + '시간 ' + (min % 60) + '분';
}

// 작업 한 줄이 말하는 것 — 그리기와 초침이 같은 글을 쓰도록 한 자리에 둔다.
function jobLine(j) {
  if (j.status === 'running') return (j.step || '진행 중') + ' · ' + since(j.stepAt || j.startedAt);
  if (j.status === 'done') return '완료';
  if (j.status === 'stopped') return '중지됨';
  return j.error ? '실패 — ' + j.error.slice(0, 80) : '실패';
}

const firstLine = (text) => (String(text || '').split('\n').map((l) => l.trim()).find((l) => l) || '붙여 넣은 글').slice(0, 24);

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
  render();
}

// ---------------------------------------------------------------- 그리기

// 다시 그려도 보던 자리와 치던 자리를 지킨다 — 1.5초마다 도는 갱신이 화면을 흔들지 않도록.
const SCROLLERS = ['.main', '#layer1 .panel-body', '#layer2 .panel-body', '#d-body'];

function render() {
  const focus = document.activeElement;
  const keep = focus && focus.id ? { id: focus.id, value: focus.value, s: focus.selectionStart, e: focus.selectionEnd } : null;
  const tops = SCROLLERS.map((sel) => { const n = document.querySelector(sel); return n ? n.scrollTop : 0; });

  S.saveOpen = null;
  S.redrawing = true;
  $('root').replaceChildren(S.pid && S.project ? app() : projectList());
  $('layer1').replaceChildren(...(S.open ? [layerOne()] : []));
  $('layer2').replaceChildren(...(S.pick ? [pickLayer()] : S.confirm ? [confirmLayer()] : []));
  S.redrawing = false;

  SCROLLERS.forEach((sel, i) => { const n = document.querySelector(sel); if (n && tops[i]) n.scrollTop = tops[i]; });

  if (keep) {
    const n = $(keep.id);
    if (n && 'value' in n) {
      // 사람이 친 글만 되살린다. 손대지 않은 칸은 서버에서 온 새 글이 이긴다
      // (커서를 두고 있었다는 이유로 갱신 결과가 가로막히면 안 된다).
      if (keep.id in S.typed) n.value = keep.value;
      n.focus();
      try { n.setSelectionRange(keep.s, keep.e); } catch {}
    }
  }
  if (S.focusNext) {
    const n = $(S.focusNext);
    S.focusNext = '';
    if (n && n.focus) n.focus();
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

function goHome() { S.pid = null; S.project = null; S.tab = '작업실'; pull(true); }

function app() {
  const p = S.project;
  return h('div', { class: 'shell' },
    h('div', { class: 'side' },
      h('div', { class: 'side-top' }, h('button', { class: 'side-title', text: 'STORY ENGINE', onclick: goHome })),
      ['작업실', '설정'].map((t) => h('button', {
        class: 'tab' + (S.tab === t ? ' on' : ''), text: t, onclick: () => { S.tab = t; render(); },
      })),
      h('div', { class: 'side-jobs' }, (p.jobs || []).map(jobRow)),
      h('div', { class: 'side-foot' }, h('button', {
        class: 'tab' + (S.tab === '휴지통' ? ' on' : ''), text: '휴지통', onclick: () => { S.tab = '휴지통'; render(); },
      }))),
    h('div', { class: 'main' },
      h('div', { class: 'top' },
        h('div', { class: 'line' },
          h('button', { class: 'back', text: '‹', title: '작품 목록', onclick: goHome }),
          h('button', { class: 'top-name', text: p.name, onclick: goHome }))),
      h('div', { class: 'body' }, S.tab === '작업실' ? workshop() : S.tab === '설정' ? settings() : trash())));
}

function jobRow(j) {
  return h('div', { class: 'job' },
    h('div', { class: 'job-name', text: j.title }),
    h('div', { class: 'job-step' + (j.status === 'failed' ? ' fail' : ''), id: 'jstep-' + j.id, text: jobLine(j) }),
    h('div', { class: 'job-acts' },
      j.status === 'running' ? h('button', { text: '중지', onclick: () => api('job.stop', { id: j.id }) }) : null,
      h('button', { text: '삭제', onclick: () => api('job.remove', { id: j.id }) })));
}

// 초마다 작업 줄의 «지난 시간»만 고쳐 쓴다 — 화면을 통째로 다시 그리지 않는다.
setInterval(() => {
  if (!S.project) return;
  for (const j of S.project.jobs || []) {
    if (j.status !== 'running') continue;
    const n = $('jstep-' + j.id);
    if (n) n.textContent = jobLine(j);
  }
}, 1000);

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
    S.newCat ? h('div', { class: 'sec' }, h('div', { class: 'sec-head' }, textbox('nc-name', '이름', '', {
      onkeydown: async (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
          const v = e.target.value;
          clearTyped('nc-name'); S.newCat = false;
          await api('cat.create', { name: v });
        } else if (e.key === 'Escape') { clearTyped('nc-name'); S.newCat = false; render(); }
      },
      onblur: async () => {
        if (S.redrawing) return;
        const v = $('nc-name') ? $('nc-name').value.trim() : '';
        S.newCat = false;
        clearTyped('nc-name');
        if (v) await api('cat.create', { name: v }); else render();
      },
    }))) : null,
    p.threads.length ? threadSection() : null);
}

function plusMenu() {
  const go = (fn) => { S.menu = false; fn(); };
  return h('div', { class: 'menu' },
    h('button', { text: '문서', onclick: () => go(() => { S.open = { type: 'newdoc' }; render(); }) }),
    h('button', { text: '카테고리', onclick: () => go(() => { S.newCat = true; S.focusNext = 'nc-name'; render(); }) }),
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
      h('button', {
        class: 'btn-line', text: '다운로드',
        onclick: () => {
          // 그 카테고리를 통째로 골랐으면 한 파일로, 골라 담았으면 문서마다 한 파일로.
          if (c.docIds.length && c.docIds.every((id) => sel.has(id))) download('cat', c.id);
          else [...sel].forEach((id, i) => setTimeout(() => download('doc', id), i * 120));
        },
      }),
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
    if (S.redrawing) return;
    const keys = ['set-name', 'set-standard', 'set-request', 'set-outline', 'set-form', 'set-length'];
    if (!keys.some((k) => k in S.typed)) return;   // 손대지 않았으면 쓰지 않는다
    const body = {
      name: $('set-name').value, standard: $('set-standard').value, request: $('set-request').value,
      spec: { outline: $('set-outline').value, form: $('set-form').value, length: $('set-length').value },
    };
    clearTyped(...keys);
    await api('project.spec', body);
  };
  const field = (id, label, value, big) => h('div', null,
    h('div', { class: 'lab', text: label }),
    big ? area(id, label, value, { onblur: save }) : textbox(id, label, value, { onblur: save }));
  return h('div', { class: 'settings' },
    guideBlock(),
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
        h('div', { class: 'when', text: String(m.chars) }),
        h('button', { class: 'btn-text red', text: '삭제', onclick: () => api('material.delete', { ids: [m.id] }) }))),
      h('div', { style: 'margin-top:10px' },
        area('set-mat', '자료'),
        h('div', { class: 'line', style: 'margin-top:8px' },
          h('button', {
            class: 'btn-line', text: '추가',
            onclick: () => { const t = $('set-mat').value; if (t.trim()) { clearTyped('set-mat'); api('material.add', { text: t }); } },
          }),
          fileButton((name, text) => api('material.add', { name, text }))))),
    h('div', null,
      h('div', { class: 'lab', text: '에이전트' }),
      (p.crew || []).map((a) => h('div', { class: 'mat' },
        h('div', { class: 'name', text: a.name }),
        h('div', { class: 'when', text: a.role }),
        a.model ? h('span', { class: 'mark', text: a.model }) : null,
        h('button', { class: 'btn-text', text: '고치기', onclick: () => openAgent(a.id) }),
        h('button', { class: 'btn-text red', text: '삭제', onclick: () => api('agent.delete', { ids: [a.id] }) }))),
      h('div', { class: 'line', style: 'margin-top:8px' },
        h('button', { class: 'btn-line', text: '추가', onclick: () => openAgent(null) }),
        // 준비가 어긋났거나 끊겼을 때만 선다 — 누르면 종류 판정부터 자료 분석까지 다시 돈다.
        p.prepared || (p.jobs || []).some((j) => j.kind === 'agents' && j.status === 'running')
          ? null
          : h('button', { class: 'btn-line', text: '에이전트 준비 다시', onclick: () => { S.open = { type: 'prepare' }; clearTyped('pp-req'); render(); } }))),
    h('div', null,
      h('div', { class: 'lab', text: '모델' }),
      modelRow(p.models, p.model, (m) => api('project.spec', { model: m }), '기본값')),
    (p.prompts || []).length ? h('details', { open: S.fold['prompts'] ? 'open' : null },
      h('summary', { text: '작법 프롬프트', onclick: () => { S.fold['prompts'] = !S.fold['prompts']; } }),
      (p.prompts || []).map((pr) => h('div', {
        class: 'row', onclick: () => openPrompt(pr.code),
      },
      h('span', { class: 'mark', text: pr.code }),
      h('div', { class: 'name', text: pr.name }),
      pr.edited ? h('span', { class: 'when', style: 'color:var(--red)', text: '고침' }) : null))) : null,
    h('div', { style: 'padding-top:20px' },
      h('button', {
        class: 'btn-red', text: '프로젝트 삭제',
        onclick: () => { S.confirm = { text: '되돌릴 수 없음', run: async () => { await api('project.delete', {}); S.pid = null; S.project = null; S.confirm = null; pull(true); } }; render(); },
      })));
}

function openAgent(id) { S.open = { type: 'agent', id, model: null }; clearTyped('ag-name', 'ag-role', 'ag-craft'); render(); }

// 쓸 모델 고르기 — 하나만 켜지는 네모. 프로젝트에도, 사람마다에도 같은 꼴로 쓴다.
// 누름을 click 이 아니라 mousedown 으로 받는다: 바로 위 칸에 글을 치던 중이면 click 이 오기 전에
// blur → 저장 → 다시 그리기가 지나가며 이 네모가 갈려 버려 첫 누름이 먹히지 않는다.
function modelRow(list, cur, pick, firstLabel) {
  return h('div', { class: 'line' }, (list || ['']).map((m) => h('div', {
    class: 'line', style: 'gap:6px;cursor:pointer',
    onmousedown: () => pick(m),
  },
  h('button', { class: 'ck' + ((cur || '') === m ? ' on' : '') }),
  h('span', { text: m || firstLabel }))));
}

// 작가가 짓는 에이전트 — 이름·역할·작법 셋. 새로 지을 때만 단추가 있고, 고칠 때는 치는 대로 들어간다.
function agentPanel(close) {
  const p = S.project;
  if (!p) return h('div', { class: 'panel narrow' }, h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '…' }), h('button', { class: 'x', text: '×', onclick: close })));
  const a = S.open.id ? (p.crew || []).find((x) => x.id === S.open.id) : null;
  const making = !S.open.id;
  const save = async () => {
    if (S.redrawing || making || !a) return;
    S.saveOpen = null;
    const body = { id: a.id };
    let any = false;
    for (const [id, key] of [['ag-name', 'name'], ['ag-role', 'role'], ['ag-craft', 'craft']]) {
      const n = $(id);
      if (n && id in S.typed) { body[key] = n.value; any = true; }
    }
    clearTyped('ag-name', 'ag-role', 'ag-craft');
    if (!any) return;
    await api('agent.write', body);
  };
  if (!making && !a) return h('div', { class: 'panel narrow' }, h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '없음' }), h('button', { class: 'x', text: '×', onclick: close })));
  if (!making) S.saveOpen = save;
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('div', { class: 'name', text: making ? '새 에이전트' : a.name }),
      making ? null : h('button', { class: 'btn-text red', text: '삭제', onclick: async () => { S.saveOpen = null; clearTyped('ag-name', 'ag-role', 'ag-craft'); await api('agent.delete', { ids: [a.id] }); close(); } }),
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      h('div', null, h('div', { class: 'lab', text: '이름' }), textbox('ag-name', '이름', a ? a.name : '', { onblur: save })),
      h('div', null, h('div', { class: 'lab', text: '역할' }), textbox('ag-role', '역할', a ? a.role : '', { onblur: save })),
      h('div', null,
        h('div', { class: 'lab', text: '모델' }),
        modelRow(p.models, making ? (S.open.model || '') : (a.model || ''),
          (m) => { if (making) { S.open.model = m; render(); } else api('agent.write', { id: a.id, model: m }); },
          '작품을 따름')),
      h('div', null, h('div', { class: 'lab', text: '작법' }), area('ag-craft', '작법', a ? a.craft : '', { class: 'body-edit', onblur: save })),
      making ? h('div', null, h('button', {
        class: 'btn', text: '만들기',
        onclick: async () => {
          const body = { name: $('ag-name').value, role: $('ag-role').value, craft: $('ag-craft').value, model: S.open.model || '' };
          // 한 글자도 치지 않았으면 짓지 않는다 — 창만 닫힌다.
          if (!String(body.name).trim() && !String(body.role).trim() && !String(body.craft).trim()) return close();
          if (!String(body.name).trim()) return;
          clearTyped('ag-name', 'ag-role', 'ag-craft');
          await api('agent.create', body);
          close();
        },
      })) : null));
}

async function openPrompt(code) {
  const r = await api('prompt.read', { code });
  if (r.ok) { S.open = { type: 'prompt', one: r.one }; S.typed = {}; render(); }
}

function promptPanel(close) {
  const one = S.open.one;
  const save = async () => {
    if (S.redrawing) return;
    S.saveOpen = null;
    const body = { code: one.code };
    let any = false;
    for (const [id, key] of [['pr-name', 'name'], ['pr-role', 'role'], ['pr-task', 'task'], ['pr-craft', 'craft']]) {
      if (id in S.typed) { body[key] = $(id).value; any = true; }
    }
    clearTyped('pr-name', 'pr-role', 'pr-task', 'pr-craft');
    if (!any) return;
    await api('prompt.write', body);
    const again = await api('prompt.read', { code: one.code });
    if (again.ok) { S.open = { type: 'prompt', one: again.one }; render(); }
  };
  S.saveOpen = save;
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('span', { class: 'mark', text: one.code }),
      h('div', { class: 'name', text: one.name }),
      one.edited ? h('button', {
        class: 'btn-text red', text: '내장으로 되돌리기',
        onclick: async () => { S.typed = {}; await api('prompt.reset', { code: one.code }); openPrompt(one.code); },
      }) : null,
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      h('div', null, h('div', { class: 'lab', text: '이름' }), textbox('pr-name', '이름', one.name, { onblur: save })),
      h('div', null, h('div', { class: 'lab', text: '역할' }), textbox('pr-role', '역할', one.role, { onblur: save })),
      h('div', null, h('div', { class: 'lab', text: '이번에 할 일' }), area('pr-task', '이번에 할 일', one.task, { onblur: save })),
      h('div', null, h('div', { class: 'lab', text: '작법' }), area('pr-craft', '작법', one.craft, { class: 'body-edit', onblur: save }))));
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

// 겹창이 쓰는 입력 열쇠 — 닫을 때 이것만 지운다(작업실·설정에 치던 글은 그대로 둔다).
const LAYER_KEYS = ['d-title', 'd-body', 'd-req', 't-say', 'nd-name', 'pp-req',
  'n-name', 'n-form', 'n-outline', 'n-length', 'n-standard', 'n-request', 'n-mat',
  'pr-name', 'pr-role', 'pr-task', 'pr-craft',
  'ag-name', 'ag-role', 'ag-craft'];

function closeLayer() {
  // 닫기 전에 저장을 먼저 부른다 — Esc·×·바깥 클릭이 모두 같은 길을 지난다.
  // (창이 사라지며 나는 blur 에 기대면 창 바깥을 누른 때와 Esc 를 누른 때가 갈린다.)
  const save = S.saveOpen;
  if (save) { try { save(); } catch { /* 저장이 미끄러져도 창은 닫는다 */ } }
  S.open = null;
  S.editMsg = null;
  S.peek = null;
  clearTyped(...LAYER_KEYS);
  for (const k of Object.keys(S.typed)) if (k.startsWith('m-edit-')) delete S.typed[k];
  render();
}

function layerOne() {
  const t = S.open.type;
  const close = closeLayer;
  const panel = t === 'doc' ? docPanel(close)
    : t === 'thread' ? threadPanel(close)
      : t === 'newproject' ? newProjectPanel(close)
        : t === 'newdoc' ? newDocPanel(close)
            : t === 'prompt' ? promptPanel(close)
              : t === 'prepare' ? preparePanel(close)
                : agentPanel(close);
  return h('div', { class: 'layer', onclick: (e) => { if (e.target.classList.contains('layer')) close(); } }, panel);
}

// 참조 칩이 가리킬 수 있는 것 — 문서와 자료
function refIndex() {
  const m = new Map();
  for (const d of S.project.docs || []) m.set(d.id, { title: d.title, isFinal: d.isFinal, kind: d.kind });
  for (const x of S.project.materials || []) m.set(x.id, { title: x.name, mat: true });
  return m;
}

function docPanel(close) {
  const d = (S.project.docs || []).find((x) => x.id === S.open.id);
  if (!d) return h('div', { class: 'panel narrow' }, h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '없음' }), h('button', { class: 'x', text: '×', onclick: close })));
  const byId = refIndex();
  const peeking = S.peek && S.peek.docId === d.id ? d.versions.find((v) => v.i === S.peek.i) : null;
  const busy = (S.project.jobs || []).some((j) => j.status === 'running' && j.targetId === d.id);
  // 아직 한 번도 채워진 적 없는 문서에는 갱신할 것이 없다 — 그때는 «생성»이다.
  const verb = !String(d.body || '').trim() && !d.versions.length ? '생성' : '갱신';
  // 이 창이 닫힐 때 저장할 것
  const saveFields = async () => {
    if (S.redrawing) return;
    S.saveOpen = null;
    const body = { id: d.id };
    if ('d-title' in S.typed) body.title = $('d-title').value;
    if ('d-body' in S.typed) body.body = $('d-body').value;
    if ('d-req' in S.typed) body.request = $('d-req').value;
    clearTyped('d-title', 'd-body', 'd-req');
    if (Object.keys(body).length === 1) return;   // 손대지 않았으면 쓰지 않는다
    await api('doc.write', body);
  };

  S.saveOpen = saveFields;

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
      peeking ? h('textarea', { id: 'd-body', class: 'body-edit', value: peeking.body, readonly: 'readonly' })
        : area('d-body', BODY_HINT, d.body, { class: 'body-edit', onblur: saveFields }),
      h('div', null, h('div', { class: 'lab', text: '카테고리' }), h('div', { class: 'line' }, catPicker(d))),
      h('div', null, h('div', { class: 'lab', text: '요청사항' }), area('d-req', '요청사항', d.request, { onblur: saveFields })),
      d.kind === 'doc' ? null : refLine('대상', d.targetIds, byId, (ids) => api('doc.write', { id: d.id, targetIds: ids }), d.id),
      refLine('참조', d.refIds, byId, (ids) => api('doc.write', { id: d.id, refIds: ids }), d.id),
      refLine('에이전트', d.agentIds, crewIndex(), (ids) => api('doc.write', { id: d.id, agentIds: ids }), null, 'agent'),
      h('div', null, h('button', {
        class: 'btn', text: busy ? verb + ' 중' : verb, disabled: busy,
        onclick: async () => { await saveFields(); await api('doc.update', { id: d.id }); },
      })),
      d.versions.length ? h('details', { open: S.fold['hist:' + d.id] ? 'open' : null },
        h('summary', {
          text: '이력',
          onclick: () => { S.fold['hist:' + d.id] = !S.fold['hist:' + d.id]; },
        }),
        (peeking ? [h('div', { class: 'ver' },
          h('div', { class: 'when', text: '지금 판' }),
          h('button', { class: 'btn-text', text: '닫기', onclick: () => { S.peek = null; render(); } }))] : []),
        d.versions.slice().reverse().map((v) => h('div', { class: 'ver' + (peeking && peeking.i === v.i ? ' on' : '') },
          h('div', {
            class: 'when', text: when(v.at) + ' · ' + v.title, style: 'cursor:pointer',
            onclick: () => { S.peek = { docId: d.id, i: v.i }; render(); },
          }),
          h('button', { class: 'btn-text', text: '복원', onclick: () => { S.peek = null; api('doc.restoreVersion', { id: d.id, index: v.i }); } })))) : null));
}

function catPicker(d) {
  const cats = [{ id: INBOX, name: '새로 추가된 문서' }, ...S.project.categories.filter((c) => !c.virtual)];
  const cur = d.categoryId || INBOX;
  return cats.map((c) => {
    const pick = () => api('doc.write', { id: d.id, categoryId: c.id === INBOX ? null : c.id });
    return h('div', { class: 'line', style: 'gap:6px;cursor:pointer', onclick: pick },
      h('button', { class: 'ck' + (cur === c.id ? ' on' : '') }),
      h('span', { text: c.name }));
  });
}

// 작가가 지은 에이전트 — 이름으로 칩을 세운다.
function crewIndex() {
  const m = new Map();
  for (const a of S.project.crew || []) m.set(a.id, { title: a.name });
  return m;
}

// pool 이 'agent' 면 고르는 창이 문서가 아니라 사람을 펼친다.
function refLine(label, ids, byId, save, selfId, pool) {
  return h('div', null,
    h('div', { class: 'lab', text: label }),
    h('div', { class: 'line' },
      (ids || []).map((id) => {
        const t = byId.get(id);
        return h('span', { class: 'chip' + (t && t.isFinal ? ' final' : '') },
          t && t.mat ? h('span', { class: 'mark', text: '자료' }) : null,
          h('span', { text: t ? t.title : '없음' }),
          h('button', { text: '×', onclick: () => save((ids || []).filter((x) => x !== id)) }));
      }),
      h('button', { class: 'plus', style: 'width:26px;height:26px;font-size:16px', text: '+', onclick: () => { S.pick = { ids: (ids || []).slice(), save, selfId, label, pool }; render(); } })));
}

function threadPanel(close) {
  const t = (S.project.threads || []).find((x) => x.id === S.open.id);
  if (!t) return h('div', { class: 'panel narrow' }, h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '없음' }), h('button', { class: 'x', text: '×', onclick: close })));
  const byId = refIndex();
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
      h('button', { class: 'ck' + (s2.id === id ? ' on' : ''), onclick: (e) => { stop(e); api('thread.head', { id: t.id, messageId: s2.id }); } }),
      h('span', { text: (s2.text || '').slice(0, 14) || '빈 말' })))));
    }
    if (m.role === 'user') {
      flow.push(S.editMsg === m.id
        ? h('div', { class: 'send', style: 'align-self:stretch' },
          area('m-edit-' + m.id, '', m.text),
          h('button', { class: 'btn', text: '보내기', onclick: async () => { const v = $('m-edit-' + m.id).value; S.editMsg = null; clearTyped('m-edit-' + m.id); await api('thread.edit', { id: t.id, messageId: m.id, text: v }); } }))
        : h('div', { class: 'msg me', text: m.text, onclick: () => { S.editMsg = m.id; render(); } }));
    } else {
      flow.push(h('div', { class: 'msg ai', text: m.text }));
    }
  }
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      textbox('t-title-' + t.id, '이름', t.title, {
        onblur: () => {
          if (S.redrawing || !(('t-title-' + t.id) in S.typed)) return;
          const v = $('t-title-' + t.id).value;
          clearTyped('t-title-' + t.id);
          api('thread.title', { id: t.id, title: v });
        },
      }),
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
  const add = (name, text) => { if (String(text || '').trim()) { S.draft.push({ name: name || firstLine(text), text }); render(); } };
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
          h('button', { class: 'btn-line', text: '추가', onclick: () => { const t = $('n-mat').value; clearTyped('n-mat'); add('', t); } }),
          fileButton(add))),
      h('div', { style: 'padding-top:6px' }, h('button', {
        class: 'btn', text: '생성',
        onclick: async () => {
          const rest = $('n-mat') ? $('n-mat').value : '';
          const body = {
            name: $('n-name').value, standard: $('n-standard').value, request: $('n-request').value,
            spec: { outline: $('n-outline').value, form: $('n-form').value, length: $('n-length').value },
            materials: rest.trim() ? [...S.draft, { name: '', text: rest }] : S.draft.slice(),
          };
          // 한 글자도 치지 않았으면 만들지 않는다 — 창만 닫힌다.
          const empty = !body.name.trim() && !body.standard.trim() && !body.request.trim()
            && !body.spec.outline.trim() && !body.spec.form.trim() && !body.spec.length.trim()
            && !body.materials.length;
          if (empty) return close();
          const r = await api('project.create', body);
          if (r.ok) { S.pid = r.pid; S.draft = []; S.open = null; S.project = null; S.typed = {}; pull(true); }
          else { S.open = { type: 'newproject', err: r.error }; render(); }
        },
      }), S.open.err ? h('span', { class: 'notice', style: 'margin-left:10px', text: S.open.err }) : null)));
}

// «에이전트 준비 다시» — 이번 한 번만 실을 요청사항을 받는다(비워 두어도 된다. 저장하지 않는다).
function preparePanel(close) {
  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '에이전트 준비' }), h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      h('div', null, h('div', { class: 'lab', text: '요청사항' }), area('pp-req', '요청사항')),
      h('button', {
        class: 'btn', text: '시작',
        onclick: async () => {
          const req = $('pp-req') ? $('pp-req').value : '';
          clearTyped('pp-req');
          const r = await api('project.prepare', { request: req });
          if (r.ok) close();
          else { S.open = { type: 'prepare', err: r.error }; render(); }
        },
      }),
      S.open.err ? h('div', { class: 'notice', text: S.open.err }) : null));
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
            // 아무것도 치지 않았으면 아무것도 만들지 않는다 — 창만 닫힌다.
            const title = ($('nd-name') ? $('nd-name').value : '').trim();
            if (!title) return close();
            const r = await api('doc.create', { title });
            if (r.ok) { S.open = { type: 'doc', id: r.id }; render(); }
          },
        }),
        fileButton(async (name, text) => {
          const r = await api('doc.create', { title: name.replace(/\.[^.]+$/, ''), body: text });
          if (r.ok) { S.open = { type: 'doc', id: r.id }; render(); }
        }))));
}

// ---------------------------------------------------------------- 2겹 창

function pickLayer() {
  const p = S.project;
  const chosen = new Set(S.pick.ids);
  const flip = (id) => { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); S.pick.ids = [...chosen]; S.pick.save(S.pick.ids); render(); };
  const close = () => { S.pick = null; render(); };
  if (S.pick.pool === 'agent') {
    const crew = p.crew || [];
    return h('div', { class: 'layer two', onclick: (e) => { if (e.target.classList.contains('layer')) close(); } },
      h('div', { class: 'panel narrow' },
        h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '에이전트' }), h('button', { class: 'x', text: '×', onclick: close })),
        h('div', { class: 'panel-body' },
          crew.length ? crew.map((a) => h('div', { class: 'row', onclick: () => flip(a.id) },
            h('button', { class: 'ck' + (chosen.has(a.id) ? ' on' : '') }),
            h('div', { class: 'name', text: a.name }),
            h('div', { class: 'when', text: a.role })))
            : h('div', { class: 'lab', text: '없음' }))));
  }
  return h('div', { class: 'layer two', onclick: (e) => { if (e.target.classList.contains('layer')) close(); } },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'name', text: S.pick.label || '참조' }), h('button', { class: 'x', text: '×', onclick: close })),
      h('div', { class: 'panel-body' },
        (p.materials || []).length ? h('div', { class: 'sec' },
          h('div', { class: 'sec-head' },
            h('button', {
              class: 'ck' + ((p.materials || []).every((m) => chosen.has(m.id)) ? ' on' : ''),
              onclick: () => {
                const allOn = (p.materials || []).every((m) => chosen.has(m.id));
                (p.materials || []).forEach((m) => (allOn ? chosen.delete(m.id) : chosen.add(m.id)));
                S.pick.ids = [...chosen]; S.pick.save(S.pick.ids); render();
              },
            }),
            h('div', { class: 'name', text: '자료' })),
          (p.materials || []).map((m) => h('div', { class: 'row', onclick: () => flip(m.id) },
            h('button', { class: 'ck' + (chosen.has(m.id) ? ' on' : '') }),
            h('div', { class: 'name', text: m.name }),
            h('div', { class: 'when', text: String(m.chars) })))) : null,
        p.categories.map((c) => {
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
  if (S.pick) { S.pick = null; render(); } else if (S.confirm) { S.confirm = null; render(); } else if (S.open) closeLayer();
});

pull(true);
setInterval(() => pull(false), 1500);
