'use strict';

// 화면 밝기 — 기본은 어두운 화면(style.css :root). «밝게» 를 고른 브라우저만 기억해 둔다.
try { if (localStorage.getItem('se-theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch { /* 저장소를 못 쓰면 기본 */ }

// 온라인판의 세 화면이 이 한 파일을 쓴다(<body data-page>로 가른다).
//   school.html  «내 수업»  — 들어가 있는 수업 · 내 수업 작품(열기 · 개인 작품으로 복사) · 수업 현황 · 학생 초대 코드(강사) · 새 수업 코드 넣기
//   account.html «내 계정»  — 새 수업 코드 넣기 · 내 AI 키 · 내 비밀번호 바꾸기(누구나)
//   manage.html «관리»  — 운영자(플랫폼 관리자)와 기관 관리자만: 기관 · 이용 기간 · 수업 · 초대 · 사용자(비밀번호 재설정 · 내보내기) · 기관 키 · 사용량
// 모든 판정은 서버(online/edu.mjs · tenancy)가 한다. 이 화면은 서버가 허락한 것을 보여 줄 뿐이다.
// 학생에게 비용 · 횟수 · 키를 보이지 않는다. 초대 코드는 만든 그 자리에서 한 번만 보인다.

const PAGE = ['manage', 'account'].includes(document.body.dataset.page) ? document.body.dataset.page : 'school';
const S = { me: null, loggedIn: false, orgs: {}, progress: {}, shown: {}, say: '', open: {}, usage: {}, members: {}, wf: {}, wfOpen: {}, invites: {} };

function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}
const $ = (id) => document.getElementById(id);
const val = (id) => ($(id) ? $(id).value.trim() : '');
const day = (t) => (t ? new Date(t).toLocaleDateString() : '');
// 수업 기간은 한국 날짜로 — 끝은 «그날 24시»로 저장되므로 하루 앞을 보인다
const ymd = (t, end) => (t ? new Date(new Date(t).getTime() - (end ? 86400000 : 0)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : '');
const period = (c) => (c.starts_at || c.ends_at ? (ymd(c.starts_at) || '') + ' ~ ' + (ymd(c.ends_at, true) || '') : '');

async function edu(op, body = {}) {
  const r = await fetch('/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...body }) }).catch(() => null);
  const out = r ? await r.json().catch(() => ({ ok: false, error: '응답 없음' })) : { ok: false, error: '연결되지 않습니다' };
  if (out.code === 'gate') location.reload();   // 출입 열쇠는 페이지를 다시 열 때 묻는다
  return out;
}
const tell = (text) => { S.say = text || ''; render(); };

// ---------------------------------------------------------------- 불러오기

async function load() {
  const m = await edu('me.memberships');
  S.loggedIn = m.ok === true;
  S.me = m.ok ? m : null;
  S.orgs = {};
  if (S.me && PAGE === 'account') S.myKeys = (await edu('me.key.list')).credentials || [];
  if (S.me && PAGE === 'manage') {
    // 관리할 수 있는 기관 — 플랫폼 관리자는 전부, 기관 관리자는 제 기관(서버가 골라 준다)
    const list = (await edu('org.list')).organizations || [];
    for (const o of list) {
      const [lic, cls, keys] = await Promise.all([edu('license.read', { orgId: o.id }), edu('class.list', { orgId: o.id }), edu('org.key.list', { orgId: o.id })]);
      S.orgs[o.id] = { org: o, lic, classes: cls.classes || [], keys: keys.credentials || [] };
    }
  }
  render();
}

// ---------------------------------------------------------------- 조각

const field = (label, id, type = 'text', extra = {}) => h('div', { style: 'flex:1;min-width:160px' },
  h('div', { class: 'lab', text: label }), h('input', { id, type, ...extra }));

const section = (title, ...body) => h('div', { class: 'sec' },
  h('div', { class: 'sec-head' }, h('div', { class: 'name', text: title })),
  h('div', { style: 'padding:14px 16px' }, ...body));

// 만든 그 자리에서 한 번만 보이는 초대 코드
const codeBox = (key) => (S.shown[key] ? h('div', { class: 'line', style: 'margin-top:10px' },
  h('div', { class: 'mark', style: 'font-size:15px;padding:6px 10px', text: S.shown[key] }),
  h('div', { class: 'when', text: '지금만 보입니다 — 적어서 전해 주세요' })) : null);

// 아직 쓸 수 있는 초대 코드 — 열고 닫는다. 코드 원문은 없다(만들 때 한 번만 보였다). 새어 나갔으면 취소한다.
async function toggleInvites(key, orgId) {
  if (S.invites[key]) { delete S.invites[key]; render(); return; }
  const r = await edu('invite.list', { orgId });
  if (!r.ok) return tell(r.error);
  S.invites[key] = r.invites;
  render();
}
function inviteList(key, orgId, classId) {
  const list = S.invites[key];
  const btn = h('button', { class: 'btn-line', text: list ? '초대 코드 목록 닫기' : '초대 코드 목록', onclick: () => toggleInvites(key, orgId) });
  if (!list) return btn;
  const rows = list.filter((x) => !classId || x.classId === classId);
  const revoke = async (x) => {
    if (!confirm('이 초대 코드를 취소할까요? 이미 들어온 사람은 그대로이고, 앞으로 이 코드로는 들어올 수 없습니다.')) return;
    const r = await edu('invite.revoke', { inviteId: x.id });
    if (!r.ok) return tell(r.error);
    delete S.invites[key];
    await toggleInvites(key, orgId);
  };
  return h('div', { style: 'width:100%' }, btn,
    rows.length ? rows.map((x) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: (ROLE_SAY[x.role] || x.role) + (x.className ? ' · ' + x.className : '') }),
      h('span', { class: 'mark', text: x.used + ' / ' + x.max + '명' }),
      h('div', { class: 'when', text: '~ ' + day(x.expiresAt) + (x.madeBy ? ' · ' + x.madeBy : '') }),
      h('button', { class: 'btn-text red', text: '취소', onclick: () => revoke(x) })))
      : h('div', { class: 'when', style: 'margin-top:6px', text: '쓸 수 있는 초대 코드가 없습니다' }));
}

async function makeInvite(key, orgId, classId, role) {
  const r = await edu('invite.create', { orgId, classId, role });
  if (!r.ok) return tell(r.error);
  S.shown[key] = r.invite.code;
  // 열려 있는 초대 코드 목록에도 새 코드가 서게 다시 받는다
  for (const k of ['o-' + orgId, 'c-' + classId]) if (S.invites[k]) { delete S.invites[k]; await toggleInvites(k, orgId); }
  render();
}

// ---------------------------------------------------------------- 들어오기(초대 코드)

function joinBox() {
  // 로그인한 사람이 새 수업 · 기관에 들어간다 — 지금 계정 그대로(새 계정을 만들지 않는다).
  // 로그인 전에는 서버가 첫 화면(/login)으로 보낸다 — 거기서 코드 · 계정 만들기 · «이미 계정이 있어요».
  const go = async () => {
    const code = val('j-code');
    if (!code) return tell('초대 코드를 넣어 주세요');
    const r = await edu('invite.accept', { code });
    if (!r.ok) return tell(r.error);
    S.say = '들어왔습니다 — «내 수업»에 보입니다';
    await load();
  };
  return section('새 수업 코드 넣기',
    h('div', { class: 'line', style: 'align-items:flex-end' },
      field('초대 코드', 'j-code', 'text', { placeholder: 'ABCD-EFGH-JKLM', autocapitalize: 'characters', spellcheck: 'false' }),
      h('button', { class: 'btn-red', text: '들어가기', onclick: go })));
}

// ---------------------------------------------------------------- 내 수업

function progressBox(c) {
  const p = S.progress[c.id];
  if (!p) return null;
  const SAY = { queued: '대기', running: '진행 중', paused: '멈춤', waiting_for_user: '멈춤', done: '완료', failed: '실패', cancelled: '중지' };
  const STAGE_SAY = { draft: '초안', approved: '승인', skipped: '건너뜀' };
  return h('div', { style: 'margin-top:10px;width:100%' }, p.students.length
    ? p.students.map((s) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: s.name + (s.projectName ? ' — ' + s.projectName : ' — (아직 작품 없음)') }),
      s.projectId ? h('span', { class: 'mark', text: '문서 ' + s.docs }) : null,
      s.stage ? h('span', { class: 'mark', text: s.stage.title + ' · ' + (STAGE_SAY[s.stage.status] || s.stage.status) }) : null,
      s.lastJob ? h('span', { class: 'mark', text: SAY[s.lastJob] || s.lastJob }) : null,
      h('div', { class: 'when', text: s.updatedAt ? day(s.updatedAt) : '' }),
      s.projectId ? h('a', { class: 'btn-text', href: '/?pid=' + encodeURIComponent(s.projectId), text: '읽기' }) : null,
      s.stage && s.stage.teachingNote ? h('button', { class: 'btn-text', text: '강의 포인트', onclick: () => { S.open['tn-' + s.userId] = !S.open['tn-' + s.userId]; render(); } }) : null,
      S.open['tn-' + s.userId] && s.stage ? h('div', { class: 'when', style: 'width:100%;white-space:normal', text: s.stage.title + ' — ' + s.stage.teachingNote }) : null))
    : h('div', { class: 'when', text: '아직 학생이 없습니다' }));
}

