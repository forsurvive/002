'use strict';

// 상점과 잇는 자리 — 열쇠를 받아 두고, 하루 한 번 두드리고, 없으면 혼자 판정한다.
//
// ── 이 파일이 지키는 약속
//
// **원고는 한 글자도 나가지 않는다.** 두드릴 때 보내는 것은 판(version)과 OS 뿐이다.
// 문서 제목도 보내지 않는다 — 제목도 원고다.
//
// **서버가 죽어도 작가는 쓴다.** 열쇠(라이선스)에 만료가 박혀 서명되어 오므로
// 브리지가 공개키로 **네트워크 없이** 판정한다. 상점이 며칠 누워 있어도 일이 멎지 않는다.
//
// **잠기는 것은 «새 호출»뿐이다.** 읽기·내보내기·되짚기는 열쇠와 무관하게 늘 열려 있다.
// 작가가 쓴 글을 인질로 잡지 않는다 — 이것이 파는 쪽의 신뢰다.

import { join } from 'node:path';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { DATA_DIR, readJson, writeJson } from './store.mjs';
import * as prompts from './prompts.mjs';
import { createHash } from 'node:crypto';

export const LINK_FILE = () => join(DATA_DIR, 'link.json');

// 이 판의 이름. 상점이 «누가 어느 판을 돌리는지» 보는 데에만 쓴다.
export const VERSION = '1.0.0';

// 상점의 공개키 — 배포물에 심어 둔다. 감출 값이 아니다(공개키다).
// 비어 있으면 처음 이을 때 /bridge/key 에서 받아 적어 둔다.
const b64u = (s) => Buffer.from(String(s || ''), 'base64url');

// 상점이 어디 있는가. 도메인을 받으면 이 값을 바꾼다(그때까지는 집에서 띄운 상점).
export const DEFAULT_SITE = String(process.env.SE2_STORE || 'http://127.0.0.1:8811').replace(/\/+$/, '');

// 한 번 눌러 잇는 길 — 상점을 열면서 «여기로 돌려보내라»를 달고 간다.
// 상점은 loopback 만 받아 주므로 이 주소는 그 사람의 기계 안에서만 쓴다.
export function linkUrl(port) {
  const site = link().site || DEFAULT_SITE;
  const back = 'http://127.0.0.1:' + port + '/link';
  return site + '/link?back=' + encodeURIComponent(back);
}

// 상점을 그냥 열 때(구독하러 가기 등).
//
// **돌아올 주소를 달고 간다.** 같은 창에서 다녀오게 바뀐 뒤로 이것이 없으면
// 상점에 닿은 사람이 제 원고로 돌아올 길이 브라우저의 «뒤로» 뿐이다.
// 결제를 다녀오면 그 «뒤로»마저 여러 칸이 된다. 상점은 이 주소가 loopback 일 때만 쓴다.
export function shopUrl(port = 0) {
  const site = link().site || DEFAULT_SITE;
  if (!port) return site;
  return site + '/?back=' + encodeURIComponent('http://127.0.0.1:' + port + '/');
}

