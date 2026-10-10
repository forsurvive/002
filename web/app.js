'use strict';

// 화면 밝기 — 기본은 어두운 화면(style.css :root). «밝게» 를 고른 브라우저만 기억해 둔다.
try { if (localStorage.getItem('se-theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch { /* 저장소를 못 쓰면 기본 */ }

// 화면 — 서버 상태를 받아 그대로 그린다. 조작은 모두 POST /api {op} 한 문으로 나간다.

const S = {
  pid: null, tab: '작업실', project: null, projects: [],
  open: null,      // 1겹 창
  pick: null,      // 2겹 참조/대상 선택
  confirm: null,   // 2겹 확인
  menu: false,
  sel: {},         // 구획 열쇠 → 체크된 id 집합
  fold: {},        // 접힌 구획
  editMsg: null,
  draft: [],       // 프로젝트 생성 창에서 모은 자료
  typed: {},       // 아직 저장되지 않은 입력값 — 다시 그려도 사라지지 않게 여기 둔다
  newCat: false,   // 카테고리 이름을 그 자리에서 받는 중
  peek: null,      // 지금 들여다보는 옛 판 { docId, i }
  pickOpen: null,  // 고르기 창에서 지금 펼쳐 본 것 { id, name, text }
  saveOpen: null,  // 지금 열린 창이 «닫기 전에 저장할 것»을 여기 걸어 둔다
  askOpen: null,   // 새로 만드는 창이 «닫기 전에 물어볼 것»을 여기 걸어 둔다
  focusNext: '',   // 다시 그린 뒤 이 칸에 커서를 둔다
  redrawing: false,// 다시 그리는 중 — 그때 떨어지는 포커스는 저장이 아니다
  tour: null,
  srcText: null,   // 지금 펼쳐 둔 작법서의 글 { id, text } — 갱신마다 오지 않으므로 열 때 한 번 받는다
  last: '',
  me: null,        // 온라인판에서 로그인한 사람 { loginId, displayName } — 개인판은 늘 null
};

const KIND_MARK = { check: '모순 검사', review: '합평회' };
// 그 종류의 문서를 짓는 자리 — 화면에 «자리» 칩으로 보이고, 사람을 걸어도 물러나지 않는다.
const KIND_SEAT = { doc: ['F-UPDATE'], check: ['F-CONTRA'], review: ['F-REVIEW', 'F-MERGE'] };
const INBOX = '__inbox__';
const BODY_HINT = '직접 입력하거나 아래의 요청사항을 작성해주세요..';
const STUDIO = 'Old Tower Studio';
const brandMark = (style) => h('div', { class: 'brand', style, text: STUDIO });
// 용도(docs/EBOOK_EDITION.md §8) — 이름은 서버가 준다(me.appName). 말 바꾸기(작품 → 책)는 고정 문구에만 쓴다(사용자가 쓴 글은 건드리지 않는다).
// «작품»과 «책»은 둘 다 받침이 있어 토씨가 그대로 맞는다. 개인판 · 소설판은 me.purpose 가 ebook 이 아니라 한 글자도 바뀌지 않는다.
const isBook = () => !!(S.me && S.me.purpose === 'ebook');
const appName = () => (S.me && S.me.appName) || '스토리 엔진';
const W = (s) => (isBook() ? String(s).replace(/작품/g, '책') : s);

// 처음 쓰는 사람을 위한 작업 순서 — 설정 탭에 접어 둔다.
const GUIDE = [
  ['① 프로젝트를 만든다', '첫 화면 오른쪽 위 [+]. 이름·형식과 자료만 있으면 됩니다(개요와 분량은 비워 두어도 됩니다). 만들고 나면 왼쪽 «자료 분석»이 돌며 글의 종류를 가리고(소설이 아니면 그 글에 맞는 에이전트를 짓고) 자료를 한 번 읽어 «자료 분석» 문서를 남깁니다. 넣은 자료는 작업실 «자료» 카테고리에 문서로 들어갑니다.'],
  ['② 문서를 짓는다', '작업실 [+] → 문서. 이름만 짓고 [생성]을 누르면 요청사항과 참조를 보고 씁니다. 본문을 직접 치셔도 됩니다. 한 호출이 십 분을 넘기기도 하니 작업 줄의 지난 시간을 보고 기다리십시오.'],
  ['③ 참조를 건다', '문서 창의 «참조»에 다른 문서를 겁니다(«자료» 카테고리의 자료도 문서라 똑같이 걸립니다). 확정본(빨간 토글)을 켜 두면 그 문서가 «최우선 사실»로 실려 다른 글을 다스립니다.'],
  ['④ 에이전트를 건다', '설정에서 이름·역할·프롬프트·쓸 모델로 사람을 짓고, 문서 창의 «에이전트»에 걸어 둡니다. 그 문서를 짓고 고칠 때 그 사람이 씁니다.'],
  ['⑤ 고쳐 간다', '본문이나 요청사항을 고치고 [갱신]. 옛 판은 «이력»에 남아 언제든 되돌립니다.'],
  ['⑥ 검사하고 듣는다', '[+] → 모순 검사로 앞뒤를 맞추고, 합평회로 평을 듣습니다. 둘 다 «대상»에 볼 문서를 겁니다. 모순 검사는 맞댈 것이 둘은 있어야 합니다(대상 둘, 또는 대상 하나에 참조 하나).'],
  ['⑦ 묻는다', '[+] → 논의 스레드. 여기는 문서를 짓는 자리가 아니라 말을 주고받는 자리입니다. 논의가 익으면 [문서로 정리]를 누릅니다.'],
  ['⑧ 꺼낸다', '문서 창의 [다운로드]. 구획을 통째로 고르면 한 파일로 받습니다.'],
];

const guideBlock = () => h('details', { open: S.fold['guide'] ? 'open' : null },
  h('summary', { text: '처음 쓰신다면', onclick: () => { S.fold['guide'] = !S.fold['guide']; } }),
  GUIDE.map(([name, txt]) => h('div', { class: 'guide-step' },
    h('div', { class: 'name', text: name }),
    h('div', { class: 'txt', text: txt }))));

// ---------------------------------------------------------------- 뼈대 도구

// 브라우저 자동 채움 막기 — 크롬은 autocomplete="off" 를 무시하고 저장된 로그인 아이디를 아무 칸에나 넣는다(2026-10-06 워크스페이스 칸에 아이디가 들어간 일).
// 읽기 전용 칸은 채우지 않으므로, 로그인용(username · current-password · new-password)이 아닌 칸은 누르기 전까지 읽기 전용으로 둔다.
const FILL_OK = ['username', 'current-password', 'new-password'];
function noAutofill(n, attrs) {
  const a = attrs || {};
  if (['hidden', 'checkbox', 'radio', 'file', 'range', 'color'].includes(a.type) || a.readonly || FILL_OK.includes(a.autocomplete)) return;
  n.setAttribute('autocomplete', 'off');
  n.readOnly = true; n.dataset.lock = '1';
  const open = () => { n.readOnly = false; delete n.dataset.lock; };
  n.addEventListener('pointerdown', open);
  n.addEventListener('focus', open);
}
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
  // 깊이를 가리지 않고 편다 — 한 줄이 여러 조각을 낳는 자리가 있다(고르기 창의 펼친 내용 따위).
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  if (tag === 'input') noAutofill(n, attrs);
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

// 풀리는 시각 — 그 날 안이면 시·분만, 넘으면 날짜까지.
function atTime(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  const two = (n) => String(n).padStart(2, '0');
  const today = d.toDateString() === new Date().toDateString();
  return (today ? '' : (d.getMonth() + 1) + '/' + d.getDate() + ' ') + two(d.getHours()) + ':' + two(d.getMinutes());
}

// 남은 양 — 숫자로만 이른다(진행 막대는 두지 않는다).
function limitSay(L) {
  if (!L) return '';
  const w = L.unifiedWindows || {};
  const pct = (x) => (x && typeof x.utilization === 'number' ? Math.round(x.utilization * 100) + '%' : '');
  const five = pct(w.five_hour);
  const week = pct(w.seven_day);
  return [five ? '5시간 ' + five : '', week ? '주간 ' + week : ''].filter((s) => s).join(' · ');
}

// 작업 한 줄이 말하는 것 — 그리기와 초침이 같은 글을 쓰도록 한 자리에 둔다.
function jobLine(j) {
  // 한도에 닿아 물음이 매달린 자리 — 무엇이 닫혔고 언제 풀리는지 이른다.
  if (j.ask) {
    if (j.ask.say) return j.ask.say;   // 온라인판 — 서버가 사람 말로 적어 보낸 까닭(«AI 연결이 필요합니다» 등)
    const what = j.ask.reason === 'quota-week' ? '주간 한도' : '구독 한도';
    const when = atTime(j.ask.resetsAt);
    return what + (when ? ' · ' + when + ' 에 풀림' : '');
  }
  if (j.status === 'running') return (j.step || '진행 중') + ' · ' + since(j.stepAt || j.startedAt);
  if (j.status === 'paused') return '멈춤' + (j.step ? ' · ' + j.step : '');
  if (j.status === 'done') return '완료';
  if (j.status === 'stopped') return '중지됨';
  return j.error ? '실패 — ' + j.error.slice(0, 80) : '실패';
}

// 그 칸들 가운데 한 글자라도 쳐 둔 것이 있는가
const typedAny = (...ids) => ids.some((id) => String(S.typed[id] || '').trim());

const firstLine = (text) => (String(text || '').split('\n').map((l) => l.trim()).find((l) => l) || '붙여 넣은 글').slice(0, 24);

async function api(op, body = {}) {
  // 튜토리얼이 도는 동안에는 서버로 한 걸음도 나가지 않는다 — 문 서른 남짓이 모두 이 한 곳을 지난다.
  if (S.tour) return S.tour.api(op, body);
  const r = await fetch('/api', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op, pid: S.pid, ...body }),
  });
  const out = await r.json().catch(() => ({ ok: false, error: '응답 없음' }));
  if (out.code === 'login') return toLogin(out);
  if (out.code === 'gate') return regate(out);
  await pull(true);
  return out;
}

// 온라인판에서 세션이 끝났으면 로그인 화면으로 — 개인판은 이 답을 내지 않는다
function toLogin(out) { location.href = '/login'; return out; }
// 출입 열쇠가 풀렸으면 페이지를 다시 연다 — 그때 브라우저가 열쇠를 묻는다(단추마다 창이 뜨지 않게)
function regate(out) { location.reload(); return out; }

// 만든 기록(온라인) — 이 글을 지은 부르기마다 «무엇을 보고(그때의 판)» · 등급 · 이번 요청. 비용 · 모델 id 는 없다.
async function toggleRuns(docId) {
  if (S.open.runs) { S.open.runs = null; return render(); }
  const r = await fetch('/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'run.list', pid: S.pid, docId }) })
    .then((x) => x.json()).catch(() => ({ ok: false, error: '응답 없음' }));
  if (!r.ok) { S.open.err = r.error; return render(); }
  S.open.runs = r.runs; render();
}
const RUN_ST = { succeeded: '완료', failed: '실패', cancelled: '취소', running: '도는 중' };
function runsBox() {
  const runs = S.open && S.open.runs;
  if (!runs) return null;
  return h('div', { class: 'card-box' },
    h('div', { class: 'lab', text: '만든 기록(최근 20)' }),
    runs.length ? runs.map((r) => h('div', { style: 'padding:6px 0;border-bottom:1px solid var(--line-soft)' },
      h('div', { class: 'line' },
        h('div', { class: 'name', style: 'flex:1', text: when(r.at) + (r.resultSeq ? ' → ' + r.resultSeq + '판' : '') }),
        r.tier ? h('span', { class: 'mark', text: r.tier }) : null,
        h('span', { class: 'when', text: (RUN_ST[r.status] || r.status) + (r.truncated ? ' · 잘렸을 수 있음' : '') })),
      r.inputs.length ? h('div', { class: 'when', style: 'white-space:normal', text: '본 것: ' + r.inputs.map((i) => i.role + ' «' + i.title + '»' + (i.seq ? ' ' + i.seq + '판' : '')).join(' · ') }) : null,
      r.once ? h('div', { class: 'when', style: 'white-space:normal', text: '이번 요청: ' + r.once }) : null))
      : h('div', { class: 'when', text: '아직 AI 로 만든 기록이 없습니다' }));
}

// 작품 파일(.story-project.json · 개인판 project.json) → 새 작품. 온라인판은 큰 파일을 받는 문(/api/import)으로.
function importProjectFile() {
  if (S.tour) return;
  const pick = h('input', { type: 'file', accept: '.json,application/json' });
  pick.onchange = async () => {
    const f = pick.files && pick.files[0];
    if (!f) return;
    let bundle;
    try { bundle = JSON.parse(await f.text()); } catch { S.homeSay = W('작품 파일이 아닙니다'); return render(); }
    S.homeSay = '가져오는 중…'; render();
    const r = await fetch(S.me ? '/api/import' : '/api', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'project.import', bundle }),
    });
    const out = await r.json().catch(() => ({ ok: false, error: r.status === 413 ? '파일이 너무 큽니다' : '응답 없음' }));
    if (out.code === 'login') return toLogin(out);
    S.homeSay = out.ok ? '' : out.error;
    if (out.ok) { S.pid = out.pid; S.tab = '작업실'; S.project = null; }
    pull(true);
  };
  pick.click();
}

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => null);
  location.href = '/login';
}

