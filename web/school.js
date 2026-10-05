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
// 알림 — 잘 된 일은 파랑(good), 막힌 일 · 오류는 빨강(2026-10-05 사용자 지시)
const tell = (text, good = false) => { S.say = text || ''; S.sayGood = good; render(); };
const done = (text) => tell(text, true);

// ---------------------------------------------------------------- 불러오기

// 초대 링크를 들고 «내 계정»으로 왔으면(이미 로그인한 사람) 코드를 채워 둔다
{
  const q = new URLSearchParams(location.search);
  S.linkInvite = PAGE === 'account' ? q.get('invite') || '' : '';
  if (S.linkInvite) { history.replaceState(null, '', location.pathname); S.sayGood = true; S.say = '초대 링크로 왔습니다 — 아래 «새 수업 코드 넣기»의 [들어가기]를 누르면 지금 계정으로 참여합니다'; }
}

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
const codeBox = (key, note = '«초대 코드 목록»에서도 다시 볼 수 있습니다') => (S.shown[key] ? h('div', { class: 'line', style: 'margin-top:10px' },
  h('div', { class: 'mark', style: 'font-size:15px;padding:6px 10px', text: S.shown[key] }),
  copyBtn(S.shown[key]),
  // 초대 코드면 링크로도 보낸다(누르면 코드가 채워진 «계정 만들기»가 열린다). 계정 · 비밀번호(mk-)는 링크로 보내지 않는다.
  key.startsWith('mk-') ? null : linkBtns(inviteUrl(S.shown[key]), '스토리 엔진 초대'),
  h('div', { class: 'when', text: note })) : null);
// 링크로 보내기 — 코드를 손으로 옮기지 않게. [링크 복사]는 어디서나, [보내기]는 휴대폰의 공유 창(카카오톡 · 문자 …)이 있을 때만.
const inviteUrl = (code) => location.origin + '/login?invite=' + encodeURIComponent(code);
const resetUrl = (code, loginId) => location.origin + '/login?reset=' + encodeURIComponent(code) + '&id=' + encodeURIComponent(loginId || '');
const linkBtns = (url, title) => [
  h('button', { class: 'btn-text', text: '링크 복사', onclick: async () => {
    try { await navigator.clipboard.writeText(url); done('링크를 복사했습니다 — 카카오톡 · 문자 · 메일에 붙여 넣어 보내세요'); } catch { tell('복사하지 못했습니다 — ' + url); }
  } }),
  navigator.share ? h('button', { class: 'btn-text', text: '보내기', onclick: () => navigator.share({ title, url }).catch(() => {}) }) : null,
];
// 복사 — 안 되는 브라우저(보안 연결이 아닌 곳 등)에서는 조용히 넘어간다(코드는 화면에 그대로 있다)
const copyBtn = (code) => h('button', { class: 'btn-text', text: '복사', onclick: async () => {
  try { await navigator.clipboard.writeText(code); done('복사했습니다'); } catch { tell('복사하지 못했습니다 — 화면의 코드를 적어 주세요'); }
} });

// 아직 쓸 수 있는 초대 코드 — 열고 닫는다. 코드도 함께 보인다(서버가 봉해 둔 것을 열어 준다 — 옛 코드는 빈칸). 새어 나갔으면 취소한다.
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
      x.code ? h('div', { class: 'mark', style: 'font-size:14px;padding:4px 8px', text: x.code }) : h('span', { class: 'when', text: '(코드를 다시 보일 수 없는 옛 코드)' }),
      x.code ? copyBtn(x.code) : null,
      x.code ? linkBtns(inviteUrl(x.code), '스토리 엔진 초대') : null,
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
    S.sayGood = true; S.say = '들어왔습니다 — «내 수업»에 보입니다';
    await load();
  };
  return section('새 수업 코드 넣기',
    h('div', { class: 'line', style: 'align-items:flex-end' },
      field('초대 코드', 'j-code', 'text', { placeholder: 'ABCD-EFGH-JKLM', autocapitalize: 'characters', spellcheck: 'false', value: S.linkInvite || '' }),
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
      s.projectId && p.canRead ? h('a', { class: 'btn-text', href: '/?pid=' + encodeURIComponent(s.projectId), text: '읽기' }) : null,
      h('button', { class: 'btn-text', text: '비밀번호 재설정 코드', onclick: () => giveResetCode(p.class.organizationId, { userId: s.userId, name: s.name, loginId: s.loginId }, () => reloadProgress(c)) }),
      resetLine(s.resetCode, s.loginId),
      s.stage && s.stage.teachingNote ? h('button', { class: 'btn-text', text: '강의 포인트', onclick: () => { S.open['tn-' + s.userId] = !S.open['tn-' + s.userId]; render(); } }) : null,
      S.open['tn-' + s.userId] && s.stage ? h('div', { class: 'when', style: 'width:100%;white-space:normal', text: s.stage.title + ' — ' + s.stage.teachingNote }) : null))
    : h('div', { class: 'when', text: '아직 학생이 없습니다' }));
}

async function reloadProgress(c) {
  const r = await edu('class.progress', { classId: c.id });
  if (r.ok) { S.progress[c.id] = r; render(); }
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
  done('복사했습니다 — 작업실의 «' + w.name + ' (개인)»');
}

// AI 회사 — 키를 넣을 때 고른다. 여럿 넣어 두면 Claude → ChatGPT → Gemini 차례로 쓴다(서버 ai/router.mjs).
const AI_CO = { anthropic: 'Claude', openai: 'ChatGPT', google: 'Gemini' };
const AI_KEY_LABEL = { anthropic: 'Claude(Anthropic) API 키', openai: 'ChatGPT(OpenAI) API 키', google: 'Gemini(Google) API 키' };
S.prov = {};
S.lim = {};
S.dates = {};
S.audit = {};
S.ops = null;
const provOf = (k) => S.prov[k] || 'anthropic';
const providerPick = (k) => h('div', { class: 'line', style: 'margin-top:10px' },
  Object.entries(AI_CO).map(([p, name]) => h('button', { class: provOf(k) === p ? 'btn' : 'btn-line', text: name, onclick: () => { S.prov[k] = p; render(); } })));