async function showProgress(c) {
  if (S.progress[c.id]) { delete S.progress[c.id]; render(); return; }   // 열려 있으면 닫는다
  const r = await edu('class.progress', { classId: c.id });
  if (!r.ok) return tell(r.error);
  S.progress[c.id] = r;
  render();
}

function myClasses() {
  const list = (S.me && S.me.classes) || [];
  if (!list.length) return null;
  return section('내 수업', list.map((c) => h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' },
    h('div', { class: 'line' },
      h('div', { class: 'name', style: 'font-weight:600;flex:1', text: c.name }),
      h('span', { class: 'mark', text: c.role === 'instructor' ? '강사' : '학생' }),
      c.status !== 'active' ? h('span', { class: 'mark', text: '닫힘' }) : null),
    h('div', { class: 'line', style: 'margin-top:8px' },
      c.role === 'instructor' ? [
        h('button', { class: 'btn-line', text: S.progress[c.id] ? '현황 닫기' : '수업 현황', onclick: () => showProgress(c) }),
        h('button', { class: 'btn-line', text: '학생 초대 코드', onclick: () => makeInvite('s-' + c.id, c.organization_id, c.id, 'student') }),
      ] : null),
    codeBox('s-' + c.id),
    c.role === 'instructor' ? h('div', { style: 'margin-top:8px' }, inviteList('c-' + c.id, c.organization_id, c.id)) : null,
    (c.works || []).map((w) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', style: 'flex:1', text: w.name }),
      h('a', { class: 'btn-text', href: '/?pid=' + encodeURIComponent(w.id), text: '열기' }),
      w.canCopy ? h('button', { class: 'btn-text', text: '개인 작품으로 복사', onclick: () => copyWork(w) }) : null)),
    progressBox(c))));
}

// 수업 작품 → 내 개인 작품(원본은 기관에 그대로). 복사본의 AI 는 내 키로 — 비용은 나에게.
async function copyWork(w) {
  if (!confirm('«' + w.name + '» 을 내 개인 작품으로 복사합니다.\n원본은 수업에 그대로 남고, 복사본에서 쓰는 AI 는 내 AI 키로 돕니다(비용은 본인).')) return;
  const r = await edu('project.copy_personal', { pid: w.id });
  if (!r.ok) return tell(r.error);
  tell('복사했습니다 — 작업실의 «' + w.name + ' (개인)»');
}

// AI 회사 — 키를 넣을 때 고른다. 여럿 넣어 두면 Claude → ChatGPT → Gemini 차례로 쓴다(서버 ai/router.mjs).
const AI_CO = { anthropic: 'Claude', openai: 'ChatGPT', google: 'Gemini' };
const AI_KEY_LABEL = { anthropic: 'Claude(Anthropic) API 키', openai: 'ChatGPT(OpenAI) API 키', google: 'Gemini(Google) API 키' };
S.prov = {};
S.lim = {};
S.dates = {};
const provOf = (k) => S.prov[k] || 'anthropic';
const providerPick = (k) => h('div', { class: 'line', style: 'margin-top:10px' },
  Object.entries(AI_CO).map(([p, name]) => h('button', { class: provOf(k) === p ? 'btn' : 'btn-line', text: name, onclick: () => { S.prov[k] = p; render(); } })));