function download(kind, id, fmt = 'md') {
  if (S.tour) return;   // 가짜 pid 로 내려받으러 가지 않는다
  const a = h('a', { href: '/api/download?pid=' + encodeURIComponent(S.pid) + '&kind=' + kind + '&id=' + encodeURIComponent(id) + '&fmt=' + fmt, download: '' });
  document.body.appendChild(a); a.click(); a.remove();
}
// [다운로드] — 누르면 그 자리에 «MD · 텍스트» 둘이 선다(2026-10-07 사용자 지시). go(fmt) 가 실제로 받는다.
function dlButton(key, go, cls = 'btn-text') {
  if (S.dlPick !== key) return h('button', { class: cls, text: '다운로드', onclick: () => { S.dlPick = key; render(); } });
  const pick = (fmt) => { S.dlPick = null; render(); go(fmt); };
  return h('span', { class: 'line', style: 'gap:6px;display:inline-flex' },
    h('button', { class: cls, text: 'MD', title: '마크다운 파일(.md)', onclick: () => pick('md') }),
    h('button', { class: cls, text: '텍스트', title: '일반 텍스트 파일(.txt) — 마크다운 기호를 걷는다', onclick: () => pick('txt') }),
    h('button', { class: 'btn-text', text: '취소', onclick: () => { S.dlPick = null; render(); } }));
}
// 마크다운을 꼴대로 보이는 칸(web/markdown.js). 그 파일이 없으면 글 그대로.
function mdView(id, text, onclick) {
  const body = window.SEMarkdown ? window.SEMarkdown.render(text) : h('div', { style: 'white-space:pre-wrap', text });
  return h('div', { id, class: 'md-view', ...(onclick ? { onclick } : {}) }, body);
}

// ---------------------------------------------------------------- 상태 받아오기

async function pull(force) {
  if (S.tour) return;   // 1.5초마다 도는 갱신도 멈춘다(가짜 pid 를 물으면 튜토리얼이 튕긴다)
  const url = S.pid ? '/api/state?pid=' + encodeURIComponent(S.pid) : '/api/state';
  let d;
  let status = 0;
  try { const r = await fetch(url); status = r.status; d = await r.json(); } catch {
    // 한 번도 그리지 못했는데 상태를 못 받으면 빈 화면 대신 까닭을 보인다(서버가 내려갔거나 · 문지기에 막혔거나)
    if (!S.drawn) bootSay('서버의 답을 읽지 못했습니다' + (status ? ' (' + status + ')' : '') + ' — 잠시 뒤 새로 고침해 주세요');
    return;
  }
  if (d.code === 'login') return toLogin(d);
  if (d.code === 'gate') return regate(d);
  S.me = d.me || null;   // 온라인판에서만 온다(로그인한 사람)
  if (S.me && S.me.appName && document.title !== S.me.appName) document.title = S.me.appName;   // 탭 제목(전자책 오토)
  if (d.projects) S.projects = d.projects;
  if (S.pid && d.ok === false) { S.pid = null; S.project = null; }
  else if (d.project) S.project = d.project;
  EV.lastPull = Date.now();
  events();   // 보는 작품이 바뀌었으면 알림도 그 작품으로 다시 붙는다
  const sig = JSON.stringify([S.pid, S.projects, S.project]);
  if (!force && sig === S.last) return;
  S.last = sig;
  render();
}

// ---------------------------------------------------------------- 그리기

// 첫 그리기 전의 알림 — 화면이 비어 있는 채로 멈추지 않게(무엇이 막혔는지 사람이 볼 수 있게)
function bootSay(text) {
  const n = document.getElementById('root');
  if (n) n.replaceChildren(h('div', { class: 'body' }, h('div', { class: 'notice', text })));
}
window.addEventListener('error', (e) => { if (!S.drawn) bootSay('화면을 그리지 못했습니다 — ' + String((e && e.message) || e).slice(0, 160)); });

// 다시 그려도 보던 자리와 치던 자리를 지킨다 — 1.5초마다 도는 갱신이 화면을 흔들지 않도록.
const SCROLLERS = ['.main', '#layer1 .panel-body', '#layer2 .panel-body', '#d-body', '#d-out', '#d-view'];

// 읽기만 하는 작품(강사 · 열람이 허락된 기관 관리자) — 고치는 손잡이를 모두 걷고 칸은 읽기 전용으로.
// 막는 것은 서버다(쓰기 문은 403) — 이것은 누를 수 없는 단추를 보이지 않게 하는 안내일 뿐이다.
const RO_HIDE = /^(\+|삭제|생성|갱신|추가|저장|만들기|복원|비우기|영구 삭제|승인|승인하고 다음 단계로|건너뛰기|건너뛰기 취소|다시 생성\(새 판\)|문서에서 고치기|고치기|되돌리기|파일 선택|일시중지|이어 하기|자료 분석 다시|에이전트 준비 다시|프로젝트 삭제|작품 파일 가져오기|책 파일 가져오기|이 판으로 되돌리기|자료 분석)$/;
function lockReadOnly() {
  for (const root of [$('root'), $('layer1'), $('layer2')]) {
    if (!root) continue;
    root.querySelectorAll('textarea, input').forEach((n) => { if (n.type !== 'checkbox' && n.type !== 'file') n.readOnly = true; });
    root.querySelectorAll('button').forEach((b) => {
      const t = (b.textContent || '').trim();
      if (b.classList.contains('plus') || b.classList.contains('tg') || b.classList.contains('ck') || RO_HIDE.test(t)) b.style.display = 'none';
    });
  }
}

function render() {
  const focus = document.activeElement;
  const keep = focus && focus.id ? { id: focus.id, value: focus.value, s: focus.selectionStart, e: focus.selectionEnd } : null;
  const tops = SCROLLERS.map((sel) => { const n = document.querySelector(sel); return n ? n.scrollTop : 0; });

  // 같은 창이 그대로 있으면 열리는 시늉(흐려졌다 또렷해지는 그 짧은 결)을 다시 하지 않는다.
  // 다시 그릴 때마다 되풀이되면 창이 번쩍이는 것처럼 보인다.
  const k1 = S.open ? S.open.type + ':' + (S.open.id || '') : '';
  const k2 = S.pick ? 'pick:' + (S.pick.label || '') : S.confirm ? 'confirm' : '';
  const same1 = !!k1 && k1 === S.mounted1;
  const same2 = !!k2 && k2 === S.mounted2;

  S.saveOpen = null;
  S.askOpen = null;
  S.redrawing = true;
  S.drawn = true;
  $('root').replaceChildren(S.pid && S.project ? app() : projectList());
  $('layer1').replaceChildren(...(S.open ? [layerOne()] : []));
  $('layer2').replaceChildren(...(S.pick ? [pickLayer()] : S.confirm ? [confirmLayer()] : []));
  $('layer3').replaceChildren(...(S.tour ? [tourLayer()] : []));
  S.redrawing = false;
  if (S.pid && S.project && S.project.readOnly) lockReadOnly();
  if (same1 && $('layer1').firstChild) $('layer1').firstChild.classList.add('still');
  if (same2 && $('layer2').firstChild) $('layer2').firstChild.classList.add('still');
  S.mounted1 = k1;
  S.mounted2 = k2;

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
  // 눈길 모으는 테는 스크롤을 되돌린 뒤에 잡는다 — 그 앞에서 잡으면 되돌리기가 지워 버린다.
  if (S.tour) tourFocus();
  if (S.focusNext) {
    const n = $(S.focusNext);
    S.focusNext = '';
    if (n && n.focus) n.focus();
  }
}

// ---------------------------------------------------------------- 프로젝트 목록

const isLight = () => document.documentElement.dataset.theme === 'light';
function toggleTheme() {
  const light = !isLight();
  if (light) document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('se-theme', light ? 'light' : 'dark'); } catch { /* 이번 창에서만 */ }
  render();
}

// 온라인판 — 지금 들어와 있는 아이디와 신분(여럿이면 모두). 개인판에는 계정이 없으므로 서지 않는다.
const ROLE_NAME = { platform_admin: '최상위 관리자', organization_admin: '기관 관리자', instructor: '강사', student: '학생' };
function whoLine() {
  if (!S.me || !S.me.loginId) return null;
  const roles = (S.me.roles || []).map((r) => ROLE_NAME[r]).filter(Boolean);
  return h('div', { class: 'who' },
    h('span', { class: 'who-id', text: S.me.loginId }),
    h('span', { text: roles.length ? roles.join(' · ') : '개인' }));
}

function newProjectOpen() {
  // 온라인판 — 열린 수업이 있으면 그 수업을 먼저 골라 둔다(학생 대부분은 과제를 만든다)
  const places = (S.me && S.me.places) || [];
  S.draft = []; S.open = { type: 'newproject', place: places.length ? places[0].classId : '' }; render();
}

function projectList() {
  return h('div', { class: 'body' },
    h('div', { class: 'top home-top', style: 'position:static;padding:0 0 22px;border:none;background:none' },
      h('div', null,
        brandMark('margin-bottom:6px'),
        h('div', { class: 'top-name', style: 'font-size:30px', text: appName() }),
        whoLine()),
      h('div', { class: 'line home-acts' },
        // 온라인판 — 관리는 운영자 · 기관 관리자에게만, 내 수업은 수업에 든 사람에게만, 내 계정은 누구나(막는 것은 서버다).
        // 쪽으로 가는 문(알약)과 로그아웃 · 밝기(옅은 글자)를 띄워 갈라 보인다.
        S.me ? h('div', { class: 'nav' },
          S.me.manage ? h('button', { class: 'nav-btn', text: '관리', onclick: () => { location.href = '/manage.html'; } }) : null,
          S.me.classes > 0 ? h('button', { class: 'nav-btn', text: '내 수업', onclick: () => { location.href = '/school.html'; } }) : null,
          h('button', { class: 'nav-btn', text: '내 계정', onclick: () => { location.href = '/account.html'; } }),
          h('span', { class: 'nav-sep' }),
          h('button', { class: 'nav-out', text: '로그아웃', onclick: logout })) : null,
        h('button', { class: 'nav-out', text: isLight() ? '어둡게' : '밝게', onclick: toggleTheme }),
        // 다른 PC · 개인판에서 내려받은 작품 파일 열기 — «+»(새 작품)와 헷갈리지 않게 위쪽 단추 줄에
        h('button', { class: 'btn-line', text: W('작품 파일 가져오기'), onclick: importProjectFile }),
        h('button', { class: 'btn-line', text: '튜토리얼 보기', onclick: () => startTour() }))),
    // 새 작품 «+» — 화면 한가운데(좁은 창에서도 잘리지 않게 줄을 따로 둔다)
    h('div', { class: 'new-row' }, h('button', { class: 'plus big', text: '+', title: W('새 작품'), onclick: newProjectOpen })),
    S.homeSay ? h('div', { class: 'new-row' }, h('div', { class: 'notice', text: S.homeSay })) : null,
    // 자유 가입판 — 이용권이 없으면 새 AI 작업이 서지 않는다는 것만 한 줄로(편집 · 열람 · 내보내기는 된다)
    S.me && S.me.edition === 'open' && S.me.pass === false ? h('div', { class: 'new-row' },
      h('a', { class: 'notice', href: '/account.html', text: '이용권이 없어 새 AI 작업은 멈춰 있습니다 — 내 계정 → 이용권' })) : null,
    h('div', { class: 'cards' }, S.projects.map((p) => h('div', {
      class: 'card', onclick: () => { S.pid = p.id; S.tab = '작업실'; S.project = null; pull(true); },
    },
    h('div', { class: 'name', text: p.name }),
    p.place ? h('span', { class: 'mark', text: p.place }) : null,
    h('div', { class: 'when', text: when(p.updatedAt || p.createdAt) })))),
    brandMark('text-align:center;padding:56px 0 8px'));
}

// ---------------------------------------------------------------- 프로젝트 안

function goHome() { S.pid = null; S.project = null; S.tab = '작업실'; pull(true); }

