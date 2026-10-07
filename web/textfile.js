// 문서 파일(docx · pdf)에서 글만 뽑는다 — 브라우저 안에서(서버로는 뽑은 글만 간다). 의존성 없음: 압축 풀기는 브라우저의 DecompressionStream.
// 개인판 · 온라인판이 함께 쓴다. 뽑지 못하면 까닭을 담아 throw 한다(화면이 그 말을 그대로 보인다).
//
// docx: zip 안의 word/document.xml — 문단(w:p)마다 한 줄, w:t 를 잇고 w:tab · w:br 을 살린다.
// pdf : 페이지 차례(카탈로그 → Pages 나무)대로 내용 흐름을 읽어 Tj · TJ · ' · " 의 글을 모은다.
//       한글 PDF 는 거의 CID 글꼴이라 글자 번호를 ToUnicode CMap 으로 바꿔야 한다(bfchar · bfrange).
//       압축(FlateDecode) · 객체 흐름(ObjStm, PDF 1.5+)을 푼다. 암호가 걸린 파일 · 스캔(그림)만 있는 파일은 못 뽑는다.
// hwp 는 다루지 않는다(구조가 닫혀 있다) — 한글에서 «다른 이름으로 저장 → docx · pdf · txt» 를 안내한다.

(function (root) {
  'use strict';
  const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; };
  const bytesOf = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };

  async function inflate(u8, raw) {
    if (typeof DecompressionStream === 'undefined') throw new Error('이 브라우저는 압축을 풀 수 없습니다 — 최신 크롬 · 엣지 · 사파리에서 해 주세요');
    const ds = new DecompressionStream(raw ? 'deflate-raw' : 'deflate');
    const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  // zlib 꼬리가 망가진 흐름도 있다 — 끝까지 못 풀면 머리(2바이트)를 떼고 raw 로 한 번 더
  async function inflateLoose(u8) {
    try { return await inflate(u8, false); } catch { return inflate(u8.subarray(2), true); }
  }

  // ---------------------------------------------------------------- docx
  async function zipEntry(u8, name) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    // 끝에서 중앙 디렉터리 끝(EOCD) 표를 찾는다
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('docx(zip) 파일이 아닙니다');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const fname = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      if (fname === name) {
        const lnl = dv.getUint16(local + 26, true), lxl = dv.getUint16(local + 28, true);
        const data = u8.subarray(local + 30 + lnl + lxl, local + 30 + lnl + lxl + csize);
        if (method === 0) return data;
        if (method === 8) return inflate(data, true);
        throw new Error('풀 수 없는 압축 방식입니다');
      }
      p += 46 + nlen + xlen + clen;
    }
    return null;
  }
  const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&');
  async function docxText(u8) {
    const xmlBytes = await zipEntry(u8, 'word/document.xml');
    if (!xmlBytes) throw new Error('docx 안에 본문(word/document.xml)이 없습니다');
    const xml = new TextDecoder().decode(xmlBytes);
    const body = (xml.match(/<w:body[\s\S]*<\/w:body>/) || [xml])[0];
    const paras = body.match(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g) || [];
    return paras.map((p) => {
      let t = '';
      const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g;
      let m;
      while ((m = re.exec(p))) t += m[1] != null ? unxml(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n';
      return t;
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------------------------------------------------------------- pdf
  // 낱말 자르기 — 이름 · 수 · 글줄 · 16진 글줄 · 배열 · 사전 · 연산자
  function lexer(s) {
    let i = 0;
    const WS = /[\0\t\n\f\r ]/, DELIM = /[()<>\[\]{}\/%]/;
    function skip() { for (;;) { while (i < s.length && WS.test(s[i])) i++; if (s[i] === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; } else break; } }
    function lit() {
      let depth = 1, out = '';
      i++;
      while (i < s.length && depth) {
        const c = s[i++];
        if (c === '\\') {
          const d = s[i++];
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (d in map) out += map[d];
          else if (/[0-7]/.test(d)) { let o = d; while (o.length < 3 && /[0-7]/.test(s[i])) o += s[i++]; out += String.fromCharCode(parseInt(o, 8) & 0xff); }
          else if (d === '\r') { if (s[i] === '\n') i++; }
          else if (d !== '\n') out += d;
        } else if (c === '(') { depth++; out += c; } else if (c === ')') { depth--; if (depth) out += c; } else out += c;
      }
      return { t: 'str', v: out };
    }
    function next() {
      skip();
      if (i >= s.length) return null;
      const c = s[i];
      if (c === '(') return lit();
      if (c === '<' && s[i + 1] === '<') { i += 2; return { t: 'op', v: '<<' }; }
      if (c === '>' && s[i + 1] === '>') { i += 2; return { t: 'op', v: '>>' }; }
      if (c === '<') { let j = s.indexOf('>', i); if (j < 0) j = s.length; let hx = s.slice(i + 1, j).replace(/[^0-9a-fA-F]/g, ''); if (hx.length % 2) hx += '0'; i = j + 1; let v = ''; for (let k = 0; k < hx.length; k += 2) v += String.fromCharCode(parseInt(hx.substr(k, 2), 16)); return { t: 'str', v }; }
      if (c === '[' || c === ']' || c === '{' || c === '}') { i++; return { t: 'op', v: c }; }
      if (c === '/') { let j = i + 1; while (j < s.length && !WS.test(s[j]) && !DELIM.test(s[j])) j++; const v = s.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))); i = j; return { t: 'name', v }; }
      let j = i; while (j < s.length && !WS.test(s[j]) && !DELIM.test(s[j])) j++;
      if (j === i) { i++; return { t: 'op', v: c }; }
      const w = s.slice(i, j); i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { t: 'num', v: Number(w) };
      return { t: 'op', v: w };
    }
    return { next, get pos() { return i; }, set pos(v) { i = v; } };
  }
  // 값 하나 읽기(사전 · 배열 · 참조 R 까지)
  function parseValue(lx, tok) {
    const t = tok || lx.next();
    if (!t) return null;
    if (t.t === 'op' && t.v === '<<') {
      const d = {};
      for (;;) { const k = lx.next(); if (!k || (k.t === 'op' && k.v === '>>')) break; if (k.t !== 'name') continue; d[k.v] = parseValue(lx); }
      return d;
    }
    if (t.t === 'op' && t.v === '[') { const a = []; for (;;) { const x = lx.next(); if (!x || (x.t === 'op' && x.v === ']')) break; a.push(parseValue(lx, x)); } return a; }
    if (t.t === 'num') {
      // «12 0 R» — 참조인지 앞을 살짝 본다
      const save = lx.pos; const a = lx.next(); const b = a && lx.next();
      if (a && a.t === 'num' && b && b.t === 'op' && b.v === 'R') return { ref: t.v };
      lx.pos = save; return t.v;
    }
    if (t.t === 'name') return { name: t.v };
    if (t.t === 'str') return { str: t.v };
    if (t.t === 'op' && (t.v === 'true' || t.v === 'false')) return t.v === 'true';
    return null;
  }

  async function pdfText(u8) {
    const s = latin1(u8);
    if (!/^%PDF-/.test(s.slice(0, 1024).trimStart())) throw new Error('pdf 파일이 아닙니다');
    if (/\/Encrypt\s/.test(s)) throw new Error('암호가 걸린 PDF 라 읽을 수 없습니다');
    const objs = new Map();   // 번호 → { dict, raw(흐름 바이트) }
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    while ((m = re.exec(s))) {
      const start = re.lastIndex;
      const lx = lexer(s); lx.pos = start;
      let val = null;
      try { val = parseValue(lx); } catch { continue; }
      let raw = null;
      const after = s.slice(lx.pos, lx.pos + 20);
      const sm = /^\s*stream\r?\n/.exec(after);
      if (sm && val && typeof val === 'object') {
        const from = lx.pos + sm[0].length;
        const len = typeof val.Length === 'number' ? val.Length : -1;
        let to = len >= 0 && s.slice(from + len, from + len + 30).includes('endstream') ? from + len : s.indexOf('endstream', from);
        if (to < 0) to = from;
        raw = u8.subarray(from, to);
        re.lastIndex = to;
      }
      objs.set(Number(m[1]), { val, raw });
    }
    const all = [...objs.values()];
    const names = (f) => (Array.isArray(f) ? f : f ? [f] : []).map((x) => x && x.name);
    async function streamOf(o) {
      if (!o || !o.raw) return new Uint8Array(0);
      let data = o.raw;
      for (const f of names(o.val.Filter)) {
        if (f === 'FlateDecode') data = await inflateLoose(data);
        else return new Uint8Array(0);   // 그림 압축(DCT 등)은 글이 아니다
      }
      return data;
    }
    // 객체 흐름(ObjStm) 안의 객체도 꺼낸다
    for (const o of all) {
      if (!o.val || !o.val.Type || o.val.Type.name !== 'ObjStm') continue;
      const txt = latin1(await streamOf(o));
      const n = o.val.N, first = o.val.First;
      const head = txt.slice(0, first).trim().split(/\s+/).map(Number);
      for (let k = 0; k < n; k++) {
        const num = head[k * 2], off = head[k * 2 + 1];
        if (objs.has(num) && objs.get(num).val) continue;
        const lx = lexer(txt); lx.pos = first + off;
        try { objs.set(num, { val: parseValue(lx), raw: null }); } catch { /* 깨진 칸 */ }
      }
    }
    const get = (v) => (v && typeof v === 'object' && 'ref' in v ? (objs.get(v.ref) || {}).val : v);
    const objOf = (v) => (v && typeof v === 'object' && 'ref' in v ? objs.get(v.ref) : null);

    // ToUnicode CMap → { bytes: 1|2, map: Map(code → 글) }
    const cmaps = new Map();
    async function cmapOf(fontRef) {
      const key = fontRef && fontRef.ref;
      if (key != null && cmaps.has(key)) return cmaps.get(key);
      const font = get(fontRef) || {};
      let out = null;
      const tu = objOf(font.ToUnicode);
      if (tu) {
        const c = latin1(await streamOf(tu));
        const map = new Map();
        let bytes = 1;
        const hexU = (h) => { let r = ''; for (let k = 0; k + 4 <= h.length; k += 4) r += String.fromCharCode(parseInt(h.substr(k, 4), 16)); return r; };
        const cs = /<([0-9a-fA-F]+)>\s*<[0-9a-fA-F]+>/.exec((c.match(/begincodespacerange([\s\S]*?)endcodespacerange/) || [])[1] || '');
        if (cs) bytes = cs[1].length / 2;
        for (const blk of c.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
          for (const mm of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) { map.set(parseInt(mm[1], 16), hexU(mm[2])); bytes = Math.max(bytes, mm[1].length / 2); }
        }
        for (const blk of c.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
          for (const mm of blk.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
            const lo = parseInt(mm[1], 16), hi = parseInt(mm[2], 16);
            bytes = Math.max(bytes, mm[1].length / 2);
            if (hi - lo > 65535) continue;
            if (mm[4]) { const base = mm[4]; const head = base.slice(0, -4), last = parseInt(base.slice(-4), 16); for (let k = lo; k <= hi; k++) map.set(k, hexU(head) + String.fromCharCode(last + (k - lo))); }
            else { const list = [...mm[5].matchAll(/<([0-9a-fA-F]+)>/g)]; for (let k = lo; k <= hi && k - lo < list.length; k++) map.set(k, hexU(list[k - lo][1])); }
          }
        }
        out = { bytes, map };
      } else if (font.Subtype && font.Subtype.name === 'Type0') {
        out = { bytes: 2, map: null };   // CMap 이 없으면 글로 바꿀 수 없다(번호뿐)
      }
      if (key != null) cmaps.set(key, out);
      return out;
    }
    const decode = (str, cm) => {
      if (!cm) return str.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      if (!cm.map) return '';
      let r = '';
      for (let k = 0; k + cm.bytes <= str.length; k += cm.bytes) {
        let code = 0; for (let b = 0; b < cm.bytes; b++) code = code * 256 + str.charCodeAt(k + b);
        const g = cm.map.get(code); if (g != null) r += g;
      }
      return r;
    };

    // 페이지 차례 — 카탈로그(Root) → Pages → Kids. 못 찾으면 객체 차례대로 Page 를 줍는다.
    const pages = [];
    const walk = (node, inherited, depth = 0) => {
      const n = get(node); if (!n || depth > 50) return;
      const res = n.Resources ? get(n.Resources) : inherited;
      if (n.Type && n.Type.name === 'Page') pages.push({ page: n, res });
      else for (const k of n.Kids || []) walk(k, res, depth + 1);
    };
    const trailer = /trailer\s*(<<[\s\S]*?>>)/.exec(s);
    let rootRef = null;
    if (trailer) { const lx = lexer(trailer[1]); const d = parseValue(lx); rootRef = d && d.Root; }
    if (!rootRef) for (const [, o] of objs) if (o.val && o.val.Root && o.val.Type && o.val.Type.name === 'XRef') rootRef = o.val.Root;
    const cat = get(rootRef) || [...objs.values()].map((o) => o.val).find((v) => v && v.Type && v.Type.name === 'Catalog');
    if (cat && cat.Pages) walk(cat.Pages, null);
    if (!pages.length) for (const [, o] of objs) if (o.val && o.val.Type && o.val.Type.name === 'Page') pages.push({ page: o.val, res: get(o.val.Resources) });

    const out = [];
    for (const { page, res } of pages) {
      const fonts = (res && get(res.Font)) || {};
      const conts = Array.isArray(get(page.Contents)) ? get(page.Contents) : [page.Contents];
      let content = '';
      for (const c of conts) content += latin1(await streamOf(objOf(c) || { val: get(c), raw: null })) + '\n';
      const lx = lexer(content);
      const stack = [];
      let cm = null, line = '', lastY = null;
      const flush = () => { if (line.trim()) out.push(line.replace(/\s+$/, '')); line = ''; };
      for (let t = lx.next(); t; t = lx.next()) {
        if (t.t !== 'op') { stack.push(t); continue; }
        const op = t.v;
        if (op === '[') {
          const arr = [];
          for (let x = lx.next(); x && !(x.t === 'op' && x.v === ']'); x = lx.next()) arr.push(x);
          stack.push({ t: 'arr', v: arr });
          continue;
        }
        if (op === '<<') { parseValue(lx, t); continue; }
        if (op === 'BI') { const end = content.indexOf('EI', lx.pos); lx.pos = end < 0 ? content.length : end + 2; stack.length = 0; continue; }
        if (op === 'Tf') { const f = stack[stack.length - 2]; cm = f && f.t === 'name' ? await cmapOf(fonts[f.v]) : null; }
        else if (op === 'Tj' || op === "'" || op === '"') { if (op !== 'Tj') flush(); const x = stack[stack.length - 1]; if (x && x.t === 'str') line += decode(x.v, cm); }
        else if (op === 'TJ') {
          const a = stack[stack.length - 1];
          if (a && a.t === 'arr') for (const x of a.v) { if (x.t === 'str') line += decode(x.v, cm); else if (x.t === 'num' && x.v < -250) line += ' '; }
        } else if (op === 'Td' || op === 'TD') { const y = stack[stack.length - 1]; if (y && y.t === 'num' && Math.abs(y.v) > 0.5) flush(); }
        else if (op === 'T*') flush();
        else if (op === 'Tm') { const y = stack[stack.length - 1]; if (y && y.t === 'num') { if (lastY != null && Math.abs(y.v - lastY) > 0.5) flush(); lastY = y.v; } }
        else if (op === 'ET') { /* 글 덩이 끝 — 줄은 다음 이동이 정한다 */ }
        stack.length = 0;
      }
      flush();
      out.push('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // 파일 하나 → 글. 확장자로 고른다.
  async function textOf(file) {
    const name = String(file.name || '');
    const u8 = new Uint8Array(await file.arrayBuffer());
    let t = '';
    if (/\.docx$/i.test(name)) t = await docxText(u8);
    else if (/\.pdf$/i.test(name)) t = await pdfText(u8);
    else throw new Error('docx · pdf 만 읽습니다');
    if (!t.trim()) throw new Error(/\.pdf$/i.test(name) ? '글을 뽑지 못했습니다(스캔한 그림 PDF 는 읽을 수 없습니다)' : '글이 없습니다');
    return t;
  }

  root.SEText = { textOf, docxText, pdfText };
})(typeof window !== 'undefined' ? window : globalThis);