// 쓸 AI 회사 고르기 — 키가 없는 회사는 «키 없음»을 단다(골라도 키를 넣기 전에는 «연결 필요»로 멈춘다)
// 키를 넣은 회사만 고른다(서버도 막는다). 처음 넣은 키의 회사가 저절로 기본이 된다.
function aiChoice(label, current, keys, save, allowed) {
  const have = new Set((keys || []).filter((x) => x.status === 'active').map((x) => x.provider));
  const list = Object.entries(AI_CO).filter(([p]) => have.has(p) && (!allowed || allowed.includes(p)));
  return h('div', { style: 'margin-top:12px' },
    h('div', { class: 'lab', text: label }),
    list.length ? h('div', { class: 'line' }, list.map(([p, name]) => h('button', {
      class: (current || list[0][0]) === p ? 'btn' : 'btn-line', text: name, onclick: () => save(p),
    }))) : h('div', { class: 'when', text: '아직 AI 키가 없습니다 — 아래에서 키를 넣으면 그 회사가 기본이 됩니다' }));
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
    done('확인하는 중…');
    const r = await edu(op + '.test', { ...extra, provider: x.provider });
    tell(r.ok ? (AI_CO[x.provider] + ' — ' + r.say) : r.error, !!(r.ok && r.verified));
    await reload();
  };
  const revoke = async (x) => {
    if (!confirm(AI_CO[x.provider] + ' 키를 지울까요? 이 키로 돌던 AI 작업은 «연결 필요»로 멈춥니다.')) return;
    const r = await edu(op + '.revoke', { ...extra, provider: x.provider });
    if (!r.ok) return tell(r.error);
    done('지웠습니다');
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
    if (S.me && r.aiProvider != null) S.me.aiProvider = r.aiProvider;
    S.myKeys = (await edu('me.key.list')).credentials || [];
    done('저장했습니다');
  };
  return section('내 AI 키',
    keyRows(S.myKeys, 'me.key', {}, load),
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

// ---------------------------------------------------------------- 감사 기록 · 운영 현황(열었다 닫는다)

const ACT = {
  'org.create': '기관 만듦', 'org.settings': '기관 설정', 'org.status': '기관 상태', 'license.issue': '이용 기간 엶', 'license.status': '이용 기간 상태',
  'license.limits': '쓸 수 있는 범위', 'class.create': '수업 만듦', 'class.dates': '수업 기간', 'class.archive': '수업 닫음', 'class.reopen': '수업 다시 엶', 'invite.create': '초대 코드',
  'invite.revoke': '초대 코드 거둠', 'invite.accept': '초대로 들어옴', 'credential.set': 'AI 키 넣음', 'credential.revoke': 'AI 키 지움', 'member.create': '계정 만듦',
  'member.remove': '사용자 뺌', 'member.reset_password': '비밀번호 재설정', 'workflow.save': '단계 고침', 'project.create': '작품 만듦', 'project.delete': '작품 지움',
  'project.copy_personal': '개인 작품으로 복사', 'project.import': '작품 가져옴', 'ai.choose': 'AI 회사 고름', 'auth.login': '로그인', 'auth.login_failed': '로그인 실패',
  'auth.password_changed': '비밀번호 바꿈', 'user.status': '계정 상태', 'admin.password_reset': '비밀번호 재설정(도구)', 'admin.user_created': '계정 만듦(도구)', 'setup.first_admin': '첫 관리자 만듦',
};
const when = (t) => (t ? new Date(t).toLocaleString() : '');
async function toggleAudit(key, orgId) {
  if (S.audit[key]) { delete S.audit[key]; return render(); }
  const r = await edu('audit.list', orgId ? { orgId } : {});
  if (!r.ok) return tell(r.error);
  S.audit[key] = r.entries; render();
}
const auditRows = (key) => (S.audit[key] ? h('div', { style: 'margin-top:8px' }, h('div', { class: 'lab', text: '감사 기록(최근 50)' }), S.audit[key].length
  ? S.audit[key].map((a) => h('div', { class: 'row', style: 'cursor:default' },
    h('div', { class: 'name', text: (ACT[a.action] || a.action) + (a.org_name ? ' · ' + a.org_name : '') }),
    h('span', { class: 'mark', text: a.actor || '-' }),
    h('div', { class: 'when', text: when(a.at) })))
  : h('div', { class: 'when', text: '아직 없습니다' })) : null);

async function toggleOps() {
  if (S.ops) { S.ops = null; return render(); }
  const r = await edu('ops.overview');
  if (!r.ok) return tell(r.error);
  S.ops = r; render();
}
const JOB_ST = { queued: '대기', running: '도는 중', paused: '멈춤', waiting_for_user: '답 기다림', done: '끝남', failed: '실패', cancelled: '취소' };
function opsBox() {
  const o = S.ops;
  if (!o) return null;
  return h('div', { style: 'margin-top:8px' },
    h('div', { class: 'lab', text: '작업(진행 중 + 지난 24시간)' }),
    h('div', { class: 'line' }, o.jobs.length ? o.jobs.map((j) => h('span', { class: 'mark', text: (JOB_ST[j.status] || j.status) + ' ' + j.n })) : h('span', { class: 'when', text: '없음' }),
      o.stuck ? h('span', { class: 'mark', style: 'color:var(--red)', text: '응답 없는 작업 ' + o.stuck }) : null),
    h('div', { class: 'lab', style: 'margin-top:12px', text: '최근 실패한 작업' }),
    o.failures.length ? o.failures.map((f) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: (f.error_message_safe || f.error_code || '실패') + ' · ' + f.kind }),
      h('span', { class: 'mark', text: (f.org_name || '개인') + ' · ' + (f.login_id || '-') }),
      h('div', { class: 'when', text: when(f.at) }))) : h('div', { class: 'when', text: '없음' }),
    h('div', { class: 'lab', style: 'margin-top:12px', text: 'AI 호출(지난 24시간)' }),
    o.calls.length ? h('div', { class: 'line' }, o.calls.map((c) => h('span', { class: 'mark', text: (c.provider || '-') + ' · ' + (c.status === 'succeeded' ? '성공' : c.error_code || c.status) + ' ' + c.n })))
      : h('div', { class: 'when', text: '없음' }),
    h('div', { class: 'lab', style: 'margin-top:12px', text: '사용량(최근 석 달 · 추정)' }),
    o.usage.length ? o.usage.map((u) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: u.month + ' · ' + u.who }),
      h('span', { class: 'mark', text: (u.payer === 'organization' ? '기관 키' : u.payer === 'user' ? '개인 키' : u.payer || '-') + ' · 호출 ' + u.calls }),
      h('div', { class: 'when', text: '$' + u.cost_usd.toFixed(2) }))) : h('div', { class: 'when', text: '없음' }));
}

