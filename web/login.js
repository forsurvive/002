'use strict';

// 화면 밝기 — 기본은 어두운 화면(style.css :root). «밝게» 를 고른 브라우저만 기억해 둔다.
try { if (localStorage.getItem('se-theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch { /* 저장소를 못 쓰면 기본 */ }

// 온라인판의 로그인 — 앱 계정(아이디 · 비밀번호). 들어가면 첫 화면(/)으로 간다.
// 개인판에는 이 화면이 없다(그 PC 안에서만 열리므로).

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
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.appendChild(c);
  if (tag === 'input') noAutofill(n, attrs);
  return n;
}

// 첫 화면 — 계정이 있으면 아이디 · 비밀번호, 처음이면 초대 코드 → (맞으면) 그 자리에서 계정 만들기.
// 시험 운영(출입 열쇠)이면 열쇠 칸이 맨 위에 하나 더 붙고, 어느 단추든 열쇠부터 넘긴다.
// 자유 가입판(S.edition 'open')에는 초대 코드가 없다.
const S = { gate: false, invite: null, say: '', edition: 'school' };
const $ = (id) => document.getElementById(id);
const v = (id) => ($(id) ? $(id).value.trim() : '');
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  return r ? r.json().catch(() => ({ ok: false, error: '응답 없음' })) : { ok: false, error: '연결되지 않습니다' };
};
const tell = (text) => { S.say = text || ''; const n = $('say'); if (n) n.textContent = S.say; };

// 출입 열쇠를 넘긴다 — 넘기면 칸을 거두고, 계정이 하나도 없으면 처음 설정으로
async function passGate() {
  if (!S.gate) return true;
  if (!v('gt-key')) { tell('출입 열쇠를 넣어 주세요'); return false; }
  const out = await post('/api/gate', { key: $('gt-key').value });
  if (!out.ok) { tell(out.error || '출입 열쇠가 맞지 않습니다'); return false; }
  S.gate = false;
  if ($('gt-box')) $('gt-box').remove();
  const st = await fetch('/api/setup').then((r) => r.json()).catch(() => ({}));
  const was = S.edition;
  if (st.edition) S.edition = st.edition === 'open' ? 'open' : 'school';
  if (st.needed) { draw(setupForm(st.ai, st.code)); return false; }
  // 열쇠 전에는 판을 몰랐다(초대 코드 칸이 섰다) — 자유 가입판이면 가입 칸이 있는 첫 화면으로 다시 그린다
  if (S.edition !== was) { draw(mainForms()); tell('출입 열쇠를 넘겼습니다 — 다시 한 번 눌러 주세요'); return false; }
  return true;
}

async function enter(e) {
  e.preventDefault();
  tell('');
  if (!v('lg-id') || !$('lg-pw').value) return tell('아이디와 비밀번호를 넣어 주세요');
  if (!(await passGate())) return;
  const out = await post('/api/auth/login', { loginId: v('lg-id'), password: $('lg-pw').value });
  if (out.ok) { location.href = '/'; return; }
  if (out.code === 'gate') { location.reload(); return; }
  tell(out.error || '들어가지 못했습니다');
}

// 비밀번호를 잊었을 때 — 한 단계 위 사람(학생 ← 강사 · 기관 관리자, 강사 ← 기관 관리자, 기관 관리자 ← 운영자)에게 받은 재설정 코드로.
// 운영자는 Secrets 의 SE2_RECOVERY_CODE 를 코드로 넣는다. 맞으면 새 비밀번호로 곧바로 들어간다.
async function resetPw(e) {
  e.preventDefault();
  tell('');
  if (!v('rs-id') || !v('rs-code') || !$('rs-pw').value) return tell('아이디 · 재설정 코드 · 새 비밀번호를 모두 넣어 주세요');
  if ($('rs-pw').value !== $('rs-pw2').value) return tell('새 비밀번호가 서로 다릅니다');
  if (!(await passGate())) return;
  const out = await post('/api/edu', { op: 'password.reset', loginId: v('rs-id'), code: v('rs-code'), password: $('rs-pw').value });
  if (out.ok) { location.href = '/'; return; }
  tell(out.error || '바꾸지 못했습니다');
}

// 초대 코드 — 먼저 맞는지만 본다(쓰지 않는다). 맞으면 계정 만들기 칸을 연다.
async function checkCode(e) {
  e.preventDefault();
  tell('');
  if (!v('iv-code')) return tell('초대 코드를 넣어 주세요');
  if (!(await passGate())) return;
  const out = await post('/api/edu', { op: 'invite.check', code: v('iv-code') });
  if (out.code === 'gate') { location.reload(); return; }
  if (!out.ok) return tell(out.error || '초대 코드를 확인하지 못했습니다');
  S.invite = { code: v('iv-code'), ...out };
  draw(mainForms());
  if ($('nu-id')) $('nu-id').focus();
}

async function join(e) {
  e.preventDefault();
  tell('');
  if (!v('nu-id') || !$('nu-pw').value) return tell('아이디와 비밀번호를 정해 넣어 주세요');
  if ($('nu-pw').value !== $('nu-pw2').value) return tell('비밀번호가 서로 다릅니다');
  const out = await post('/api/edu', { op: 'invite.accept', code: S.invite.code, loginId: v('nu-id'), displayName: v('nu-name'), password: $('nu-pw').value });
  if (out.ok) { location.href = '/'; return; }
  if (out.code === 'gate') { location.reload(); return; }
  tell(out.error || '계정을 만들지 못했습니다');
}

// 자유 가입판 — 아이디 · 이름 · 비밀번호로 가입하고 곧바로 «내 계정»(키 넣기 · 이용권)으로 간다
async function signup(e) {
  e.preventDefault();
  tell('');
  if (!v('su-id') || !$('su-pw').value) return tell('아이디와 비밀번호를 정해 넣어 주세요');
  if ($('su-pw').value !== $('su-pw2').value) return tell('비밀번호가 서로 다릅니다');
  if (!(await passGate())) return;
  const out = await post('/api/auth/signup', { loginId: v('su-id'), displayName: v('su-name'), password: $('su-pw').value });
  if (out.ok) { location.href = '/account.html'; return; }
  if (out.code === 'gate') { location.reload(); return; }
  tell(out.error || '가입하지 못했습니다');
}

// 이미 계정이 있는 사람 — 새 계정을 만들지 않고, 로그인한 뒤 그 계정으로 이 수업 · 기관에 들어간다
async function joinWithAccount(e) {
  e.preventDefault();
  tell('');
  if (!v('ha-id') || !$('ha-pw').value) return tell('아이디와 비밀번호를 넣어 주세요');
  const li = await post('/api/auth/login', { loginId: v('ha-id'), password: $('ha-pw').value });
  if (!li.ok) return tell(li.error || '들어가지 못했습니다');
  const out = await post('/api/edu', { op: 'invite.accept', code: S.invite.code });
  if (!out.ok) return tell(out.error || '수업에 들어가지 못했습니다');
  location.href = '/';
}

// 처음 설정 — 계정이 하나도 없을 때만 서버가 needed 를 준다. 운영자 계정과 (있으면) AI 키를 한 번에.
// 키는 서버가 봉해 저장하고 다시 돌려주지 않는다 — 이 화면도 보낸 뒤 칸을 비운다.
async function setup(e) {
  e.preventDefault();
  tell('');
  if ($('st-pw').value !== $('st-pw2').value) return tell('비밀번호가 서로 다릅니다');
  const out = await post('/api/setup', { loginId: v('st-id'), password: $('st-pw').value, displayName: v('st-name'), apiKey: v('st-key'), setupCode: v('st-code') });
  $('st-key').value = '';
  if (out.ok) { if (out.note) alert(out.note); location.href = '/'; return; }
  if (out.code === 'gate') { location.reload(); return; }
  tell(out.error || '설정하지 못했습니다');
}

const field = (label, id, type, extra = {}) => [
  h('div', { class: 'lab', style: 'margin-top:14px', text: label }),
  h('input', { id, type, ...extra }),
];
const sayLine = () => h('div', { id: 'say', class: 'notice', style: 'min-height:22px;margin:10px 0', text: S.say });
const ROLE = { student: '학생', instructor: '강사', organization_admin: '기관 관리자' };

function mainForms() {
  const inv = S.invite;
  return h('div', null,
    S.gate ? h('div', { id: 'gt-box', style: 'margin-bottom:22px' },
      h('div', { class: 'lab', text: '출입 열쇠' }),
      h('input', { id: 'gt-key', type: 'password', autocomplete: 'off', spellcheck: 'false' }),
      h('div', { class: 'when', style: 'margin-top:6px', text: '시험 운영 중 — 운영자에게 받은 열쇠(이 브라우저는 한 번만)' })) : null,
    h('form', { onsubmit: enter },
      h('div', { class: 'lab', text: '아이디' }),
      h('input', { id: 'lg-id', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
      h('div', { class: 'lab', style: 'margin-top:14px', text: '비밀번호' }),
      h('input', { id: 'lg-pw', type: 'password', autocomplete: 'current-password' }),
      h('div', { class: 'line', style: 'margin-top:14px' }, h('button', { class: 'btn-red', type: 'submit', text: '로그인' }),
        h('button', { class: 'btn-text', type: 'button', text: S.forgot ? '닫기' : '비밀번호를 잊었어요', onclick: () => { S.forgot = !S.forgot; draw(mainForms()); } }))),
    S.forgot ? h('form', { onsubmit: resetPw, style: 'margin-top:14px;padding:14px;border-radius:12px;background:var(--group)' },
      h('div', { class: 'when', text: S.edition === 'open' ? '재설정 코드는 운영자에게 문의해 받습니다.' : '재설정 코드는 학생은 선생님(또는 기관 관리자)에게, 강사는 기관 관리자에게, 기관 관리자는 운영자에게 받습니다.' }),
      field('아이디', 'rs-id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
      field('재설정 코드', 'rs-code', 'text', { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'ABCD-EFGH-JKLM' }),
      field('새 비밀번호(10자 이상)', 'rs-pw', 'password', { autocomplete: 'new-password' }),
      field('새 비밀번호 한 번 더', 'rs-pw2', 'password', { autocomplete: 'new-password' }),
      h('div', { class: 'line', style: 'margin-top:14px' }, h('button', { class: 'btn-red', type: 'submit', text: '새 비밀번호로 들어가기' }))) : null,
    sayLine(),
    S.edition === 'open' ? signupBox() : h('div', { style: 'margin-top:18px;padding-top:18px;border-top:1px solid var(--line-soft)' },
      h('div', { class: 'lab', text: '처음 오셨나요? 초대 링크를 받았으면 그 링크를 누르면 됩니다 — 코드만 받았으면 여기에' }),
      inv && S.invite.have ? h('form', { onsubmit: joinWithAccount },
        h('div', { class: 'top-name', style: 'font-size:19px;margin-top:6px', text: '내 계정으로 참여' }),
        h('div', { class: 'when', style: 'margin-top:4px', text: [inv.organizationName, inv.className, ROLE[inv.role] || ''].filter(Boolean).join(' · ') }),
        field('아이디', 'ha-id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
        field('비밀번호', 'ha-pw', 'password', { autocomplete: 'current-password' }),
        h('div', { class: 'line', style: 'margin-top:14px' },
          h('button', { class: 'btn-red', type: 'submit', text: '로그인하고 참여' }),
          h('button', { class: 'btn-text', type: 'button', text: '새 계정 만들기', onclick: () => { S.invite.have = false; draw(mainForms()); } })))
      : inv ? h('form', { onsubmit: join },
        // 역할은 고르지 않는다 — 초대 코드가 정한다(스스로 기관 관리자를 고르는 길을 두지 않는다)
        h('div', { class: 'top-name', style: 'font-size:19px;margin-top:6px', text: (ROLE[inv.role] || '') + ' 계정 만들기' }),
        h('div', { class: 'when', style: 'margin-top:4px', text: [inv.organizationName, inv.className].filter(Boolean).join(' · ') }),
        field('아이디(영문 소문자 · 숫자, 3자 이상)', 'nu-id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
        field('이름', 'nu-name', 'text'),
        field('비밀번호(10자 이상)', 'nu-pw', 'password', { autocomplete: 'new-password' }),
        field('비밀번호 한 번 더', 'nu-pw2', 'password', { autocomplete: 'new-password' }),
        h('div', { class: 'line', style: 'margin-top:14px' },
          h('button', { class: 'btn-red', type: 'submit', text: '계정 만들고 들어가기' }),
          h('button', { class: 'btn-text', type: 'button', text: '이미 계정이 있어요', onclick: () => { S.invite.have = true; draw(mainForms()); } }),
          h('button', { class: 'btn-text', type: 'button', text: '다른 코드', onclick: () => { S.invite = null; draw(mainForms()); } })))
        : h('form', { onsubmit: checkCode, class: 'line', style: 'align-items:center' },
          h('input', { id: 'iv-code', type: 'text', placeholder: 'ABCD-EFGH-JKLM', autocapitalize: 'characters', spellcheck: 'false', style: 'flex:1' }),
          h('button', { class: 'btn-line', type: 'submit', text: '다음' }))));
}

// 자유 가입판의 «처음 오셨나요?» — 누르면 그 자리에서 가입 칸이 열린다
const signupBox = () => h('div', { style: 'margin-top:18px;padding-top:18px;border-top:1px solid var(--line-soft)' },
  S.signup ? h('form', { onsubmit: signup },
    h('div', { class: 'top-name', style: 'font-size:19px;margin-top:6px', text: '가입하기' }),
    field('아이디(영문 소문자 · 숫자, 3자 이상)', 'su-id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
    field('이름', 'su-name', 'text'),
    field('비밀번호(10자 이상)', 'su-pw', 'password', { autocomplete: 'new-password' }),
    field('비밀번호 한 번 더', 'su-pw2', 'password', { autocomplete: 'new-password' }),
    h('div', { class: 'line', style: 'margin-top:14px' },
      h('button', { class: 'btn-red', type: 'submit', text: '가입하고 들어가기' }),
      h('button', { class: 'btn-text', type: 'button', text: '닫기', onclick: () => { S.signup = false; draw(mainForms()); } })))
    : h('div', { class: 'line', style: 'align-items:center' },
      h('div', { class: 'lab', style: 'margin:0;flex:1', text: '처음 오셨나요?' }),
      h('button', { class: 'btn-line', type: 'button', text: '가입하기', onclick: () => { S.signup = true; draw(mainForms()); if ($('su-id')) $('su-id').focus(); } })));

const setupForm = (ai, code) => h('form', { onsubmit: setup },
  h('div', { class: 'when', text: '처음 설정 — 운영자 계정을 만듭니다. 이 화면은 한 번만 나옵니다.' }),
  code ? field('설정 코드(서버 콘솔의 XXXX-XXXX-XXXX 또는 Secrets 의 SE2_SETUP_CODE)', 'st-code', 'text', { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' }) : null,
  field('아이디(영문 소문자 · 숫자)', 'st-id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
  field('이름', 'st-name', 'text'),
  field('비밀번호(10자 이상)', 'st-pw', 'password', { autocomplete: 'new-password' }),
  field('비밀번호 한 번 더', 'st-pw2', 'password', { autocomplete: 'new-password' }),
  ai ? field('Claude(Anthropic) API 키(나중에 — ChatGPT · Gemini 키는 «내 계정»에서)', 'st-key', 'password', { autocomplete: 'off', spellcheck: 'false' }) : h('input', { id: 'st-key', type: 'hidden' }),
  sayLine(),
  h('button', { class: 'btn-red', type: 'submit', text: '만들고 들어가기' }));

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

// 다시 그려도 치던 글은 남긴다 — «비밀번호를 잊었어요»를 누르면 쳐 둔 아이디가 지워졌다(2026-10-07 검수).
function draw(form) {
  const root = $('root');
  const keep = {};
  for (const el of root.querySelectorAll('input[id]')) if (el.type !== 'hidden' && el.value !== el.defaultValue) keep[el.id] = el.value;
  root.textContent = '';
  root.appendChild(h('div', { class: 'body', style: 'max-width:380px;margin:0 auto;padding-top:12vh;padding-bottom:40px' },
    h('div', { class: 'top-name', style: 'font-size:30px;margin-bottom:24px', text: '스토리 엔진' }), form));
  for (const [id, v] of Object.entries(keep)) {
    const el = $(id);
    if (!el) continue;
    el.value = v;
    if (el.dataset.lock) { el.readOnly = false; delete el.dataset.lock; }
  }
  // 재설정 칸의 아이디는 로그인 칸에 쳐 둔 것으로 채운다
  if ($('rs-id') && !$('rs-id').value && $('lg-id') && $('lg-id').value) $('rs-id').value = $('lg-id').value;
  if (S.invite) wireIdCheck('nu-id', () => ({ code: S.invite.code }));
}

(async () => {
  const st = await fetch('/api/setup').then((r) => r.json()).catch(() => ({}));
  S.gate = st.code === 'gate';
  S.edition = st.edition === 'open' ? 'open' : 'school';
  // 링크로 왔으면(초대 링크 · 재설정 링크) 코드를 채워 둔다 — 주소창에서는 지운다(뒤에 남는 화면 · 스크린샷에 코드가 덜 보이게)
  const q = new URLSearchParams(location.search);
  const linkInvite = q.get('invite') || ''; const linkReset = q.get('reset') || ''; const linkId = q.get('id') || '';
  if (linkInvite || linkReset) history.replaceState(null, '', '/login');
  if (linkReset && !st.needed) S.forgot = true;
  // 자유 가입판 — /login?signup 으로 오면(소개 페이지 · 결제창의 «진입 페이지») 가입 칸을 열어 둔다
  if (S.edition === 'open' && q.has('signup') && !linkReset) S.signup = true;
  draw(st.needed ? setupForm(st.ai, st.code) : mainForms());
  if (!st.needed && linkReset) {
    if ($('rs-id')) $('rs-id').value = linkId;
    if ($('rs-code')) $('rs-code').value = linkReset;
    if ($('rs-pw')) $('rs-pw').focus();
    tell('재설정 링크로 왔습니다 — 새 비밀번호만 정하면 됩니다');
  } else if (!st.needed && linkInvite && $('iv-code')) {
    $('iv-code').value = linkInvite;
    await checkCode({ preventDefault() {} });   // 맞으면 곧바로 «계정 만들기» 칸이 열린다
  }
  const boot = $('boot');
  if (boot) boot.remove();
})();
