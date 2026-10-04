'use strict';

// 온라인판의 «기관 · 수업» 화면 — 초대 코드로 들어오기 · 내 수업 · 수업 현황(강사) · 기관 관리 · 운영(플랫폼 관리자).
// 모든 판정은 서버(online/edu.mjs · tenancy)가 한다. 이 화면은 서버가 허락한 것을 보여 줄 뿐이다.
// 학생에게 비용 · 횟수 · 키를 보이지 않는다. 초대 코드는 만든 그 자리에서 한 번만 보인다.

const S = { me: null, loggedIn: false, orgs: {}, progress: {}, shown: {}, say: '', open: {}, usage: {} };

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
  for (const c of kids.flat()) if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}
const $ = (id) => document.getElementById(id);
const val = (id) => ($(id) ? $(id).value.trim() : '');
const day = (t) => (t ? new Date(t).toLocaleDateString() : '');

async function edu(op, body = {}) {
  const r = await fetch('/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...body }) }).catch(() => null);
  return r ? r.json().catch(() => ({ ok: false, error: '응답 없음' })) : { ok: false, error: '연결되지 않습니다' };
}
const tell = (text) => { S.say = text || ''; render(); };

// ---------------------------------------------------------------- 불러오기

async function load() {
  const m = await edu('me.memberships');
  S.loggedIn = m.ok === true;
  S.me = m.ok ? m : null;
  S.orgs = {};
  if (S.me) {
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
  h('div', { class: 'when', text: '이 코드는 지금만 보입니다 — 적어서 전해 주세요' })) : null);

async function makeInvite(key, orgId, classId, role) {
  const r = await edu('invite.create', { orgId, classId, role });
  if (!r.ok) return tell(r.error);
  S.shown[key] = r.invite.code;
  render();
}

// ---------------------------------------------------------------- 들어오기(초대 코드)

function joinBox() {
  const go = async () => {
    const body = { code: val('j-code') };
    if (!S.loggedIn) Object.assign(body, { loginId: val('j-id'), displayName: val('j-name'), password: val('j-pw') });
    if (!S.loggedIn && body.password !== val('j-pw2')) return tell('비밀번호가 서로 다릅니다');
    const r = await edu('invite.accept', body);
    if (!r.ok) return tell(r.error);
    S.say = '들어왔습니다';
    await load();
  };
  return section(S.loggedIn ? '초대 코드로 수업 · 기관에 들어가기' : '초대 코드로 처음 들어오기',
    h('div', { class: 'line', style: 'align-items:flex-end' },
      field('초대 코드', 'j-code', 'text', { placeholder: 'ABCD-EFGH-JKLM', autocapitalize: 'characters', spellcheck: 'false' }),
      ...(S.loggedIn ? [] : [
        field('아이디(영문 소문자 · 숫자)', 'j-id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
        field('이름', 'j-name'),
        field('비밀번호(10자 이상)', 'j-pw', 'password', { autocomplete: 'new-password' }),
        field('비밀번호 한 번 더', 'j-pw2', 'password', { autocomplete: 'new-password' }),
      ]),
      h('button', { class: 'btn-red', text: '들어가기', onclick: go })),
    S.loggedIn ? null : h('div', { class: 'when', style: 'margin-top:10px' }, '이미 계정이 있으면 ', h('a', { href: '/login', text: '로그인' }), ' 한 뒤 코드를 넣어 주세요.'));
}

// ---------------------------------------------------------------- 내 수업

function newWorkForm(c) {
  const k = 'nw-' + c.id;
  if (!S.open[k]) return h('button', { class: 'btn-line', text: '이 수업에 새 작품', onclick: () => { S.open[k] = true; render(); } });
  const go = async () => {
    const r = await fetch('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      op: 'project.create', classId: c.id, name: val(k + '-name'), spec: { form: val(k + '-form') }, materials: [{ name: '자료', text: val(k + '-mat') }],
    }) }).then((x) => x.json()).catch(() => ({ ok: false, error: '연결되지 않습니다' }));
    if (!r.ok) return tell(r.error);
    location.href = '/';
  };
  return h('div', { style: 'width:100%' },
    h('div', { class: 'line', style: 'align-items:flex-end' }, field('작품 이름', k + '-name'), field('형식(예: 단편소설)', k + '-form')),
    h('div', { class: 'lab', style: 'margin-top:10px', text: '자료' }), h('textarea', { id: k + '-mat' }),
    h('div', { class: 'line', style: 'margin-top:10px' }, h('button', { class: 'btn-red', text: '만들기', onclick: go }),
      h('button', { class: 'btn-text', text: '닫기', onclick: () => { S.open[k] = false; render(); } })));
}