// ---------------------------------------------------------------- 기관 관리

// ---------------------------------------------------------------- 기관 관리 — 상태 카드 하나 + 탭 넷(수업 · 사용자 · AI · 설정)
// 한 눈에: 맨 위 카드가 «지금 이 기관이 돌아가는가»(이용 기간 · AI 키 · 시작 등급)를 보이고, 빠진 것은 붉게 짚어 그 탭으로 데려간다.

const liveOf = (orgId) => ((S.orgs[orgId] && S.orgs[orgId].lic || {}).licenses || []).find((l) => l.status === 'active' && (!l.ends_at || new Date(l.ends_at) > new Date()));
const pausedLic = (orgId) => ((S.orgs[orgId] && S.orgs[orgId].lic || {}).licenses || []).find((l) => l.status === 'suspended' && (!l.ends_at || new Date(l.ends_at) > new Date()));
const keyedOf = (keys) => [...new Set((keys || []).filter((x) => x.status === 'active').map((x) => x.provider))];
const tabRow = (list, cur, pick) => h('div', { class: 'line', style: 'margin:4px 0 14px' },
  list.map(([k, name]) => h('button', { class: cur === k ? 'btn' : 'btn-line', text: name, onclick: () => pick(k) })));
const toggleRow = (label, on, flip, note) => h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' },
  h('div', { class: 'line' }, h('div', { class: 'name', style: 'flex:1', text: label }), flip ? h('button', { class: 'tg' + (on ? ' on' : ''), onclick: flip }) : h('span', { class: 'mark', text: on ? '켜짐' : '꺼짐' })),
  note ? h('div', { class: 'when', style: 'margin-top:2px', text: note }) : null);
S.sub = {};

function orgView(id) {
  const o = S.orgs[id];
  // 처음 열 때 — AI 키가 없으면 [AI] 부터(그것 없이는 학생 작업이 돌지 않는다), 있으면 [수업]
  const tab = S.sub[id] || (keyedOf(o.keys).length ? '수업' : 'AI');
  const go = (t) => { S.sub[id] = t; render(); };
  return h('div', null,
    orgCard(id, go),
    tabRow([['수업', '수업'], ['사용자', '사용자'], ['AI', 'AI'], ['설정', '설정']], tab, go),
    tab === '수업' ? classesTab(id) : tab === '사용자' ? usersTab(id) : tab === 'AI' ? aiTab(id) : settingsTab(id));
}

// 상태 카드 — 이용 기간 · AI · 시작 등급. 빠진 것은 붉게, 누르면 고칠 자리로.
function orgCard(id, go) {
  const { org, lic, keys } = S.orgs[id];
  const live = liveOf(id);
  const keyed = keyedOf(keys);
  const prov = (org.settings && org.settings.ai_provider) || '';
  const tier = (org.settings && org.settings.ai_tier) || 'balanced';
  const item = (label, text, bad, onclick) => h('div', { style: 'min-width:150px;flex:1;cursor:' + (onclick ? 'pointer' : 'default'), onclick },
    h('div', { class: 'lab', text: label }),
    h('div', { style: 'font-weight:600' + (bad ? ';color:var(--red)' : ''), text }));
  return h('div', { class: 'card-box', style: 'margin-bottom:14px' },
    h('div', { class: 'line', style: 'margin-bottom:8px' },
      h('div', { class: 'name', style: 'flex:1;font-size:18px;font-weight:700', text: org.name }),
      org.status !== 'active' ? h('span', { class: 'mark', style: 'color:var(--red)', text: '멈춤' }) : null),
    h('div', { class: 'line', style: 'align-items:flex-start' },
      item('이용 기간', live ? '~ ' + (live.ends_at ? day(live.ends_at) : '기한 없음') + ' · 학생 ' + (lic.seatsUsed || 0) + (live.seat_limit ? '/' + live.seat_limit : '') : '없음 — ' + (S.me.platformAdmin ? '아래에서 여세요' : '운영자에게 요청'), !live),
      item('AI', keyed.length ? (AI_CO[prov] || AI_CO[keyed[0]]) + ' 사용' : '키 없음 — 넣기', !keyed.length, () => go('AI')),
      item('새 수업 작품 시작 등급', TIER_CO[tier], false, () => go('AI'))),
    S.me.platformAdmin ? operatorRow(id) : null);
}

