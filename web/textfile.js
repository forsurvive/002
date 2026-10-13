// 문서 파일(docx · pdf)에서 글만 뽑는다 — 브라우저 안에서(서버로는 뽑은 글만 간다). 의존성 없음: 압축 풀기는 브라우저의 DecompressionStream.
// 개인판 · 온라인판이 함께 쓴다. 뽑지 못하면 까닭을 담아 throw 한다(화면이 그 말을 그대로 보인다).
//
// docx: zip 안의 word/document.xml — 문단(w:p)마다 한 줄, w:t 를 잇고 w:tab · w:br 을 살린다.
// pdf : 페이지 차례(카탈로그 → Pages 나무)대로 내용 흐름을 읽어 Tj · TJ · ' · " 의 글을 모은다.
//       한글 PDF 는 거의 CID 글꼴이라 글자 번호를 ToUnicode CMap 으로 바꿔야 한다(bfchar · bfrange).
//       압축(FlateDecode) · 객체 흐름(ObjStm, PDF 1.5+)을 푼다. 암호가 걸린 파일 · 스캔(그림)만 있는 파일은 글로는 못 뽑는다.
// hwp 는 다루지 않는다(구조가 닫혀 있다) — 한글에서 «다른 이름으로 저장 → docx · pdf · txt» 를 안내한다.
// 개인판은 그림도 꺼낸다(contentOf · mdContent — DESIGN §6-9): docx 본문 속 그림 · pdf 에 그려진 그림 · md 속 data: 그림 · 그림 파일.
// 그림은 브라우저에 있다가 글과 함께 서버로 간다(글 속 자리는 임시 열쇠 img:k1 — 서버가 그림 id 로 바꾼다).

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
  // 그림(DESIGN §6-9) — 받는 꼴은 png · jpeg · gif · webp. 앞 바이트로 가린다(서버도 다시 가린다)
  function sniff(u8) {
    if (!u8 || u8.length < 12) return '';
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
    if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'image/jpeg';
    if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x38) return 'image/gif';
    if (latin1(u8.subarray(0, 4)) === 'RIFF' && latin1(u8.subarray(8, 12)) === 'WEBP') return 'image/webp';
    return '';
  }
  // 글 속 그림 자리 — 임시 열쇠(k1 …). 서버가 받아 둔 그림 id 로 바꾼다
  const picRef = (alt, key) => '![' + String(alt || '그림').replace(/[[\]\n]/g, ' ').trim() + '](img:' + key + ')';

  // opts.images 가 참이면 본문 속 그림(a:blip · v:imagedata)을 놓인 자리에 꺼낸다 — 그림 설명(docPr descr)이 있으면 그것을 설명으로
  async function docxContent(u8, opts = {}) {
    const xmlBytes = await zipEntry(u8, 'word/document.xml');
    if (!xmlBytes) throw new Error('docx 안에 본문(word/document.xml)이 없습니다');
    const xml = new TextDecoder().decode(xmlBytes);
    const body = (xml.match(/<w:body[\s\S]*<\/w:body>/) || [xml])[0];
    const paras = body.match(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g) || [];
    const rels = new Map();
    if (opts.images) {
      const rb = await zipEntry(u8, 'word/_rels/document.xml.rels');
      for (const r of (rb ? new TextDecoder().decode(rb) : '').match(/<Relationship\b[^>]*>/g) || []) {
        const id = (/\bId="([^"]+)"/.exec(r) || [])[1], target = (/\bTarget="([^"]+)"/.exec(r) || [])[1];
        if (id && target && !/TargetMode="External"/.test(r)) rels.set(id, target.startsWith('/') ? target.slice(1) : 'word/' + target);
      }
    }
    const images = []; let skipped = 0;
    const out = [];
    for (const p of paras) {
      let t = '';
      let alt = '';
      let hadPic = false;
      const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>|<wp:docPr\b([^>]*)>|<a:blip\b[^>]*\br:embed="([^"]+)"|<v:imagedata\b[^>]*\br:id="([^"]+)"/g;
      let m;
      while ((m = re.exec(p))) {
        if (m[1] != null) t += unxml(m[1]);
        else if (m[2] != null) alt = unxml((/\bdescr="([^"]*)"/.exec(m[2]) || /\btitle="([^"]*)"/.exec(m[2]) || [])[1] || '');
        else if (m[3] != null || m[4] != null) {
          if (!opts.images) continue;
          const path = rels.get(m[3] != null ? m[3] : m[4]);
          const bytes = path ? await zipEntry(u8, path) : null;
          const mime = bytes ? sniff(bytes) : '';
          if (!mime) { skipped++; continue; }   // emf · wmf · tiff 따위
          const key = 'k' + (images.length + 1);
          images.push({ key, name: alt || '그림 ' + (images.length + 1), mime, bytes: new Uint8Array(bytes) });
          t += (t && !t.endsWith('\n') ? '\n' : '') + picRef(alt || '그림 ' + images.length, key) + '\n';
          alt = '';
          hadPic = true;
        } else t += m[0] === '<w:tab/>' ? '\t' : '\n';
      }
      out.push(hadPic ? t.replace(/\n$/, '') : t);   // 그림 뒤에 붙인 줄바꿈만 걷는다(글만 뽑는 길은 지금 그대로)
    }
    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), images, skipped };
  }
  async function docxText(u8) { return (await docxContent(u8)).text; }

  // ---------------------------------------------------------------- 한글 hwpx — zip 안의 Contents/section*.xml(OWPML)에서 문단(hp:p)마다 글(hp:t)을 잇는다
  async function hwpxText(u8) {
    const list = zipDir(u8).filter((e) => /^Contents\/section\d+\.xml$/i.test(e.name))
      .sort((a, b) => Number(a.name.match(/\d+/)[0]) - Number(b.name.match(/\d+/)[0]));
    if (!list.length) throw new Error('hwpx 안에 본문(Contents/section*.xml)이 없습니다');
    const out = [];
    for (const e of list) {
      const xml = new TextDecoder().decode(await zipData(u8, e));
      for (const p of xml.match(/<hp:p[\s>][\s\S]*?<\/hp:p>/g) || []) {
        let t = '';
        const re = /<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|<hp:lineBreak\s*\/>|<hp:tab\s*\/>/g;
        let m;
        while ((m = re.exec(p))) t += m[1] != null ? unxml(m[1].replace(/<[^>]+>/g, '')) : /tab/.test(m[0]) ? '\t' : '\n';
        out.push(t);
      }
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---------------------------------------------------------------- 압축 파일(zip) — 안의 파일을 자동으로 가려 꺼낸다(DESIGN §3 «압축 파일»)
  // 중앙 디렉터리를 읽어 항목 목록을 낸다. 이름은 UTF-8 표시(비트 11)가 있으면 UTF-8, 없으면 UTF-8 로 읽어 보고 안 되면 한국어 윈도(CP949).
  function zipName(bytes, utf8) {
    if (utf8) return new TextDecoder().decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 아래 */ }
    try { return new TextDecoder('euc-kr').decode(bytes); } catch { return latin1(bytes); }
  }
  function zipDir(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('압축(zip) 파일이 아닙니다');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let n = 0; n < count && p + 46 <= u8.length; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      out.push({ name: zipName(u8.subarray(p + 46, p + 46 + nlen), !!(flags & 0x800)), flags, method, csize, usize, local });
      p += 46 + nlen + xlen + clen;
    }
    return out;
  }
  async function zipData(u8, e) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (e.local + 30 > u8.length || dv.getUint32(e.local, true) !== 0x04034b50) throw new Error('깨진 압축입니다');
    const at = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
    const data = u8.subarray(at, at + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflate(data, true);
    throw new Error('풀 수 없는 압축 방식입니다');
  }

  // 글로 읽기 — BOM(UTF-8 · UTF-16)을 먼저 보고, 그다음 UTF-8, 안 되면 한국어 윈도(CP949). 바이너리(NUL)면 null.
  function decodeText(u8) {
    if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder().decode(u8.subarray(3));
    if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
    if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
    if (u8.subarray(0, 8192).includes(0)) return null;
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { /* 아래 */ }
    try {
      const t = new TextDecoder('euc-kr').decode(u8);
      return (t.match(/�/g) || []).length > Math.max(3, t.length / 100) ? null : t;
    } catch { return null; }
  }

  // 내용으로 종류를 가린다 — 이름(확장자)은 마지막 단서다
  const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  function kindOf(name, u8) {
    if (latin1(u8.subarray(0, 5)) === '%PDF-') return 'pdf';
    if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04) {
      let names = [];
      try { names = zipDir(u8).map((e) => e.name); } catch { return 'zip'; }
      if (names.includes('word/document.xml')) return 'docx';
      if (names.some((x) => /^Contents\/section\d+\.xml$/i.test(x))) return 'hwpx';
      if (names.some((x) => /^(xl|ppt)\//.test(x))) return 'office';
      return 'zip';
    }
    if (sniff(u8)) return 'image';
    if (OLE.every((b, i) => u8[i] === b) || latin1(u8.subarray(0, 17)) === 'HWP Document File') return /\.hwp$/i.test(name) || latin1(u8.subarray(0, 3)) === 'HWP' ? 'hwp' : 'oldoffice';
    return decodeText(u8) == null ? 'binary' : 'text';
  }

  const JUNK = (path) => /(^|\/)__MACOSX\//.test(path) || /(^|\/)\._/.test(path) || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(path);
  const WHY = { hwp: '한글(hwp)은 읽지 못합니다 — hwpx · docx 로 저장해 넣어 주세요', oldoffice: '옛 오피스 문서는 읽지 못합니다 — docx · pdf 로', office: '엑셀 · 파워포인트는 읽지 못합니다 — pdf 로', binary: '글이 아닌 파일' };
  const LIMIT = { files: 1000, bytes: 300 * 1024 * 1024 };

  // 압축 하나 → { files: [{ path, kind, bytes? , text? }], skipped: [{ path, why }] }
  //   kind: 'text'(text 에 풀어 둔 글) · 'hwpx'(text 에 뽑은 글) · 'pdf' · 'docx' · 'image'(bytes 그대로)
  // 압축 안의 압축은 세 겹까지 풀어 들어간다(경로는 «바깥.zip/안의 경로»).
  async function zipFiles(u8, depth = 0, prefix = '', acc = null) {
    const top = !acc;
    acc = acc || { files: [], skipped: [], seen: 0, bytes: 0 };
    const list = zipDir(u8);
    for (const e of list) {
      const path = prefix + e.name;
      if (/\/$/.test(e.name) || JUNK(e.name)) continue;
      acc.seen += 1; acc.bytes += e.usize;
      if (acc.seen > LIMIT.files || acc.bytes > LIMIT.bytes) throw new Error('압축 안의 파일이 너무 많거나 큽니다(파일 1,000개 · 풀린 크기 300MB 까지)');
      if (e.flags & 1) { acc.skipped.push({ path, why: '암호가 걸려 있습니다' }); continue; }
      if (e.csize === 0xffffffff || e.usize === 0xffffffff) { acc.skipped.push({ path, why: '너무 큰 압축 꼴(zip64)은 풀지 못합니다' }); continue; }
      if (e.method !== 0 && e.method !== 8) { acc.skipped.push({ path, why: '풀 수 없는 압축 방식입니다' }); continue; }
      let bytes;
      try { bytes = new Uint8Array(await zipData(u8, e)); } catch (err) { acc.skipped.push({ path, why: String((err && err.message) || err) }); continue; }
      const kind = kindOf(e.name, bytes);
      if (kind === 'zip') {
        if (depth >= 2) { acc.skipped.push({ path, why: '압축이 너무 여러 겹입니다' }); continue; }
        try { await zipFiles(bytes, depth + 1, path + '/', acc); } catch (err) { acc.skipped.push({ path, why: String((err && err.message) || err) }); }
        continue;
      }
      if (kind === 'text') acc.files.push({ path, kind, text: decodeText(bytes) });
      else if (kind === 'hwpx') {
        try { acc.files.push({ path, kind, text: await hwpxText(bytes) }); } catch (err) { acc.skipped.push({ path, why: String((err && err.message) || err) }); }
      } else if (kind === 'pdf' || kind === 'docx' || kind === 'image') acc.files.push({ path, kind, bytes });
      else acc.skipped.push({ path, why: WHY[kind] || '읽지 않는 꼴' });
    }
    if (top) return { files: acc.files, skipped: acc.skipped };
    return acc;
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

  // ---------------------------------------------------------------- pdf 의 그림(DESIGN §6-9)
  // JPEG(DCTDecode)은 그대로, 8비트 회색 · RGB(FlateDecode — PNG 예측자 포함, SMask 투명도 포함)는 PNG 로 다시 싼다.
  // 그 밖의 꼴(색 목록 · CMYK · 16비트 · JPX · 팩스 꼴)은 빼고 수를 센다. 16px 아래 조각(꾸밈)은 그림으로 치지 않는다.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  async function deflate(u8) {
    if (typeof CompressionStream === 'undefined') throw new Error('이 브라우저는 압축을 할 수 없습니다');
    return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  }
  // PNG 예측자(행마다 앞에 거르개 바이트)를 풀어 날 화소로
  function unpredict(data, w, bpp) {
    const row = w * bpp, h = Math.floor(data.length / (row + 1));
    const out = new Uint8Array(row * h);
    for (let y = 0; y < h; y++) {
      const f = data[y * (row + 1)], src = y * (row + 1) + 1, at = y * row;
      for (let x = 0; x < row; x++) {
        const a = x >= bpp ? out[at + x - bpp] : 0, b = y ? out[at - row + x] : 0, c = x >= bpp && y ? out[at - row + x - bpp] : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
        out[at + x] = (data[src + x] + pred) & 0xff;
      }
    }
    return out;
  }
  async function pngOf(w, h, chans, px) {
    const type = chans === 1 ? 0 : chans === 2 ? 4 : chans === 3 ? 2 : 6;
    const row = w * chans;
    const raw = new Uint8Array((row + 1) * h);
    for (let y = 0; y < h; y++) raw.set(px.subarray(y * row, y * row + row), y * (row + 1) + 1);
    const chunk = (name, data) => {
      const td = new Uint8Array(4 + data.length); for (let i = 0; i < 4; i++) td[i] = name.charCodeAt(i); td.set(data, 4);
      const o = new Uint8Array(12 + data.length); const dv = new DataView(o.buffer);
      dv.setUint32(0, data.length); o.set(td, 4); dv.setUint32(8 + data.length, crc32(td));
      return o;
    };
    const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer); dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 8; ihdr[9] = type;
    const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let at = 0; for (const x of parts) { out.set(x, at); at += x.length; }
    return out;
  }

  async function pdfText(u8) { return (await pdfContent(u8)).text; }
  async function pdfContent(u8, opts = {}) {
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

    // 그림 한 장 — XObject(Image) → { mime, bytes } 또는 null(읽지 못하는 꼴)
    const comps = (cs) => {
      const c = get(cs);
      const n = c && c.name ? c.name : Array.isArray(c) && c[0] ? c[0].name : '';
      if (n === 'DeviceRGB' || n === 'CalRGB') return 3;
      if (n === 'DeviceGray' || n === 'CalGray') return 1;
      if (n === 'ICCBased' && Array.isArray(c)) { const icc = get(c[1]); const k = icc && icc.N; return k === 1 || k === 3 ? k : 0; }
      return 0;
    };
    async function pixels(o, chans) {
      const v = o.val;
      if (!o.raw || names(v.Filter).join() !== 'FlateDecode' || v.BitsPerComponent !== 8) return null;
      let data = await inflateLoose(o.raw);
      const dp = get(v.DecodeParms) || {};
      if (dp.Predictor >= 10) data = unpredict(data, v.Width, chans);
      else if (dp.Predictor && dp.Predictor !== 1) return null;
      return data.length >= v.Width * v.Height * chans ? data : null;
    }
    async function pdfImage(o) {
      const v = o && o.val;
      if (!v || !o.raw) return null;
      const f = names(v.Filter);
      if (f.length === 1 && f[0] === 'DCTDecode') { const b = new Uint8Array(o.raw); return sniff(b) === 'image/jpeg' ? { mime: 'image/jpeg', bytes: b } : null; }
      const chans = comps(v.ColorSpace);
      if (!chans || v.ImageMask) return null;
      const px = await pixels(o, chans);
      if (!px) return null;
      const w = v.Width, h = v.Height;
      const sm = objOf(v.SMask);
      const alpha = sm && sm.val && sm.val.Width === w && sm.val.Height === h ? await pixels(sm, 1) : null;
      if (!alpha) return { mime: 'image/png', bytes: await pngOf(w, h, chans, px.subarray(0, w * h * chans)) };
      const mix = new Uint8Array(w * h * (chans + 1));
      for (let i = 0; i < w * h; i++) { for (let k = 0; k < chans; k++) mix[i * (chans + 1) + k] = px[i * chans + k]; mix[i * (chans + 1) + chans] = alpha[i]; }
      return { mime: 'image/png', bytes: await pngOf(w, h, chans + 1, mix) };
    }
    const images = [];
    let skipped = 0;
    const seenImg = new Set();   // 쪽마다 되풀이되는 같은 그림(머리 무늬 따위)은 한 번만

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
        else if (op === 'Do' && opts.images) {
          // 그려지는 그림 — 놓인 차례대로 그 자리에 자리 표시를 세운다(DESIGN §6-9)
          const nm = stack[stack.length - 1];
          const ref = nm && nm.t === 'name' ? ((res && get(res.XObject)) || {})[nm.v] : null;
          const o = objOf(ref);
          const v = o && o.val;
          if (v && v.Subtype && v.Subtype.name === 'Image' && v.Width >= 16 && v.Height >= 16 && !seenImg.has(ref.ref)) {
            seenImg.add(ref.ref);
            const pic = await pdfImage(o);
            if (!pic) skipped++;
            else {
              flush();
              const key = 'k' + (images.length + 1);
              images.push({ key, name: '그림 ' + (images.length + 1), mime: pic.mime, bytes: pic.bytes });
              out.push('', picRef('그림 ' + images.length, key), '');   // 그림은 제 문단에
            }
          }
        }
        else if (op === 'Tm') { const y = stack[stack.length - 1]; if (y && y.t === 'num') { if (lastY != null && Math.abs(y.v - lastY) > 0.5) flush(); lastY = y.v; } }
        else if (op === 'ET') { /* 글 덩이 끝 — 줄은 다음 이동이 정한다 */ }
        stack.length = 0;
      }
      flush();
      out.push('');
    }
    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n').trim(), images, skipped };
  }

  // 파일 하나 → 글. 확장자로 고른다.
  async function textOf(file) {
    const name = String(file.name || '');
    const u8 = new Uint8Array(await file.arrayBuffer());
    let t = '';
    if (/\.docx$/i.test(name)) t = await docxText(u8);
    else if (/\.pdf$/i.test(name)) t = await pdfText(u8);
    else if (/\.hwpx$/i.test(name)) t = await hwpxText(u8);
    else throw new Error('docx · pdf · hwpx 만 읽습니다');
    if (!t.trim()) throw new Error(/\.pdf$/i.test(name) ? '글을 뽑지 못했습니다(스캔한 그림 PDF 는 읽을 수 없습니다)' : '글이 없습니다');
    return t;
  }

  // 파일 하나 → { text, images: [{ key, name, mime, bytes }], skipped } — 개인판의 [파일 선택]은 그림도 꺼낸다(DESIGN §6-9).
  // 글 속 그림 자리는 임시 열쇠(img:k1 …) — 서버가 받아 둔 그림 id 로 바꾼다. 스캔한 PDF 도 그림으로는 들어온다.
  const PIC_EXT = /\.(png|jpe?g|gif|webp)$/i;
  async function contentOf(file) {
    const name = String(file.name || '');
    const u8 = new Uint8Array(await file.arrayBuffer());
    if (PIC_EXT.test(name)) {
      const mime = sniff(u8);
      if (!mime) throw new Error('png · jpg · gif · webp 그림만 넣을 수 있습니다');
      const alt = name.replace(PIC_EXT, '');
      return { text: picRef(alt, 'k1'), images: [{ key: 'k1', name: alt, mime, bytes: u8 }], skipped: 0 };
    }
    let r;
    if (/\.docx$/i.test(name)) r = await docxContent(u8, { images: true });
    else if (/\.pdf$/i.test(name)) r = await pdfContent(u8, { images: true });
    else if (/\.hwpx$/i.test(name)) r = { text: await hwpxText(u8), images: [], skipped: 0 };
    else throw new Error('docx · pdf · hwpx · 그림 파일만 읽습니다');
    if (!r.text.trim()) throw new Error(/\.pdf$/i.test(name) ? '글도 그림도 뽑지 못했습니다' : '글이 없습니다');
    return r;
  }
  // 마크다운 글 속 data: 그림(다른 프로그램이 그림을 안에 담아 내보낸 md) → 임시 열쇠 자리 + 그림
  function mdContent(text) {
    const images = [];
    const out = String(text || '').replace(/!\[([^\]\n]*)\]\(data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)\)/g, (m, alt, mime, b64) => {
      let bytes;
      try { const bin = atob(b64.replace(/\s+/g, '')); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch { return m; }
      if (sniff(bytes) !== mime) return m;
      const key = 'k' + (images.length + 1);
      images.push({ key, name: alt || '그림 ' + (images.length + 1), mime, bytes });
      return picRef(alt || '그림 ' + images.length, key);
    });
    return { text: out, images, skipped: 0 };
  }

  root.SEText = { textOf, docxText, pdfText, hwpxText, contentOf, mdContent, sniff, zipFiles, kindOf, decodeText };
})(typeof window !== 'undefined' ? window : globalThis);