function app() {
  const p = S.project;
  return h('div', { class: 'shell' },
    h('div', { class: 'side' },
      h('div', { class: 'side-top' },
        h('button', { class: 'side-title', text: appName(), onclick: goHome }),
        brandMark()),
      // 단계 탭은 단계 흐름이 실려 올 때만(서버가 템플릿을 갖고 있을 때) 선다
      ['작업실', ...(p.workflow ? ['단계'] : []), '설정'].map((t) => h('button', {
        class: 'tab' + (S.tab === t ? ' on' : ''), text: t, onclick: () => { S.tab = t; render(); },
      })),
      h('div', { class: 'side-jobs' }, (p.jobs || []).map(jobRow)),
      h('div', { class: 'side-foot' }, h('button', {
        class: 'tab' + (S.tab === '휴지통' ? ' on' : ''), text: '휴지통', onclick: () => { S.tab = '휴지통'; render(); },
      }))),
    h('div', { class: 'main' },
      h('div', { class: 'top' },
        h('div', { class: 'line' },
          h('button', { class: 'back', text: '‹', title: W('작품 목록'), onclick: goHome }),
          h('button', { class: 'top-name', text: p.name, onclick: goHome }),
          // 온라인판 — 강사 · 기관 관리자의 열람. 고치는 문은 서버가 막는다(이 표시는 알림일 뿐이다)
          p.readOnly ? h('span', { class: 'mark', text: '읽기만' }) : null),
        whoLine()),
      h('div', { class: 'body' }, S.tab === '작업실' ? workshop() : S.tab === '단계' && p.workflow ? stagesView() : S.tab === '설정' ? settings() : trash()),
      lectureCard()));
}

// 그 작업이 도는 자리 — 목록에 없으면 null(그 줄은 눌리지 않는다).
// kind 로 가지치지 않는다: 옛 레코드도, 휴지통으로 간 대상도 저절로 물러난다.
function jobTarget(j) {
  const id = j.targetId || (j.docIds || [])[0] || '';
  if (!id || !S.project) return null;
  if ((S.project.threads || []).some((t) => t.id === id)) return { type: 'thread', id };
  if ((S.project.docs || []).some((d) => d.id === id)) return { type: 'doc', id };
  return null;
}

// 열려 있던 창은 제 길로 닫는다 — 치던 글 저장과 되묻기를 건너뛰지 않게.
function openJob(go) {
  if (S.open) { closeLayer(); if (S.confirm) return; }
  S.open = { type: go.type, id: go.id };
  render();
}

function jobRow(j) {
  const go = jobTarget(j);
  return h('div', { class: 'job' + (go ? ' hit' : ''), onclick: go ? () => openJob(go) : null },
    h('div', { class: 'job-name', text: j.title }),
    h('div', { class: 'job-step' + (j.status === 'failed' ? ' fail' : ''), id: 'jstep-' + j.id, text: jobLine(j) }),
    h('div', { class: 'job-acts' },
      // 한도에 닿았으면 «무엇으로 이어갈까»를 고른다. 그만둘 길은 삭제가 이미 맡고 있다.
      // API 키가 없으면 그 갈래를 세우지 않는다 — 고를 수 없는 것을 보여 주지 않는다(키는 설정에서 넣는다).
      j.ask
        ? [
          h('button', { text: '기다렸다 잇기', onclick: (e) => { stop(e); api('job.answer', { id: j.id, choice: 'wait' }); } }),
          // 굳은 값이 아니라 «지금» 키가 있는가를 본다 — 한도에 닿은 뒤 설정에서 키를 넣을 수 있다.
          S.project && S.project.auth && S.project.auth.hasKey
            ? h('button', { text: 'API로', onclick: (e) => { stop(e); api('job.answer', { id: j.id, choice: 'api' }); } })
            : null,
        ]
        // 중지는 두지 않는다 — 삭제가 멈추고 치운다(사용자 지시).
        : j.status === 'running' || j.status === 'paused'
          ? h('button', {
            text: j.status === 'paused' ? '이어 하기' : '일시중지',
            onclick: (e) => { stop(e); api(j.status === 'paused' ? 'job.resume' : 'job.pause', { id: j.id }); },
          })
          : null,
      h('button', { text: '삭제', onclick: (e) => { stop(e); api('job.remove', { id: j.id }); } })));
}

// 초마다 작업 줄의 «지난 시간»만 고쳐 쓴다 — 화면을 통째로 다시 그리지 않는다.
setInterval(() => {
  if (!S.project) return;
  for (const j of S.project.jobs || []) {
    if (j.status !== 'running') continue;   // 멈춰 있으면 시간이 흐르지 않는다
    const n = $('jstep-' + j.id);
    if (n) n.textContent = jobLine(j);
  }
}, 1000);

// ---------------------------------------------------------------- 단계형 작업 흐름(docs/WORKFLOW.md)
//
// 자유 문서 작업 «위에» 얹은 진행표다. 단계의 결과는 보통 문서이고, 문서 창 · 이력 · 참조 · 확정본이 그대로 된다.
// 강제 순서가 아니다 — 앞 단계가 승인 전이면 알리기만 한다. 승인 ≠ 확정본(확정본은 승인할 때 고른 경우에만).

const STAGE_MARK = { not_started: '○', draft: '◐', approved: '●', skipped: '⤼' };
const STAGE_SAY = { not_started: '시작 전', draft: '초안 — 검토하세요', approved: '승인됨', skipped: '건너뜀' };

// 이 단계(회차)의 결과 문서를 지금 짓고 있는 작업
const stageJob = (docId) => (S.project.jobs || []).find((j) => j.kind === 'stage' && j.targetId === docId && (j.status === 'running' || j.status === 'paused'));

function openStage(key, episode) {
  const st = S.project.workflow.stages.find((x) => x.key === key);
  const ep = episode ? (st.episodes || []).find((e) => e.episode === episode) : null;
  const doc = (S.project.docs || []).find((d) => d.id === ((ep || st).docId));
  // 참조는 문서에 이미 걸린 것이 있으면 그것을, 없으면 앞 단계에서 추천한 것을 체크된 채로 보인다(사람이 확인한다)
  const refIds = doc && (doc.refIds || []).length ? doc.refIds.slice() : ((ep || st).refs || []).slice();
  S.open = { type: 'stage', key, episode: episode || 0, refIds, final: false };
  clearTyped('st-once', 'st-ep');
  render();
}

// 한 줄의 말 — 짓는 중이면 «생성 중», 문서가 비어 있으면 «비어 있음»(초안이라고 하지 않는다)
function stageSay(st) {
  if (st.output === 'input') return st.status === 'approved' ? '완료' : '규격 · 자료가 필요합니다';
  if (st.docId && stageJob(st.docId)) return '생성 중';
  const d = st.docId ? (S.project.docs || []).find((x) => x.id === st.docId) : null;
  if (st.status === 'draft' && d && !String(d.body || '').trim()) return '비어 있음 — 생성하세요';
  return STAGE_SAY[st.status] || '';
}

function stagesView() {
  const w = S.project.workflow;
  const ew = w.episodeWord || '화';   // 회차의 말(전자책 — 장)
  const row = (st) => h('div', { class: 'row' + (st.off ? '' : ''), onclick: () => openStage(st.key) },
    h('span', { class: 'mark', text: STAGE_MARK[st.status] || '○' }),
    h('div', { class: 'name', text: st.n + '  ' + st.title + (st.off ? ' (꺼짐)' : '') }),
    st.upstreamChanged ? h('span', { class: 'mark', text: '⚠ 앞 단계가 바뀜' }) : null,
    (st.episodes || []).length ? h('span', { class: 'mark', text: st.episodes.length + ew }) : null,
    h('div', { class: 'when', text: stageSay(st) }));
  // 지금 할 단계 · 다음 단계 — 승인 · 건너뜀이 아닌 첫 단계(꺼진 단계는 건너 센다). 강제가 아니라 길잡이다.
  const live = w.stages.filter((x) => !x.off);
  const at = live.findIndex((x) => x.status !== 'approved' && x.status !== 'skipped');
  const now = at >= 0 ? live[at] : null;
  const next = at >= 0 ? live[at + 1] : null;
  const banner = h('div', { class: 'card-box', style: 'margin-bottom:12px' },
    now ? [
      h('div', { class: 'line' },
        h('div', { class: 'name', style: 'flex:1;font-weight:700', text: '지금: ' + now.n + '  ' + now.title }),
        h('div', { class: 'when', text: stageSay(now) }),
        h('button', { class: 'btn-line', text: '열기', onclick: () => openStage(now.key) })),
      next ? h('div', { class: 'when', text: '다음: ' + next.n + '  ' + next.title }) : null,
    ] : h('div', { class: 'name', text: '모든 단계를 승인했습니다' }));
  return h('div', null,
    banner,
    h('div', { class: 'sec' },
      h('div', { class: 'sec-head' },
        h('div', { class: 'name', text: w.title || '단계' }),
        // 끌 수 있는 단계(본문)가 있는 템플릿만 — 전자책 단계에는 없다
        w.stages.some((x) => x.optional) ? [
          h('div', { class: 'when', text: '본문 단계' }),
          h('button', { class: 'tg' + (w.bodyOn ? ' on' : ''), onmousedown: () => api('project.spec', { bodyStage: !w.bodyOn }) })] : null),
      w.stages.map(row)),
    h('div', { class: 'when', text: '○ 시작 전 · ◐ 초안 · ● 승인 · ⤼ 건너뜀 — 순서는 강제가 아닙니다. 승인은 «이 단계의 산출물로 인정», 확정본은 «참조에서 최우선 사실»로 서로 다릅니다.' }));
}