// 운영자만 — 이용 기간(기본값 90일 · 40자리 · 범위 모두) · 범위 · 멈추기
function operatorRow(id) {
  const { org } = S.orgs[id];
  const live = liveOf(id); const paused = pausedLic(id);
  const k = 'lic-' + id;
  if (!S.lim[id]) { const l = live || {}; S.lim[id] = { p: [...(l.allowed_providers || [])], t: [...(l.allowed_model_tiers || [])] }; }
  const lim = S.lim[id];
  const flip = (xs, x) => { const i = xs.indexOf(x); if (i < 0) xs.push(x); else xs.splice(i, 1); render(); };
  const issue = async () => {
    const days = Number(val('ld-' + id)) || 90;
    if (live && !confirm('이미 이용 기간이 있습니다. 오늘부터 ' + days + '일짜리 이용 기간을 새로 열까요?')) return;
    const r = await edu('license.issue', { orgId: id, days, seatLimit: Number(val('ls-' + id)) || null, allowedProviders: lim.p, allowedTiers: lim.t });
    if (!r.ok) return tell(r.error);
    S.open[k] = false;
    S.sayGood = true; S.say = org.name + ' — 이용 기간을 열었습니다(~ ' + day(r.license.ends_at) + ' · 학생 ' + (r.license.seat_limit || '제한 없음') + '자리)';
    await load();
  };
  const saveLimits = async () => {
    const r = await edu('license.limits', { licenseId: live.id, allowedProviders: lim.p, allowedTiers: lim.t });
    if (!r.ok) return tell(r.error);
    S.open[k] = false; S.sayGood = true; S.say = '쓸 수 있는 범위를 바꿨습니다'; await load();
  };
  const orgStatus = async () => {
    const to = org.status === 'active' ? 'suspended' : 'active';
    if (to === 'suspended' && !confirm(org.name + ' — 기관 이용을 멈출까요? 새 작품 · AI 작업이 서지 않습니다(작품은 그대로).')) return;
    const r = await edu('org.status', { orgId: id, status: to });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.say = org.name + (to === 'active' ? ' — 다시 열었습니다' : ' — 멈췄습니다'); await load();
  };
  const licStatus = async (l, to) => {
    if (to === 'suspended' && !confirm('이용 기간을 멈출까요? 새 작품 · AI 작업이 서지 않습니다.')) return;
    const r = await edu('license.status', { licenseId: l.id, status: to });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.say = org.name + ' 이용 기간 — ' + (to === 'active' ? '다시 열었습니다' : '멈췄습니다'); await load();
  };
  const chip = (xs, x, name) => h('button', { class: xs.includes(x) ? 'btn' : 'btn-line', text: name, onclick: () => flip(xs, x) });
  return h('div', { style: 'margin-top:12px;padding-top:10px;border-top:1px solid var(--line-soft)' },
    h('div', { class: 'line' },
      h('span', { class: 'when', text: '운영자' }),
      h('button', { class: 'btn-line', text: S.open[k] ? '닫기' : live ? '이용 기간 · 범위' : '이용 기간 열기', onclick: () => { S.open[k] = !S.open[k]; render(); } }),
      live ? h('button', { class: 'btn-text red', text: '이용 기간 멈추기', onclick: () => licStatus(live, 'suspended') })
        : paused ? h('button', { class: 'btn-text', text: '이용 기간 다시 열기', onclick: () => licStatus(paused, 'active') }) : null,
      h('button', { class: 'btn-text' + (org.status === 'active' ? ' red' : ''), text: org.status === 'active' ? '기관 멈추기' : '기관 다시 열기', onclick: orgStatus })),
    S.open[k] ? h('div', { style: 'margin-top:10px' },
      h('div', { class: 'lab', text: '쓸 수 있는 AI · 등급(아무것도 고르지 않으면 모두)' }),
      h('div', { class: 'line' }, Object.entries(AI_CO).map(([p, n]) => chip(lim.p, p, n)), h('span', { class: 'when', text: '·' }), Object.entries(TIER_CO).map(([t, n]) => chip(lim.t, t, n))),
      live ? h('div', { class: 'line', style: 'margin-top:6px' }, h('button', { class: 'btn-line', text: '지금 이용 기간에 범위 적용', onclick: saveLimits })) : null,
      h('div', { class: 'line', style: 'margin-top:10px;align-items:flex-end' },
        field('이용 일수', 'ld-' + id, 'text', { value: '90' }), field('학생 자리', 'ls-' + id, 'text', { value: '40' }),
        h('button', { class: 'btn-red', text: live ? '새 이용 기간 열기' : '이용 기간 열기', onclick: issue }))) : null);
}

// 수업 — 한 줄에 이름 · 기간 · 학생 수와 자주 쓰는 둘(학생 초대 코드 · 현황). 나머지는 [더보기].
function classesTab(id) {
  const { classes } = S.orgs[id];
  const nk = 'nc-open-' + id;
  const addClass = async () => {
    const r = await edu('class.create', { orgId: id, name: val('nc-' + id), startsAt: val('ncs-' + id), endsAt: val('nce-' + id) });
    if (!r.ok) return tell(r.error);
    S.open[nk] = false; S.sayGood = true; S.say = '«' + r.class.name + '» 수업을 만들었습니다 — [학생 초대 코드]로 학생을 부르세요'; await load();
  };
  const saveDates = async (c) => {
    const r = await edu('class.dates', { classId: c.id, startsAt: val('cds-' + c.id), endsAt: val('cde-' + c.id) });
    if (!r.ok) return tell(r.error);
    S.dates[c.id] = false; S.sayGood = true; S.say = '수업 기간을 바꿨습니다'; await load();
  };
  const archive = async (c) => {
    const closing = c.status === 'active';
    if (closing && !confirm('«' + c.name + '» 수업을 닫을까요?\n닫으면 이 수업에 새 작품을 만들거나 초대 코드로 새로 들어올 수 없습니다.\n이미 든 학생과 작품은 그대로 남고, «다시 열기»로 되돌릴 수 있습니다.')) return;
    const r = await edu('class.archive', { classId: c.id, reopen: !closing });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.say = '«' + c.name + '» ' + (closing ? '수업을 닫았습니다' : '수업을 다시 열었습니다'); await load();
  };
  const sorted = [...classes].sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1));
  return h('div', null,
    S.open[nk] ? h('div', { class: 'card-box', style: 'margin-bottom:12px' },
      h('div', { class: 'line', style: 'align-items:flex-end' }, field('수업 이름', 'nc-' + id),
        field('시작하는 날(선택)', 'ncs-' + id, 'date'), field('끝나는 날(선택)', 'nce-' + id, 'date')),
      h('div', { class: 'line', style: 'margin-top:10px' }, h('button', { class: 'btn-red', text: '만들기', onclick: addClass }),
        h('button', { class: 'btn-text', text: '취소', onclick: () => { S.open[nk] = false; render(); } })))
      : h('button', { class: 'btn', style: 'margin-bottom:12px', text: '+ 새 수업', onclick: () => { S.open[nk] = true; render(); } }),
    sorted.length ? sorted.map((c) => {
      const more = S.open['more-' + c.id];
      return h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' + (c.status === 'active' ? '' : ';opacity:.6') },
        h('div', { class: 'line' },
          h('div', { class: 'name', style: 'flex:1;font-weight:600', text: c.name + (c.status === 'active' ? '' : ' (닫힘)') }),
          period(c) ? h('span', { class: 'when', text: period(c) }) : null,
          h('span', { class: 'mark', text: '학생 ' + (c.students || 0) }),
          c.status === 'active' ? h('button', { class: 'btn-text', text: '학생 초대 코드', onclick: () => makeInvite('s-' + c.id, id, c.id, 'student') }) : null,
          h('button', { class: 'btn-text', text: S.progress[c.id] ? '현황 닫기' : '현황', onclick: () => showProgress(c) }),
          h('button', { class: 'btn-text', text: more ? '접기' : '더보기', onclick: () => { S.open['more-' + c.id] = !more; render(); } })),
        more ? h('div', { class: 'line', style: 'margin-top:6px' },
          c.status === 'active' ? h('button', { class: 'btn-line', text: '강사 초대 코드', onclick: () => makeInvite('i-' + c.id, id, c.id, 'instructor') }) : null,
          h('button', { class: 'btn-line', text: S.dates[c.id] ? '기간 닫기' : '수업 기간', onclick: () => { S.dates[c.id] = !S.dates[c.id]; render(); } }),
          inviteList('c-' + c.id, id, c.id),
          h('button', { class: 'btn-text' + (c.status === 'active' ? ' red' : ''), text: c.status === 'active' ? '수업 닫기' : '다시 열기', onclick: () => archive(c) })) : null,
        S.dates[c.id] ? h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
          field('시작하는 날', 'cds-' + c.id, 'date', { value: ymd(c.starts_at) }), field('끝나는 날', 'cde-' + c.id, 'date', { value: ymd(c.ends_at, true) }),
          h('button', { class: 'btn-line', text: '저장', onclick: () => saveDates(c) })) : null,
        codeBox('s-' + c.id), codeBox('i-' + c.id), progressBox(c));
    }) : h('div', { class: 'when', text: '아직 수업이 없습니다 — [+ 새 수업]으로 만드세요' }));
}