// 상점이 지금 서 있는가. **가기 전에 물어본다** —
// 같은 창으로 옮겨 가므로, 닿지 않는 곳으로 보내면 작가의 화면이 죽은 쪽으로 덮인다.
export async function reachable(site = '', ms = 4000) {
  const base = String(site || link().site || DEFAULT_SITE).replace(/\/+$/, '');
  try {
    const r = await fetch(base + '/health', { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch { return false; }
}

// 돌아온 열쇠를 받는다 — 주소는 우리가 이미 안다.
export async function take(token) {
  return connect(link().site || DEFAULT_SITE, token);
}

export function link() {
  const v = readJson(LINK_FILE(), null) || {};
  return {
    site: String(v.site || '').replace(/\/+$/, ''),
    token: String(v.token || ''),
    publicKey: String(v.publicKey || ''),
    license: String(v.license || ''),
    email: String(v.email || ''),
    checkedAt: Number(v.checkedAt) || 0,
    lastError: String(v.lastError || ''),
  };
}

export function linkWrite(next = {}) {
  const now = link();
  writeJson(LINK_FILE(), { ...now, ...next });
  return view();
}

// 왜 막혔는지를 **작가의 말로** 옮긴다.
//
// 「열쇠」·「공개키」·「서명」은 우리끼리 쓰는 말이다. 화면에 그대로 내보내면
// 글을 쓰러 온 사람이 제가 무엇을 해야 하는지 알 수 없다. 할 일은 하나다 — 구독.
// (브라우저에서 «열쇠가 없습니다»가 홈에 찍히는 것을 보고 고쳤다.)
export function whyHuman(l = link(), lic = null, now = Date.now()) {
  const v = lic || readLicense(l, now);
  if (!l.token) return '아직 잇지 않았습니다';
  if (v.ok && (v.rights || []).includes('bridge')) return '';
  if (!l.license || v.ok) return '구독이 없습니다';
  if (String(v.why || '').includes('지났')) return '구독 기간이 지났습니다';
  return '구독을 확인하지 못했습니다';
}

// 화면에 내려 주는 꼴 — **열쇠는 돌려주지 않는다**(들어 있는지만 이른다).
export function view(now = Date.now()) {
  const l = link();
  const lic = readLicense(l, now);
  return {
    site: l.site || DEFAULT_SITE,
    email: l.email,
    linked: !!l.token,
    checkedAt: l.checkedAt,
    lastError: l.lastError,
    ok: !!(lic && lic.ok),
    rights: lic && lic.rights ? lic.rights : [],
    until: lic && lic.exp ? lic.exp : 0,
    why: whyHuman(l, lic, now),
  };
}

// ── 열쇠 읽기 — 네트워크 없이 여기서 끝난다

export function readLicense(l = link(), now = Date.now()) {
  if (!l.license) return { ok: false, rights: [], why: '열쇠가 없습니다' };
  if (!l.publicKey) return { ok: false, rights: [], why: '공개키가 없습니다' };
  const s = String(l.license);
  const i = s.lastIndexOf('.');
  if (i <= 0) return { ok: false, rights: [], why: '열쇠가 깨졌습니다' };
  let pub;
  try { pub = createPublicKey({ key: b64u(l.publicKey), format: 'der', type: 'spki' }); } catch { return { ok: false, rights: [], why: '공개키가 깨졌습니다' }; }
  let good = false;
  try { good = edVerify(null, Buffer.from(s.slice(0, i)), pub, b64u(s.slice(i + 1))); } catch { return { ok: false, rights: [], why: '열쇠를 읽지 못했습니다' }; }
  if (!good) return { ok: false, rights: [], why: '열쇠가 맞지 않습니다' };
  let body;
  try { body = JSON.parse(b64u(s.slice(0, i)).toString('utf8')); } catch { return { ok: false, rights: [], why: '열쇠가 깨졌습니다' }; }
  if (!body.exp || now > body.exp) return { ok: false, rights: [], exp: body.exp, why: '열쇠가 지났습니다' };
  return { ok: true, rights: body.rights || [], exp: body.exp, uid: body.uid, why: '' };
}

// 지금 이 권리를 가지고 있는가. **이 한 줄이 상점과 본체를 잇는 전부다.**
export function has(code, now = Date.now()) {
  const lic = readLicense(link(), now);
  return !!(lic.ok && (lic.rights || []).includes(code));
}

// 새 호출을 걸어도 되는가.
// 잇지 않았으면 «그렇다» — 상점을 붙이기 전의 프로그램이 멈추면 안 된다.
export function mayCall(now = Date.now()) {
  const l = link();
  // **일할 줄을 모르면 부를 것이 없다.** 일꾼 아홉의 «일하는 법»은 열쇠와 함께 온다.
  // 파는 판에는 그것이 들어 있지 않으므로, 베낀 폴더는 여기서 선다 —
  // 빗장을 따로 걸지 않아도 이 한 줄이 곧 빗장이다(지운다고 열리지 않는다).
  if (!prompts.haveBrain()) return { ok: false, why: '구독이 없습니다' };
  if (!l.token) return { ok: true, why: '' };       // 아직 상점에 잇지 않았다
  const lic = readLicense(l, now);
  if (lic.ok && (lic.rights || []).includes('bridge')) return { ok: true, why: '' };
  // 작가에게는 사람 말로 이른다 — 한 자리에서 옮긴다(whyHuman).
  return { ok: false, why: whyHuman(l, lic, now) };
}

// ── 상점 두드리기

async function post(site, op, body, token) {
  const r = await fetch(site + '/api', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ op, ...body }),
  });
  if (r.status === 401) return { ok: false, error: '열쇠가 듣지 않습니다', gone: true };
  return r.json();
}