function stagePanel(close) {
  const w = S.project.workflow;
  const st = w.stages.find((x) => x.key === S.open.key);
  if (!st) return h('div', { class: 'panel narrow' }, h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '없는 단계' }), h('button', { class: 'x', text: '×', onclick: close })));
  const per = st.output === 'perEpisode';
  const ew = w.episodeWord || '화';   // 회차의 말(전자책 — 장)
  const ep = per ? (S.open.episode || Number(typedVal('st-ep', '')) || 0) : 0;
  const cur = per && ep ? (st.episodes || []).find((e) => e.episode === ep) : (per ? null : st);
  const status = cur ? cur.status : 'not_started';
  const docId = cur ? cur.docId : '';
  const doc = (S.project.docs || []).find((d) => d.id === docId);
  const job = docId ? stageJob(docId) : null;
  const byId = refIndex();
  const readOnly = !!S.project.readOnly;
  const go = async () => {
    const episode = per ? (S.open.episode || Number(($('st-ep') || {}).value) || 0) : 0;
    const r = await api('stage.start', { key: st.key, episode, refIds: S.open.refIds, requestOnce: ($('st-once') || {}).value || '', keepRequest: !!S.open.keepReq });
    if (!r.ok) { S.open.err = r.error; render(); return; }
    S.open.err = ''; S.open.episode = episode; S.open.keepReq = false; clearTyped('st-once');
    render();
  };
  const approve = async () => {
    const r = await api('stage.approve', { key: st.key, episode: ep, final: !!S.open.final });
    S.open.err = r.ok ? '' : r.error; render();
  };
  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' },
      h('div', { class: 'name', text: st.n + '  ' + st.title + (per && ep ? ' — ' + ep + ew : '') }),
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      st.task ? h('div', null, h('div', { class: 'lab', text: '이 단계에서 하는 일' }), h('div', { text: st.task.replace(/\{n\}/g, ep ? String(ep) : 'N') })) : null,
      // 강의 카드(켜져 있을 때만) — 시작하기 전에 통째로 읽는다. 생성이 도는 동안에는 떠 있는 카드가 다시 짚는다.
      st.card ? h('div', { class: 'card-box' },
        h('div', { class: 'lab', text: '강의 카드' }),
        h('div', { text: st.card.what }),
        (st.card.look || []).length ? [h('div', { class: 'lab', text: '결과를 읽을 때 볼 점' }), st.card.look.map((x) => h('div', { text: '· ' + x }))] : null,
        st.card.ask ? [h('div', { class: 'lab', text: '생각해 볼 질문' }), h('div', { text: st.card.ask })] : null) : null,
      st.prevPending && status === 'not_started' ? h('div', { class: 'notice', text: '앞 단계가 아직 승인 전입니다 — 그래도 시작할 수 있습니다' }) : null,
      cur && cur.upstreamChanged ? h('div', { class: 'notice', text: '⚠ 승인한 뒤 앞 단계 문서가 바뀌었습니다 — 다시 보거나 다시 생성해 보세요(자동으로 바뀌지 않습니다)' }) : null,
      per && !S.open.episode ? h('div', null, h('div', { class: 'lab', text: '몇 ' + ew }), textbox('st-ep', '예: 1')) : null,
      per && (st.episodes || []).length ? h('div', { class: 'line' }, st.episodes.map((e) => h('button', {
        class: 'chip', text: e.episode + ew + ' ' + (STAGE_MARK[e.status] || ''), onclick: () => openStage(st.key, e.episode),
      }))) : null,
      st.output === 'input' ? h('div', { class: 'when', text: W('작품을 만들 때 넣은 규격과 자료입니다 — 설정 탭에서 고칩니다.') }) : null,
      st.output === 'final' ? h('div', { class: 'when', text: '다 쓴 원고를 모순 검사 · 합평으로 점검하고 내려받습니다. 점검을 마쳤으면 승인하세요.' }) : null,
      st.output !== 'input' && st.output !== 'final' ? [
        refLine('참조(앞 단계에서 추천 — 빼거나 더할 수 있습니다)', S.open.refIds, byId, (ids) => { S.open.refIds = ids; render(); }, docId),
        h('div', null, h('div', { class: 'lab', text: '이번 요청사항(이번 한 번만 — 저장되지 않습니다)' }), area('st-once', '이번 생성에만 덧붙일 말')),
        readOnly ? null : h('div', { class: 'line', style: 'gap:6px;cursor:pointer', onmousedown: () => { S.open.keepReq = !S.open.keepReq; render(); } },
          h('button', { class: 'ck' + (S.open.keepReq ? ' on' : '') }), h('span', { text: '이 요청을 문서의 요청사항으로도 남기기(다음 생성에도 계속)' })),
        // 문서의 요청사항(지속) — 일회성과 갈라 보인다. 고치는 곳은 문서 창이다.
        doc ? h('div', null, h('div', { class: 'lab', text: '이 문서의 요청사항(계속 적용 — 문서에 남습니다)' }),
          h('div', { class: 'line' }, h('div', { class: 'when', style: 'flex:1;white-space:pre-wrap', text: String(doc.request || '').trim() || '없음' }),
            readOnly ? null : h('button', { class: 'btn-text', text: '문서에서 고치기', onclick: () => { S.open = { type: 'doc', id: doc.id }; render(); } }))) : null,
      ] : null,
      status === 'approved' && cur && cur.approvedAt ? h('div', { class: 'when', text: '승인됨 · ' + new Date(cur.approvedAt).toLocaleString() + (cur.approvedBy ? ' · ' + cur.approvedBy : '') }) : null,
      S.open.err ? h('div', { class: 'notice', text: S.open.err }) : null,
      job ? h('div', { class: 'when', text: '생성 중 — ' + jobLine(job) }) : null,
      readOnly ? null : h('div', { class: 'line' },
        st.output !== 'input' && st.output !== 'final' && !job
          ? h('button', { class: 'btn', text: doc && String(doc.body || '').trim() ? '다시 생성(새 판)' : '생성', onclick: go }) : null,
        doc ? h('button', { class: 'btn-line', text: '문서 열기', onclick: () => { S.open = { type: 'doc', id: doc.id }; render(); } }) : null,
        st.output !== 'input' && st.output !== 'perEpisode' && status !== 'approved'
          ? h('button', { class: 'btn-text', text: status === 'skipped' ? '건너뛰기 취소' : '건너뛰기', onclick: () => api('stage.skip', { key: st.key, on: status !== 'skipped' }) }) : null),
      // 승인 — 확정본 켜기는 고를 때만(기본 꺼짐)
      !readOnly && (status === 'draft' || (st.output === 'final' && status !== 'approved')) && !job ? h('div', { class: 'line' },
        h('button', { class: 'btn-red', text: '승인하고 다음 단계로', onclick: approve }),
        doc ? h('div', { class: 'line', style: 'gap:6px;cursor:pointer', onmousedown: () => { S.open.final = !S.open.final; render(); } },
          h('button', { class: 'ck' + (S.open.final ? ' on' : '') }), h('span', { text: '이 문서를 확정본으로도 켜기' })) : null) : null,
      !readOnly && status === 'approved' ? h('button', { class: 'btn-text', text: '승인 풀기(다시 고치기)', onclick: () => api('stage.reopen', { key: st.key, episode: ep }) }) : null));
}

// 작업 중 강의 카드 — 단계 생성이 도는 동안 «무엇인가 · 볼 점 · 질문»을, 끝나면 «볼 점» 체크리스트를 보인다.
// 켜져 있을 때만(기관 설정 · 개인 설정 — 서버가 card 를 실어 보낼 때만). 점수가 아니고 저장하지 않는다.
function lectureCard() {
  const w = S.project && S.project.workflow;
  if (!w || !w.cards) return null;
  S.cardSeen = S.cardSeen || {};
  const jobs = (S.project.jobs || []).filter((j) => j.kind === 'stage' && j.params && !S.cardSeen[j.id]);
  const j = jobs.find((x) => x.status === 'running' || x.status === 'paused') || jobs.filter((x) => x.status === 'done').pop();
  if (!j) return null;
  const st = w.stages.find((x) => x.key === j.params.stageKey);
  if (!st || !st.card) return null;
  const running = j.status === 'running' || j.status === 'paused';
  S.cardCheck = S.cardCheck || {};
  return h('div', { class: 'lecture' },
    h('div', { class: 'line' },
      h('div', { class: 'name', style: 'flex:1;font-weight:700', text: running ? st.title + ' — 만드는 중' : '방금 배운 기준으로 읽기' }),
      h('button', { class: 'x', text: '×', onclick: () => { S.cardSeen[j.id] = true; render(); } })),
    running ? [
      h('div', { class: 'when', id: 'jstep-card-' + j.id, text: jobLine(j) }),
      h('div', { text: st.card.what }),
      h('div', { class: 'lab', text: '결과를 읽을 때 볼 점' }),
      st.card.look.map((x) => h('div', { text: '· ' + x })),
      st.card.ask ? [h('div', { class: 'lab', text: '생각해 볼 질문' }), h('div', { text: st.card.ask })] : null,
    ] : [
      st.card.look.map((x, i) => h('div', { class: 'line', style: 'gap:6px;cursor:pointer', onmousedown: () => { const k = j.id + ':' + i; S.cardCheck[k] = !S.cardCheck[k]; render(); } },
        h('button', { class: 'ck' + (S.cardCheck[j.id + ':' + i] ? ' on' : '') }), h('span', { text: x }))),
      h('div', { class: 'line' }, h('button', { class: 'btn-line', text: '결과 문서 열기', onclick: () => { S.cardSeen[j.id] = true; S.open = { type: 'doc', id: j.targetId }; render(); } })),
    ]);
}

// ---------------------------------------------------------------- 작업실

function selOf(key) { return (S.sel[key] = S.sel[key] || new Set()); }

function toggleSel(key, id) {
  const s = selOf(key);
  if (s.has(id)) s.delete(id); else s.add(id);
  render();
}

// on 을 밖에서 받는다 — 켜짐은 «고른 것이 전부인가»로 그때그때 셈한다(따로 기억하지 않는다).
function toggleAll(key, ids, on) {
  S.sel[key] = new Set(on ? ids : []);
  render();
}

// 한 줄이라도 골랐으면 손질거리를 세운다(«전체 선택»을 켠 때만 서던 것을 고쳤다 — 사용자 지시).
// 이 구획에 실제로 있는 것 가운데 고른 것만 — 자루에 남은 옛 id 는 세지 않는다.
const pickedOf = (sel, ids) => ids.filter((id) => sel.has(id));
const allPicked = (sel, ids) => ids.length > 0 && ids.every((id) => sel.has(id));

function workshop() {
  const p = S.project;
  const byId = new Map(p.docs.map((d) => [d.id, d]));
  const cats = p.categories;
  return h('div', null,
    h('div', { class: 'plus-wrap' },
      h('button', { class: 'plus', text: '+', onclick: (e) => { stop(e); S.menu = !S.menu; render(); } }),
      S.menu ? plusMenu() : null),
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
    h('button', { text: '논의 스레드', onclick: () => go(async () => { const r = await api('thread.create', { title: '논의' }); if (r.ok) { S.open = { type: 'thread', id: r.id, fresh: true }; render(); } }) }),
    h('button', { text: '모순 검사', onclick: () => go(() => newCheck('check', '모순 검사')) }),
    h('button', { text: '합평회', onclick: () => go(() => newCheck('review', '합평회')) }));
}

// 모순 검사·합평회는 한 글자도 받지 않고 곧바로 만들어진다 — 그래서 «갓 만든 것» 표를 달아 둔다.
// 아무것도 담기지 않은 채 창을 닫으면 없던 일로 돌린다(사용자 지시).
async function newCheck(kind, title) {
  const r = await api('doc.create', { kind, title });
  if (r.ok) { S.open = { type: 'doc', id: r.id, fresh: true }; render(); }
}

function catSection(c, byId) {
  const key = 'cat:' + c.id;
  const sel = selOf(key);
  const folded = S.fold[key];
  const docs = c.docIds.map((id) => byId.get(id)).filter(Boolean);
  const picked = pickedOf(sel, c.docIds);
  return h('div', { class: 'sec' },
    h('div', { class: 'sec-head' },
      h('button', { class: 'ck' + (allPicked(sel, c.docIds) ? ' on' : ''), onclick: () => toggleAll(key, c.docIds, !allPicked(sel, c.docIds)) }),
      h('div', { class: 'name click', text: c.name, onclick: () => { S.fold[key] = !folded; render(); } }),
      c.virtual ? null : h('button', { class: 'btn-text red', text: '삭제', onclick: () => api('cat.delete', { ids: [c.id] }) })),
    // 고르면 다운로드 · 삭제만 선다 — 확정본은 줄마다 있는 토글로 켜고 끈다(사용자 지시, 2026-09-29).
    picked.length ? h('div', { class: 'bulk' },
      // 그 카테고리를 통째로 골랐으면 한 파일로, 골라 담았으면 문서마다 한 파일로. 꼴(MD · 텍스트)은 누를 때 고른다.
      dlButton('cat:' + key, (fmt) => {
        if (c.docIds.length && picked.length === c.docIds.length) download('cat', c.id, fmt);
        else picked.forEach((id, i) => setTimeout(() => download('doc', id, fmt), i * 120));
      }, 'btn-line'),
      moveButton(key),
      h('button', { class: 'btn-red', text: '삭제', onclick: () => api('doc.delete', { ids: picked }) })) : null,
    picked.length && S.movePick === key ? moveChooser(key, c, picked) : null,
    folded ? null : docs.map((d) => h('div', {
      class: 'row' + (d.isFinal ? ' final' : ''),
      onclick: () => { S.open = { type: 'doc', id: d.id }; render(); },
    },
    h('button', { class: 'ck' + (sel.has(d.id) ? ' on' : ''), onclick: (e) => { stop(e); toggleSel(key, d.id); } }),
    h('button', { class: 'tg' + (d.isFinal ? ' on' : ''), onclick: (e) => { stop(e); api('doc.final', { ids: [d.id], on: !d.isFinal }); } }),
    KIND_MARK[d.kind] ? h('span', { class: 'mark', text: KIND_MARK[d.kind] }) : null,
    h('div', { class: 'name', text: d.title }))));
}

// [옮기기] — 고른 문서들을 한 번에 다른 카테고리로(2026-10-07 사용자 지시). 누르면 그 아래에 옮길 곳이 선다.
function moveButton(key) {
  return h('button', { class: 'btn-line', text: '옮기기', onclick: () => { S.movePick = S.movePick === key ? null : key; render(); } });
}
function moveChooser(key, c, picked) {
  const cats = [{ id: INBOX, name: '새로 추가된 문서' }, ...S.project.categories.filter((x) => !x.virtual)].filter((x) => x.id !== c.id);
  const go = async (to) => {
    S.movePick = null;
    const r = await api('doc.move', { ids: picked, categoryId: to.id === INBOX ? null : to.id });
    if (r && r.ok !== false) { S.sel[key] = new Set(); render(); }
  };
  return h('div', { class: 'bulk' },
    cats.length ? cats.map((x) => h('button', { class: 'btn-line', text: x.name, onclick: () => go(x) }))
      : h('span', { class: 'when', text: '옮길 카테고리가 없습니다' }),
    h('button', { class: 'btn-text', text: '취소', onclick: () => { S.movePick = null; render(); } }));
}

function threadSection() {
  const p = S.project;
  const key = 'threads';
  const sel = selOf(key);
  const ids = p.threads.map((t) => t.id);
  const picked = pickedOf(sel, ids);
  return h('div', { class: 'sec' },
    h('div', { class: 'sec-head' },
      h('button', { class: 'ck' + (allPicked(sel, ids) ? ' on' : ''), onclick: () => toggleAll(key, ids, !allPicked(sel, ids)) }),
      h('div', { class: 'name click', text: '논의 스레드', onclick: () => { S.fold[key] = !S.fold[key]; render(); } })),
    picked.length ? h('div', { class: 'bulk' },
      dlButton('threads', (fmt) => picked.forEach((id, i) => setTimeout(() => download('thread', id, fmt), i * 120)), 'btn-line'),
      h('button', { class: 'btn-red', text: '삭제', onclick: () => api('thread.delete', { ids: picked }) })) : null,
    S.fold[key] ? null : p.threads.map((t) => h('div', {
      class: 'row', onclick: () => { S.open = { type: 'thread', id: t.id }; render(); },
    },
    h('button', { class: 'ck' + (sel.has(t.id) ? ' on' : ''), onclick: (e) => { stop(e); toggleSel(key, t.id); } }),
    h('div', { class: 'name', text: t.title }))));
}