// 사용자 — 목록은 열면 바로 보인다. 학생은 수업의 초대 코드로, 강사 · 기관 관리자는 여기서.
function usersTab(id) {
  if (!S.members[id] && !S.open['ml-' + id]) { S.open['ml-' + id] = true; showMembers(id).finally(() => { S.open['ml-' + id] = false; }); }
  return h('div', null,
    // 사람을 부르는 길은 초대 코드(본인이 비밀번호를 정한다). 운영자만 계정을 직접 만든다.
    h('div', { class: 'line', style: 'margin-bottom:10px' },
      h('button', { class: 'btn-line', text: '+ 강사 초대 코드', onclick: () => makeInvite('ti-' + id, id, null, 'instructor') }),
      h('button', { class: 'btn-line', text: '+ 기관 관리자 초대 코드', onclick: () => makeInvite('a-' + id, id, null, 'organization_admin') })),
    codeBox('ti-' + id), codeBox('a-' + id),
    makeMemberBox(id),
    codeBox('mk-' + id, '아이디 / 비밀번호 — 지금만 보입니다. 적어 두고 본인에게 전해 주세요'),
    S.members[id] ? membersBox(id, { fixed: true }) : h('div', { class: 'when', text: '불러오는 중…' }),
    h('div', { style: 'margin-top:14px' }, inviteList('o-' + id, id, null)));
}

// AI — ① 쓰는 회사(키가 있는 회사만) ② 키 ③ 시작 등급(기본 Balanced) ④ 사용량
function aiTab(id) {
  const { org, keys } = S.orgs[id];
  const live = liveOf(id);
  const keyed = keyedOf(keys).filter((p) => !(live && live.allowed_providers) || live.allowed_providers.includes(p));
  const prov = (org.settings && org.settings.ai_provider) || '';
  const tier = (org.settings && org.settings.ai_tier) || 'balanced';
  const kk = 'ok-' + id;
  const saveKey = async () => {
    const r = await edu('org.key.set', { orgId: id, provider: provOf(kk), apiKey: val(kk) });
    if ($(kk)) $(kk).value = '';
    if (!r.ok) return tell(r.error);
    S.open['addkey-' + id] = false;
    S.sayGood = true; S.say = AI_CO[provOf(kk)] + ' 키를 저장했습니다(다시 보이지 않습니다) — [연결 확인]으로 확인해 보세요';
    await load();
  };
  const tiers = START_TIERS.filter((t) => !(live && live.allowed_model_tiers) || live.allowed_model_tiers.includes(t));
  return h('div', null,
    h('div', { class: 'lab', text: '이 기관 작품에 쓰는 AI' }),
    keyed.length ? h('div', { class: 'line' }, keyed.map((p) => h('button', {
      class: (prov || keyed[0]) === p ? 'btn' : 'btn-line', text: AI_CO[p],
      onclick: async () => { const r = await edu('org.settings', { orgId: id, aiProvider: p }); if (!r.ok) return tell(r.error); S.sayGood = true; S.say = AI_CO[p] + '를 씁니다'; await load(); },
    }))) : h('div', { class: 'notice', text: '아직 AI 키가 없습니다 — 아래에서 키를 넣으면 그 회사가 기본이 됩니다' }),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '키(학생 작업이 이 키로 돕니다 · 다시 보이지 않습니다)' }),
    keyRows(keys, 'org.key', { orgId: id }, load),
    S.open['addkey-' + id] ? h('div', { class: 'card-box', style: 'margin-top:8px' },
      providerPick(kk),
      h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
        field(AI_KEY_LABEL[provOf(kk)], kk, 'password', { autocomplete: 'off', spellcheck: 'false' }),
        h('button', { class: 'btn-red', text: '저장', onclick: saveKey }),
        h('button', { class: 'btn-text', text: '취소', onclick: () => { S.open['addkey-' + id] = false; render(); } })))
      : h('button', { class: 'btn-line', style: 'margin-top:8px', text: '+ 키 넣기', onclick: () => { S.open['addkey-' + id] = true; render(); } }),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '새 수업 작품의 시작 등급(학생이 작품마다 바꿀 수 있습니다)' }),
    h('div', { class: 'line' }, tiers.map((t) => h('button', {
      class: tier === t ? 'btn' : 'btn-line', text: TIER_CO[t] + (t === 'balanced' ? ' (기본)' : ''),
      onclick: async () => { const r = await edu('org.settings', { orgId: id, aiTier: t }); if (!r.ok) return tell(r.error); S.sayGood = true; S.say = TIER_CO[t] + '로 시작합니다'; await load(); },
    }))),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '사용량(이 기관 키)' }),
    S.usage['o-' + id] ? h('button', { class: 'btn-line', text: '사용량 닫기', onclick: () => { delete S.usage['o-' + id]; render(); } })
      : h('button', { class: 'btn-line', text: '사용량 보기', onclick: () => showUsage('o-' + id, id) }),
    usageRows('o-' + id));
}

