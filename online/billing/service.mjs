// 이용권(자유 가입판의 월 이용료) — 결제 대행 웹훅을 받아 반영하고, «새 AI 작업을 해도 되나»를 답한다.
// 설계: docs/OPEN_EDITION.md §4-4 · §4-6. 대행의 말(서명 · 본문 꼴)은 어댑터(./groble.mjs)가 맡고, 여기는 정규화한 사건만 본다.
//
// 지키는 것
//   · 웹훅은 서명부터. 틀리거나 5분 밖이면 401(남기지 않는다 · 같은 곳이 거듭 틀리면 429), 시크릿이 서버에 없으면 503(대행이 다시 보낸다).
//     410 은 절대 돌려주지 않는다(대행이 엔드포인트를 끈다).
//   · 받은 원문을 먼저 남기고(같은 Idempotency-Key 는 그대로 200) 같은 트랜잭션에서 반영한다 — DB 가 잠깐 안 되면 통째로 되돌리고 503 → 다시 받는다.
//   · 도착 순서를 믿지 않는다 — 정기결제(참조값)마다 마지막으로 반영한 사건의 때(occurred_at)보다 이르거나 같은 상태 변경은 기록만.
//   · 막는 것은 «해지 완료»와 기한 지남뿐 — 결제 실패 · 해지 예고로는 막지 않는다.
//   · 읽지 못한 꼴 · 연결 못 한 결제 · 금액이 다른 결제도 200 으로 받고 «확인 필요»로 세운다.
//   · AI 비용(본인 키)과 이용료를 섞지 않는다(원칙 7). 로그에는 개인정보를 쓰지 않는다(콘솔은 ASCII · 오류 이름만).

import * as groble from './groble.mjs';
import { CANCEL_REASONS, refundMail, cancelMail, chargedMail, testMail } from './notice.mjs';
import { envMailer, transient } from '../mail.mjs';