function progressBox(c) {
  const p = S.progress[c.id];
  if (!p) return null;
  const SAY = { queued: '대기', running: '진행 중', paused: '멈춤', waiting_for_user: '멈춤', done: '완료', failed: '실패', cancelled: '중지' };
  return h('div', { style: 'margin-top:10px;width:100%' }, p.students.length
    ? p.students.map((s) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: s.name + (s.projectName ? ' — ' + s.projectName : ' — (아직 작품 없음)') }),
      s.projectId ? h('span', { class: 'mark', text: '문서 ' + s.docs }) : null,
      s.lastJob ? h('span', { class: 'mark', text: SAY[s.lastJob] || s.lastJob }) : null,
      h('div', { class: 'when', text: s.updatedAt ? day(s.updatedAt) : '' }),
      s.projectId ? h('a', { class: 'btn-text', href: '/?pid=' + encodeURIComponent(s.projectId), text: '읽기' }) : null))
    : h('div', { class: 'when', text: '아직 학생이 없습니다' }));
}

async function showProgress(c) {
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
      c.role === 'student' && c.status === 'active' ? newWorkForm(c) : null,
      c.role === 'instructor' ? [
        h('button', { class: 'btn-line', text: '수업 현황', onclick: () => showProgress(c) }),
        h('button', { class: 'btn-line', text: '학생 초대 코드', onclick: () => makeInvite('s-' + c.id, c.organization_id, c.id, 'student') }),
      ] : null),
    codeBox('s-' + c.id),
    progressBox(c))));
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
  const addClass = async () => { const r = await edu('class.create', { orgId: id, name: val('nc-' + id) }); if (!r.ok) return tell(r.error); await load(); };
  const saveKey = async () => {
    const r = await edu('org.key.set', { orgId: id, provider: 'anthropic', apiKey: val('ok-' + id) });
    $('ok-' + id).value = '';
    if (!r.ok) return tell(r.error);
    S.say = 'AI 키를 저장했습니다(다시 보이지 않습니다)';
    await load();
  };
  const readable = !!(org.settings && org.settings.admin_can_read_projects);
  return section(org.name + ' — 기관 관리',
    h('div', { class: 'lab', text: '이용 기간' }),
    h('div', { class: 'when', text: live ? '~ ' + (live.ends_at ? day(live.ends_at) : '기한 없음') + ' · 학생 ' + (lic.seatsUsed || 0) + (live.seat_limit ? ' / ' + live.seat_limit : '') : '유효한 이용 기간이 없습니다 — 새 작품 · AI 작업이 멈춥니다' }),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '수업' }),
    classes.map((c) => h('div', { style: 'padding:8px 0;border-bottom:1px solid var(--line-soft)' },
      h('div', { class: 'line' },
        h('div', { class: 'name', style: 'flex:1', text: c.name }),
        h('span', { class: 'mark', text: '학생 ' + (c.students || 0) }),
        c.status !== 'active' ? h('span', { class: 'mark', text: '닫힘' }) : null,
        h('button', { class: 'btn-text', text: '현황', onclick: () => showProgress(c) }),
        h('button', { class: 'btn-text', text: '학생 초대', onclick: () => makeInvite('s-' + c.id, id, c.id, 'student') }),
        h('button', { class: 'btn-text', text: '강사 초대', onclick: () => makeInvite('i-' + c.id, id, c.id, 'instructor') }),
        h('button', { class: 'btn-text' + (c.status === 'active' ? ' red' : ''), text: c.status === 'active' ? '닫기' : '다시 열기',
          onclick: async () => { await edu('class.archive', { classId: c.id, reopen: c.status !== 'active' }); await load(); } })),
      codeBox('s-' + c.id), codeBox('i-' + c.id), progressBox(c))),
    h('div', { class: 'line', style: 'margin-top:10px;align-items:flex-end' }, field('새 수업 이름', 'nc-' + id), h('button', { class: 'btn-line', text: '수업 만들기', onclick: addClass })),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '기관 관리자' }),
    h('div', { class: 'line' }, h('button', { class: 'btn-line', text: '기관 관리자 초대 코드', onclick: () => makeInvite('a-' + id, id, null, 'organization_admin') })),
    codeBox('a-' + id),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '기관 AI 키(학생 작업이 이 키로 돕니다)' }),
    h('div', { class: 'when', text: keys.filter((k) => k.status === 'active').map((k) => k.provider + ' ' + k.keyHint).join(' · ') || '아직 없습니다' }),
    h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
      field('Anthropic API 키', 'ok-' + id, 'password', { autocomplete: 'off', spellcheck: 'false' }), h('button', { class: 'btn-line', text: '저장', onclick: saveKey })),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '사용량(기관 키)' }),
    h('button', { class: 'btn-line', text: '사용량 보기', onclick: () => showUsage('o-' + id, id) }),
    usageRows('o-' + id),
    h('div', { class: 'line', style: 'margin-top:16px' },
      h('div', { class: 'lab', style: 'margin:0', text: '기관 관리자가 학생 작품을 읽을 수 있게' }),
      h('button', { class: 'tg' + (readable ? ' on' : ''), onclick: async () => { await edu('org.settings', { orgId: id, adminCanReadProjects: !readable }); await load(); } })));
}

