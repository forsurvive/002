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

document.getElementById('root').appendChild(
  h('div', { class: 'body', style: 'max-width:380px;margin:0 auto;padding-top:14vh' },
    h('div', { class: 'top-name', style: 'font-size:30px;margin-bottom:24px', text: '스토리 엔진' }),
    h('form', { onsubmit: enter },
      h('div', { class: 'lab', text: '아이디' }),
      h('input', { id: 'lg-id', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' }),
      h('div', { class: 'lab', style: 'margin-top:14px', text: '비밀번호' }),
      h('input', { id: 'lg-pw', type: 'password', autocomplete: 'current-password' }),
      h('div', { id: 'say', class: 'notice', style: 'min-height:22px;margin:10px 0' }),
      h('button', { class: 'btn-red', type: 'submit', text: '들어가기' }))));