// 쓸 AI 회사 고르기 — 키가 없는 회사는 «키 없음»을 단다(골라도 키를 넣기 전에는 «연결 필요»로 멈춘다)
function aiChoice(label, current, keys, save, allowed) {
  const have = new Set((keys || []).filter((x) => x.status === 'active').map((x) => x.provider));
  return h('div', { style: 'margin-top:12px' },
    h('div', { class: 'lab', text: label }),
    h('div', { class: 'line' }, Object.entries(AI_CO).filter(([p]) => !allowed || allowed.includes(p)).map(([p, name]) => h('button', {
      class: current === p ? 'btn' : 'btn-line', text: name + (have.has(p) ? '' : ' (키 없음)'), onclick: () => save(p),
    }))),
    current ? null : h('div', { class: 'when', style: 'margin-top:4px', text: '아직 고르지 않았습니다 — 고르기 전에는 키를 넣어 둔 회사 가운데 하나를 씁니다.' }));
}

// 등급 — 화면은 이름만(실제 모델은 회사 · 설정이 정한다). 기관 기본 등급은 새 수업 작품의 시작 등급이 된다.
const TIER_CO = { high_reasoning: 'High Reasoning', balanced: 'Balanced', fast: 'Fast' };
const START_TIERS = ['high_reasoning', 'balanced'];
const limitText = (l) => (l && (l.allowed_providers || l.allowed_model_tiers)
  ? 'AI ' + (l.allowed_providers ? l.allowed_providers.map((p) => AI_CO[p]).join(' · ') : '모두') + ' / 등급 ' + (l.allowed_model_tiers ? l.allowed_model_tiers.map((t) => TIER_CO[t]).join(' · ') : '모두')
  : '');

// 넣어 둔 키 — 회사 · 끝 네 자리 · 확인 상태, 그리고 [연결 확인] [지우기]
const KEY_ERR = { auth: '키가 맞지 않음', credit: '잔액 없음', rate: '요청 많음', model: '모델 표 없음', overloaded: '회사 서버 바쁨', timeout: '응답 늦음' };
function keyRows(list, op, extra, reload) {
  const live = (list || []).filter((x) => x.status === 'active' || x.status === 'invalid');
  if (!live.length) return h('div', { class: 'when', text: '아직 없습니다' });
  const test = async (x) => {
    tell('확인하는 중…');
    const r = await edu(op + '.test', { ...extra, provider: x.provider });
    tell(r.ok ? (AI_CO[x.provider] + ' — ' + r.say) : r.error);
    await reload();
  };
  const revoke = async (x) => {
    if (!confirm(AI_CO[x.provider] + ' 키를 지울까요? 이 키로 돌던 AI 작업은 «연결 필요»로 멈춥니다.')) return;
    const r = await edu(op + '.revoke', { ...extra, provider: x.provider });
    if (!r.ok) return tell(r.error);
    tell('지웠습니다');
    await reload();
  };
  return live.map((x) => h('div', { class: 'row', style: 'cursor:default' },
    h('div', { class: 'name', text: (AI_CO[x.provider] || x.provider) + ' ' + x.keyHint }),
    h('span', { class: 'mark', text: x.status === 'invalid' ? '키가 맞지 않음' : x.lastErrorCode ? (KEY_ERR[x.lastErrorCode] || '연결 안 됨') : x.lastVerifiedAt ? '확인됨 ' + day(x.lastVerifiedAt) : '확인 전' }),
    h('button', { class: 'btn-text', text: '연결 확인', onclick: () => test(x) }),
    h('button', { class: 'btn-text red', text: '지우기', onclick: () => revoke(x) })));
}

// ---------------------------------------------------------------- 내 AI 키(누구나 — 쓰기 전용). 내 개인 작품의 AI 는 이 키로.
function myKeyBox() {
  const k = 'mykey';
  if (!S.open[k] && PAGE !== 'account') return h('button', { class: 'btn-text', text: '내 AI 키', onclick: async () => { S.myKeys = (await edu('me.key.list')).credentials || []; S.open[k] = true; render(); } });
  const save = async () => {
    const r = await edu('me.key.set', { provider: provOf(k), apiKey: val('mk-key') });
    if ($('mk-key')) $('mk-key').value = '';
    if (!r.ok) return tell(r.error);
    S.myKeys = (await edu('me.key.list')).credentials || [];
    tell('저장했습니다');
  };
  return section('내 AI 키',
    keyRows(S.myKeys, 'me.key', {}, async () => { S.myKeys = (await edu('me.key.list')).credentials || []; render(); }),
    h('div', { class: 'when', style: 'margin-top:4px', text: '내 개인 작품의 AI 는 이 키로 돌고 비용은 키 주인에게 나갑니다. 수업 작품은 기관 키로 돕니다. 만 14세 이상만 넣어 주세요.' }),
    aiChoice('개인 작품에 쓸 AI 회사(작품마다 설정 탭에서 바꿀 수 있습니다)', (S.me && S.me.aiProvider) || '', S.myKeys, async (p) => {
      const r = await edu('me.ai.set', { provider: p });
      if (!r.ok) return tell(r.error);
      S.me.aiProvider = r.provider; tell(AI_CO[p] + '를 씁니다');
    }),
    providerPick(k),
    h('div', { class: 'line', style: 'align-items:flex-end;margin-top:10px' },
      field(AI_KEY_LABEL[provOf(k)], 'mk-key', 'password', { autocomplete: 'off', spellcheck: 'false' }),
      h('button', { class: 'btn-red', text: '저장', onclick: save })));
}

// ---------------------------------------------------------------- 사용량(비용을 내는 쪽만 — 서버가 학생 · 강사에게는 내주지 않는다)

async function showUsage(key, orgId) {
  const r = await edu('usage.summary', orgId ? { orgId } : {});
  if (!r.ok) return tell(r.error);
  S.usage[key] = r.usage;
  render();
}
const usageRows = (key) => (S.usage[key] ? h('div', { style: 'margin-top:8px' }, S.usage[key].length
  ? S.usage[key].map((u) => h('div', { class: 'row', style: 'cursor:default' },
    h('div', { class: 'name', text: u.month + ' · ' + u.model_id }),
    h('span', { class: 'mark', text: '호출 ' + u.calls + (u.failed ? ' (실패 ' + u.failed + ')' : '') }),
    h('div', { class: 'when', text: '입력 ' + u.input_tokens.toLocaleString() + ' · 출력 ' + u.output_tokens.toLocaleString() + ' 토큰 · 추정 $' + u.cost_usd.toFixed(2) })))
  : h('div', { class: 'when', text: '아직 쓴 것이 없습니다' }),
h('div', { class: 'when', style: 'margin-top:6px', text: '금액은 모델 가격표로 낸 추정입니다 — 정확한 청구는 AI 회사의 청구서를 보세요' })) : null);