// refundNoUse(«AI 작업 전까지만»)는 기본 끔 — 환불 버튼은 구독 시작 뒤 기간 안이면 서고, AI 작업 수는 운영자에게 가는 메일에 근거로 실린다(2026-10-10)
export const DEFAULT_RULES = { trialDays: 0, graceDays: 10, refundDays: 7, refundNoUse: false, notifyEmail: '' };
const STEP = { paid: 1, failed: 2, cancel_requested: 3, terminated: 4 };
const STATUS_STEP = { active: 1, past_due: 2, cancel_pending: 3, ended: 4 };
const DAY = 86400000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;   // tenancy.mjs 의 isUuid 와 같다 — tenancy 가 이 파일을 부르므로 순환을 만들지 않으려 따로 둔다
export const kstDay = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
// 'YYYY-MM-DD'(한국 날짜)의 그날 끝 + days 일 — 한국은 일광 절약 시간이 없어 하루는 늘 24시간
export const dayEndPlus = (ymd, days = 0) => new Date(new Date(ymd + 'T00:00:00+09:00').getTime() + (1 + days) * DAY);
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const errName = (e) => String((e && (e.code || e.name)) || 'error').replace(/[^\x20-\x7e]/g, '?').slice(0, 40);
// jsonb 는 NUL 글자를 받지 않는다 — 원문을 남기다 막히지 않게 값 안의 NUL 만 걷는다
// (직렬화한 글자에서 무늬로 지우면 구매자가 넣은 글자 «\\u0000»의 이스케이프를 깨뜨려 저장이 늘 실패한다)
const noNul = (v) => (typeof v === 'string' ? v.replace(/\u0000/g, '') : Array.isArray(v) ? v.map(noNul)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/\u0000/g, ''), noNul(x)])) : v);
const rawText = (raw) => (Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw == null ? '' : raw)).replace(/\u0000/g, '').slice(0, 20000);
export const normEmail = (e) => { const s = String(e || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+$/.test(s) ? s.slice(0, 200) : ''; };

// 이용 규칙(운영 화면 «이용 규칙») — 가입 직후 무료 체험 일수 · 결제 실패 · 해지 뒤 여유 일수 · 환불 기간 · «AI 작업을 안 했을 때만» ·
// 환불 요청 · 구독 취소를 알릴 메일 주소
export async function rulesOf(db) {
  const v = ((await db.query(`SELECT value FROM app_settings WHERE key = 'billing.rules'`)).rows[0] || {}).value || {};
  const n = (x, d, max) => (Number.isInteger(x) && x >= 0 && x <= max ? x : d);
  return { trialDays: n(v.trialDays, DEFAULT_RULES.trialDays, 90), graceDays: n(v.graceDays, DEFAULT_RULES.graceDays, 60),
    refundDays: n(v.refundDays, DEFAULT_RULES.refundDays, 30), refundNoUse: typeof v.refundNoUse === 'boolean' ? v.refundNoUse : DEFAULT_RULES.refundNoUse,
    notifyEmail: normEmail(v.notifyEmail) };
}

// ---------------------------------------------------------------- 7일 환불 · 구독 취소(docs/OPEN_EDITION.md §4-8)
// 환불 기간은 **구독 시작(그 정기결제의 첫 결제)**부터 센다(2026-10-10 사용자 지시 «가입 후 7일») — 그 안에는 [환불 요청], 지나면 [구독 취소].
// 돈을 돌려주는 것 · 정기결제를 끊는 것은 그로블 판매 관리에서 한다(판매자 API 가 없다). 여기는 판정 · 기록 · 운영자 알림 메일 · 즉시 멈춤 · «둘 다 됐나».

// 결제 뒤 이 사람이 한 AI 작업 수 — 그 사람이 시킨 생성 기록 가운데 끝까지 마쳤거나 출력이 나온 것
export async function aiRunsSince(db, userId, since) {
  return (await db.query(`SELECT count(*)::int AS n FROM generation_runs WHERE requested_by = $1 AND started_at >= $2 AND (status = 'succeeded' OR output_tokens > 0)`,
    [userId, since])).rows[0].n;
}
/**
 * 환불 판정(at 때 기준) — startAt 은 구독 시작(그 정기결제의 첫 결제). 기한 = 시작한 날(한국 날짜) + 환불 기간의 그날 끝 — 시작한 날은 세지 않는다.
 * AI 작업은 시작 뒤로 센다. 돌려주는 값: { ok, reason: ok | off | window_passed | ai_used, deadline, aiRuns, refundDays, noUse }
 */
export async function judgeRefund(db, userId, paidAt, { at = new Date(), rules = null } = {}) {
  const r = rules || await rulesOf(db);
  const deadline = dayEndPlus(kstDay(paidAt), r.refundDays);
  const aiRuns = await aiRunsSince(db, userId, paidAt);
  const reason = !r.refundDays ? 'off' : new Date(at).getTime() >= deadline.getTime() ? 'window_passed' : r.refundNoUse && aiRuns > 0 ? 'ai_used' : 'ok';
  return { ok: reason === 'ok', reason, deadline, aiRuns, refundDays: r.refundDays, noUse: r.refundNoUse };
}
// 판정을 한 줄로 — 결제 기록 · 운영 화면에 남는다(기한은 그날까지로 보인다)
export const verdictText = (j, startAt) => '구독 시작 ' + kstDay(startAt) + ' · 기한 ' + kstDay(j.deadline.getTime() - 1) + '까지 · 시작 뒤 AI 작업 ' + j.aiRuns + '회 · '
  + (j.ok ? '규정 안' : '규정 밖(' + ({ off: '환불 기간 0일', window_passed: '기간 지남', ai_used: 'AI 작업을 함' }[j.reason] || j.reason) + ')');

// 이번 회차 결제 — 그 사람의 그로블 정기결제에서 마지막으로 반영한 결제(subscriptionId 를 주면 그 정기결제에서)
async function lastPayment(db, userId, subscriptionId = null) {
  return (await db.query(
    `SELECT e.merchant_uid, coalesce(e.occurred_at, e.received_at) AS paid_at, e.amount, e.subscription_id FROM billing_events e JOIN subscriptions s ON s.id = e.subscription_id
      WHERE e.user_id = $1 AND s.provider = 'groble' AND e.type = 'subscription_payment.completed' AND e.result = 'applied' AND ($2::uuid IS NULL OR e.subscription_id = $2)
      ORDER BY coalesce(e.occurred_at, e.received_at) DESC, e.id DESC LIMIT 1`, [userId, subscriptionId])).rows[0] || null;
}

// 구독 시작 — 그 정기결제에서 처음으로 반영한 결제
async function firstPayment(db, subscriptionId) {
  return (await db.query(
    `SELECT e.merchant_uid, coalesce(e.occurred_at, e.received_at) AS paid_at, e.amount FROM billing_events e
      WHERE e.subscription_id = $1 AND e.type = 'subscription_payment.completed' AND e.result = 'applied'
      ORDER BY coalesce(e.occurred_at, e.received_at), e.id LIMIT 1`, [subscriptionId])).rows[0] || null;
}
const startOf = async (db, subscriptionId, fallback) => ((subscriptionId && await firstPayment(db, subscriptionId)) || {}).paid_at || fallback;

/**
 * 내 환불 판정 — «내 계정 → 이용권»과 [환불 요청]이 쓴다. 환불할 결제는 이번 회차, 기한은 그 정기결제의 시작부터. 돌려주는 값:
 *   { eligible, reason: ok | off | no_payment | window_passed | ai_used | requested | refunded, payment, start, deadline, aiRuns, request }
 */
export async function refundCheck(db, userId, { at = new Date() } = {}) {
  const rules = await rulesOf(db);
  const pay = await lastPayment(db, userId);
  const base = { eligible: false, payment: null, start: null, deadline: null, aiRuns: 0, refundDays: rules.refundDays, noUse: rules.refundNoUse, request: null };
  if (!rules.refundDays) return { ...base, reason: 'off' };
  if (!pay) return { ...base, reason: 'no_payment' };
  const start = await startOf(db, pay.subscription_id, pay.paid_at);
  const j = await judgeRefund(db, userId, start, { at, rules });
  const req = (await db.query(`SELECT id, source, status, created_at, refunded_at, cancelled_at FROM refund_requests
    WHERE user_id = $1 AND paid_at = $2 AND status <> 'withdrawn' ORDER BY created_at DESC LIMIT 1`, [userId, pay.paid_at])).rows[0] || null;
  const refunded = !!pay.merchant_uid && (await db.query(`SELECT 1 FROM billing_events WHERE merchant_uid = $1 AND type = 'subscription_payment.refunded' LIMIT 1`, [pay.merchant_uid])).rowCount > 0;
  const reason = refunded || (req && req.refunded_at) ? 'refunded' : req ? 'requested' : j.reason;
  return {
    ...base, eligible: reason === 'ok', reason, start, deadline: j.deadline, aiRuns: j.aiRuns,
    payment: { paidAt: pay.paid_at, merchantUid: pay.merchant_uid, amount: pay.amount, subscriptionId: pay.subscription_id },
    request: req ? { id: req.id, source: req.source, status: req.status, createdAt: req.created_at, refundedAt: req.refunded_at, cancelledAt: req.cancelled_at } : null,
  };
}

/**
 * [구독 취소]를 세울까 — 기한이 남은 그로블 정기결제(이용 중 · 결제 실패)가 있고, 환불 기간이 아니고(그때는 [환불 요청]),
 * 아직 취소를 접수하지 않았을 때. 돌려주는 값: { eligible, reason: ok | none | pending | requested | refund_window, subscription, request }
 *   pending — 그로블에서 이미 해지(예고 · 완료) · requested — 우리가 취소를 접수했다(그로블 해지 확인을 기다린다)
 */
export async function cancelCheck(db, userId, { at = new Date() } = {}) {
  const sub = (await db.query(
    `SELECT id, status, paid_until, next_billing_date::text AS next_billing_date FROM subscriptions WHERE user_id = $1 AND provider = 'groble' AND paid_until > $2
      ORDER BY (status = 'active') DESC, paid_until DESC LIMIT 1`, [userId, at])).rows[0];
  if (!sub) return { eligible: false, reason: 'none', subscription: null, request: null };
  const subscription = { id: sub.id, status: sub.status, paidUntil: sub.paid_until, nextBillingDate: sub.next_billing_date || '' };
  const req = (await db.query(`SELECT id, status, created_at, next_billing::text AS next_billing, confirmed_at, charged_at FROM cancel_requests
    WHERE subscription_id = $1 AND status <> 'withdrawn' ORDER BY created_at DESC LIMIT 1`, [sub.id])).rows[0];
  const request = req ? { id: req.id, status: req.status, createdAt: req.created_at, nextBilling: req.next_billing || '', confirmedAt: req.confirmed_at, chargedAt: req.charged_at } : null;
  if (['cancel_pending', 'ended'].includes(sub.status)) return { eligible: false, reason: 'pending', subscription, request };
  if (request) return { eligible: false, reason: 'requested', subscription, request };
  const rc = await refundCheck(db, userId, { at });
  if (['ok', 'requested', 'refunded'].includes(rc.reason)) return { eligible: false, reason: 'refund_window', subscription, request };
  return { eligible: true, reason: 'ok', subscription, request };
}

// 이용권이 살아 있는가 — 운영자 · 무료 이용 · 기한이 남은 줄. 새 AI 작업 앞(tenancy.aiAllowed)과 worker 가 돌리기 직전에 부른다.
export async function passActive(db, userId) {
  const r = (await db.query(
    `SELECT u.is_platform_admin AS op, coalesce(c.free, false) AS free,
            EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.paid_until > now()) AS paid
       FROM users u LEFT JOIN billing_customers c ON c.user_id = u.id WHERE u.id = $1`, [userId])).rows[0];
  return !!(r && (r.op || r.free || r.paid));
}

// 사람 하나의 이용권 — 줄 여럿(정기결제 · 손 연장 · 체험)을 한 줄로: 지금 쓸 수 있는가 · 대표 상태 · 기한.
// 대표는 기한이 남은 줄 가운데 이용 중 > 해지 예정 > 결제 실패 > 해지됨 차례(같으면 기한이 늦은 것). 운영 화면의 SQL(STATUS_SQL)도 같은 차례다.
export function summarize(rows, { free = false, operator = false, now = Date.now() } = {}) {
  const t = (v) => (v ? new Date(v).getTime() : 0);
  const live = rows.filter((r) => t(r.paid_until) > now);
  const rank = { active: 0, cancel_pending: 1, past_due: 2, ended: 3 };
  const main = [...live].sort((a, b) => rank[a.status] - rank[b.status] || t(b.paid_until) - t(a.paid_until))[0] || null;
  const last = rows.reduce((m, r) => (t(r.paid_until) > t(m) ? r.paid_until : m), null);
  return {
    active: !!(operator || free || main),
    operator: !!operator,
    free: !!free,
    status: main ? main.status : rows.length ? 'ended' : 'none',
    provider: main ? main.provider : '',
    paidUntil: main ? main.paid_until : last,
    nextBillingDate: main && main.provider === 'groble' && main.status !== 'cancel_pending' ? main.next_billing_date || '' : '',
    serviceEndsAt: main && main.status === 'cancel_pending' ? main.service_ends_at || main.paid_until : null,
    finalFailure: !!(main && main.status === 'past_due' && main.final_failure),
    warn: live.some((r) => r.status === 'past_due'),
  };
}
// 같은 차례를 SQL 로 — s 는 그 사람의 subscriptions 를 모은 것(운영 화면의 고객 목록 · 거르기)
export const STATUS_SQL = `CASE WHEN bool_or(s.paid_until > now() AND s.status = 'active') THEN 'active'
  WHEN bool_or(s.paid_until > now() AND s.status = 'cancel_pending') THEN 'cancel_pending'
  WHEN bool_or(s.paid_until > now() AND s.status = 'past_due') THEN 'past_due'
  WHEN count(s.id) > 0 THEN 'ended' ELSE 'none' END`;

/**
 * mailer — 운영자 알림 메일({ on(), send({ to, subject, text }) }, 기본은 Secrets 의 RESEND_API_KEY) · siteUrl — 메일에 실을 운영 화면 주소 ·
 * retryMs — 잠깐의 실패면 한 번 더 보낼 때까지(0 이면 다시 보내지 않는다)
 */
export function createBilling({ pool, adapter = groble, secrets = () => [], log = () => {}, mailer = envMailer, siteUrl = '', retryMs = 30000 }) {
  const fails = new Map();   // ip → { n, until } — 서명이 거듭 틀리는 곳
  const FAIL_LIMIT = 30; const FAIL_WINDOW = 15 * 60 * 1000;
  const health = { rejected: 0, rejectedAt: 0, noSecret: 0, noSecretAt: 0 };   // 운영 화면 «웹훅 상태»(남기지 않은 것의 수만)
  const reply = (status, extra = {}) => ({ status, body: { ok: status === 200, ...extra } });
  const keys = () => (secrets() || []).map((s) => String(s || '').trim()).filter(Boolean);

  /**
   * 웹훅 하나 받기 — 서버의 한 길(POST /api/billing/groble)이 원본 본문(Buffer)과 머리글을 넘긴다. 돌려주는 값: { status, body }
   * 200 받음(반영 · 기록 · 같은 것 다시) · 401 서명 · 429 거듭 틀림 · 503 시크릿 없음 · DB 안 됨(대행이 다시 보낸다)
   */
  async function receive({ rawBody, headers = {}, ip = '' }) {
    const now = Date.now();
    // 서명부터 본다 — 맞는 서명은 고삐와 상관없이 받는다(남이 틀린 서명을 쏟아부어도 그로블의 정상 웹훅은 막히지 않게). 고삐는 틀린 것에만.
    const v = adapter.verify({ rawBody, headers, secrets: keys(), now });
    if (!v.ok) {
      if (v.reason === 'no_secret') { health.noSecret += 1; health.noSecretAt = now; return reply(503, { error: 'webhook secret is not set' }); }
      health.rejected += 1; health.rejectedAt = now;
      const f = fails.get(ip);
      if (f && f.n >= FAIL_LIMIT && f.until > now) return reply(429, { error: 'too many invalid signatures' });
      if (!f || f.until <= now) fails.set(ip, { n: 1, until: now + FAIL_WINDOW }); else f.n += 1;
      if (fails.size > 5000) for (const [k, x] of fails) if (x.until <= now) fails.delete(k);
      return reply(401, { error: 'invalid signature' });
    }
    const ev = adapter.parse(rawBody);
    const key = adapter.idempotencyKey(headers, ev) || null;
    let c;
    try { c = await pool.connect(); } catch (e) { log('webhook not applied (' + errName(e) + ') - the provider will send it again'); return reply(503); }
    try {
      await c.query('BEGIN');
      const ins = await c.query(
        `INSERT INTO billing_events (provider, idem_key, event_id, type, occurred_at, ref, merchant_uid, amount, raw)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (provider, idem_key) DO NOTHING RETURNING id`,
        [adapter.name, key, ev.ok ? ev.id.slice(0, 200) : '', ev.ok ? ev.type.slice(0, 100) : '', ev.ok ? ev.occurredAt : null, ev.ok ? ev.ref : '',
          ev.ok ? ev.merchantUid : '', ev.ok ? ev.amount : null, ev.ok ? noNul(ev.body) : { unreadable: true, text: rawText(rawBody) }]);
      if (!ins.rowCount) { await c.query('COMMIT'); return reply(200, { duplicate: true }); }
      const out = await reflect(c, ev);
      await c.query('UPDATE billing_events SET result = $2, note = $3, user_id = $4, subscription_id = $5, review = $6 WHERE id = $1',
        [ins.rows[0].id, out.result, out.note || '', out.userId || null, out.subId || null, !!out.review]);
      await c.query('COMMIT');
      // 취소를 접수한 정기결제에서 다시 결제됐다 — 운영자에게 알린다(웹훅 답을 늦추지 않게 기다리지 않는다)
      if (out.charged) notify('charged', out.charged.id, { payment: out.charged }).catch(() => {});
      return reply(200);
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* 연결이 끊겼다 */ }
      log('webhook not applied (' + errName(e) + ') - the provider will send it again');
      return reply(503);
    } finally {
      c.release();
    }
  }

  // 누구의 결제인가 — 참조값 → 사람. 없거나 모르는 값이면 구매자 이메일(운영자가 이어 둔 것 · 가입 이메일이 하나뿐인 사람),
  // 회차 환불(참조값이 없다)은 결제 건 번호(merchantUid)로 그 결제를 받은 사람.
  async function whose(c, ev) {
    if (ev.ref) {
      const r = (await c.query(`UPDATE billing_refs SET used_at = coalesce(used_at, now()) WHERE kind = 'link' AND ref = $1 RETURNING user_id`, [ev.ref])).rows[0];
      if (r) return { userId: r.user_id };
    }
    if (ev.kind === 'refunded' && ev.merchantUid) {
      const r = (await c.query('SELECT user_id, subscription_id FROM billing_events WHERE merchant_uid = $1 AND user_id IS NOT NULL ORDER BY id DESC LIMIT 1', [ev.merchantUid])).rows[0];
      if (r) return { userId: r.user_id, subId: r.subscription_id };
    }
    const email = normEmail(ev.buyer && ev.buyer.email);
    if (email) {
      const a = (await c.query(`SELECT user_id FROM billing_refs WHERE kind = 'email' AND ref = $1`, [email])).rows[0];
      if (a) return { userId: a.user_id };
      const u = (await c.query(`SELECT id FROM users WHERE lower(email) = $1 AND status = 'active' LIMIT 2`, [email])).rows;
      if (u.length === 1) return { userId: u[0].id };
    }
    return null;
  }

  // 이 결제가 맞는 결제인가 — 결제 옵션 가운데 같은 금액 · 같은 상품(상품 번호를 비운 옵션은 금액만). 꺼진 옵션도 본다(옛 구독자의 갱신).
  async function planFor(c, ev) {
    const plans = (await c.query('SELECT id, price, product_id, cycle_months FROM billing_plans ORDER BY sort_order, created_at')).rows.filter((p) => p.price === ev.amount);
    return plans.find((p) => p.product_id && p.product_id === ev.contentId) || plans.find((p) => !p.product_id) || null;
  }

  /**
   * 사건 하나를 반영한다(트랜잭션 c 안). 돌려주는 값: { result, note, userId, subId, review }
   *   result — applied(반영) · stale(늦게 온 소식 — 기록만) · recorded(기록만) · unlinked(사람을 못 찾음) · amount_mismatch(금액 · 상품이 다름) · unreadable(읽지 못함)
   * force · userId — 운영자의 [이 계정에 연결]: 그 사람으로, 금액 검사 없이(운영자가 확인했다)
   */
  async function reflect(c, ev, { force = false, userId: chosen = null } = {}) {
    if (!ev.ok) return { result: 'unreadable', note: '읽지 못한 꼴(JSON 이 아니거나 모양이 다르다)', review: true };
    if (ev.kind === 'unknown') return { result: 'unreadable', note: '모르는 종류: ' + ev.type.slice(0, 60), review: true };
    // 구매자가 그로블에서 취소(환불) 요청 — 우리가 받은 정기결제의 결제 건이면 그때의 판정을 붙여 운영자에게(승인 · 반려는 그로블에서)
    if (ev.kind === 'cancel_request' && ev.merchantUid) {
      const pay = (await c.query(`SELECT user_id, subscription_id, coalesce(occurred_at, received_at) AS paid_at FROM billing_events
        WHERE merchant_uid = $1 AND type = 'subscription_payment.completed' AND user_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [ev.merchantUid])).rows[0];
      if (pay) {
        const start = await startOf(c, pay.subscription_id, pay.paid_at);
        const j = await judgeRefund(c, pay.user_id, start, { at: ev.occurredAt || new Date() });
        return { result: 'recorded', note: '구매자가 그로블에서 취소(환불) 요청 — ' + verdictText(j, start) + ' → 승인 · 반려는 그로블에서', review: true, userId: pay.user_id, subId: pay.subscription_id };
      }
    }
    const who = chosen ? { userId: chosen } : await whose(c, ev);
    if (ev.kind === 'one_time' || ev.kind === 'cancel_request') {
      const ours = !!ev.contentId && (await c.query(`SELECT 1 FROM billing_plans WHERE product_id <> '' AND product_id = $1`, [ev.contentId])).rowCount > 0;
      return { result: 'recorded', note: ours ? '결제 옵션의 상품인데 정기결제가 아니다 — 그로블 상품 설정을 확인' : '정기결제가 아닌 결제(기록만)', review: ours, userId: who ? who.userId : null };
    }
    if (!who) return { result: 'unlinked', note: '연결 안 된 결제 — 참조값 · 이메일로 사람을 찾지 못했다', review: true };
    const userId = who.userId;
    if (ev.kind === 'refunded') return refundedRound(c, ev, who);
    let plan = null;
    if (ev.kind === 'paid') {
      plan = await planFor(c, ev);
      if (!force && ev.paymentType && ev.paymentType !== 'SUBSCRIPTION') return { result: 'amount_mismatch', note: '정기결제가 아닌 상품의 결제 — 반영하지 않았다', review: true, userId };
      if (!force && !plan) {
        const none = !(await c.query('SELECT 1 FROM billing_plans LIMIT 1')).rowCount;
        return { result: 'amount_mismatch', note: none ? '결제 옵션이 없다 — «결제 옵션»에 상품을 넣은 뒤 [이 계정에 연결]' : '금액 · 상품이 결제 옵션과 다르다 — 반영하지 않았다', review: true, userId };
      }
    }
    const rules = await rulesOf(c);
    // 이 정기결제의 줄(사람 · 참조값) — 처음 보면 만들고, 잠그고 본다(같은 정기결제의 사건이 동시에 와도 하나씩)
    await c.query(`INSERT INTO subscriptions (user_id, provider, ref) VALUES ($1, 'groble', $2) ON CONFLICT (user_id, provider, ref) DO NOTHING`, [userId, ev.ref]);
    const row = (await c.query(
      `SELECT id, status, paid_until, next_billing_date::text AS next_billing_date, service_ends_at, final_failure, occurred_at, plan_id, last_paid_at, last_amount
         FROM subscriptions WHERE user_id = $1 AND provider = 'groble' AND ref = $2 FOR UPDATE`, [userId, ev.ref])).rows[0];
    const at = ev.occurredAt || new Date();
    // 더 이른 소식은 기록만. 때가 같으면 일의 차례(결제 < 실패 < 해지 예고 < 해지 완료)가 뒤인 것만 반영한다 —
    // 즉시 해지(예고와 완료가 같은 때)의 «해지 완료»를 잃지 않고, 같은 소식이 다시 와도 두 번 반영하지 않는다.
    if (row.occurred_at) {
      const prev = new Date(row.occurred_at).getTime();
      if (at.getTime() < prev || (at.getTime() === prev && STEP[ev.kind] <= STATUS_STEP[row.status])) return { result: 'stale', note: '늦게 온 소식 — 더 나중 일을 이미 반영했다(기록만)', userId, subId: row.id };
    }
    const next = { ...row };
    let note = ''; let review = false; let charged = null;
    if (ev.kind === 'paid') {
      // 다음 결제일 그날 끝 + 여유(그로블의 갱신 재시도 3일 + 유예 7일) — 갱신 소식이 끝내 오지 않아도 저절로 끝난다
      const day = ev.nextBillingDate || kstDay(addMonths(at, ev.cycleMonths || (plan && plan.cycle_months) || 1));
      const until = dayEndPlus(day, rules.graceDays);
      Object.assign(next, { status: 'active', paid_until: row.paid_until && new Date(row.paid_until) > until ? row.paid_until : until, next_billing_date: day,
        service_ends_at: null, final_failure: false, last_paid_at: at, last_amount: ev.amount, plan_id: plan ? plan.id : row.plan_id });
      note = (ev.billingReason === 'RENEWAL' ? '갱신' : '결제') + ' — 다음 결제일 ' + day + ' + 여유 ' + rules.graceDays + '일까지' + (force ? ' (운영자가 연결)' : '');
      // 이미 이용 중인 사람의 새 정기결제 — 두 번 결제했을 수 있다(운영자가 본다 · 막지는 않는다)
      // 참조값 없이 온 정기결제는 사람마다 한 줄로 모인다(가려낼 값이 없다) — 그 줄이 이미 살아 있는데 새 최초 결제가 와도 겹친 결제로 본다
      const sameRowLive = !ev.ref && ['active', 'past_due'].includes(row.status) && row.paid_until && new Date(row.paid_until) > new Date();
      if (ev.billingReason !== 'RENEWAL' && (sameRowLive || (await c.query(
        `SELECT 1 FROM subscriptions WHERE user_id = $1 AND provider = 'groble' AND ref <> $2 AND status IN ('active', 'past_due') AND paid_until > now() LIMIT 1`, [userId, ev.ref])).rowCount)) {
        review = true; note += ' · 이미 이용 중인 정기결제가 또 있다(겹친 결제인지 확인' + (sameRowLive ? ' — 참조값 없는 결제는 한 줄로 모인다' : '') + ')';
      }
      // 이미 환불된 결제가 늦게 왔다(도착 순서는 보장되지 않는다) — 이용권을 늘리지 않는다
      const refundedAt = ev.merchantUid ? ((await c.query(`SELECT coalesce(occurred_at, received_at) AS at FROM billing_events
        WHERE merchant_uid = $1 AND type = 'subscription_payment.refunded' ORDER BY id LIMIT 1`, [ev.merchantUid])).rows[0] || {}).at : null;
      if (refundedAt) { next.paid_until = row.paid_until || refundedAt; review = true; note += ' · 이미 환불된 결제가 늦게 왔다 — 이용권을 늘리지 않았다'; }
      // 환불한 정기결제에서 다시 결제 — 그로블에서 정기결제를 끊지 않았다(돈을 냈으니 반영은 한다)
      if (ev.billingReason === 'RENEWAL' && (await c.query(`SELECT 1 FROM refund_requests WHERE subscription_id = $1 AND status <> 'withdrawn' LIMIT 1`, [row.id])).rowCount) {
        review = true; note += ' · 환불한 정기결제에서 다시 결제됐다 — 그로블에서 해지됐는지 확인';
      }
      // 구독 취소를 접수한 정기결제에서 다시 결제 — 그로블 해지가 늦었다(반영은 하되 운영자에게 알린다: 이 결제 환불 · 해지)
      if (ev.billingReason === 'RENEWAL') {
        const asked = (await c.query(`UPDATE cancel_requests SET charged_at = coalesce(charged_at, $2) WHERE subscription_id = $1 AND status <> 'withdrawn' AND created_at < $2
          RETURNING id`, [row.id, at])).rows[0];
        if (asked) { review = true; note += ' · 구독 취소를 접수한 뒤 다시 결제됐다 — 그로블에서 이 결제 환불 · 정기결제 해지'; charged = { id: asked.id, merchantUid: ev.merchantUid, amount: ev.amount, paidAt: at }; }
      }
    } else if (ev.kind === 'failed') {
      Object.assign(next, { status: 'past_due', final_failure: !!ev.isFinal });
      note = ev.isFinal ? '마지막 재시도도 실패 — 유예가 끝나면 해지된다' : '갱신 결제 실패 — 그로블이 다시 시도한다(이용은 그대로)';
    } else if (ev.kind === 'cancel_requested') {
      // 지금 막지는 않는다 — 다만 끝나는 날(화면이 보이는 날) + 하루에 저절로 끝나게 한다(«해지 완료»를 못 받아도 갱신 여유를 더 쓰지 않게)
      const day = ev.nextBillingDate || row.next_billing_date;
      const ends = ev.serviceEndsAt || (day ? dayEndPlus(day) : null);
      const cap = ends ? new Date(new Date(ends).getTime() + DAY) : null;
      Object.assign(next, { status: 'cancel_pending', service_ends_at: ends, paid_until: cap && row.paid_until && new Date(row.paid_until) > cap ? cap : row.paid_until });
      note = '해지 예고 — 이용 기간은 남는다' + (ends ? '(' + kstDay(ends) + '까지)' : '');
    } else if (ev.kind === 'terminated') {
      // 기한을 늘리지는 않는다 — 환불 · [환불 요청] · [이용권 끝내기]가 앞당긴 기한을 «해지 완료»가 되살리지 않게
      const end = ev.terminatedAt || at;
      Object.assign(next, { status: 'ended', paid_until: row.paid_until && new Date(row.paid_until) < new Date(end) ? row.paid_until : end });
      note = '해지 완료 — 이용권 끝';
    }
    await c.query(
      `UPDATE subscriptions SET status = $2, paid_until = $3, next_billing_date = $4, service_ends_at = $5, final_failure = $6, plan_id = $7,
              last_paid_at = $8, last_amount = $9, occurred_at = $10, updated_at = now() WHERE id = $1`,
      [row.id, next.status, next.paid_until, next.next_billing_date || null, next.service_ends_at, next.final_failure, next.plan_id, next.last_paid_at, next.last_amount, at]);
    // 해지가 왔다 — 이 정기결제의 환불 건에 «해지됨»을 적고(환불도 됐으면 끝낸다), 접수한 구독 취소는 «해지 확인»으로 끝낸다
    if (ev.kind === 'cancel_requested' || ev.kind === 'terminated') {
      await c.query(`UPDATE refund_requests SET cancelled_at = coalesce(cancelled_at, $2) WHERE subscription_id = $1 AND status = 'open'`, [row.id, at]);
      await closeRefunds(c, row.id);
      await c.query(`UPDATE cancel_requests SET confirmed_at = coalesce(confirmed_at, $2), status = 'done', resolved_at = coalesce(resolved_at, now())
        WHERE subscription_id = $1 AND status = 'open'`, [row.id, at]);
    }
    return { result: 'applied', note, review, userId, subId: row.id, charged };
  }

  // 환불과 해지가 둘 다 확인된 환불 건은 끝낸다
  const closeRefunds = (c, subId) => c.query(`UPDATE refund_requests SET status = 'done', resolved_at = coalesce(resolved_at, now())
    WHERE subscription_id = $1 AND status = 'open' AND refunded_at IS NOT NULL AND cancelled_at IS NOT NULL`, [subId]);

  /**
   * 회차 환불 웹훅(subscription_payment.refunded). 이번 회차(그 정기결제에서 마지막으로 반영한 결제)면 이용권을 환불 때로 끝내고
   * 환불 건에 «환불됨»을 적는다 — [환불 요청]이 없었으면 그로블에서 먼저 한 것으로 새 건을 만든다(그때의 판정과 함께).
   * 해지(예고 · 완료)가 아직이면 그 건은 «해지 안 됨»으로 남는다(그로블에서 정기결제를 끊지 않으면 다음 결제일에 다시 청구된다).
   * 지난 회차의 환불은 기록만. 규정 밖 환불은 «확인 필요».
   */
  async function refundedRound(c, ev, who) {
    const userId = who.userId;
    const at = ev.occurredAt || new Date();
    const pay = ev.merchantUid ? (await c.query(`SELECT subscription_id, coalesce(occurred_at, received_at) AS paid_at, amount FROM billing_events
      WHERE merchant_uid = $1 AND type = 'subscription_payment.completed' AND user_id = $2 AND subscription_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [ev.merchantUid, userId])).rows[0] : null;
    if (!pay) return { result: 'recorded', note: '회차 환불 — 받은 적 없는 결제 건(기록만)', review: true, userId, subId: who.subId || null };
    const start = await startOf(c, pay.subscription_id, pay.paid_at);
    const j = await judgeRefund(c, userId, start, { at });
    const last = await lastPayment(c, userId, pay.subscription_id);
    if (!last || last.merchant_uid !== ev.merchantUid) {
      return { result: 'recorded', note: '지난 회차 환불 — 이용권은 그대로 · ' + verdictText(j, start), review: true, userId, subId: pay.subscription_id };
    }
    const row = (await c.query('SELECT id, status, paid_until, occurred_at FROM subscriptions WHERE id = $1 FOR UPDATE', [pay.subscription_id])).rows[0];
    await c.query('UPDATE subscriptions SET paid_until = least(paid_until, $2), updated_at = now() WHERE id = $1', [row.id, at]);
    const cancelledAt = ['cancel_pending', 'ended'].includes(row.status) ? row.occurred_at || at : null;
    const mine = (await c.query(`UPDATE refund_requests SET refunded_at = coalesce(refunded_at, $3), cancelled_at = coalesce(cancelled_at, $4)
      WHERE user_id = $1 AND paid_at = $2 AND status = 'open' RETURNING id`, [userId, pay.paid_at, at, cancelledAt])).rowCount;
    if (!mine) {
      await c.query(`INSERT INTO refund_requests (user_id, subscription_id, merchant_uid, amount, paid_at, deadline, ai_runs, in_policy, prev_paid_until, source, refunded_at, cancelled_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'groble', $10, $11)`, [userId, row.id, ev.merchantUid, ev.amount || pay.amount, pay.paid_at, j.deadline, j.aiRuns, j.ok, row.paid_until, at, cancelledAt]);
    }
    await closeRefunds(c, row.id);
    const note = ['이번 회차 환불 — 이용권을 끝냈다', verdictText(j, start)];
    if (!cancelledAt) note.push('그로블에서 정기결제 해지가 아직 — 끊지 않으면 다음 결제일에 다시 청구된다');
    return { result: 'applied', note: note.join(' · '), review: !j.ok, userId, subId: row.id };
  }

  // ---------------------------------------------------------------- 환불 요청 · 구독 취소(사용자) · 되돌리기(운영자) · 알림 메일

  /**
   * [환불 요청] — 서버가 다시 판정하고(화면을 믿지 않는다) 이유와 함께 요청을 남긴 뒤 이용권을 바로 멈추고(그 정기결제의 기한 = 지금) 운영자에게 메일.
   * 요청한 뒤에 AI 를 쓰고 환불받는 일이 없게. 편집 · 열람 · 내보내기는 그대로. 돈과 정기결제는 운영자가 그로블에서.
   * 돌려주는 값: { ok, requestId, check, mail } 또는 { ok:false, code(판정의 reason), check }
   */
  async function requestRefund(user, { reason = '', detail = '' } = {}) {
    const c = await pool.connect();
    let out;
    try {
      await c.query('BEGIN');
      // 그 사람의 정기결제 줄을 잠근다 — 두 번 누름 · 같은 때 온 웹훅과 차례로
      await c.query(`SELECT id FROM subscriptions WHERE user_id = $1 AND provider = 'groble' ORDER BY id FOR UPDATE`, [user.id]);
      const chk = await refundCheck(c, user.id);
      if (!chk.eligible) { await c.query('ROLLBACK'); return { ok: false, code: chk.reason, check: chk }; }
      const p = chk.payment;
      const sub = (await c.query('SELECT paid_until, status, occurred_at FROM subscriptions WHERE id = $1', [p.subscriptionId])).rows[0];
      const cancelledAt = sub && ['cancel_pending', 'ended'].includes(sub.status) ? sub.occurred_at || new Date() : null;   // 그로블에서 먼저 해지했다
      const req = (await c.query(`INSERT INTO refund_requests (user_id, subscription_id, merchant_uid, amount, paid_at, deadline, ai_runs, prev_paid_until, cancelled_at, reason, detail)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [user.id, p.subscriptionId, p.merchantUid, p.amount, p.paidAt, chk.deadline, chk.aiRuns, sub ? sub.paid_until : null, cancelledAt, reason, detail])).rows[0];
      await c.query('UPDATE subscriptions SET paid_until = least(paid_until, now()), updated_at = now() WHERE id = $1', [p.subscriptionId]);
      await c.query('COMMIT');
      out = { ok: true, requestId: req.id, check: chk };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* 끊겼다 */ }
      throw e;
    } finally {
      c.release();
    }
    // 메일은 연결을 돌려준 뒤에(저쪽이 늦어도 DB 연결을 붙잡지 않게)
    return { ...out, mail: await notify('refund', out.requestId) };
  }

  /**
   * [구독 취소] — 환불 기간이 지난 뒤. 이유와 함께 접수하고 운영자에게 메일. 그로블에 판매자 해지 API 가 없어 해지는 그로블 판매 관리에서 하고,
   * 그 해지 웹훅이 오면 이 요청에 «해지 확인»이 찍힌다(reflect). 이용권은 지금 결제 기간 끝까지 그대로.
   * 돌려주는 값: { ok, requestId, check, mail } 또는 { ok:false, code: none | pending | requested | refund_window, check }
   */
  async function requestCancel(user, { reason = '', detail = '' } = {}) {
    const c = await pool.connect();
    let out;
    try {
      await c.query('BEGIN');
      await c.query(`SELECT id FROM subscriptions WHERE user_id = $1 AND provider = 'groble' ORDER BY id FOR UPDATE`, [user.id]);
      const chk = await cancelCheck(c, user.id);
      if (!chk.eligible) { await c.query('ROLLBACK'); return { ok: false, code: chk.reason, check: chk }; }
      const req = (await c.query(`INSERT INTO cancel_requests (user_id, subscription_id, reason, detail, next_billing) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [user.id, chk.subscription.id, reason, detail, chk.subscription.nextBillingDate || null])).rows[0];
      await c.query('COMMIT');
      out = { ok: true, requestId: req.id, check: chk };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* 끊겼다 */ }
      throw e;
    } finally {
      c.release();
    }
    return { ...out, mail: await notify('cancel', out.requestId) };
  }

  /**
   * 운영자 알림 메일 — 받는 주소는 이용 규칙의 «알림 메일». 환불 요청 · 구독 취소는 그 줄에 보낸 때 · 못 보낸 까닭(이름)을 적고,
   * 잠깐의 실패(닿지 않음 · 밀림)면 한 번 더 보낸다. 메일이 안 가도 요청은 남아 있다(운영 화면 [결제 기록]에 보인다).
   * kind: refund | cancel | charged(취소 뒤 갱신 결제 — 그 취소 요청의 id 와 결제). 돌려주는 값: mailer 의 { ok, reason }
   */
  async function notify(kind, id, { payment = null, attempt = 1 } = {}) {
    const rules = await rulesOf(pool);
    const table = kind === 'refund' ? 'refund_requests' : 'cancel_requests';
    const r = UUID.test(String(id || '')) ? (await pool.query(`SELECT x.*, u.login_id, u.display_name FROM ${table} x JOIN users u ON u.id = x.user_id WHERE x.id = $1`, [id])).rows[0] : null;
    if (!r) return { ok: false, reason: 'missing' };
    const user = { loginId: r.login_id, name: r.display_name };
    let msg;
    if (kind === 'refund') {
      const prev = (await pool.query(`SELECT count(*)::int AS n FROM refund_requests WHERE user_id = $1 AND id <> $2 AND status <> 'withdrawn' AND created_at < $3`, [r.user_id, r.id, r.created_at])).rows[0].n;
      msg = refundMail({ user, at: r.created_at, start: await startOf(pool, r.subscription_id, r.paid_at), until: kstDay(new Date(r.deadline).getTime() - 1), inPolicy: r.in_policy,
        payment: { merchantUid: r.merchant_uid, amount: r.amount, paidAt: r.paid_at }, aiRuns: r.ai_runs, prevRefunds: prev, reason: r.reason, detail: r.detail, site: siteUrl });
    } else if (kind === 'cancel') {
      const last = r.subscription_id ? await lastPayment(pool, r.user_id, r.subscription_id) : null;
      msg = cancelMail({ user, at: r.created_at, nextBilling: r.next_billing ? kstDay(r.next_billing) : '', reason: r.reason, detail: r.detail, site: siteUrl,
        lastPayment: last ? { merchantUid: last.merchant_uid, amount: last.amount, paidAt: last.paid_at } : null });
    } else {
      msg = chargedMail({ user, requestedAt: r.created_at, at: payment && payment.paidAt, payment: payment || {}, site: siteUrl });
    }
    const sent = await mailer.send({ to: rules.notifyEmail, ...msg });
    if (kind !== 'charged') {
      await pool.query(`UPDATE ${table} SET mailed_at = CASE WHEN $2 THEN now() ELSE mailed_at END, mail_error = $3 WHERE id = $1`, [id, sent.ok, sent.ok ? '' : String(sent.reason || 'error').slice(0, 40)]);
    }
    if (!sent.ok) {
      log('notice mail not sent (' + String(sent.reason || 'error').replace(/[^\x20-\x7e]/g, '?').slice(0, 40) + ')');
      if (attempt === 1 && retryMs > 0 && transient(sent.reason)) setTimeout(() => { notify(kind, id, { payment, attempt: 2 }).catch(() => {}); }, retryMs).unref();
    }
    return sent;
  }
  // [시험 메일 보내기](운영자) — 이용 규칙의 «알림 메일»로 한 통
  const sendTestMail = async () => mailer.send({ to: (await rulesOf(pool)).notifyEmail, ...testMail({ site: siteUrl }) });

  // [요청 되돌리기](운영자) — 환불 전에만. 멈춘 이용권을 되살린다(그 사이 늘어난 기한은 그대로). 돌려주는 값: { ok } 또는 { ok:false, code: missing | closed | refunded }
  async function withdrawRefund(id, by) {
    if (!UUID.test(String(id || ''))) return { ok: false, code: 'missing' };
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = (await c.query('SELECT id, user_id, subscription_id, status, refunded_at, prev_paid_until FROM refund_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
      const code = !r ? 'missing' : r.status !== 'open' ? 'closed' : r.refunded_at ? 'refunded' : '';
      if (code) { await c.query('ROLLBACK'); return { ok: false, code }; }
      if (r.subscription_id) await c.query('UPDATE subscriptions SET paid_until = greatest(paid_until, $2), updated_at = now() WHERE id = $1', [r.subscription_id, r.prev_paid_until]);
      await c.query(`UPDATE refund_requests SET status = 'withdrawn', resolved_by = $2, resolved_at = now() WHERE id = $1`, [id, by]);
      await c.query('COMMIT');
      return { ok: true, userId: r.user_id };
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch { /* 끊겼다 */ }
      throw e;
    } finally {
      c.release();
    }
  }

  // ---------------------------------------------------------------- 사용자

  // 내 이용권 — «내 계정 → 이용권»에 보일 것만(금액 · 매출은 싣지 않는다). [결제하기]에 걸 켜진 결제 옵션의 이름.
  async function myPass(user) {
    const rows = (await pool.query(
      `SELECT provider, status, paid_until, next_billing_date::text AS next_billing_date, service_ends_at, final_failure FROM subscriptions WHERE user_id = $1`, [user.id])).rows;
    const free = !!((await pool.query('SELECT free FROM billing_customers WHERE user_id = $1', [user.id])).rows[0] || {}).free;
    const plans = (await pool.query('SELECT id, name FROM billing_plans WHERE enabled ORDER BY sort_order, created_at')).rows;
    // 환불 — 할 수 있을 때 · 요청했을 때 · 환불됐을 때 · 기간 안인데 AI 작업을 했을 때(규칙이 켜졌을 때만)만 보인다(기간이 지나면 말하지 않는다)
    const rc = await refundCheck(pool, user.id);
    const refund = ['ok', 'requested', 'refunded', 'ai_used'].includes(rc.reason) ? {
      eligible: rc.eligible, reason: rc.reason, paidOn: kstDay(rc.payment.paidAt), startedOn: kstDay(rc.start), until: kstDay(rc.deadline.getTime() - 1), aiRuns: rc.aiRuns, noUse: rc.noUse, days: rc.refundDays,
      request: rc.request ? { status: rc.request.status, createdAt: rc.request.createdAt, refunded: !!rc.request.refundedAt, cancelled: !!rc.request.cancelledAt } : null,
    } : null;
    // 구독 취소 — 환불 기간이 지나면 [구독 취소](이유를 묻는다). 접수했으면 그 줄(그로블 해지 확인을 기다린다)
    const cc = await cancelCheck(pool, user.id);
    const cancel = { can: cc.eligible, nextBillingDate: cc.subscription ? cc.subscription.nextBillingDate : '',
      request: cc.request ? { createdAt: cc.request.createdAt, nextBilling: cc.request.nextBilling, confirmed: !!cc.request.confirmedAt, charged: !!cc.request.chargedAt } : null };
    return { ...summarize(rows, { free, operator: !!user.isPlatformAdmin }), plans, refund, cancel, reasons: CANCEL_REASONS };
  }

  // [결제하기] — 누를 때마다 새 참조값(정기결제 하나 = 참조값 하나) + 결제창 링크.
  async function checkout(user, planId) {
    const plan = UUID.test(String(planId || '')) ? (await pool.query('SELECT id, checkout_url FROM billing_plans WHERE id = $1 AND enabled', [planId])).rows[0] : null;
    if (!plan) return { ok: false, code: 'missing' };
    const ref = adapter.newRef();
    const url = adapter.checkoutUrl(plan.checkout_url, ref);
    if (!url) return { ok: false, code: 'bad_link' };
    await pool.query(`INSERT INTO billing_refs (kind, ref, user_id, plan_id) VALUES ('link', $1, $2, $3)`, [ref, user.id, plan.id]);
    // 쓰지 않은 참조값 걷기 — 오래 열어 둔 결제창 탭도 잇도록 30일이 지난 것만, 그래도 사람마다 200개를 넘으면 오래된 것부터
    await pool.query(
      `DELETE FROM billing_refs WHERE kind = 'link' AND user_id = $1 AND used_at IS NULL AND (created_at < now() - interval '30 days' OR ref NOT IN (
         SELECT ref FROM billing_refs WHERE kind = 'link' AND user_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 200))`, [user.id]);
    return { ok: true, url };
  }

  // 가입 직후 무료 체험(이용 규칙의 일수가 0 이면 없다)
  async function grantTrial(userId) {
    const { trialDays } = await rulesOf(pool);
    if (!trialDays) return 0;
    await pool.query(`INSERT INTO subscriptions (user_id, provider, ref, status, paid_until, occurred_at)
      VALUES ($1, 'trial', '', 'active', now() + make_interval(days => $2), now()) ON CONFLICT (user_id, provider, ref) DO NOTHING`, [userId, trialDays]);
    return trialDays;
  }

  // 웹훅 시크릿이 서버에 있는가(값은 내주지 않는다)
  const secretState = () => { const s = secrets() || []; return { current: !!String(s[0] || '').trim(), previous: !!String(s[1] || '').trim() }; };

  return { receive, reflect, myPass, checkout, grantTrial, requestRefund, requestCancel, withdrawRefund, notify, sendTestMail, mailOn: () => !!mailer.on(), health, secretState, adapter };
}