// ---------------------------------------------------------------- 설정

// 온라인판 — 이 작품에 쓸 AI 회사. 개인 작품은 주인이 고르고, 수업 작품은 기관이 정한 것을 보여 준다(개인판에는 없다).
const AI_CO = { anthropic: 'Claude', openai: 'ChatGPT', google: 'Gemini' };
function aiCompany(p) {
  if (!p.ai || S.tour) return null;
  const a = p.ai;
  const keys = new Set(a.keys || []);
  const name = (x) => AI_CO[x] || '';
  if (a.classWork) {
    return h('div', null, h('div', { class: 'lab', text: 'AI 회사' }),
      h('div', { class: 'when', text: a.ownerDefault ? '기관이 정한 회사: ' + name(a.ownerDefault) : '기관이 아직 회사를 고르지 않았습니다' }));
  }
  // 운영자 구독이 켜져 있으면 이 작품은 Claude 구독으로 돈다(회사 고르기는 쓰이지 않는다 — 끄는 곳은 «내 계정»)
  if (a.subscription) {
    return h('div', null, h('div', { class: 'lab', text: 'AI 회사' }),
      h('div', { class: 'when', text: 'Claude 구독으로 돕니다(API 키를 쓰지 않습니다) — «내 계정»에서 끌 수 있습니다' }));
  }
  const set = async (provider) => {
    const r = await fetch('/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'project.ai.set', pid: S.pid, provider }) })
      .then((x) => x.json()).catch(() => ({ ok: false }));
    if (r.ok) { a.provider = r.provider; render(); }
  };
  return h('div', null,
    h('div', { class: 'lab', text: W('이 작품에 쓸 AI 회사') }),
    h('div', { class: 'line' },
      h('button', { class: !a.provider ? 'btn' : 'btn-line', text: '내 기본' + (a.ownerDefault ? '(' + name(a.ownerDefault) + ')' : ''), onclick: () => set('') }),
      // 키를 넣은 회사만 고를 수 있다(서버도 막는다)
      Object.keys(AI_CO).filter((x) => keys.has(x)).map((x) => h('button', { class: a.provider === x ? 'btn' : 'btn-line', text: name(x), onclick: () => set(x) }))),
    h('div', { class: 'when', style: 'margin-top:4px', text: keys.size ? '다른 회사를 쓰려면 «내 계정»에서 그 회사의 키를 넣으세요' : '아직 AI 키가 없습니다 — «내 계정»에서 넣으면 그 회사가 기본이 됩니다' }));
}

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
    aiCompany(p),
    // 자료는 작업실 «자료» 카테고리의 보통 문서다(사용자 지시, 2026-09-28) — 여기에는 어디 있는지만 이른다.
    h('div', null,
      h('div', { class: 'lab', text: '자료' }),
      h('div', { class: 'when', text: '작업실의 «자료» 카테고리에 문서로 있습니다 — 열어 읽고 고치며, 참조로 걸고, 확정본으로 켤 수 있습니다.' })),
    h('div', null,
      h('div', { class: 'lab', text: '에이전트' }),
      (p.crew || []).map((a) => h('div', { class: 'mat' },
        h('div', { class: 'name', text: a.name }),
        h('div', { class: 'when', text: a.role }),
        a.model ? h('span', { class: 'mark', text: modelName(a.model) }) : null,
        h('button', { class: 'btn-text', text: '고치기', onclick: () => openAgent(a.id) }),
        h('button', { class: 'btn-text red', text: '삭제', onclick: () => api('agent.delete', { ids: [a.id] }) }))),
      h('div', { class: 'line', style: 'margin-top:8px' },
        h('button', { class: 'btn-line', text: '추가', onclick: () => openAgent(null) }),
        // 준비가 어긋났거나 끊겼을 때만 선다 — 누르면 종류 판정부터 자료 분석까지 다시 돈다.
        p.prepared || (p.jobs || []).some((j) => j.kind === 'agents' && j.status === 'running')
          ? null
          : h('button', { class: 'btn-line', text: '자료 분석 다시', onclick: () => { S.open = { type: 'prepare' }; clearTyped('pp-req'); render(); } }))),
    h('div', null,
      h('div', { class: 'lab', text: '모델' }),
      modelRow(p.models, p.model, (m) => api('project.spec', { model: m }))),
    // 무엇으로 돈이 나가는가 — 구독인지 API 키인지. 사람이 고른다(사용자 지시, 2026-09-22).
    // 「구독으로 돕니다」라고 말하면서 물려받은 환경 변수 때문에 말없이 종량 과금되면 안 된다.
    // 고를 갈래가 없으면(온라인판 — 키는 서버만 다룬다) 이 칸을 세우지 않는다.
    !(p.auth && (p.auth.modes || []).length) ? null : h('div', null,
      h('div', { class: 'lab', text: '무엇으로' }),
      authRow(p.auth),
      h('div', { class: 'line', style: 'margin-top:8px' },
        textbox('set-key', 'API 키', '', {
          onblur: async () => {
            const v = String(S.typed['set-key'] || '').trim();
            if (!v) return;
            clearTyped('set-key');
            await api('auth.write', { apiKey: v });
          },
        }),
        p.auth && p.auth.hasKey
          ? h('button', { class: 'btn-text red', text: '키 지우기', onclick: () => api('auth.write', { apiKey: '' }) })
          : null),
      p.limit ? h('div', { class: 'when', text: limitSay(p.limit) }) : null),
    // 누름을 click 이 아니라 mousedown 으로 받는다 — 위 칸에 글을 치던 중이면 click 이 오기 전에 다시 그려진다.
    h('div', { class: 'line' },
      h('div', { class: 'lab', style: 'margin:0', text: '계량어 금지' }),
      h('button', { class: 'tg' + (p.noCount ? ' on' : ''), onmousedown: () => api('project.spec', { noCount: !p.noCount }) })),
    // 에이전트 목록 — **고칠 수 있다는 것이 보여야 한다**(사용자 지시).
    //
    // 고치는 길은 전부터 있었다(이름·역할·이번에 할 일·프롬프트, 그리고 되돌리기).
    // 그런데 이름이 「기본 에이전트」였고 접혀 있어서, 이 작품에 맞춰 지어진 것이라는 걸
    // 알 길이 없었다. **있는데 못 찾는 것은 없는 것과 같다.**
    // 지어진 자리가 있으면 펴 둔다 — 작가가 한 번 접으면 그다음부터는 그 뜻을 따른다.
    (p.prompts || []).length ? agentList(p) : null,
    // 작품 통째로 — 다른 PC · 개인판(USB) · 온라인판에서 «작품 파일 가져오기»로 그대로 연다
    h('div', { class: 'line', style: 'padding-top:20px' },
      h('button', { class: 'btn-line', text: W('작품 파일 내려받기'), onclick: () => download('project', '') }),
      h('div', { class: 'when', text: '문서 · 판 이력 · 확정본 · 논의까지 한 파일로' })),
    h('div', { style: 'padding-top:20px' },
      h('button', {
        class: 'btn-red', text: '프로젝트 삭제',
        onclick: () => { S.confirm = { text: '되돌릴 수 없음', run: async () => { await api('project.delete', {}); S.pid = null; S.project = null; S.confirm = null; pull(true); } }; render(); },
      })),
    brandMark('text-align:center;padding:44px 0 4px'));
}

// back 이 있으면 이 창을 닫을 때 그 자리로 되돌아간다(오던 길을 함께 닫지 않는다).
function openAgent(id, back) { S.open = { type: 'agent', id, model: null, back: back || null }; clearTyped('ag-name', 'ag-role', 'ag-craft'); render(); }

// 쓸 모델 고르기 — 하나만 켜지는 네모. 프로젝트에도, 사람마다에도 같은 꼴로 쓴다.
// 누름을 click 이 아니라 mousedown 으로 받는다: 바로 위 칸에 글을 치던 중이면 click 이 오기 전에
// blur → 저장 → 다시 그리기가 지나가며 이 네모가 갈려 버려 첫 누름이 먹히지 않는다.
// 무엇으로 도는가 — 셋 가운데 하나. modelRow 와 같은 결로 둔다.
//   그대로 : 그 PC 의 환경이 정하는 대로(손대지 않는다)
//   구독   : 물려받은 API 키를 지워 구독으로만 돌린다
//   API 키 : 담아 둔 키로 돈다
const AUTH_SAY = { auto: '그대로', sub: '구독', api: 'API 키' };

function authRow(a) {
  const cur = (a && a.mode) || 'auto';
  const list = (a && a.modes) || ['auto', 'sub', 'api'];
  return h('div', { class: 'line' }, list.map((m) => h('div', {
    class: 'line', style: 'gap:6px;cursor:pointer',
    onmousedown: () => api('auth.write', { mode: m }),
  },
  h('button', { class: 'ck' + (cur === m ? ' on' : '') }),
  h('span', { text: AUTH_SAY[m] || m }))));
}

// follow 를 주면 맨 앞에 «따르기» 칸(빈 값)이 선다 — 지어진 에이전트가 작품의 모델을 따르는 자리.
// 화면에 보이는 모델 이름 — 온라인판은 등급(High Reasoning / Balanced)만 보인다(CLAUDE.md 원칙 4 — 실제 모델은 회사 · 설정이 정한다).
// 개인판은 지금처럼 별칭(opus · sonnet · fable) 그대로.
const TIER_NAME = { opus: 'High Reasoning', sonnet: 'Balanced', fable: 'High Reasoning' };
const modelName = (m) => (S.me && !S.tour ? TIER_NAME[m] || m : m);

function modelRow(list, cur, pick, follow) {
  const opts = (follow ? [''] : []).concat(list || []);
  return h('div', { class: 'line' }, opts.map((m) => h('div', {
    class: 'line', style: 'gap:6px;cursor:pointer',
    onmousedown: () => pick(m),
  },
  h('button', { class: 'ck' + (cur === m ? ' on' : '') }),
  h('span', { text: m ? modelName(m) : follow }))));
}

// 작가가 짓는 에이전트 — 이름·역할·프롬프트 셋. 새로 지을 때만 단추가 있고, 고칠 때는 치는 대로 들어간다.
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
  else S.askOpen = { label: '만들고 닫기', dirty: () => typedAny('ag-name', 'ag-role', 'ag-craft'), save: makeAgent };
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
        // 사람마다 하나씩 정해 둔다 — 정하지 않고 지으면 프로젝트에 정해 둔 모델로 태어난다.
        modelRow(p.models, making ? (S.open.model || p.model) : (a.model || p.model),
          (m) => { if (making) { S.open.model = m; render(); } else api('agent.write', { id: a.id, model: m }); })),
      h('div', null, h('div', { class: 'lab', text: '프롬프트' }), area('ag-craft', '프롬프트', a ? a.craft : '', { class: 'body-edit', onblur: save })),
      making ? h('div', null,
        h('div', { class: 'line' },
          h('button', { class: 'btn', text: '만들기', onclick: makeAgent }),
          S.open.err ? h('span', { class: 'notice', text: S.open.err }) : null)) : null));
}

// 돌려주는 값: 갈무리했으면 true. 이름이 비면 짓지 못하므로 창을 열어 둔다.
async function makeAgent() {
  const body = { name: $('ag-name').value, role: $('ag-role').value, craft: $('ag-craft').value, model: (S.open && S.open.model) || '' };
  // 필수는 이름 하나. 빠지면 짓지 않고 그 자리에 짚어 준다(창은 닫지 않는다).
  if (!String(body.name).trim()) { S.open.err = '필수 항목 누락 — 이름'; render(); return false; }
  S.open.err = '';
  clearTyped('ag-name', 'ag-role', 'ag-craft');
  await api('agent.create', body);
  closeLayer(true);
  return true;
}

