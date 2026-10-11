'use strict';
// 소개 · 개인정보처리방침 · 이용약관 — 로그인 없이 열리는 읽기 쪽(docs/OPEN_EDITION.md §4-10).
// 글은 HTML 에 그대로 있다(스크립트 없이도 읽힌다). 여기서는 앱 이름 · 용도만 채운다 — 이름은 서버가 준다(/api/setup).
(async () => {
  let st = {};
  try { st = await (await fetch('/api/setup')).json(); } catch { /* 이름 없이도 읽힌다 */ }
  const name = st && st.name ? String(st.name) : '';
  if (name) {
    for (const el of document.querySelectorAll('[data-name]')) el.textContent = name;
    document.title = name + ' — ' + (document.body.dataset.title || '');
  }
  // 용도마다 다른 한 단락(전자책 오토 · 스토리 엔진) — 모르면 둘 다 보인다
  const purpose = st && st.purpose ? String(st.purpose) : '';
  if (purpose) for (const el of document.querySelectorAll('[data-purpose]')) el.hidden = el.dataset.purpose !== purpose;
})();
