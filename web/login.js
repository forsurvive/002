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

async function enter(e) {
  e.preventDefault();
  const say = document.getElementById('say');
  say.textContent = '';
  const r = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId: document.getElementById('lg-id').value, password: document.getElementById('lg-pw').value }),
  }).catch(() => null);
  const out = r ? await r.json().catch(() => ({ ok: false })) : { ok: false, error: '연결되지 않습니다' };
  if (out.ok) { location.href = '/'; return; }
  say.textContent = out.error || '들어가지 못했습니다';
}

// 처음 설정 — 계정이 하나도 없을 때만 서버가 needed 를 준다. 운영자 계정과 (있으면) AI 키를 한 번에.
// 키는 서버가 봉해 저장하고 다시 돌려주지 않는다 — 이 화면도 보낸 뒤 칸을 비운다.
async function setup(e) {
  e.preventDefault();
  const say = document.getElementById('say');
  const v = (id) => document.getElementById(id).value;
  say.textContent = '';
  if (v('st-pw') !== v('st-pw2')) { say.textContent = '비밀번호가 서로 다릅니다'; return; }
  const r = await fetch('/api/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId: v('st-id'), password: v('st-pw'), displayName: v('st-name'), apiKey: v('st-key') }),
  }).catch(() => null);
  document.getElementById('st-key').value = '';
  const out = r ? await r.json().catch(() => ({ ok: false })) : { ok: false, error: '연결되지 않습니다' };
  if (out.ok) { if (out.note) alert(out.note); location.href = '/'; return; }
  say.textContent = out.error || '설정하지 못했습니다';
}

const field = (label, id, type, extra = {}) => [
  h('div', { class: 'lab', style: 'margin-top:14px', text: label }),
  h('input', { id, type, ...extra }),
];

const loginForm = () => h('form', { onsubmit: enter },
  h('div', { class: 'lab', text: '아이디' }),
  h('input', { id: 'lg-id', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
  h('div', { class: 'lab', style: 'margin-top:14px', text: '비밀번호' }),
  h('input', { id: 'lg-pw', type: 'password', autocomplete: 'current-password' }),
  h('div', { id: 'say', class: 'notice', style: 'min-height:22px;margin:10px 0' }),
  h('button', { class: 'btn-red', type: 'submit', text: '들어가기' }));

const setupForm = (ai) => h('form', { onsubmit: setup },
  h('div', { class: 'when', text: '처음 설정 — 쓸 계정을 만듭니다. 이 화면은 한 번만 나옵니다.' }),
  field('아이디(영문 소문자 · 숫자)', 'st-id', 'text', { autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
  field('이름', 'st-name', 'text'),
  field('비밀번호(10자 이상)', 'st-pw', 'password', { autocomplete: 'new-password' }),
  field('비밀번호 한 번 더', 'st-pw2', 'password', { autocomplete: 'new-password' }),
  ai ? field('Anthropic API 키(나중에 넣어도 됩니다)', 'st-key', 'password', { autocomplete: 'off', spellcheck: 'false' }) : h('input', { id: 'st-key', type: 'hidden' }),
  h('div', { id: 'say', class: 'notice', style: 'min-height:22px;margin:10px 0' }),
  h('button', { class: 'btn-red', type: 'submit', text: '만들고 들어가기' }));

(async () => {
  const st = await fetch('/api/setup').then((r) => r.json()).catch(() => ({}));
  document.getElementById('root').appendChild(
    h('div', { class: 'body', style: 'max-width:380px;margin:0 auto;padding-top:14vh' },
      h('div', { class: 'top-name', style: 'font-size:30px;margin-bottom:24px', text: '스토리 엔진' }),
      st.needed ? setupForm(st.ai) : loginForm()));
})();