// 설정 — 켜고 끄기(기본값이 적혀 있다) · 단계와 강의 카드 · 감사 기록
function settingsTab(id) {
  const { org } = S.orgs[id];
  const st = org.settings || {};
  const set = (patch) => async () => { const r = await edu('org.settings', { orgId: id, ...patch }); if (!r.ok) return tell(r.error); await load(); };
  const readable = !!st.admin_can_read_projects;
  return h('div', null,
    toggleRow('학생에게 작업 중 강의 카드 보이기', st.student_cards !== false, set({ studentCards: st.student_cards === false }), '기본: 켬'),
    toggleRow('학생이 수업 작품을 개인 작품으로 복사해 갈 수 있게', st.allow_copy !== false, set({ allowCopy: st.allow_copy === false }), '기본: 켬 — 복사본의 AI 는 학생 본인의 키로 돕니다'),
    toggleRow('기관 관리자가 학생 작품을 읽을 수 있게', readable, S.me.platformAdmin ? set({ adminCanReadProjects: !readable }) : null, '기본: 끔 — 최상위 관리자만 바꿉니다'),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '단계 · 강의 카드 고쳐 쓰기(이 기관만 — 원문은 남습니다)' }),
    wfEditor(id),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '감사 기록(누가 무엇을 바꿨나)' }),
    h('button', { class: 'btn-line', text: S.audit['o-' + id] ? '감사 기록 닫기' : '감사 기록 보기', onclick: () => toggleAudit('o-' + id, id) }),
    auditRows('o-' + id));
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

// 계정 직접 만들기 — 최상위 관리자만(기관 관리자 · 강사 · 학생). 비밀번호는 운영자가 정한다(기술 지원용) — [자동으로]는 칸에 지어 넣어 보이게 한다.
// 기관 관리자 · 강사는 초대 코드로 사람을 부른다(이 상자는 보이지 않는다).
function makeMemberBox(orgId) {
  if (!S.me || !S.me.platformAdmin) return null;
  const k = 'mk-' + orgId;
  const o = S.orgs[orgId];
  const st = S.open[k];
  if (!st) return h('button', { class: 'btn-line', text: '+ 계정 직접 만들기', onclick: () => { S.open[k] = { role: 'instructor', classId: '' }; render(); } });
  const pick = (patch) => { Object.assign(st, patch); render(); };
  setTimeout(() => wireIdCheck(k + '-id'), 0);   // 그리기가 끝난 뒤
  const gen = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const r = crypto.getRandomValues(new Uint8Array(12)); $(k + '-pw').value = [...r].map((x, i) => (i && i % 4 === 0 ? '-' : '') + a[x % a.length]).join(''); $(k + '-pw').type = 'text'; };
  const go = async () => {
    const pw = val(k + '-pw');
    const r = await edu('member.create', { orgId, role: st.role, classId: st.classId || null, loginId: val(k + '-id'), displayName: val(k + '-name'), password: pw });
    if (!r.ok) return tell(r.error);
    S.shown[k] = r.loginId + ' / ' + (r.password || pw);
    S.open[k] = null;
    S.sayGood = true; S.say = '계정을 만들었습니다 — 아이디와 비밀번호를 본인에게 전해 주세요';
    await load(); await showMembers(orgId);   // 학생 자리 수(상태 카드)도 다시
  };
  const classes = o.classes.filter((c) => c.status === 'active');
  return h('div', { class: 'card-box', style: 'width:100%' },
    h('div', { class: 'line' }, [['organization_admin', '기관 관리자'], ['instructor', '강사'], ['student', '학생']].map(([r, n]) =>
      h('button', { class: st.role === r ? 'btn' : 'btn-line', text: n, onclick: () => pick({ role: r, classId: r === 'organization_admin' ? '' : st.classId }) }))),
    st.role !== 'organization_admin' && classes.length ? h('div', { style: 'margin-top:8px' },
      h('div', { class: 'lab', text: st.role === 'student' ? '들어갈 수업' : '맡길 수업(나중에 정해도 됩니다)' }),
      h('div', { class: 'line' },
        st.role === 'student' ? null : h('button', { class: st.classId === '' ? 'btn' : 'btn-line', text: '아직 없음', onclick: () => pick({ classId: '' }) }),
        classes.map((c) => h('button', { class: st.classId === c.id ? 'btn' : 'btn-line', text: c.name, onclick: () => pick({ classId: c.id }) })))) : null,
    st.role === 'student' && !classes.length ? h('div', { class: 'notice', text: '학생은 수업에 들어갑니다 — [수업] 탭에서 수업을 먼저 만드세요' }) : null,
    h('div', { class: 'line', style: 'align-items:flex-end;margin-top:8px' },
      field('아이디(영문 소문자 · 숫자, 3자 이상)', k + '-id', 'text', { autocapitalize: 'none', spellcheck: 'false' }),
      field('이름', k + '-name'),
      field('비밀번호(10자 이상)', k + '-pw', 'text', { autocomplete: 'off', spellcheck: 'false' }),
      h('button', { class: 'btn-text', text: '자동으로', onclick: gen })),
    h('div', { class: 'line', style: 'margin-top:10px' },
      h('button', { class: 'btn-red', text: '만들기', onclick: go }),
      h('button', { class: 'btn-text', text: '닫기', onclick: () => { S.open[k] = null; render(); } })),
    h('div', { class: 'when', style: 'margin-top:6px', text: '비밀번호는 운영자가 정해 본인에게 전합니다. 본인이 «내 계정»에서 바꾸면 운영자도 모르게 됩니다.' }));
}