// ---------------------------------------------------------------- 기관 관리

function orgBox(id) {
  const { org, lic, classes, keys } = S.orgs[id];
  const live = (lic.licenses || []).find((l) => l.status === 'active' && (!l.ends_at || new Date(l.ends_at) > new Date()));
  const addClass = async () => { const r = await edu('class.create', { orgId: id, name: val('nc-' + id), startsAt: val('ncs-' + id), endsAt: val('nce-' + id) }); if (!r.ok) return tell(r.error); await load(); };
  const saveDates = async (c) => {
    const r = await edu('class.dates', { classId: c.id, startsAt: val('cds-' + c.id), endsAt: val('cde-' + c.id) });
    if (!r.ok) return tell(r.error);
    S.dates[c.id] = false; S.say = '수업 기간을 바꿨습니다';
    await load();
  };
  const saveKey = async () => {
    const r = await edu('org.key.set', { orgId: id, provider: provOf('ok-' + id), apiKey: val('ok-' + id) });
    $('ok-' + id).value = '';
    if (!r.ok) return tell(r.error);
    S.say = 'AI 키를 저장했습니다(다시 보이지 않습니다)';
    await load();
  };
  const readable = !!(org.settings && org.settings.admin_can_read_projects);
  return section(org.name + ' — 기관 관리',
    h('div', { class: 'lab', text: '이용 기간' }),
    h('div', { class: 'when', text: live ? '~ ' + (live.ends_at ? day(live.ends_at) : '기한 없음') + ' · 학생 ' + (lic.seatsUsed || 0) + (live.seat_limit ? ' / ' + live.seat_limit : '') : '유효한 이용 기간이 없습니다 — 새 작품 · AI 작업이 멈춥니다' }),
    live && limitText(live) ? h('div', { class: 'when', text: '쓸 수 있는 범위: ' + limitText(live) }) : null,
    h('div', { class: 'lab', style: 'margin-top:16px', text: '수업' }),
    classes.map((c) => h('div', { style: 'padding:8px 0;border-bottom:1px solid var(--line-soft)' },
      h('div', { class: 'line' },
        h('div', { class: 'name', style: 'flex:1', text: c.name }),
        period(c) ? h('span', { class: 'when', text: period(c) }) : null,
        h('span', { class: 'mark', text: '학생 ' + (c.students || 0) }),
        c.status !== 'active' ? h('span', { class: 'mark', text: '닫힘' }) : null,
        h('button', { class: 'btn-text', text: S.progress[c.id] ? '현황 닫기' : '현황', onclick: () => showProgress(c) }),
        h('button', { class: 'btn-text', text: S.dates[c.id] ? '기간 닫기' : '기간', onclick: () => { S.dates[c.id] = !S.dates[c.id]; render(); } }),
        h('button', { class: 'btn-text', text: '학생 초대', onclick: () => makeInvite('s-' + c.id, id, c.id, 'student') }),
        h('button', { class: 'btn-text', text: '강사 초대', onclick: () => makeInvite('i-' + c.id, id, c.id, 'instructor') }),
        h('button', { class: 'btn-text' + (c.status === 'active' ? ' red' : ''), text: c.status === 'active' ? '닫기' : '다시 열기',
          onclick: async () => { await edu('class.archive', { classId: c.id, reopen: c.status !== 'active' }); await load(); } })),
      S.dates[c.id] ? h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
        field('시작하는 날', 'cds-' + c.id, 'date', { value: ymd(c.starts_at) }), field('끝나는 날', 'cde-' + c.id, 'date', { value: ymd(c.ends_at, true) }),
        h('button', { class: 'btn-line', text: '저장', onclick: () => saveDates(c) })) : null,
      codeBox('s-' + c.id), codeBox('i-' + c.id), progressBox(c))),
    h('div', { class: 'line', style: 'margin-top:10px;align-items:flex-end' }, field('새 수업 이름', 'nc-' + id),
      field('시작하는 날(선택)', 'ncs-' + id, 'date'), field('끝나는 날(선택)', 'nce-' + id, 'date'), h('button', { class: 'btn-line', text: '수업 만들기', onclick: addClass })),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '기관 관리자' }),
    h('div', { class: 'line' }, h('button', { class: 'btn-line', text: '기관 관리자 초대 코드', onclick: () => makeInvite('a-' + id, id, null, 'organization_admin') })),
    codeBox('a-' + id),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '초대 코드' }),
    inviteList('o-' + id, id, null),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '기관 AI 키(학생 작업이 이 키로 돕니다)' }),
    keyRows(keys, 'org.key', { orgId: id }, load),
    providerPick('ok-' + id),
    h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
      field(AI_KEY_LABEL[provOf('ok-' + id)], 'ok-' + id, 'password', { autocomplete: 'off', spellcheck: 'false' }), h('button', { class: 'btn-line', text: '저장', onclick: saveKey })),
    aiChoice('이 기관 작품에 쓸 AI 회사', (org.settings && org.settings.ai_provider) || '', keys, async (p) => {
      const r = await edu('org.settings', { orgId: id, aiProvider: p });
      if (!r.ok) return tell(r.error);
      S.say = AI_CO[p] + '를 씁니다';
      await load();
    }, live && live.allowed_providers),
    h('div', { style: 'margin-top:12px' },
      h('div', { class: 'lab', text: '새 수업 작품의 시작 등급(학생이 작품마다 바꿀 수 있습니다)' }),
      h('div', { class: 'line' }, START_TIERS.filter((t) => !(live && live.allowed_model_tiers) || live.allowed_model_tiers.includes(t)).map((t) => h('button', {
        class: ((org.settings && org.settings.ai_tier) || '') === t ? 'btn' : 'btn-line', text: TIER_CO[t],
        onclick: async () => { const r = await edu('org.settings', { orgId: id, aiTier: t }); if (!r.ok) return tell(r.error); S.say = TIER_CO[t] + '로 시작합니다'; await load(); },
      })))),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '사용자' }),
    h('div', { class: 'line', style: 'margin-bottom:8px' }, makeMemberBox(id)),
    codeBox('mk-' + id),
    membersBox(id),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '사용량(기관 키)' }),
    S.usage['o-' + id] ? h('button', { class: 'btn-line', text: '사용량 닫기', onclick: () => { delete S.usage['o-' + id]; render(); } })
      : h('button', { class: 'btn-line', text: '사용량 보기', onclick: () => showUsage('o-' + id, id) }),
    usageRows('o-' + id),
    h('div', { class: 'line', style: 'margin-top:16px' },
      h('div', { class: 'lab', style: 'margin:0', text: '학생에게 작업 중 강의 카드 보이기' }),
      h('button', { class: 'tg' + (!(org.settings && org.settings.student_cards === false) ? ' on' : ''),
        onclick: async () => { await edu('org.settings', { orgId: id, studentCards: !!(org.settings && org.settings.student_cards === false) }); await load(); } })),
    h('div', { class: 'line', style: 'margin-top:16px' },
      h('div', { class: 'lab', style: 'margin:0', text: '학생이 수업 작품을 개인 작품으로 복사해 갈 수 있게' }),
      h('button', { class: 'tg' + (!(org.settings && org.settings.allow_copy === false) ? ' on' : ''),
        onclick: async () => { await edu('org.settings', { orgId: id, allowCopy: !!(org.settings && org.settings.allow_copy === false) }); await load(); } })),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '단계 · 강의 카드 고쳐 쓰기(이 기관)' }),
    wfEditor(id),
    // 학생 작품 열람 — 최상위 관리자만 바꾼다. 기관 관리자는 지금 상태만 본다.
    h('div', { class: 'line', style: 'margin-top:16px' },
      h('div', { class: 'lab', style: 'margin:0', text: '기관 관리자가 학생 작품을 읽을 수 있게' + (S.me && S.me.platformAdmin ? '' : ' — ' + (readable ? '켜짐' : '꺼짐') + '(최상위 관리자가 정함)') }),
      S.me && S.me.platformAdmin ? h('button', { class: 'tg' + (readable ? ' on' : ''), onclick: async () => { await edu('org.settings', { orgId: id, adminCanReadProjects: !readable }); await load(); } }) : null));
}

