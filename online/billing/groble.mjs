// 결제 대행 어댑터 — 그로블(Groble) 정기결제. 순수하다(DB · HTTP 를 모른다): 서명 검사 · 본문 읽기 · 결제창 링크.
// 근거: 그로블 공식 가이드(결제창 · 웹훅 · 웹훅 이벤트, 스키마 version 2026-04-30 — docs/OPEN_EDITION.md §3-3).
// 반영 규칙(online/billing/service.mjs)은 대행을 모르고 아래의 «정규화한 사건»만 본다 — 다른 대행(래피드 …)은 같은 꼴의 어댑터 하나로 갈아 끼운다:
//   { name, verify, parse, idempotencyKey, checkoutUrl, newRef, REF_RE }

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

export const name = 'groble';
// 참조값 규칙 — 어기면 그로블이 값만 조용히 뺀다. 주소창에 보이고 구매자가 바꿀 수 있으므로 추측 못 할 무작위 토큰을 쓴다.
export const REF_RE = /^[A-Za-z0-9\-_.:=~]{1,128}$/;
export const WINDOW_MS = 5 * 60 * 1000;   // timestamp 허용 폭 ±5분

// 그로블 사건 종류 → 정규화한 갈래
//   paid · failed · cancel_requested · terminated · refunded(정기결제) · one_time(단건 결제 · 취소 · 환불) · unknown
const KINDS = {
  'subscription_payment.completed': 'paid',          // 최초(INITIAL) · 매 갱신(RENEWAL)
  'subscription_payment.failed': 'failed',            // 갱신 실패(기본 3회 · 1일 간격 재시도 → 유예 7일)
  'subscription.cancel_requested': 'cancel_requested', // 해지 «예고» — 이용 기간은 남는다
  'subscription.terminated': 'terminated',            // 해지 완료 — 막는 것은 이것뿐
  'subscription_payment.refunded': 'refunded',        // 회차 환불 — 해지가 아니다
  'payment.completed': 'one_time',
  'payment.cancel_requested': 'one_time',
  'payment.refunded': 'one_time',
};

export const newRef = () => randomBytes(18).toString('base64url');   // 24자 — REF_RE 안

const header = (headers, key) => {
  const v = (headers || {})[key];
  return Array.isArray(v) ? String(v[0] || '') : v == null ? '' : String(v);
};
const hex64 = (s) => {
  const v = String(s || '').trim().toLowerCase().replace(/^sha256=/, '');
  return /^[0-9a-f]{64}$/.test(v) ? v : '';
};

/**
 * 서명 — X-Groble-Signature = HEX(HMAC-SHA256(secret, "{X-Groble-Timestamp}.{원본 본문}")), timestamp 는 초 · ±5분.
 * 시크릿을 바꾼 뒤 24시간은 X-Groble-Signature-Previous(옛 시크릿으로 지은 것)도 온다 — 서버에 둔 시크릿(지금 · 옛) 어느 쪽과 맞아도 된다.
 * 원본 본문(파싱하기 전 바이트)으로 셈하고, 견주기는 상수 시간.
 * @returns {{ ok: true } | { ok: false, reason: 'no_secret' | 'missing' | 'stale' | 'bad_signature' }}
 */
export function verify({ rawBody, headers, secrets, now = Date.now() }) {
  const keys = (secrets || []).map((s) => String(s || '')).filter(Boolean);
  if (!keys.length) return { ok: false, reason: 'no_secret' };
  const ts = header(headers, 'x-groble-timestamp').trim();
  const sigs = [header(headers, 'x-groble-signature'), header(headers, 'x-groble-signature-previous')].map(hex64).filter(Boolean);
  if (!/^\d{9,13}$/.test(ts) || !sigs.length) return { ok: false, reason: 'missing' };
  const sec = ts.length > 11 ? Number(ts) / 1000 : Number(ts);   // 초 — 밀리초로 와도 너그럽게(서명은 받은 글자 그대로 셈한다)
  if (Math.abs(now - sec * 1000) > WINDOW_MS) return { ok: false, reason: 'stale' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody), 'utf8');
  for (const key of keys) {
    const want = createHmac('sha256', key).update(ts + '.').update(body).digest();
    for (const s of sigs) {
      const got = Buffer.from(s, 'hex');
      if (got.length === want.length && timingSafeEqual(got, want)) return { ok: true };
    }
  }
  return { ok: false, reason: 'bad_signature' };
}