// ---------------------------------------------------------------- 운영(플랫폼 관리자)

function platformBox() {
  if (!S.me || !S.me.platformAdmin) return null;
  const addOrg = async () => { const r = await edu('org.create', { name: val('no-name'), slug: val('no-slug') }); if (!r.ok) return tell(r.error); await load(); };
  const issue = async (orgId) => {
    const r = await edu('license.issue', { orgId, days: Number(val('ld-' + orgId)) || 30, seatLimit: Number(val('ls-' + orgId)) || null });
    if (!r.ok) return tell(r.error);
    await load();
  };
  return section('운영 — 기관 · 이용 기간',
    h('div', { class: 'line', style: 'align-items:flex-end' }, field('기관 이름', 'no-name'), field('주소 이름(영문 소문자 · -)', 'no-slug'),
      h('button', { class: 'btn-line', text: '기관 만들기', onclick: addOrg })),
    Object.values(S.orgs).map(({ org }) => h('div', { class: 'line', style: 'margin-top:10px;align-items:flex-end' },
      h('div', { class: 'name', style: 'flex:1;font-weight:600', text: org.name }),
      field('이용 일수', 'ld-' + org.id, 'text', { value: '90' }), field('학생 자리', 'ls-' + org.id, 'text', { value: '40' }),
      h('button', { class: 'btn-line', text: '이용 기간 열기', onclick: () => issue(org.id) }))));
}

// ---------------------------------------------------------------- 그리기

function render() {
  $('root').replaceChildren(h('div', { class: 'body' },
    h('div', { class: 'line', style: 'margin-bottom:22px' },
      h('div', { class: 'top-name', style: 'font-size:28px;flex:1', text: '기관 · 수업' }),
      S.loggedIn ? h('a', { class: 'btn-line', href: '/', text: '작업실로' }) : h('a', { class: 'btn-line', href: '/login', text: '로그인' })),
    S.say ? h('div', { class: 'notice', style: 'margin-bottom:14px', text: S.say }) : null,
    platformBox(),
    Object.keys(S.orgs).map(orgBox),
    myClasses(),
    joinBox()));
}

load();