// 비밀번호를 잊은 사람 — 재설정 코드를 준다(비밀번호는 아무도 모른다). 본인이 로그인 화면 «비밀번호를 잊었어요»에서 아이디 · 코드 · 새 비밀번호를 넣는다.
async function giveResetCode(orgId, m, after) {
  if (!confirm((m.name || m.loginId) + '(' + m.loginId + ')에게 비밀번호 재설정 코드를 줄까요?\n본인이 로그인 화면의 «비밀번호를 잊었어요»에서 이 코드로 새 비밀번호를 정합니다(7일 · 한 번).')) return;
  const r = await edu('member.reset_password', { orgId, userId: m.userId });
  if (!r.ok) return tell(r.error);
  done('재설정 코드를 만들었습니다 — 본인에게 전해 주세요');
  await after();
}
const resetLine = (code, loginId) => (code ? h('div', { class: 'line', style: 'margin-top:6px' },
  h('div', { class: 'mark', style: 'font-size:14px;padding:4px 8px', text: code }), copyBtn(code),
  linkBtns(resetUrl(code, loginId), '스토리 엔진 비밀번호 재설정'),
  h('div', { class: 'when', text: '재설정 코드(7일 · 한 번) — 링크는 그 사람에게만 1:1로 보내세요(단체방에 올리지 않습니다)' })) : null);