// 이 작품이 쓰는 사람들. 누르면 이름·역할·이번에 할 일·프롬프트를 고친다.
//
// 비소설이면 프로그램이 작품 규격을 읽고 자리마다 새로 짓는다(agents.mjs).
// 소설이면 내장 아홉을 그대로 쓴다. 어느 쪽이든 **여기서 고칠 수 있고, 되돌릴 수 있다.**
function agentList(p) {
  const rows = p.prompts || [];
  const made = rows.some((pr) => pr.made);
  const open = S.fold['prompts'] === undefined ? made : S.fold['prompts'];
  return h('details', { open: open ? 'open' : null },
    h('summary', {
      text: made ? (W('이 작품의 에이전트') + (p.agentKind ? ' — ' + p.agentKind : '')) : '에이전트',
      onclick: () => { S.fold['prompts'] = !open; },
    }),
    h('div', { class: 'when', style: 'padding:2px 0 8px',
      text: made ? W('이 작품에 맞춰 지었습니다. 눌러서 고치십시오.') : '눌러서 고치십시오.' }),
    rows.map((pr) => h('div', {
      class: 'row', onclick: () => openPrompt(pr.code),
    },
    h('span', { class: 'mark', text: pr.code }),
    h('div', { class: 'name', text: pr.name }),
    pr.model ? h('span', { class: 'mark', text: modelName(pr.model) }) : null,
    pr.made ? h('span', { class: 'when', text: '지음' }) : null,
    pr.edited ? h('span', { class: 'when', style: 'color:var(--red)', text: '고침' }) : null)));
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
        class: 'btn-text red', text: one.made ? '지은 것으로 되돌리기' : '내장으로 되돌리기',
        onclick: async () => { S.typed = {}; await api('prompt.reset', { code: one.code }); openPrompt(one.code); },
      }) : null,
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      h('div', null, h('div', { class: 'lab', text: '이름' }), textbox('pr-name', '이름', one.name, { onblur: save })),
      h('div', null, h('div', { class: 'lab', text: '역할' }), textbox('pr-role', '역할', one.role, { onblur: save })),
      h('div', null,
        h('div', { class: 'lab', text: '모델' }),
        // 정하지 않으면 작품의 모델을 따른다 — 작품의 모델을 바꾸면 이 자리도 따라 바뀐다.
        // [되돌리기] 는 글만 걷는다. 모델은 여기서 «작품 모델 따름» 을 눌러 걷는다.
        modelRow(S.project && S.project.models, one.model || '', (m) => {
          S.open.one = { ...one, model: m };
          render();
          api('prompt.model', { code: one.code, model: m });
        }, W('작품 모델 따름 (') + ((S.project && S.project.model) || '') + ')')),
      h('div', null, h('div', { class: 'lab', text: '이번에 할 일' }), area('pr-task', '이번에 할 일', one.task, { onblur: save })),
      h('div', null, h('div', { class: 'lab', text: '프롬프트' }), area('pr-craft', '프롬프트', one.craft, { class: 'body-edit', onblur: save }))));
}