// ---------------------------------------------------------------- 사용자(기관 관리자) — 한 사람 한 계정

async function showMembers(orgId) {
  const r = await edu('org.members', { orgId });
  if (!r.ok) return tell(r.error);
  S.members[orgId] = r.members;
  render();
}
const ROLE_SAY = { organization_admin: '기관 관리자', instructor: '강사', student: '학생' };

// 아이디 칸 — 치는 동안 쓸 수 있는지 미리 본다(잠깐 멈추면 묻는다). 만들 때도 서버가 다시 막는다.
function wireIdCheck(id, extra = () => ({})) {
  const n = $(id);
  if (!n || n.dataset.wired) return;
  n.dataset.wired = '1';
  const say = h('div', { class: 'when', style: 'margin-top:4px;min-height:18px' });
  n.after(say);
  let t = 0;
  n.addEventListener('input', () => {
    clearTimeout(t);
    say.textContent = '';
    const v = n.value.trim();
    if (!v) return;
    t = setTimeout(async () => {
      const r = await fetch('/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'login.available', loginId: v, ...extra() }) }).catch(() => null);
      const out = r ? await r.json().catch(() => ({})) : {};
      if (n.value.trim() !== v) return;   // 그 사이 더 쳤다
      say.textContent = out.ok ? out.say : '';
      say.className = out.ok && !out.available ? 'notice' : 'when';
    }, 400);
  });
}

// 강사(· 기관 관리자) 계정 직접 만들기 — 임시 비밀번호는 만든 자리에서 한 번만 보인다
function makeMemberBox(orgId) {
  const k = 'mk-' + orgId;
  const o = S.orgs[orgId];
  const st = S.open[k];
  if (!st) return h('button', { class: 'btn-line', text: '강사 계정 만들기', onclick: () => { S.open[k] = { role: 'instructor', classId: '' }; render(); } });
  const pick = (patch) => { Object.assign(st, patch); render(); };
  setTimeout(() => wireIdCheck(k + '-id'), 0);   // 그리기가 끝난 뒤
  const go = async () => {
    const r = await edu('member.create', { orgId, role: st.role, classId: st.classId || null, loginId: val(k + '-id'), displayName: val(k + '-name') });
    if (!r.ok) return tell(r.error);
    S.shown[k] = r.loginId + ' / 임시 비밀번호 ' + r.tempPassword;
    S.open[k] = null;
    if (S.members[orgId]) await showMembers(orgId); else render();
  };
  return h('div', { style: 'width:100%' },
    S.me && S.me.platformAdmin ? h('div', { class: 'line' },
      h('button', { class: st.role === 'instructor' ? 'btn' : 'btn-line', text: '강사', onclick: () => pick({ role: 'instructor' }) }),
      h('button', { class: st.role === 'organization_admin' ? 'btn' : 'btn-line', text: '기관 관리자', onclick: () => pick({ role: 'organization_admin', classId: '' }) })) : null,
    st.role === 'instructor' && o.classes.length ? h('div', { style: 'margin-top:8px' },
      h('div', { class: 'lab', text: '맡길 수업(나중에 정해도 됩니다)' }),
      h('div', { class: 'line' },
        h('button', { class: st.classId === '' ? 'btn' : 'btn-line', text: '아직 없음', onclick: () => pick({ classId: '' }) }),
        o.classes.filter((c) => c.status === 'active').map((c) => h('button', { class: st.classId === c.id ? 'btn' : 'btn-line', text: c.name, onclick: () => pick({ classId: c.id }) })))) : null,
    h('div', { class: 'line', style: 'align-items:flex-end;margin-top:8px' },
      field('아이디(영문 소문자 · 숫자, 3자 이상)', k + '-id', 'text', { autocapitalize: 'none', spellcheck: 'false' }),
      field('이름', k + '-name'),
      h('button', { class: 'btn-red', text: '만들기', onclick: go }),
      h('button', { class: 'btn-text', text: '닫기', onclick: () => { S.open[k] = null; render(); } })),
    h('div', { class: 'when', style: 'margin-top:6px', text: '임시 비밀번호가 한 번만 보입니다 — 본인에게 전하고 «내 계정»에서 바꾸게 해 주세요. 학생은 초대 코드로 들어옵니다.' }));
}

function membersBox(orgId) {
  const list = S.members[orgId];
  if (!list) return h('button', { class: 'btn-line', text: '사용자 목록', onclick: () => showMembers(orgId) });
  const reset = async (m) => {
    if (!confirm(m.name + '(' + m.loginId + ')의 비밀번호를 임시 비밀번호로 바꿀까요? 그 사람은 다시 로그인해야 합니다.')) return;
    const r = await edu('member.reset_password', { orgId, userId: m.userId });
    if (!r.ok) return tell(r.error);
    S.shown['pw-' + m.userId] = r.tempPassword;
    render();
  };
  const remove = async (m) => {
    if (!confirm(m.name + '(' + m.loginId + ')을(를) 기관에서 내보낼까요? 계정과 작품은 남고, 수업에서만 빠집니다.')) return;
    const r = await edu('member.remove', { orgId, userId: m.userId });
    if (!r.ok) return tell(r.error);
    await showMembers(orgId);
  };
  return h('div', null,
    h('button', { class: 'btn-line', text: '사용자 목록 닫기', onclick: () => { delete S.members[orgId]; render(); } }),
    h('div', { class: 'when', style: 'margin-top:8px', text: '학생 · 강사는 저마다 제 아이디로 들어옵니다(초대 코드는 수업에 들어오는 열쇠일 뿐 계정이 아닙니다).' }),
    list.map((m) => h('div', { style: 'padding:6px 0;border-bottom:1px solid var(--line-soft)' },
      h('div', { class: 'line' },
        h('div', { class: 'name', style: 'flex:1', text: (m.name || m.loginId) + ' · ' + m.loginId }),
        m.roles.map((r) => h('span', { class: 'mark', text: ROLE_SAY[r] || r })),
        m.classes.length ? h('div', { class: 'when', text: m.classes.join(', ') }) : null,
        S.me && m.loginId === S.me.loginId ? null : [
          h('button', { class: 'btn-text', text: '비밀번호 재설정', onclick: () => reset(m) }),
          h('button', { class: 'btn-text red', text: '내보내기', onclick: () => remove(m) }),
        ]),
      S.shown['pw-' + m.userId] ? h('div', { class: 'line', style: 'margin-top:6px' },
        h('div', { class: 'mark', style: 'font-size:15px;padding:6px 10px', text: S.shown['pw-' + m.userId] }),
        h('div', { class: 'when', text: '임시 비밀번호 — 지금만 보입니다. 전해 주고, 들어간 뒤 «비밀번호 바꾸기»로 바꾸게 해 주세요.' })) : null)),
    h('button', { class: 'btn-text', style: 'margin-top:8px', text: '다시 불러오기', onclick: () => showMembers(orgId) }));
}

// ---------------------------------------------------------------- 내 비밀번호

function passwordBox() {
  const k = 'pwbox';
  if (!S.open[k] && PAGE !== 'account') return h('button', { class: 'btn-text', text: '내 비밀번호 바꾸기', onclick: () => { S.open[k] = true; render(); } });
  const go = async () => {
    if (val('pw-next') !== val('pw-next2')) return tell('새 비밀번호가 서로 다릅니다');
    const r = await fetch('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: val('pw-cur'), next: val('pw-next') }) })
      .then((x) => x.json()).catch(() => ({ ok: false, error: '연결되지 않습니다' }));
    if (!r.ok) return tell(r.error);
    S.open[k] = false;
    tell('비밀번호를 바꿨습니다');
  };
  return section('내 비밀번호 바꾸기',
    h('div', { class: 'line', style: 'align-items:flex-end' },
      field('지금 비밀번호', 'pw-cur', 'password', { autocomplete: 'current-password' }),
      field('새 비밀번호(10자 이상)', 'pw-next', 'password', { autocomplete: 'new-password' }),
      field('새 비밀번호 한 번 더', 'pw-next2', 'password', { autocomplete: 'new-password' }),
      h('button', { class: 'btn-red', text: '바꾸기', onclick: go })));
}

// ---------------------------------------------------------------- 단계 · 강의 카드 고쳐 쓰기
// 운영자는 «전체 기본»을, 기관 관리자는 «제 기관»을 고친다. 원문(설정 파일)은 남고, 비우면 원래대로 돌아간다.
// 고칠 수 있는 칸: 이름 · 할 일 · 추천 참조(앞 단계만) · 끌 수 있음 · 카드(무엇인가 · 볼 점 · 질문) · 강사 메모.

async function loadWf(scopeKey, orgId) {
  const r = await edu('workflow.view', orgId ? { orgId } : {});
  if (!r.ok) return tell(r.error);
  S.wf[scopeKey] = r.workflow;
  render();
}

function wfEditor(orgId) {
  const sk = orgId || 'platform';
  const w = S.wf[sk];
  if (!w) return h('button', { class: 'btn-line', text: '단계 목록 열기', onclick: () => loadWf(sk, orgId) });
  const layerOf = (st) => (orgId ? st.organization : st.platform) || {};
  const close = () => h('button', { class: 'btn-line', style: 'margin-top:8px', text: '단계 목록 닫기', onclick: () => { delete S.wf[sk]; render(); } });
  return h('div', null, close(), w.stages.map((st) => {
    const k = sk + ':' + st.key;
    const mine = layerOf(st);
    const eff = st.effective;
    const head = h('div', { class: 'line', style: 'padding:6px 0;border-bottom:1px solid var(--line-soft);cursor:pointer', onclick: () => { S.wfOpen[k] = !S.wfOpen[k]; render(); } },
      h('div', { class: 'name', style: 'flex:1', text: st.n + '  ' + eff.title }),
      Object.keys(mine).length ? h('span', { class: 'mark', text: orgId ? '이 기관이 고침' : '고침' }) : null,
      !orgId ? null : st.platform ? h('span', { class: 'mark', text: '운영자가 고침' }) : null,
      h('span', { class: 'when', text: S.wfOpen[k] ? '접기 ▴' : '열기 ▾' }));
    if (!S.wfOpen[k]) return head;
    const id = (f) => 'wf-' + sk + '-' + st.key + '-' + f;
    const before = w.stages.filter((x) => x.n < st.n);
    const generates = st.output !== 'input' && st.output !== 'final';
    const save = async (clear) => {
      const typed = {
        title: val(id('title')), task: $(id('task')) ? $(id('task')).value : undefined, teachingNote: $(id('note')).value,
        optional: $(id('opt')) ? $(id('opt')).checked : undefined,
        tier: generates ? (Object.keys(TIER_CO).find((t) => $(id('t-' + t)) && $(id('t-' + t)).checked) || undefined) : undefined,
        inputs: before.some((x) => $(id('in-' + x.key))) ? before.filter((x) => $(id('in-' + x.key)).checked).map((x) => x.key) : undefined,
        card: { what: $(id('what')).value, look: $(id('look')).value.split('\n').map((x) => x.trim()).filter(Boolean), ask: $(id('ask')).value },
      };
      // 아래 층(원문, 기관이면 원문 + 운영자)과 같은 칸은 보내지 않는다 — 안 고친 칸을 얼려 두지 않게
      const below = { ...st.original, ...(orgId ? st.platform || {} : {}) };
      const emptyCard = (c) => !c || (!c.what && !(c.look || []).length && !c.ask);
      const norm = (k, v) => k === 'card' ? (emptyCard(v) ? 'null' : JSON.stringify({ what: v.what || '', look: v.look || [], ask: v.ask || '' }))
        : k === 'inputs' ? JSON.stringify([...(v || [])].sort()) : k === 'optional' ? String(!!v) : JSON.stringify(v === '' || v == null ? null : v);
      const same = (k) => norm(k, typed[k]) === norm(k, below[k]);
      const data = {};
      if (!clear) for (const k of Object.keys(typed)) if (typed[k] !== undefined && !same(k)) data[k] = typed[k];
      const r = await edu('workflow.save', { ...(orgId ? { orgId } : {}), stageKey: st.key, data });
      if (!r.ok) return tell(r.error);
      S.say = (clear ? '원래대로 되돌렸습니다' : '저장했습니다 — 다음 생성부터 쓰입니다') + ' (' + st.n + '  ' + (clear ? st.original.title : (data.title || st.effective.title)) + ')';
      S.wfOpen[k] = false;   // 저장하면 그 단계는 접는다
      await loadWf(sk, orgId);
    };
    const box = (f, label, value, big, hint) => h('div', { style: 'margin-top:10px' },
      h('div', { class: 'lab', text: label }),
      big ? h('textarea', { id: id(f), placeholder: hint || '' }) : h('input', { id: id(f), type: 'text', placeholder: hint || '' }));
    const form = h('div', { style: 'padding:6px 0 14px' },
      box('title', '단계 이름', '', false, st.original.title),
      generates ? box('task', '이 단계에서 하는 일(AI 에게 주는 «이번 단계에 할 일»)', '', true) : null,
      generates && before.length ? h('div', { style: 'margin-top:10px' }, h('div', { class: 'lab', text: '추천 참조(앞 단계 결과를 자동으로 체크해 보여 줌)' }),
        h('div', { class: 'line' }, before.map((x) => h('label', { class: 'line', style: 'gap:4px' },
          h('input', { id: id('in-' + x.key), type: 'checkbox' }), h('span', { text: x.effective.title }))))) : null,
      generates ? h('label', { class: 'line', style: 'gap:6px;margin-top:10px' }, h('input', { id: id('opt'), type: 'checkbox' }), h('span', { text: '학생 · 작가가 이 단계를 끌 수 있음' })) : null,
      generates ? h('div', { style: 'margin-top:10px' }, h('div', { class: 'lab', text: '기본 등급(학생 · 작가가 고르지 않았을 때 — 온라인판)' }),
        h('div', { class: 'line' }, Object.entries(TIER_CO).map(([t, name]) => h('label', { class: 'line', style: 'gap:4px' },
          h('input', { id: id('t-' + t), type: 'radio', name: id('tier') }), h('span', { text: name }))))) : null,
      box('what', '강의 카드 — 무엇인가', '', true),
      box('look', '강의 카드 — 볼 점(한 줄에 하나)', '', true),
      box('ask', '강의 카드 — 생각해 볼 질문', '', false),
      box('note', '강사 메모(강사 화면에만)', '', true),
      h('div', { class: 'line', style: 'margin-top:12px' },
        h('button', { class: 'btn-red', text: '저장', onclick: () => save(false) }),
        h('button', { class: 'btn-line', text: '닫기', onclick: () => { S.wfOpen[k] = false; render(); } }),
        Object.keys(mine).length ? h('button', { class: 'btn-text', text: '원래대로', onclick: () => save(true) }) : null,
        h('div', { class: 'when', text: '원문은 그대로 남습니다' })));
    // 칸에 지금 값(합친 결과)을 채워 둔다 — 그리기가 끝난 뒤
    setTimeout(() => {
      const set = (f, v) => { const n = $(id(f)); if (n && !n.dataset.filled) { n.value = v == null ? '' : v; n.dataset.filled = '1'; } };
      set('title', eff.title); set('task', eff.task); set('note', eff.teachingNote);
      set('what', eff.card && eff.card.what); set('look', eff.card ? (eff.card.look || []).join('\n') : ''); set('ask', eff.card && eff.card.ask);
      const opt = $(id('opt')); if (opt && !opt.dataset.filled) { opt.checked = !!eff.optional; opt.dataset.filled = '1'; }
      const tr = eff.tier && $(id('t-' + eff.tier)); if (tr && !tr.dataset.filled) { tr.checked = true; tr.dataset.filled = '1'; }
      for (const x of before) { const c = $(id('in-' + x.key)); if (c && !c.dataset.filled) { c.checked = (eff.inputs || []).includes(x.key); c.dataset.filled = '1'; } }
    }, 0);
    return h('div', null, head, form);
  }), close());
}

// ---------------------------------------------------------------- 운영(플랫폼 관리자)

function platformBox() {
  if (!S.me || !S.me.platformAdmin) return null;
  const addOrg = async () => { const r = await edu('org.create', { name: val('no-name'), slug: val('no-slug') }); if (!r.ok) return tell(r.error); await load(); };
  // 쓸 수 있는 AI 회사 · 등급 — 아무것도 고르지 않으면 모두
  const liveOf = (orgId) => ((S.orgs[orgId].lic || {}).licenses || []).find((l) => l.status === 'active' && (!l.ends_at || new Date(l.ends_at) > new Date()));
  const limOf = (orgId) => {
    if (!S.lim[orgId]) { const l = liveOf(orgId) || {}; S.lim[orgId] = { p: [...(l.allowed_providers || [])], t: [...(l.allowed_model_tiers || [])] }; }
    return S.lim[orgId];
  };
  const flip = (xs, x) => { const i = xs.indexOf(x); if (i < 0) xs.push(x); else xs.splice(i, 1); render(); };
  const issue = async (orgId) => {
    const lim = limOf(orgId);
    const r = await edu('license.issue', { orgId, days: Number(val('ld-' + orgId)) || 30, seatLimit: Number(val('ls-' + orgId)) || null, allowedProviders: lim.p, allowedTiers: lim.t });
    if (!r.ok) return tell(r.error);
    await load();
  };
  const saveLimits = async (orgId) => {
    const l = liveOf(orgId); const lim = limOf(orgId);
    const r = await edu('license.limits', { licenseId: l.id, allowedProviders: lim.p, allowedTiers: lim.t });
    if (!r.ok) return tell(r.error);
    S.say = '쓸 수 있는 범위를 바꿨습니다';
    await load();
  };
  const limRow = (orgId) => {
    const lim = limOf(orgId);
    const chip = (xs, x, name) => h('button', { class: xs.includes(x) ? 'btn' : 'btn-line', text: name, onclick: () => flip(xs, x) });
    return h('div', { class: 'line', style: 'margin:4px 0 6px' },
      h('span', { class: 'when', text: '쓸 수 있는 AI' }), Object.entries(AI_CO).map(([p, n]) => chip(lim.p, p, n)),
      h('span', { class: 'when', text: '등급' }), Object.entries(TIER_CO).map(([t, n]) => chip(lim.t, t, n)),
      h('span', { class: 'when', text: lim.p.length || lim.t.length ? '' : '(고르지 않으면 모두)' }),
      liveOf(orgId) ? h('button', { class: 'btn-text', text: '지금 이용 기간에 적용', onclick: () => saveLimits(orgId) }) : null);
  };
  return section('운영 — 기관 · 이용 기간 · 단계',
    h('div', { class: 'lab', text: '단계 · 강의 카드 고쳐 쓰기(전체 기본 — 모든 기관 · 개인에게)' }),
    wfEditor(null),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '기관' }),
    h('div', { class: 'line', style: 'align-items:flex-end' }, field('기관 이름', 'no-name'), field('영문 약칭(선택 — 비워 두면 자동)', 'no-slug', 'text', { placeholder: '예: sea-school', autocapitalize: 'none', spellcheck: 'false' }),
      h('button', { class: 'btn-line', text: '기관 만들기', onclick: addOrg })),
    Object.values(S.orgs).map(({ org }) => [h('div', { class: 'line', style: 'margin-top:10px;align-items:flex-end' },
      h('div', { class: 'name', style: 'flex:1;font-weight:600', text: org.name }),
      field('이용 일수', 'ld-' + org.id, 'text', { value: '90' }), field('학생 자리', 'ls-' + org.id, 'text', { value: '40' }),
      h('button', { class: 'btn-line', text: '이용 기간 열기', onclick: () => issue(org.id) })), limRow(org.id)]));
}

