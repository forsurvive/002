// 마크다운을 화면에 꼴대로 — AI 가 쓴 글(제목 · 굵게 · 목록 · 표 · 인용 · 코드)이 기호째 보이지 않게(2026-10-07 사용자 지시).
// 의존성 없음. **HTML 로 끼워 넣지 않는다** — 요소를 만들고 글은 textContent 로만 넣는다(글 속의 <script> 따위가 그대로 글자로 보인다).
// 링크는 http(s) 만 살리고 새 창으로 연다. 개인판 · 온라인판이 함께 쓴다.

(function (root) {
  'use strict';
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  // 한 줄 안의 꾸밈 — `코드` · **굵게** · *기울임* · ~~지움~~ · [글](주소)
  function inline(parent, text) {
    const re = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w가-힣])_([^_\s][^_]*?)_(?![\w가-힣])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      let n;
      if (m[2] != null) { n = el('code'); n.textContent = m[2]; }
      else if (m[3] != null || m[4] != null) { n = el('strong'); inline(n, m[3] != null ? m[3] : m[4]); }
      else if (m[5] != null) { n = el('del'); inline(n, m[5]); }
      else if (m[6] != null || m[7] != null) { n = el('em'); inline(n, m[6] != null ? m[6] : m[7]); }
      else { n = el('a'); n.textContent = m[8]; n.href = m[9]; n.target = '_blank'; n.rel = 'noopener noreferrer'; }
      parent.appendChild(n);
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function render(src) {
    const box = el('div', 'md');
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = el('p');
      para.forEach((l, k) => { if (k) p.appendChild(el('br')); inline(p, l); });
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
        const hN = el('h' + Math.min(6, m[1].length)); inline(hN, m[2]); box.appendChild(hN); i++; continue;
      }
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { flush(); box.appendChild(el('hr')); i++; continue; }
      // 표 — 머리줄 + 가름줄
      if (isRow(l) && i + 1 < lines.length && isSep(lines[i + 1])) {
        flush();
        const t = el('table'); const head = el('tr');
        for (const c of cells(l)) { const th = el('th'); inline(th, c); head.appendChild(th); }
        t.appendChild(head);
        i += 2;
        while (i < lines.length && isRow(lines[i])) {
          const tr = el('tr');
          for (const c of cells(lines[i])) { const td = el('td'); inline(td, c); tr.appendChild(td); }
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
        bq.appendChild(render(q.join('\n')));
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
          inline(li, text);
          i++;
          // 이어지는 들여 쓴 줄은 같은 항목으로
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+•]|\d+[.)])\s+/.test(lines[i])) { li.appendChild(el('br')); inline(li, lines[i].trim()); i++; }
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