// 시험 · 도구용 — 같은 규칙으로 서명을 짓는다
export const sign = (secret, ts, rawBody) => createHmac('sha256', String(secret)).update(String(ts) + '.').update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')).digest('hex');

// ---------------------------------------------------------------- 본문 읽기(너그럽게 — 모르는 키는 무시)

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const int = (v) => { const n = typeof v === 'number' ? v : /^-?\d+(\.0+)?$/.test(str(v)) ? Number(str(v)) : NaN; return Number.isFinite(n) ? Math.round(n) : null; };
const when = (v) => { const s = str(v); if (!s) return null; const d = new Date(/^\d{9,13}$/.test(s) ? Number(s) * (s.length > 11 ? 1 : 1000) : s); return isNaN(d.getTime()) ? null : d; };
// 날짜 하나(한국 날짜 YYYY-MM-DD) — '2026-11-09' 은 그대로, 시각이 붙어 있으면 한국 시각의 날짜로
const kstDay = (v) => { const s = str(v); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; const d = when(s); return d ? d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : ''; };
// 이름을 아는 키를 깊이 셋까지 찾는다(가이드에 자리가 적히지 않은 값 — isFinal · serviceEndsAt)
function deep(o, key, depth = 3) {
  let level = [o];
  for (let d = 0; d <= depth && level.length; d++) {
    const next = [];
    for (const x of level) {
      if (!isObj(x)) continue;
      if (key in x) return x[key];
      for (const v of Object.values(x)) if (isObj(v)) next.push(v);
    }
    level = next;
  }
  return undefined;
}

/**
 * 원본 본문 → 정규화한 사건. 읽지 못하면 { ok: false } — 받는 쪽은 그래도 200 으로 받고 «확인 필요»로 세운다.
 * 본문 꼴: { id, type, version, occurredAt, data: { object } }
 */
export function parse(rawBody) {
  let body;
  try { body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')); } catch { return { ok: false, problems: ['json'] }; }
  if (!isObj(body)) return { ok: false, problems: ['shape'] };
  const o = isObj(body.data) && isObj(body.data.object) ? body.data.object : {};
  const sub = isObj(o.subscription) ? o.subscription : {};
  const buyer = isObj(o.buyer) ? o.buyer : {};
  const content = isObj(o.content) ? o.content : {};
  const pricing = isObj(o.pricing) ? o.pricing : {};
  const term = isObj(o.termination) ? o.termination : {};
  const type = str(body.type);
  const problems = [];
  if (!isObj(body.data) || !isObj(body.data.object)) problems.push('object');
  const refRaw = str(o.sellerReference);
  const final = deep(o, 'isFinal');
  return {
    ok: true,
    body,
    id: str(body.id),
    type,
    version: str(body.version),
    kind: KINDS[type] || 'unknown',
    occurredAt: when(body.occurredAt),
    ref: REF_RE.test(refRaw) ? refRaw : '',
    merchantUid: str(o.merchantUid).slice(0, 200),
    buyer: { name: str(buyer.displayName || buyer.name), email: str(buyer.email), phone: str(buyer.phoneNumber || buyer.phone) },
    contentId: str(content.id),
    paymentType: str(content.paymentType).toUpperCase(),
    amount: int(pricing.finalAmount),
    billingReason: str(sub.billingReason).toUpperCase(),
    round: int(sub.currentRound),
    nextBillingDate: kstDay(sub.nextBillingDate),
    subStatus: str(sub.status),
    cycleMonths: int(sub.billingCycleMonths),
    isFinal: final === true || final === 'true',
    serviceEndsAt: when(deep(o, 'serviceEndsAt')),
    terminatedAt: when(term.terminatedAt) || when(deep(o, 'terminatedAt')),
    problems,
  };
}

// 두 번 처리하지 않기 — X-Groble-Idempotency-Key, 없으면 사건 id
export function idempotencyKey(headers, ev) {
  const k = header(headers, 'x-groble-idempotency-key').trim().slice(0, 200);
  return k || (ev && ev.id ? 'event:' + ev.id.slice(0, 190) : '');
}

// 결제창 링크 + ?ref=<참조값> — 운영자가 넣은 링크가 https 이고 참조값이 규칙 안일 때만
export function checkoutUrl(base, ref) {
  if (!REF_RE.test(String(ref || ''))) return '';
  let u;
  try { u = new URL(String(base || '').trim()); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  u.searchParams.set('ref', ref);
  return u.toString();
}