// 글 파일(txt · md, 2MB 까지)과 문서 파일(docx · pdf, 20MB 까지 — 글만 뽑아 넣는다, web/textfile.js). 서버는 뽑은 글만 받고 다시 거른다.
// hwp 는 읽지 못한다(한글에서 docx · pdf · txt 로 저장해 넣는다). 스캔한 그림 PDF 도 글이 없어 못 읽는다.
const FILE_MAX = 2 * 1024 * 1024;
const DOC_MAX = 20 * 1024 * 1024;
const TEXT_EXT = /\.(txt|md|markdown|text)$/i;
const DOC_EXT = /\.(docx|pdf)$/i;
function fileButton(onRead, onBad = (m) => { S.open.err = m; render(); }) {
  const input = h('input', {
    type: 'file', style: 'display:none', multiple: true, accept: '.txt,.md,.markdown,.text,.docx,.pdf,text/plain,text/markdown,application/pdf',
    onchange: (e) => {
      for (const f of e.target.files) {
        if (DOC_EXT.test(f.name)) {
          if (f.size > DOC_MAX) { onBad(f.name + ' — 파일이 너무 큽니다(20MB 까지)'); continue; }
          if (!window.SEText) { onBad(f.name + ' — 문서 파일을 읽는 부분을 불러오지 못했습니다'); continue; }
          window.SEText.textOf(f).then((t) => {
            if (t.length > FILE_MAX) return onBad(f.name + ' — 뽑은 글이 너무 깁니다(2MB 까지) — 나눠서 넣어 주세요');
            onRead(f.name.replace(DOC_EXT, ''), t);
          }).catch((err) => onBad(f.name + ' — ' + String((err && err.message) || err)));
          continue;
        }
        if (/\.hwpx?$/i.test(f.name)) { onBad(f.name + ' — 한글(hwp) 파일은 읽지 못합니다. 한글에서 docx · pdf · txt 로 저장해 넣어 주세요'); continue; }
        if (!TEXT_EXT.test(f.name) && !/^text\//.test(f.type || '')) { onBad(f.name + ' — txt · md · docx · pdf 파일만 넣을 수 있습니다'); continue; }
        if (f.size > FILE_MAX) { onBad(f.name + ' — 파일이 너무 큽니다(2MB 까지)'); continue; }
        const rd = new FileReader();
        rd.onload = () => {
          const t = String(rd.result || '');
          // 깨진 글자(�)가 많거나 NUL 이 있으면 글 파일이 아니다(인코딩이 다르거나 바이너리)
          if (t.includes('\u0000') || (t.match(/\uFFFD/g) || []).length > Math.max(3, t.length / 100)) return onBad(f.name + ' — 글로 읽을 수 없습니다(UTF-8 txt · md 로 저장해 주세요)');
          onRead(f.name, t);
        };
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
        h('button', { class: 'ck' + (allPicked(sel, ids) ? ' on' : ''), onclick: () => toggleAll(key, ids, !allPicked(sel, ids)) }),
        h('div', { class: 'name', text: '휴지통' })),
      pickedOf(sel, ids).length ? h('div', { class: 'bulk' },
        h('button', { class: 'btn-line', text: '복원', onclick: () => api('trash.restore', { ids: pickedOf(sel, ids) }) }),
        h('button', { class: 'btn-red', text: '삭제', onclick: () => { S.confirm = { text: '되돌릴 수 없음', run: async () => { await api('trash.purge', { ids: pickedOf(sel, ids) }); S.confirm = null; render(); } }; render(); } })) : null,
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
  'ag-name', 'ag-role', 'ag-craft', 'st-once', 'st-ep'];

function closeLayer(force) {
  // 새로 만드는 창은 닫으면 치던 글이 사라진다 — 그때는 그냥 닫지 않고 묻는다(사용자 지시).
  // 고치는 창은 닫을 때 저장되므로 묻지 않는다(잃는 것이 없다).
  const asking = S.askOpen;
  if (!force && asking && asking.dirty()) {
    S.confirm = {
      text: '치던 글이 있습니다',
      acts: [
        {
          label: asking.label, class: 'btn',
          run: async () => { S.confirm = null; render(); const done = await asking.save(); if (!done) render(); },
        },
        { label: '버리고 닫기', class: 'btn-line', run: () => { S.confirm = null; closeLayer(true); } },
      ],
    };
    render();
    return;
  }
  // 닫기 전에 저장을 먼저 부른다 — Esc·×·바깥 클릭이 모두 같은 길을 지난다.
  // (창이 사라지며 나는 blur 에 기대면 창 바깥을 누른 때와 Esc 를 누른 때가 갈린다.)
  const save = S.saveOpen;
  if (save) { try { save(); } catch { /* 저장이 미끄러져도 창은 닫는다 */ } }
  // 오던 길이 적혀 있으면 그 자리로 돌아간다 — 한꺼번에 닫지 않는다.
  const back = S.open && S.open.back;
  S.open = back ? back.open : null;
  if (back && back.pick) S.pick = back.pick;
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
          : t === 'stage' ? stagePanel(close)
            : t === 'prompt' ? promptPanel(close)
              : t === 'prepare' ? preparePanel(close)
                : agentPanel(close);
  return h('div', { class: 'layer', onclick: (e) => { if (e.target.classList.contains('layer')) close(); } }, panel);
}

// 참조 칩이 가리킬 수 있는 것 — 문서(자료도 «자료» 카테고리의 문서다)
function refIndex() {
  const m = new Map();
  for (const d of S.project.docs || []) m.set(d.id, { title: d.title, isFinal: d.isFinal, kind: d.kind });
  return m;
}

// 그 문서를 지으려면 무엇이 있어야 하는가 — 없으면 그 이름들을 돌려준다.
function missingFor(d) {
  // 합평회와 모순 검사는 «이번에 무엇을 보라»는 말이 있어야 선다 — 요청사항이 그 자리의 미션이다(사용자 지시).
  // 모순 검사는 거기에 더해 맞댈 것이 둘은 있어야 한다(대상 둘, 또는 대상 하나에 참조 하나).
  if (d.kind === 'check' || d.kind === 'review') {
    const miss = [];
    if (!(d.targetIds || []).length) miss.push('대상');
    else if (d.kind === 'check' && (d.targetIds || []).length + (d.refIds || []).length < 2) miss.push('대상 또는 참조');
    if (!String(d.request || '').trim()) miss.push('요청사항');
    return miss.join(' · ');
  }
  const has = String(d.body || '').trim() || String(d.request || '').trim() || (d.refIds || []).length;
  return has ? '' : '요청사항 또는 참조';
}

// 작법서는 가리키기만 하는 문서다 — 본문이 갱신에 실려 오지 않으므로 열 때 한 번 받아 둔다.
async function fetchSrc(id) {
  if (S.srcText && S.srcText.id === id) return;
  S.srcText = { id, text: '' };
  const r = await api('peek', { id });
  if (!S.srcText || S.srcText.id !== id) return;
  S.srcText = { id, text: r.ok ? r.one.text : '' };
  render();
}

// 고치는 문서의 본문 — 글이 있고 치는 중이 아니면 «보기»(꼴대로), [고치기] 또는 보기를 누르면 치는 칸. 빈 문서는 곧바로 치는 칸.
function bodyBox(d, saveFields, busy = false) {
  const has = String(d.body || '').trim();
  // 생성 중에는 읽기만 — 치는 칸도 [고치기]도 없다(서버도 막는다). 끝나면 새 판이 «보기»로 선다.
  if (busy) {
    clearTyped('d-body');
    return has ? mdView('d-view', d.body) : h('div', { class: 'md-view', style: 'color:var(--dim)', text: '생성 중입니다 — 끝나면 여기에 보입니다' });
  }
  const editing = !has || (S.open && S.open.edit) || 'd-body' in S.typed;
  const toEdit = () => { S.open.edit = true; render(); const t = $('d-body'); if (t) t.focus(); };
  const toView = async () => { await saveFields(); S.open.edit = false; render(); };
  return h('div', null,
    has ? h('div', { class: 'line', style: 'gap:6px;margin-bottom:6px' },
      h('button', { class: editing ? 'btn-line' : 'btn', text: '보기', onclick: editing ? toView : null }),
      h('button', { class: editing ? 'btn' : 'btn-line', text: '고치기', onclick: editing ? null : toEdit })) : null,
    editing ? area('d-body', BODY_HINT, d.body, { class: 'body-edit', onblur: saveFields }) : mdView('d-view', d.body, toEdit));
}

function docPanel(close) {
  const d = (S.project.docs || []).find((x) => x.id === S.open.id);
  if (!d) return h('div', { class: 'panel narrow' }, h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '없음' }), h('button', { class: 'x', text: '×', onclick: close })));
  const byId = refIndex();
  if (d.src) fetchSrc(d.id);   // 가리키는 문서는 열 때 한 번 글을 받아 온다
  const peeking = S.peek && S.peek.docId === d.id ? d.versions.find((v) => v.i === S.peek.i) : null;
  const busy = (S.project.jobs || []).some((j) => j.status === 'running' && j.targetId === d.id);
  // 본문을 잠그는 것은 «돌 차례를 기다리는 · 도는 · 멈춘» 작업 모두(곧 결과가 이 문서에 온다)
  const locked = (S.project.jobs || []).some((j) => ['queued', 'running', 'paused', 'waiting_for_user', 'waiting'].includes(j.status) && j.targetId === d.id);
  // 아직 한 번도 채워진 적 없는 문서에는 갱신할 것이 없다 — 그때는 «생성»이다.
  const verb = !String(d.body || '').trim() && !d.versions.length ? '생성' : '갱신';
  // 이 창이 닫힐 때 저장할 것
  // 칸을 떠날 때마다 부른다 — 친 것이 있을 때만 쓴다. 닫는 길(S.saveOpen)은 건드리지 않는다.
  // 고치기 시작할 때 본 판의 시각 — 치는 동안은 얼려 두고, 치지 않을 때는 지금 것을 따른다
  const typing = ['d-title', 'd-body'].some((k) => k in S.typed);
  if (!typing || S.open.baseAt == null) S.open.baseAt = d.updatedAt || 0;
  const saveFields = async () => {
    if (S.redrawing) return;
    const body = { id: d.id, baseAt: S.open && S.open.baseAt };
    if ('d-title' in S.typed) body.title = $('d-title').value;
    if ('d-body' in S.typed && $('d-body')) body.body = $('d-body').value;
    if ('d-req' in S.typed) body.request = $('d-req').value;
    // 저장이 거절되면(너무 큼 · 연결 끊김) 쓴 글을 버리지 않는다 — 친 그대로 칸에 되살리고 까닭을 보인다
    const kept = Object.fromEntries(['d-title', 'd-body', 'd-req'].filter((k) => k in S.typed).map((k) => [k, S.typed[k]]));
    clearTyped('d-title', 'd-body', 'd-req');
    if (Object.keys(body).length === 1) return;   // 손대지 않았으면 쓰지 않는다
    if (S.open) S.open.fresh = false;             // 한 글자라도 담았으면 갓 만든 것이 아니다
    let r = null;
    try { r = await api('doc.write', body); } catch { r = null; }
    if (!r || r.ok === false) {
      Object.assign(S.typed, kept);
      if (S.open && S.open.id === d.id) { S.open.err = '저장하지 못했습니다 — ' + ((r && r.error) || '연결을 확인해 주세요') + ' · 쓴 글은 칸에 남아 있습니다'; render(); }
      return;
    }
    if (S.open && S.open.id === d.id) {
      S.open.baseAt = null;
      if (r && r.conflict) { S.open.err = '그사이 다른 곳에서 고친 글이 있었습니다 — 그 글은 이력(판)에 남아 있습니다'; render(); }
    }
  };
  // 닫을 때만 지나는 길 — 저장한 뒤, 갓 만들어 비어 있으면 거둔다.
  // (칸을 떠날 때마다 부르는 saveFields 에 두면 창 안에서 칸만 옮겨도 문서가 사라진다.)
  const closeFields = async () => {
    // 표는 기다리기 전에 쥔다 — 닫는 쪽은 저장을 기다리지 않고 곧바로 S.open 을 비운다.
    const fresh = !!(S.open && S.open.fresh);
    await saveFields();
    if (fresh) await api('doc.discard', { id: d.id });
  };

  S.saveOpen = closeFields;

  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      KIND_MARK[d.kind] ? h('span', { class: 'mark', text: KIND_MARK[d.kind] }) : null,
      textbox('d-title', '이름', d.title, { onblur: saveFields }),
      h('span', { class: 'lab', style: 'margin:0', text: '확정본' }),
      h('button', { class: 'tg' + (d.isFinal ? ' on' : ''), onclick: () => api('doc.final', { ids: [d.id], on: !d.isFinal }) }),
      dlButton('doc:' + d.id, (fmt) => download('doc', d.id, fmt)),
      S.me && !S.tour ? h('button', { class: 'btn-text', text: S.open.runs ? '만든 기록 닫기' : '만든 기록', onclick: () => toggleRuns(d.id) }) : null,
      h('button', { class: 'btn-text red', text: '삭제', onclick: async () => { await api('doc.delete', { ids: [d.id] }); close(); } }),
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      // 지금 판을 지은 AI 가 출력 상한에 닿았다(온라인 — 서버가 truncated 를 실을 때만). 저장은 됐고, 끝이 잘렸을 수 있다.
      runsBox(),
      d.truncated && !peeking ? h('div', { class: 'notice', text: '이 글은 길이 한도에 닿아 끝이 잘렸을 수 있습니다 — 끝부분을 확인하고, 필요하면 나눠서 다시 생성하세요' }) : null,
      // 모순 검사는 견주는 자리이지 치는 자리가 아니다 — 결과만 보인다(사용자 지시).
      // 옛 판 펼쳐보기도 같은 읽기 칸을 쓴다. 치는 칸과 id 를 갈라 두어야
      // 옛 판을 펼친 채로 창을 닫을 때 그 글이 지금 본문을 덮지 않는다.
      // 모순 검사에는 치는 칸이 없다 — 결과가 나온 뒤에만 읽는 칸이 선다(빈 칸을 세워 두면 치는 자리로 보인다).
      // 작법서는 읽는 자리다 — 치는 칸도, 지을 거리도 두지 않는다.
      // 읽는 칸(작법서 · 옛 판 · 모순 검사 결과)은 마크다운을 꼴대로 보인다. 고치는 문서는 글이 있으면 «보기»가 먼저, [고치기]로 치는 칸(2026-10-07).
      d.src ? mdView('d-out', S.srcText && S.srcText.id === d.id ? S.srcText.text : '')
        : peeking ? mdView('d-out', peeking.body)
          : d.kind === 'check'
            ? (String(d.body || '').trim() ? mdView('d-out', d.body) : null)
            : bodyBox(d, saveFields, locked),
      h('div', null, h('div', { class: 'lab', text: '카테고리' }), h('div', { class: 'line' }, catPicker(d))),
      d.src ? null : h('div', null, h('div', { class: 'lab', text: '요청사항' }), area('d-req', '요청사항', d.request, { onblur: saveFields })),
      d.src || d.kind === 'doc' ? null : refLine('대상', d.targetIds, byId, (ids) => api('doc.write', { id: d.id, targetIds: ids }), d.id),
      d.src ? null : refLine('참조', d.refIds, byId, (ids) => api('doc.write', { id: d.id, refIds: ids }), d.id),
      d.src ? null : refLine('에이전트', d.agentIds, crewIndex(), (ids) => api('doc.write', { id: d.id, agentIds: ids }), null, 'agent',
        seatNames(d.kind === 'review' && (d.agentIds || []).length > 1 ? KIND_SEAT.review : [KIND_SEAT[d.kind][0]])),
      d.src ? null : h('div', { class: 'line' }, S.open.err ? h('span', { class: 'notice', text: S.open.err }) : null, h('button', {
        class: 'btn', text: busy ? verb + ' 중' : verb, disabled: busy,
        onclick: async () => {
          await saveFields();
          // 저장한 뒤의 것을 보고 따진다 — 손에 쥔 d 는 그리기 때의 것이라 방금 친 요청사항이 없다.
          const fresh = (S.project.docs || []).find((x) => x.id === d.id) || d;
          // 시킬 것이 하나도 없으면 부르지 않는다 — 무엇이 없는지 짚어 준다.
          const miss = missingFor(fresh);
          if (miss) { S.open.err = '필수 항목 누락 — ' + miss; return render(); }
          S.open.err = '';
          const m = await pickOneModel(d.agentIds);
          if (m === null) return;              // 그만두기
          await api('doc.update', { id: d.id, model: m.trim() });
        },
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

// 걸린 사람들이 저마다 다른 모델을 쓰면 어느 것으로 모을지 묻는다(사용자 지시).
// 실제로 쓰이는 모델 = 그 사람의 것, 정하지 않았으면 작품의 것.
function splitModels(agentIds) {
  const p = S.project;
  if (!p || (agentIds || []).length < 2) return [];
  const byId = new Map((p.crew || []).map((a) => [a.id, a]));
  const seen = [];
  for (const id of agentIds) {
    const a = byId.get(id);
    if (!a) continue;
    const m = String(a.model || '').trim() || String(p.model || '');
    if (!seen.includes(m)) seen.push(m);
  }
  return seen.length > 1 ? seen : [];
}

// 갈렸으면 묻고 고른 것을 돌려준다. 갈리지 않았으면 곧바로 ''. 그만두면 null.
function pickOneModel(agentIds) {
  const split = splitModels(agentIds);
  if (!split.length) return Promise.resolve('');
  return new Promise((resolve) => {
    S.confirm = {
      text: '쓰는 모델이 서로 다릅니다',
      acts: split.map((m) => ({
        label: modelName(m), class: 'btn-line',
        run: () => { S.confirm = null; render(); resolve(m); },
      })),
      onClose: () => resolve(null),
    };
    render();
  });
}

// 그 자리에 늘 서는 사람의 이름 — 설정의 프롬프트 목록에서 가져온다.
function seatNames(codes) {
  const by = new Map(((S.project && S.project.prompts) || []).map((x) => [x.code, x.name]));
  return codes.map((c) => by.get(c)).filter(Boolean);
}

// pool 이 'agent' 면 고르는 창이 문서가 아니라 사람을 펼친다.
// fixed 는 «늘 서는 자리 사람» — 뗄 수 없으므로 × 를 붙이지 않는다.
function refLine(label, ids, byId, save, selfId, pool, fixed) {
  return h('div', null,
    h('div', { class: 'lab', text: label }),
    h('div', { class: 'line' },
      (fixed || []).map((name) => h('span', { class: 'chip' },
        h('span', { class: 'mark', text: '자리' }),
        h('span', { text: name }))),
      (ids || []).map((id) => {
        const t = byId.get(id);
        return h('span', { class: 'chip' + (t && t.isFinal ? ' final' : '') },
          h('span', { text: t ? t.title : '없음' }),
          h('button', { text: '×', onclick: () => save((ids || []).filter((x) => x !== id)) }));
      }),
      h('button', { class: 'plus', style: 'width:26px;height:26px', text: '+', onclick: () => { S.pick = { ids: (ids || []).slice(), save, selfId, label, pool }; render(); } })));
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
      flow.push(h('div', { class: 'msg ai' }, window.SEMarkdown ? window.SEMarkdown.render(m.text) : m.text));
    }
  }
  // 친 말이 있으면 바깥 클릭·Esc·× 로 그냥 닫지 않는다 — 보낼지 버릴지 묻는다(사용자 지시).
  // 아무것도 치지 않았으면 묻지 않고 닫힌다(저장할 것이 없다).
  S.askOpen = {
    label: '보내고 닫기',
    dirty: () => typedAny('t-say'),
    save: async () => {
      const v = $('t-say') ? $('t-say').value : '';
      if (!v.trim()) { closeLayer(true); return true; }
      const m = await pickOneModel(t.agentIds);
      if (m === null) return false;              // 그만두면 창을 열어 둔다
      clearTyped('t-say');
      await api('thread.send', { id: t.id, text: v, model: m.trim() });
      closeLayer(true);
      return true;
    },
  };
  // 닫을 때 지나는 한 목 — 이름을 지어 주었으면 그것을 쓰고, 갓 만든 빈 것이면 거둔다.
  // (바깥 클릭·Esc·× 가 모두 closeLayer 로 모이고, 거기서 이 함수를 부른다.)
  // 이름 칸을 떠날 때 — 지어 주었으면 그 이름을 쓴다. 그뿐이다.
  const saveTitle = async () => {
    if (S.redrawing) return;
    const key = 't-title-' + t.id;
    if (!(key in S.typed)) return;
    const v = $(key).value;
    clearTyped(key);
    if (S.open) S.open.fresh = false;         // 이름을 지어 주었으면 갓 만든 것이 아니다
    await api('thread.title', { id: t.id, title: v });
  };
  // 창을 닫을 때만 지나는 길 — 이름을 쓰고, 갓 만들어 비어 있으면 거둔다.
  // (이름 칸의 blur 에 이것을 걸면 칸을 눌렀다 나가기만 해도 스레드가 사라진다.)
  const closeThread = async () => {
    const fresh = !!(S.open && S.open.fresh);   // 기다리기 전에 쥔다
    await saveTitle();
    if (fresh) await api('thread.discard', { id: t.id });
  };
  S.saveOpen = closeThread;
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' },
      textbox('t-title-' + t.id, '이름', t.title, { onblur: saveTitle }),
      dlButton('thread:' + t.id, (fmt) => download('thread', t.id, fmt)),
      h('button', { class: 'btn-text red', text: '삭제', onclick: async () => { S.saveOpen = null; await api('thread.delete', { ids: [t.id] }); close(); } }),
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      refLine('참조', t.refIds, byId, (ids) => api('thread.refs', { id: t.id, refIds: ids }), null),
      refLine('에이전트', t.agentIds, crewIndex(), (ids) => api('thread.agents', { id: t.id, agentIds: ids }), null, 'agent',
        seatNames(['F-TALK', 'F-THREADDOC'])),
      h('div', { class: 'talk' }, flow),
      S.open.err ? h('div', { class: 'notice', text: S.open.err }) : null,
      h('div', { class: 'send' },
        // 여기는 대화하는 자리다 — 문서를 갱신하는 «요청사항» 칸이 아니다(사용자 지시).
        area('t-say', '할 말'),
        h('button', {
          class: 'btn', text: '보내기',
          onclick: async () => {
            const v = $('t-say').value;
            if (!v.trim()) { S.open.err = '필수 항목 누락 — 할 말'; return render(); }
            S.open.err = '';
            const m = await pickOneModel(t.agentIds);
            if (m === null) return;
            clearTyped('t-say');
            await api('thread.send', { id: t.id, text: v, model: m.trim() });
          },
        }),
        h('button', {
          class: 'btn-line', text: '문서로 정리',
          onclick: async () => {
            // 오간 말이 없으면 정리할 것이 없다.
            if (!(t.messages || []).length) { S.open.err = '필수 항목 누락 — 오간 말'; return render(); }
            S.open.err = '';
            const v = $('t-say') ? $('t-say').value : '';
            const m = await pickOneModel(t.agentIds);
            if (m === null) return;
            clearTyped('t-say');
            await api('thread.doc', { id: t.id, request: v, model: m.trim() });
          },
        }))));
}

const NEW_PROJECT_KEYS = ['n-name', 'n-form', 'n-outline', 'n-length', 'n-standard', 'n-request', 'n-mat'];

function newProjectPanel(close) {
  const add = (name, text) => { if (String(text || '').trim()) { S.draft.push({ name: name || firstLine(text), text }); render(); } };
  S.askOpen = {
    label: '만들고 닫기',
    dirty: () => typedAny(...NEW_PROJECT_KEYS) || S.draft.length > 0,
    save: makeProject,
  };
  return h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: W('새 작품') }), h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      placeChoice(),
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
      h('div', { style: 'padding-top:6px' },
        h('div', { class: 'line' },
          h('button', { class: 'btn', text: '생성', onclick: makeProject }),
          S.open.err ? h('span', { class: 'notice', text: S.open.err }) : null),
        S.open.note ? h('div', { class: 'lab', style: 'margin-top:8px', text: S.open.note }) : null)));
}

