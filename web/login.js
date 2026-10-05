'use strict';

// 온라인판의 로그인 — 앱 계정(아이디 · 비밀번호). 들어가면 첫 화면(/)으로 간다.
// 개인판에는 이 화면이 없다(그 PC 안에서만 열리므로).

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
  return n;
}

// 첫 화면 — 계정이 있으면 아이디 · 비밀번호, 처음이면 초대 코드 → (맞으면) 그 자리에서 계정 만들기.
// 시험 운영(출입 열쇠)이면 열쇠 칸이 맨 위에 하나 더 붙고, 어느 단추든 열쇠부터 넘긴다.
const S = { gate: false, invite: null, say: '' };
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
  if (st.needed) { draw(setupForm(st.ai, st.code)); return false; }
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
      h('div', { class: 'line', style: 'margin-top:14px' }, h('button', { class: 'btn-red', type: 'submit', text: '로그인' }))),
    sayLine(),
    h('div', { style: 'margin-top:18px;padding-top:18px;border-top:1px solid var(--line-soft)' },
      h('div', { class: 'lab', text: '처음 오셨나요? 초대 코드' }),
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

const setupForm = (ai, code) => h('form', { onsubmit: setup },
  h('div', { class: 'when', text: '처음 설정 — 운영자 계정을 만듭니다. 이 화면은 한 번만 나옵니다.' }),
  code ? field('설정 코드(서버 콘솔에 찍힌 XXXX-XXXX-XXXX)', 'st-code', 'text', { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' }) : null,
  field('아이디(영문 소문자 · 숫자)', 'st-id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
  field('이름', 'st-name', 'text'),
  field('비밀번호(10자 이상)', 'st-pw', 'password', { autocomplete: 'new-password' }),
  field('비밀번호 한 번 더', 'st-pw2', 'password', { autocomplete: 'new-password' }),
  ai ? field('Anthropic API 키(나중에 넣어도 됩니다)', 'st-key', 'password', { autocomplete: 'off', spellcheck: 'false' }) : h('input', { id: 'st-key', type: 'hidden' }),
  sayLine(),
  h('button', { class: 'btn-red', type: 'submit', text: '만들고 들어가기' }));

function draw(form) {
  const root = $('root');
  root.textContent = '';
  root.appendChild(h('div', { class: 'body', style: 'max-width:380px;margin:0 auto;padding-top:12vh;padding-bottom:40px' },
    h('div', { class: 'top-name', style: 'font-size:30px;margin-bottom:24px', text: '스토리 엔진' }), form));
}

(async () => {
  const st = await fetch('/api/setup').then((r) => r.json()).catch(() => ({}));
  S.gate = st.code === 'gate';
  draw(st.needed ? setupForm(st.ai, st.code) : mainForms());
  const boot = $('boot');
  if (boot) boot.remove();
})();