// 처음 잇기 — 사람이 상점 화면에서 받은 열쇠를 붙여 넣는다.
export async function connect(site, token) {
  const base = String(site || '').replace(/\/+$/, '');
  // 되지 않았으면 까닭을 상태에 적어 둔다 — 화면이 창을 띄우지 않고 그것을 읽어 보인다.
  const nope = (why) => { linkWrite({ site: base, lastError: why }); return { ok: false, error: why }; };
  if (!/^https?:\/\//.test(base)) return nope('주소를 다시 봐 주십시오');
  if (!String(token || '').trim()) return nope('열쇠를 붙여 넣어 주십시오');
  let pub = '';
  try {
    const k = await (await fetch(base + '/bridge/key')).json();
    pub = String((k && k.publicKey) || '');
  } catch { return nope('상점에 닿지 않습니다'); }
  if (!pub) return nope('공개키를 받지 못했습니다');
  linkWrite({ site: base, token: String(token).trim(), publicKey: pub, license: '', lastError: '' });
  return check();
}

// 끊는다 — **상점 주소는 남긴다.**
// 주소까지 지우면 다음에 [구독하기] 를 눌렀을 때 갈 곳이 집 안(127.0.0.1)으로 되돌아가고,
// 거기엔 아무것도 없다. 같은 창으로 옮겨 가므로 그 순간 작가의 화면이 죽은 쪽으로 덮인다.
export function disconnect() {
  const l = link();
  writeJson(LINK_FILE(), l.site ? { site: l.site } : {});
  return view();
}

// 하루 한 번 두드린다. **보내는 것은 판과 OS 뿐이다.**
export async function check(now = Date.now()) {
  const l = link();
  if (!l.token || !l.site) return { ok: false, error: '아직 잇지 않았습니다', view: view(now) };
  let got;
  try {
    // 들고 있는 것의 지문을 함께 보낸다 — 같으면 상점이 다시 싣지 않는다(64KB 를 날마다 나르지 않게).
    got = await post(l.site, 'bridge.check', {
      version: VERSION, os: process.platform, brain: brainHash(),
    }, l.token);
  } catch {
    // 닿지 않아도 죽지 않는다 — 들고 있는 열쇠로 버틴다. 그것이 오프라인 유예다.
    linkWrite({ lastError: '상점에 닿지 않았습니다' });
    return { ok: false, error: '상점에 닿지 않았습니다', view: view(now) };
  }
  if (got && got.gone) {
    linkWrite({ token: '', license: '', lastError: '열쇠가 듣지 않습니다' });
    return { ok: false, error: '열쇠가 듣지 않습니다', view: view(now) };
  }
  if (!got || !got.ok) {
    linkWrite({ lastError: String((got && got.error) || '되지 않았습니다') });
    return { ok: false, error: String((got && got.error) || '되지 않았습니다'), view: view(now) };
  }
  // 일하는 법이 실려 왔으면 적어 두고 곧바로 갈아 끼운다.
  // **내려오는 것뿐이다** — 이 길로 올라가는 것은 판과 OS 와 지문뿐이다.
  if (got.brain) { try { prompts.saveBrain(got.brain); } catch { /* 못 적어도 이번 걸음은 산다 */ } }
  linkWrite({ license: String(got.license || ''), email: String(got.email || ''), checkedAt: now, lastError: '' });
  return { ok: true, view: view(now) };
}

// 들고 있는 «일하는 법»의 지문. 없으면 빈 값이라 상점이 통째로 실어 준다.
export function brainHash() {
  const codes = Object.keys(prompts.BUILTIN).sort();
  if (!codes.length) return '';
  const h = createHash('sha256');
  for (const c of codes) h.update(c).update(String(prompts.BUILTIN[c].craft || ''));
  return h.digest('base64url').slice(0, 22);
}

// 하루에 한 번이면 넉넉하다. 띄울 때 한 번 두드리고 그 뒤로는 하루마다.
export const CHECK_MS = 24 * 3600 * 1000;
let timer = null;

export function beat() {
  if (timer) return;
  const tick = () => { if (link().token) check().catch(() => {}); };
  tick();
  timer = setInterval(tick, CHECK_MS);
  if (timer.unref) timer.unref();
}

export function stopBeat() { if (timer) { clearInterval(timer); timer = null; } }