function membersBox(orgId, { fixed = false } = {}) {
  const list = S.members[orgId];
  if (!list) return h('button', { class: 'btn-line', text: '사용자 목록', onclick: () => showMembers(orgId) });
  const remove = async (m) => {
    if (!confirm(m.name + '(' + m.loginId + ')을(를) 기관에서 내보낼까요? 계정과 작품은 남고, 수업에서만 빠집니다.')) return;
    const r = await edu('member.remove', { orgId, userId: m.userId });
    if (!r.ok) return tell(r.error);
    await showMembers(orgId);
  };
  return h('div', null,
    fixed ? null : h('button', { class: 'btn-line', text: '사용자 목록 닫기', onclick: () => { delete S.members[orgId]; render(); } }),
    h('div', { class: 'when', style: 'margin-top:8px', text: '학생 · 강사는 저마다 제 아이디로 들어옵니다(초대 코드는 수업에 들어오는 열쇠일 뿐 계정이 아닙니다).' }),
    list.length ? null : h('div', { class: 'when', style: 'margin-top:8px', text: '아직 사용자가 없습니다 — 학생은 [수업] 탭의 «학생 초대 코드»로, 강사는 [+ 강사 초대 코드]로 부르세요' }),
    list.map((m) => h('div', { style: 'padding:6px 0;border-bottom:1px solid var(--line-soft)' },
      h('div', { class: 'line' },
        h('div', { class: 'name', style: 'flex:1', text: (m.name || m.loginId) + ' · ' + m.loginId }),
        m.roles.map((r) => h('span', { class: 'mark', text: ROLE_SAY[r] || r })),
        m.classes.length ? h('div', { class: 'when', text: m.classes.join(', ') }) : null,
        S.me && m.loginId === S.me.loginId ? null : [
          h('button', { class: 'btn-text', text: '비밀번호 재설정 코드', onclick: () => giveResetCode(orgId, m, () => showMembers(orgId)) }),
          h('button', { class: 'btn-text red', text: '내보내기', onclick: () => remove(m) }),
        ]),
      resetLine(m.resetCode, m.loginId))),
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
    done('비밀번호를 바꿨습니다');
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
      S.sayGood = true; S.say = (clear ? '원래대로 되돌렸습니다' : '저장했습니다 — 다음 생성부터 쓰입니다') + ' (' + st.n + '  ' + (clear ? st.original.title : (data.title || st.effective.title)) + ')';
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

// ---------------------------------------------------------------- 운영(최상위 관리자) — 현황 · 감사 기록 · 단계(전체) · 계정
S.opsTab = '현황';
function opsView() {
  const t = S.opsTab;
  if (t === '현황' && !S.ops && !S.open.opsLoading) { S.open.opsLoading = true; edu('ops.overview').then((r) => { S.open.opsLoading = false; if (r.ok) { S.ops = r; render(); } }); }
  if (t === '감사 기록' && !S.audit.all && !S.open.auditLoading) { S.open.auditLoading = true; edu('audit.list', {}).then((r) => { S.open.auditLoading = false; if (r.ok) { S.audit.all = r.entries; render(); } }); }
  const userStatus = async (status) => {
    const loginId = val('us-id');
    if (!loginId) return tell('아이디를 적어 주세요');
    if (status === 'disabled' && !confirm(loginId + ' — 계정을 멈출까요? 곧바로 로그아웃되고 다시 열 때까지 들어올 수 없습니다.')) return;
    const r = await edu('user.status', { loginId, status });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.say = r.loginId + (status === 'disabled' ? ' — 멈췄습니다' : ' — 다시 열었습니다'); $('us-id').value = ''; render();
  };
  const orgList = Object.values(S.orgs);
  return h('div', null,
    tabRow([['현황', '현황'], ['감사 기록', '감사 기록'], ['단계', '단계 · 강의 카드(전체)'], ['계정', '계정 멈추기']], t, (k) => { S.opsTab = k; if (k === '현황') S.ops = null; render(); }),
    t === '현황' ? h('div', null,
      h('div', { class: 'lab', text: '기관' }),
      orgList.length ? orgList.map(({ org }) => {
        const live = liveOf(org.id); const keyed = keyedOf(S.orgs[org.id].keys);
        return h('div', { class: 'row', onclick: () => { S.sel = org.id; render(); } },
          h('div', { class: 'name', text: org.name }),
          org.status !== 'active' ? h('span', { class: 'mark', style: 'color:var(--red)', text: '멈춤' }) : null,
          h('span', { class: 'mark', style: live ? '' : 'color:var(--red)', text: live ? '~ ' + (live.ends_at ? day(live.ends_at) : '기한 없음') : '이용 기간 없음' }),
          h('span', { class: 'mark', style: keyed.length ? '' : 'color:var(--red)', text: keyed.length ? keyed.map((p) => AI_CO[p]).join(' · ') : 'AI 키 없음' }),
          h('div', { class: 'when', text: '수업 ' + S.orgs[org.id].classes.filter((c) => c.status === 'active').length }));
      }) : h('div', { class: 'when', text: '아직 기관이 없습니다 — 위의 [+ 새 기관]으로 만드세요' }),
      S.ops ? opsBox() : h('div', { class: 'when', style: 'margin-top:10px', text: '불러오는 중…' })) : null,
    t === '감사 기록' ? (S.audit.all ? auditRows('all') : h('div', { class: 'when', text: '불러오는 중…' })) : null,
    t === '단계' ? h('div', null, h('div', { class: 'when', style: 'margin-bottom:8px', text: '모든 기관 · 개인에게 쓰이는 기본입니다(기관은 그 위에 다시 고쳐 쓸 수 있습니다). 원문은 남습니다.' }), wfEditor(null)) : null,
    t === '계정' ? h('div', null,
      h('div', { class: 'when', style: 'margin-bottom:8px', text: '멈추면 곧바로 로그아웃되고 다시 열 때까지 들어올 수 없습니다. 작품은 그대로입니다.' }),
      h('div', { class: 'line', style: 'align-items:flex-end' }, field('아이디', 'us-id', 'text', { autocapitalize: 'none', spellcheck: 'false' }),
        h('button', { class: 'btn-red', text: '멈추기', onclick: () => userStatus('disabled') }),
        h('button', { class: 'btn-line', text: '다시 열기', onclick: () => userStatus('active') }))) : null);
}

// 새 기관 — 이용 기간을 바로 연다(기본값 90일 · 학생 40자리 — 끄면 기관만)
function newOrgView() {
  if (S.open.withLic == null) S.open.withLic = true;
  const go = async () => {
    const r = await edu('org.create', { name: val('no-name'), slug: val('no-slug') });
    if (!r.ok) return tell(r.error);
    const l = S.open.withLic ? await edu('license.issue', { orgId: r.organization.id, days: Number(val('no-days')) || 90, seatLimit: Number(val('no-seats')) || null }) : null;
    S.sel = r.organization.id; S.sub[r.organization.id] = 'AI';
    S.sayGood = !l || l.ok;
    S.say = l && !l.ok ? '기관은 만들었지만 이용 기간을 열지 못했습니다 — ' + l.error
      : '«' + r.organization.name + '» 기관을 만들었습니다' + (l ? ' · 이용 기간을 열었습니다' : '') + ' — 다음으로 AI 키를 넣으세요';
    await load();
  };
  return h('div', { class: 'card-box' },
    h('div', { class: 'line', style: 'align-items:flex-end' }, field('기관 이름', 'no-name'),
      field('영문 약칭(선택 — 비워 두면 자동)', 'no-slug', 'text', { placeholder: '예: sea-school', autocapitalize: 'none', spellcheck: 'false' })),
    h('div', { class: 'line', style: 'margin-top:12px;gap:6px;cursor:pointer', onmousedown: () => { S.open.withLic = !S.open.withLic; render(); } },
      h('button', { class: 'ck' + (S.open.withLic ? ' on' : '') }), h('span', { text: '이용 기간도 바로 열기' })),
    S.open.withLic ? h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
      field('이용 일수', 'no-days', 'text', { value: '90' }), field('학생 자리', 'no-seats', 'text', { value: '40' })) : null,
    h('div', { class: 'line', style: 'margin-top:12px' }, h('button', { class: 'btn-red', text: '기관 만들기', onclick: go })));
}

// 관리 화면 — 맨 위 줄에서 고른다(운영 · 기관마다 · 새 기관). 기관이 하나뿐인 기관 관리자는 줄 없이 곧바로.
function manageView() {
  const ids = Object.keys(S.orgs);
  const admin = !!S.me.platformAdmin;
  if (!S.sel || (S.sel !== 'ops' && S.sel !== 'new' && !S.orgs[S.sel])) S.sel = admin ? 'ops' : ids[0];
  const pills = [...(admin ? [['ops', '운영']] : []), ...ids.map((id) => [id, S.orgs[id].org.name]), ...(admin ? [['new', '+ 새 기관']] : [])];
  return h('div', null,
    pills.length > 1 ? h('div', { class: 'line', style: 'margin-bottom:16px;flex-wrap:wrap' },
      pills.map(([k, name]) => h('button', { class: S.sel === k ? 'nav-btn on' : 'nav-btn', style: S.sel === k ? 'background:var(--blue);color:var(--on-color)' : '', text: name, onclick: () => { S.sel = k; render(); } }))) : null,
    S.sel === 'ops' ? opsView() : S.sel === 'new' ? newOrgView() : orgView(S.sel));
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
  const notice = S.say ? h('div', { class: 'notice' + (S.sayGood ? ' good' : ''), style: 'margin-bottom:14px', text: S.say }) : null;
  if (PAGE === 'manage') {
    // 관리 화면 — 운영자 · 기관 관리자만. 서버도 문마다 다시 본다(이 갈림은 안내일 뿐이다).
    const can = S.me && (S.me.platformAdmin || Object.keys(S.orgs).length);
    $('root').replaceChildren(h('div', { class: 'body' }, head('관리'), notice,
      !S.loggedIn ? h('div', { class: 'when', text: '로그인이 필요합니다' })
        : !can ? h('div', { class: 'when', text: '관리 권한이 없습니다 — 운영자나 기관 관리자만 들어옵니다' })
          : manageView()));
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