// 화면 밝기 — 기본은 어둡게, 고르면 이 브라우저가 기억한다
function themeBox() {
  const light = document.documentElement.dataset.theme === 'light';
  const flip = () => {
    if (light) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = 'light';
    try { localStorage.setItem('se-theme', light ? 'dark' : 'light'); } catch { /* 이번 창에서만 */ }
    render();
  };
  return section('화면',
    h('div', { class: 'line' }, h('div', { class: 'lab', style: 'margin:0', text: '밝은 화면' }), h('button', { class: 'tg' + (light ? ' on' : ''), onclick: flip })));
}

// ---------------------------------------------------------------- 그리기

// 지금 들어와 있는 아이디와 신분 — 위쪽 제목 아래(여럿이면 모두)
function whoLine() {
  if (!S.me || !S.me.loginId) return null;
  const held = new Set([...(S.me.organizations || []).flatMap((o) => o.roles || []), ...(S.me.classes || []).map((c) => c.role)]);
  const names = [S.me.platformAdmin ? '최상위 관리자' : null, ...['organization_admin', 'instructor', 'student'].filter((r) => held.has(r)).map((r) => ROLE_SAY[r])].filter(Boolean);
  return h('div', { class: 'who' }, h('span', { class: 'who-id', text: S.me.loginId }), h('span', { text: names.length ? names.join(' · ') : '개인' }));
}

