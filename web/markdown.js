// 마크다운을 화면에 꼴대로 — AI 가 쓴 글(제목 · 굵게 · 목록 · 표 · 인용 · 코드)이 기호째 보이지 않게(2026-10-07 사용자 지시).
// 의존성 없음. **HTML 로 끼워 넣지 않는다** — 요소를 만들고 글은 textContent 로만 넣는다(글 속의 <script> 따위가 그대로 글자로 보인다).
// 링크는 http(s) 만 살리고 새 창으로 연다. 개인판 · 온라인판이 함께 쓴다.

(function (root) {
  'use strict';
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  // 그림 — 이 작품의 것(img:<그림 id>)만 그린다. 주소는 부르는 쪽이 opts.image(id) 로 준다(DESIGN §6-9).
  // 그 밖의 주소(http · data)나 주소를 줄 수 없는 자리(온라인판)는 «[그림: 설명]» 글로 — 바깥 주소를 몰래 불러오지 않는다.
  function picture(alt, url, opts) {
    const m = /^img:([A-Za-z0-9_-]{1,64})$/.exec(url);
    const src = m && opts && typeof opts.image === 'function' ? String(opts.image(m[1]) || '') : '';
    if (!src) { const t = el('span', 'md-noimg'); t.textContent = '[그림' + (alt.trim() ? ': ' + alt.trim() : '') + ']'; return t; }
    const img = el('img', 'md-img'); img.src = src; img.alt = alt; img.loading = 'lazy';
    return img;
  }
  // 글자 번호(&#91; · &#x5B;)와 이름(&amp; 따위) — 남의 프로그램에서 온 마크다운이 기호째 보이지 않게
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function entity(e) {
    if (e[0] !== '#') return ENT[e] || '';
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
  }

  // 한 줄 안의 꾸밈 — `코드` · **굵게** · *기울임* · ~~지움~~ · [글](주소) · ![설명](img:그림) · 역슬래시 표기(\[) · 글자 번호(&#91;)
  function inline(parent, text, opts) {
    const re = /!\[([^\]\n]*)\]\(([^)\s]+)\)|\\([\\`*_{}[\]()#+\-.!~|<>])|&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos|nbsp);|(`+)([^`]+?)\5|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w가-힣])_([^_\s][^_]*?)_(?![\w가-힣])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      let n;
      if (m[2] != null) n = picture(m[1], m[2], opts);
      else if (m[3] != null) n = document.createTextNode(m[3]);
      else if (m[4] != null) n = document.createTextNode(entity(m[4]));
      else if (m[6] != null) { n = el('code'); n.textContent = m[6]; }
      else if (m[7] != null || m[8] != null) { n = el('strong'); inline(n, m[7] != null ? m[7] : m[8], opts); }
      else if (m[9] != null) { n = el('del'); inline(n, m[9], opts); }
      else if (m[10] != null || m[11] != null) { n = el('em'); inline(n, m[10] != null ? m[10] : m[11], opts); }
      else { n = el('a'); n.textContent = m[12]; n.href = m[13]; n.target = '_blank'; n.rel = 'noopener noreferrer'; }
      parent.appendChild(n);
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  // opts = { image(id) → 그림 주소 } — 없으면 그림 자리는 글로 선다
  function render(src, opts) {
    const box = el('div', 'md');
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el('p');
      para.forEach((l, k) => { if (k) p.appendChild(el('br')); inline(p, l, opts); });
      box.appendChild(p);
      para = [];
    };
    while (i < lines.length) {
      const l = lines[i];
      // 코드 덩이 ```
      if (/^\s*```/.test(l)) {
        flush();
        const pre = el('pre'); const code = el('code');
        const body = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
        i++;
        code.textContent = body.join('\n');
        pre.appendChild(code); box.appendChild(pre);
        continue;
      }
      if (!l.trim()) { flush(); i++; continue; }
      let m;
      if ((m = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
        flush();
        const hN = el('h' + Math.min(6, m[1].length)); inline(hN, m[2], opts); box.appendChild(hN); i++; continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); box.appendChild(el('hr')); i++; continue; }
      // 표 — 머리줄 + 가름줄
      if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
        flush();
        const t = el('table'); const head = el('tr');
        for (const c of cells(l)) { const th = el('th'); inline(th, c, opts); head.appendChild(th); }
        t.appendChild(head);
        i += 2;
        while (i < lines.length && isRow(lines[i])) {
          const tr = el('tr');
          for (const c of cells(lines[i])) { const td = el('td'); inline(td, c, opts); tr.appendChild(td); }
          t.appendChild(tr); i++;
        }
        const wrap = el('div', 'md-table'); wrap.appendChild(t); box.appendChild(wrap);
        continue;
      }
      // 인용 >
      if (/^\s{0,3}>/.test(l)) {
        flush();
        const q = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
        const bq = el('blockquote');
        bq.appendChild(render(q.join('\n'), opts));
        box.appendChild(bq);
        continue;
      }
      // 목록 — - * + · 1. 1)
      if (/^\s*([-*+•]|\d+[.)])\s+/.test(l)) {
        flush();
        const ordered = /^\s*\d+[.)]\s+/.test(l);
        const list = el(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*+•]|\d+[.)])\s+/.test(lines[i])) {
          const li = el('li');
          let text = lines[i].replace(/^\s*([-*+•]|\d+[.)])\s+/, '');
          const box2 = text.match(/^\[([ xX])\]\s+(.*)$/);   // 할 일 칸 - [ ] / - [x]
          if (box2) { li.appendChild(document.createTextNode(box2[1] === ' ' ? '☐ ' : '☑ ')); text = box2[2]; }
          inline(li, text, opts);
          i++;
          // 이어지는 들여 쓴 줄은 같은 항목으로
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+•]|\d+[.)])\s+/.test(lines[i])) { li.appendChild(el('br')); inline(li, lines[i].trim(), opts); i++; }
          list.appendChild(li);
        }
        box.appendChild(list);
        continue;
      }
      para.push(l);
      i++;
    }
    flush();
    return box;
  }

  root.SEMarkdown = { render };
})(typeof window !== 'undefined' ? window : globalThis);