// 온라인판 — 어디에 만들까요? 수업 작품은 기관 키로, 내 개인 작품은 내 AI 키로 돈다(개인판에는 이 칸이 없다).
function placeChoice() {
  if (!S.me) return null;
  const places = S.me.places || [];
  const pick = S.open.place || '';
  const choose = (v) => { S.open.place = v; render(); };
  return h('div', null,
    places.length ? [
      h('div', { class: 'lab', text: '어디에 만들까요?' }),
      h('div', { class: 'line' },
        places.map((c) => h('button', { class: pick === c.classId ? 'btn' : 'btn-line', text: c.orgName + ' · ' + c.name, onclick: () => choose(c.classId) })),
        h('button', { class: pick === '' ? 'btn' : 'btn-line', text: W('내 개인 작품'), onclick: () => choose('') })),
    ] : null,
    pick === '' ? h('div', { class: 'when', style: 'margin-top:8px', text: W('내 개인 작품 — AI 는 내 AI 키(«내 계정»)로 돌고, 비용은 본인에게 나갑니다.') }) : null);
}

// 돌려주는 값: 이 자리에서 창까지 다 갈무리했으면 true. 거절당했으면 false(창을 열어 둔다).
async function makeProject() {
  const rest = $('n-mat') ? $('n-mat').value : '';
  const body = {
    name: $('n-name').value, standard: $('n-standard').value, request: $('n-request').value,
    spec: { outline: $('n-outline').value, form: $('n-form').value, length: $('n-length').value },
    materials: rest.trim() ? [...S.draft, { name: '', text: rest }] : S.draft.slice(),
  };
  // 필수는 셋 — 이름·형식·자료. 빠진 것이 있으면 만들지 않고 그 자리에 짚어 준다(사용자 지시).
  const miss = [];
  if (!body.name.trim()) miss.push('이름');
  if (!body.spec.form.trim()) miss.push('형식');
  if (!body.materials.length) miss.push('자료');
  if (miss.length) {
    S.open.err = '필수 항목 누락 — ' + miss.join(' · ');
    // 분량은 필수가 아니다. 비어 있으면 스스로 정한다는 것만 함께 알린다.
    S.open.note = body.spec.length.trim() ? '' : isBook() ? '분량은 비워 두면 «책의 설계»에서 AI 가 자료를 보고 정합니다' : '분량은 비워 두면 회차 수를 스스로 정합니다';
    render();
    return false;
  }
  if (S.me && S.open.place) body.classId = S.open.place;
  const r = await api('project.create', body);
  if (r.ok) { S.pid = r.pid; S.draft = []; S.open = null; S.project = null; S.typed = {}; pull(true); return true; }
  S.open.err = r.error;
  render();
  return false;
}

// «자료 분석 다시»(전의 «에이전트 준비 다시» — 2026-10-07 이름만 바꿈) — 이번 한 번만 실을 요청사항을 받는다(비워 두어도 된다. 저장하지 않는다).
function preparePanel(close) {
  S.askOpen = { label: '시작하고 닫기', dirty: () => typedAny('pp-req'), save: startPrepare };
  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '자료 분석' }), h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      h('div', null, h('div', { class: 'lab', text: '요청사항' }), area('pp-req', '요청사항')),
      h('button', { class: 'btn', text: '시작', onclick: startPrepare }),
      S.open.err ? h('div', { class: 'notice', text: S.open.err }) : null));
}

async function startPrepare() {
  const req = $('pp-req') ? $('pp-req').value : '';
  clearTyped('pp-req');
  const r = await api('project.prepare', { request: req });
  if (r.ok) { closeLayer(true); return true; }
  S.open.err = r.error;
  render();
  return false;
}

function newDocPanel(close) {
  S.askOpen = { label: '만들고 닫기', dirty: () => typedAny('nd-name'), save: makeDoc };
  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '문서' }), h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      textbox('nd-name', '이름'),
      S.open.err ? h('div', { class: 'notice', text: S.open.err }) : null,
      h('div', { class: 'line' },
        h('button', {
          class: 'btn', text: '생성', onclick: makeDoc,
        }),
        fileButton(async (name, text) => {
          let r = null;
          try { r = await api('doc.create', { title: name.replace(/\.[^.]+$/, ''), body: text }); } catch { r = null; }
          if (r && r.ok) { S.open = { type: 'doc', id: r.id }; render(); return; }
          // 만들지 못했으면 말없이 지나가지 않는다
          S.open.err = '파일로 문서를 만들지 못했습니다 — ' + ((r && r.error) || '연결을 확인해 주세요'); render();
        }))));
}

// 돌려주는 값: 갈무리했으면 true. 만들기는 문서 창을 여는 것으로 끝난다.
async function makeDoc() {
  // 필수는 이름 하나. 빠지면 만들지 않고 그 자리에 짚어 준다(창은 닫지 않는다).
  const title = ($('nd-name') ? $('nd-name').value : '').trim();
  if (!title) { S.open.err = '필수 항목 누락 — 이름'; render(); return false; }
  S.open.err = '';
  clearTyped('nd-name');
  const r = await api('doc.create', { title });
  if (r.ok) { S.open = { type: 'doc', id: r.id }; render(); }
  return true;
}

// ---------------------------------------------------------------- 2겹 창

// 고르기 창에서 한 줄을 누르면 그 내용을 그 자리에 펼친다(고르는 것은 왼쪽 동그라미가 한다).
async function peekOne(id) {
  if (S.pickOpen && S.pickOpen.id === id) { S.pickOpen = null; return render(); }
  S.pickOpen = { id, name: '', text: '', loading: true };
  render();
  const r = await api('peek', { id });
  if (!S.pickOpen || S.pickOpen.id !== id) return;
  S.pickOpen = r.ok ? { ...r.one, loading: false } : { id, name: '', text: '없습니다', loading: false };
  render();
}

function peekBox(id) {
  if (!S.pickOpen || S.pickOpen.id !== id) return null;
  return h('div', { class: 'peek', text: S.pickOpen.loading ? '…' : (S.pickOpen.text || '(비어 있음)') });
}

function pickLayer() {
  const p = S.project;
  const chosen = new Set(S.pick.ids);
  const flip = (id) => { if (chosen.has(id)) chosen.delete(id); else chosen.add(id); S.pick.ids = [...chosen]; S.pick.save(S.pick.ids); render(); };
  const close = () => { S.pick = null; S.pickOpen = null; render(); };
  if (S.pick.pool === 'agent') {
    const crew = p.crew || [];
    return h('div', { class: 'layer two', onclick: (e) => { if (e.target.classList.contains('layer')) close(); } },
      h('div', { class: 'panel narrow' },
        h('div', { class: 'panel-head' }, h('div', { class: 'name', text: '에이전트' }), h('button', { class: 'x', text: '×', onclick: close })),
        h('div', { class: 'panel-body' },
          crew.length
            ? crew.map((a) => [
              h('div', { class: 'row', onclick: () => peekOne(a.id) },
                h('button', { class: 'ck' + (chosen.has(a.id) ? ' on' : ''), onclick: (e) => { stop(e); flip(a.id); } }),
                h('div', { class: 'name', text: a.name }),
                h('div', { class: 'when', text: a.role })),
              peekBox(a.id),
            ])
            // 아직 아무도 짓지 않았으면 그 자리에서 지을 수 있게 한다(막다른 골목을 두지 않는다).
            : h('button', {
              class: 'btn',
              text: '에이전트 만들기',
              onclick: async () => {
                // 오던 길을 적어 두고 간다 — 짓고 닫으면 고르던 자리로 돌아온다.
                const back = { open: S.open, pick: S.pick };
                if (S.saveOpen) { try { await S.saveOpen(); } catch { /* 저장이 미끄러져도 길은 간다 */ } }
                S.pick = null;
                openAgent(null, back);
              },
            }))));
  }
  return h('div', { class: 'layer two', onclick: (e) => { if (e.target.classList.contains('layer')) close(); } },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'name', text: S.pick.label || '참조' }), h('button', { class: 'x', text: '×', onclick: close })),
      h('div', { class: 'panel-body' },
        // 자료는 «자료» 카테고리의 문서라 아래 카테고리들 사이에 함께 선다.
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
            return [
              h('div', { class: 'row' + (d.isFinal ? ' final' : ''), onclick: () => peekOne(id) },
                h('button', { class: 'ck' + (chosen.has(id) ? ' on' : ''), onclick: (e) => { stop(e); flip(id); } }),
                KIND_MARK[d.kind] ? h('span', { class: 'mark', text: KIND_MARK[d.kind] }) : null,
                h('div', { class: 'name', text: d.title })),
              peekBox(id),
            ];
          }));
      }))));
}

function confirmLayer() {
  const onClose = S.confirm.onClose;
  const close = () => { S.confirm = null; render(); if (onClose) onClose(); };
  // 갈래를 적어 주지 않으면 지난날처럼 [삭제] 하나다.
  const acts = S.confirm.acts || [{ label: '삭제', class: 'btn-red', run: S.confirm.run }];
  return h('div', { class: 'layer two' },
    h('div', { class: 'panel narrow' },
      h('div', { class: 'panel-head' }, h('div', { class: 'name', text: S.confirm.text }), h('button', { class: 'x', text: '×', onclick: close })),
      h('div', { class: 'panel-body' },
        h('div', { class: 'line' }, acts.map((a) => h('button', { class: a.class || 'btn', text: a.label, onclick: a.run }))))));
}

// ---------------------------------------------------------------- 시작

document.addEventListener('click', (e) => {
  if (S.tour) return;   // 각본이 세워 둔 차림표를 바깥 클릭이 닫지 않게
  if (S.menu && !e.target.closest('.menu') && !e.target.closest('.plus')) { S.menu = false; render(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (S.tour) return tourExit();   // 튜토리얼에서는 Esc 가 «나가기»다
  if (S.pick) { S.pick = null; S.pickOpen = null; render(); }
  else if (S.confirm) { const f = S.confirm.onClose; S.confirm = null; render(); if (f) f(); }
  else if (S.open) closeLayer();
});

// 온라인판 «기관 · 수업» 화면에서 학생 작품을 열 때 — /?pid=… 로 들어온다
try { const q = new URLSearchParams(location.search).get('pid'); if (q) S.pid = q; } catch { /* 주소를 못 읽으면 첫 화면 */ }

// 바뀜 알림(온라인판 — SSE). 붙어 있으면 1.5초 묻기를 쉬고 15초마다 한 번만 확인한다. 끊기면 곧바로 1.5초 묻기로 돌아간다.
// 개인판(로그인 없음 — S.me 가 없다)은 붙지 않는다. 서버가 알림을 못 쓰면(503 · LISTEN 불가) 1분 뒤에 다시 붙어 본다.
const EV = { es: null, pid: null, ok: false, retryAt: 0, lastPull: 0 };
function events() {
  if (!S.me || S.tour || typeof EventSource === 'undefined') return;
  const want = S.pid || '';
  if (EV.es && EV.pid === want) return;
  if (EV.es) { EV.es.close(); EV.es = null; EV.ok = false; }
  if (Date.now() < EV.retryAt) return;
  EV.pid = want;
  const es = new EventSource('/api/events' + (want ? '?pid=' + encodeURIComponent(want) : ''));
  EV.es = es;
  es.onopen = () => { EV.ok = true; };
  es.onmessage = () => pull(false);
  es.onerror = () => {
    EV.ok = false;
    if (es.readyState === 2) { if (EV.es === es) EV.es = null; EV.retryAt = Date.now() + 60000; }   // 닫혔다(503 등) — 묻기로
  };
}

pull(true);
setInterval(() => {
  if (EV.ok && Date.now() - EV.lastPull < 15000) return;
  pull(false);
}, 1500);