function render() {
  const head = (title) => h('div', { class: 'line', style: 'margin-bottom:22px;align-items:flex-start' },
    h('div', { style: 'flex:1' }, h('div', { class: 'top-name', style: 'font-size:28px', text: title }), whoLine()),
    S.loggedIn ? h('a', { class: 'btn-line', href: '/', text: '작업실로' }) : h('a', { class: 'btn-line', href: '/login', text: '로그인' }));
  const notice = S.say ? h('div', { class: 'notice', style: 'margin-bottom:14px', text: S.say }) : null;
  if (PAGE === 'manage') {
    // 관리 화면 — 운영자 · 기관 관리자만. 서버도 문마다 다시 본다(이 갈림은 안내일 뿐이다).
    const can = S.me && (S.me.platformAdmin || Object.keys(S.orgs).length);
    $('root').replaceChildren(h('div', { class: 'body' }, head('관리'), notice,
      !S.loggedIn ? h('div', { class: 'when', text: '로그인이 필요합니다' })
        : !can ? h('div', { class: 'when', text: '관리 권한이 없습니다 — 운영자나 기관 관리자만 들어옵니다' })
          : [platformBox(), Object.keys(S.orgs).map(orgBox)]));
    return;
  }
  if (PAGE === 'account') {
    $('root').replaceChildren(h('div', { class: 'body' }, head('내 계정'), notice,
      S.loggedIn ? [joinBox(), myKeyBox(), passwordBox(), themeBox()] : h('div', { class: 'when', text: '로그인이 필요합니다' })));
    return;
  }
  $('root').replaceChildren(h('div', { class: 'body' }, head('내 수업'), notice,
    S.loggedIn ? (myClasses() || h('div', { class: 'when', style: 'margin-bottom:14px', text: '들어가 있는 수업이 없습니다' })) : h('div', { class: 'when', text: '로그인이 필요합니다' }),
    S.loggedIn ? joinBox() : null));
}

load();
