// 문서의 그림 파일(DESIGN §6-9) — 작품마다 data/images/<작품 id>/<그림 id>.<꼴>. 본문은 자리 표시(img:<id>)만 갖고, 작품은 목록(images)만 안다.
// 받는 꼴은 png · jpeg · gif · webp 넷뿐이다 — 이름이 아니라 앞 바이트로 가린다(svg 같은 글 꼴 그림은 받지 않는다: 그림 주소를 열면 스크립트가 돌 수 있다).
// 그림은 지우지 않는다(옛 판 · 휴지통이 가리킬 수 있다) — 작품을 지울 때만 폴더째 지운다.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './store.mjs';

export const IMAGE_MAX = 8 * 1024 * 1024;   // 한 장 — 화면이 올리기 전에 긴 변 1600px 로 줄이므로 넉넉하다
export const IMAGES_PER_OP = 200;            // 한 요청에 실려 오는 그림 수(파일 하나 · 자료 묶음)
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const safe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '');
const dirOf = (pid) => join(DATA_DIR, 'images', safe(pid));

export function sniff(buf) {
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

// base64 한 장 → { buf, mime } 또는 { error }(사람 말)
export function decode(data) {
  let buf;
  try { buf = Buffer.from(String(data || '').replace(/^data:[^,]*,/, ''), 'base64'); } catch { buf = null; }
  if (!buf || !buf.length) return { error: '그림이 비어 있습니다' };
  if (buf.length > IMAGE_MAX) return { error: '그림이 너무 큽니다(8MB 까지)' };
  const mime = sniff(buf);
  if (!mime) return { error: 'png · jpg · gif · webp 그림만 넣을 수 있습니다' };
  return { buf, mime };
}

export function save(pid, id, buf, mime) {
  if (!EXT[mime] || !safe(id)) return false;
  mkdirSync(dirOf(pid), { recursive: true });
  writeFileSync(join(dirOf(pid), safe(id) + '.' + EXT[mime]), buf);
  return true;
}

export function read(pid, id) {
  if (!safe(pid) || !safe(id)) return null;
  for (const [mime, ext] of Object.entries(EXT)) {
    const f = join(dirOf(pid), safe(id) + '.' + ext);
    if (existsSync(f)) return { mime, buf: readFileSync(f) };
  }
  return null;
}

export function removeAll(pid) {
  if (!safe(pid)) return;
  rmSync(dirOf(pid), { recursive: true, force: true });
}

// 받은 그림 묶음 [{ key, name, data }] → 가려 둔다(아직 쓰지 않는다). 돌려주는 값: { list: [{ key, id, name, buf, mime }], error }
// newId 는 그림 id 를 짓는 손(작품 id 와 따로 — 작품을 만들기 전에 글 속 열쇠를 먼저 바꿀 수 있게)
export function prepare(items, newId) {
  const arr = Array.isArray(items) ? items : [];
  if (arr.length > IMAGES_PER_OP) return { list: [], error: '그림이 너무 많습니다(한 번에 ' + IMAGES_PER_OP + '장까지)' };
  const list = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const d = decode(x.data);
    if (d.error) return { list: [], error: (x.name ? x.name + ' — ' : '') + d.error };
    list.push({ key: String(x.key || ''), id: newId('i').replace(/[^A-Za-z0-9_-]/g, ''), name: String(x.name || '그림').slice(0, 200), buf: d.buf, mime: d.mime });
  }
  return { list, error: '' };
}
