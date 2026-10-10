// 고객 · 결제 관리(운영 화면 — 최상위 운영자만). 설계: docs/OPEN_EDITION.md §4-6.
// 판정(운영자인가)과 감사 기록은 문(./ops.mjs)이 하고, 여기는 읽고 고치는 일만 한다.
//
// 지키는 것
//   · 결제 기록의 이름 · 전화 · 이메일은 가려서 내보낸다(원문은 DB 에만). 금액 · 매출은 이 화면에만.
//   · 손으로 바꾸는 것(연장 · 끝내기 · 무료 이용)은 이용권 줄만 고친다 — 그로블 쪽 카드 청구는 여기서 끊지 않는다(그로블 판매 관리에서).
//   · [이 계정에 연결]은 그 결제를 그 사람에게 반영하고(금액 검사 없이 — 운영자가 확인했다), 참조값(없으면 구매자 이메일)을 기억해 다음 소식부터 저절로 잇는다.

import { summarize, rulesOf, normEmail, kstDay, STATUS_SQL } from './service.mjs';
import { reasonSay, mailSay } from './notice.mjs';
import { isUuid } from '../tenancy.mjs';
import { NO_PASSWORD } from '../auth.mjs';

export const PASS_FILTERS = ['active', 'past_due', 'cancel_pending', 'ended', 'none', 'free'];

// 가리기 — 홍길동 → 홍*동 · 010-1234-5678 → ***-****-5678 · buyer@example.com → bu***@example.com
export const maskName = (s) => { const t = [...String(s || '').trim()]; return !t.length ? '' : t.length === 1 ? '*' : t.length === 2 ? t[0] + '*' : t[0] + '*'.repeat(t.length - 2) + t[t.length - 1]; };
export const maskPhone = (s) => { const d = String(s || '').replace(/\D/g, ''); return !d ? '' : d.length < 4 ? '***' : '***-****-' + d.slice(-4); };
export const maskEmail = (s) => { const e = String(s || '').trim(); const i = e.indexOf('@'); return !e ? '' : i < 1 ? '***' : e.slice(0, Math.min(2, i)) + '***' + e.slice(i); };
const shortRef = (r) => (r ? (r.length > 8 ? r.slice(0, 6) + '…' : r) : '');
const likeOf = (q) => '%' + String(q || '').trim().slice(0, 64).replace(/[\\%_]/g, (m) => '\\' + m) + '%';

// 받은 웹훅 한 줄 → 화면(가려서)
function eventView(r) {
  const o = (r.raw && r.raw.data && r.raw.data.object) || {};
  const b = o.buyer || {};
  return {
    id: Number(r.id), receivedAt: r.received_at, occurredAt: r.occurred_at, type: r.type, result: r.result, note: r.note, review: r.review,
    amount: r.amount, ref: shortRef(r.ref), merchantUid: r.merchant_uid, contentId: String((o.content && o.content.id) || ''),
    buyer: { name: maskName(b.displayName || b.name), email: maskEmail(b.email), phone: maskPhone(b.phoneNumber || b.phone) },
    user: r.user_id ? { userId: r.user_id, loginId: r.login_id || '' } : null,
    resolved: !!r.resolved_at,
  };
}
const EVENT_COLS = `e.id, e.received_at, e.occurred_at, e.type, e.result, e.note, e.review, e.amount, e.ref, e.merchant_uid, e.raw, e.user_id, e.resolved_at, u.login_id`;

// 환불 건 한 줄 → 화면 — 그때의 판정(결제 때 · 기한 · AI 작업 수 · 규정 안)과 할 일 둘(그로블 환불 · 그로블 해지)의 확인
function refundView(r) {
  return {
    id: r.id, user: { userId: r.user_id, loginId: r.login_id || '', name: r.display_name || '' }, source: r.source, status: r.status,
    merchantUid: r.merchant_uid, amount: r.amount, paidAt: r.paid_at, until: kstDay(new Date(r.deadline).getTime() - 1), aiRuns: r.ai_runs, inPolicy: r.in_policy,
    createdAt: r.created_at, refundedAt: r.refunded_at, cancelledAt: r.cancelled_at, resolvedAt: r.resolved_at,
    reason: r.reason || '', reasonSay: r.reason ? reasonSay(r.reason) : '', detail: r.detail || '', mailedAt: r.mailed_at, mailError: r.mail_error || '',
    mailErrorSay: r.mail_error ? mailSay(r.mail_error) : '',
  };
}
const REFUND_COLS = `r.id, r.user_id, u.login_id, u.display_name, r.source, r.status, r.merchant_uid, r.amount, r.paid_at, r.deadline, r.ai_runs, r.in_policy,
  r.created_at, r.refunded_at, r.cancelled_at, r.resolved_at, r.reason, r.detail, r.mailed_at, r.mail_error`;

// 구독 취소 한 줄 → 화면 — 이유 · 다음 결제일(이 날 전에 그로블에서 해지) · 그로블 해지 확인 · 취소 뒤 다시 결제됐나 · 알림 메일
function cancelView(r) {
  return {
    id: r.id, user: { userId: r.user_id, loginId: r.login_id || '', name: r.display_name || '' }, status: r.status,
    reason: r.reason, reasonSay: reasonSay(r.reason), detail: r.detail, nextBilling: r.next_billing || '',
    createdAt: r.created_at, confirmedAt: r.confirmed_at, chargedAt: r.charged_at, mailedAt: r.mailed_at, mailError: r.mail_error || '', resolvedAt: r.resolved_at,
    mailErrorSay: r.mail_error ? mailSay(r.mail_error) : '',
  };
}
const CANCEL_COLS = `x.id, x.user_id, u.login_id, u.display_name, x.status, x.reason, x.detail, x.next_billing::text AS next_billing,
  x.created_at, x.confirmed_at, x.charged_at, x.mailed_at, x.mail_error, x.resolved_at`;

export function createBillingAdmin({ pool, billing }) {
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0] || null;

  return {
    // 고객 — 가입한 사람 목록. 찾기(아이디 · 이름) · 이용권 상태별 거르기 · 50명씩
    async customers({ q = '', status = '', limit = 50, offset = 0 } = {}) {
      const st = PASS_FILTERS.includes(status) ? status : '';
      const rows = (await pool.query(
        `SELECT u.id, u.login_id, u.display_name, u.created_at, u.status AS account_status, u.is_platform_admin,
                coalesce(c.free, false) AS free, coalesce(c.memo, '') <> '' AS has_memo, ${STATUS_SQL} AS pass_status,
                max(s.paid_until) AS until,
                min(s.next_billing_date) FILTER (WHERE s.provider = 'groble' AND s.paid_until > now() AND s.status IN ('active', 'past_due'))::text AS next_billing,
                max(s.last_paid_at) AS last_paid_at, count(*) OVER () AS total
           FROM users u LEFT JOIN billing_customers c ON c.user_id = u.id LEFT JOIN subscriptions s ON s.user_id = u.id
          WHERE ($1 = '%%' OR u.login_id ILIKE $1 OR u.display_name ILIKE $1)
          GROUP BY u.id, c.free, c.memo
         HAVING $2 = '' OR ($2 = 'free' AND coalesce(c.free, false)) OR ($2 <> 'free' AND ${STATUS_SQL} = $2)
          ORDER BY u.created_at DESC LIMIT $3 OFFSET $4`,
        [likeOf(q), st, Math.max(1, Math.min(200, Number(limit) || 50)), Math.max(0, Number(offset) || 0)])).rows;
      return {
        total: rows.length ? Number(rows[0].total) : 0,
        customers: rows.map((r) => ({ userId: r.id, loginId: r.login_id, name: r.display_name, createdAt: r.created_at, accountStatus: r.account_status, operator: r.is_platform_admin,
          free: r.free, hasMemo: r.has_memo, status: r.pass_status, until: r.until, nextBilling: r.next_billing || '', lastPaidAt: r.last_paid_at })),
      };
    },

    // 한 사람 — 이용권(줄들) · 결제 기록(가려서) · 메모
    async customer(userId) {
      if (!isUuid(userId)) return null;
      // 구글 로그인 — 이은 구글(이메일은 가려서) · 비밀번호가 없는 계정인가(구글로 만든 계정 — 비밀번호를 정하려면 재설정 코드)
      const u = await one(`SELECT u.id, u.login_id, u.display_name, u.created_at, u.last_login_at, u.status, u.is_platform_admin, coalesce(c.free, false) AS free, coalesce(c.memo, '') AS memo,
          u.password_hash = $2 AS no_password, (SELECT i.email FROM user_identities i WHERE i.provider = 'google' AND i.user_id = u.id LIMIT 1) AS google_email,
          EXISTS (SELECT 1 FROM user_identities i WHERE i.provider = 'google' AND i.user_id = u.id) AS google
        FROM users u LEFT JOIN billing_customers c ON c.user_id = u.id WHERE u.id = $1`, [userId, NO_PASSWORD]);
      if (!u) return null;
      const subs = (await pool.query(
        `SELECT s.provider, s.ref, s.status, s.paid_until, s.next_billing_date::text AS next_billing_date, s.service_ends_at, s.final_failure, s.last_paid_at, s.last_amount, s.created_at, p.name AS plan_name
           FROM subscriptions s LEFT JOIN billing_plans p ON p.id = s.plan_id WHERE s.user_id = $1 ORDER BY s.created_at DESC`, [userId])).rows;
      const events = (await pool.query(`SELECT ${EVENT_COLS} FROM billing_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.user_id = $1 ORDER BY e.received_at DESC, e.id DESC LIMIT 50`, [userId])).rows;
      const refunds = (await pool.query(`SELECT ${REFUND_COLS} FROM refund_requests r JOIN users u ON u.id = r.user_id WHERE r.user_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [userId])).rows;
      const cancels = (await pool.query(`SELECT ${CANCEL_COLS} FROM cancel_requests x JOIN users u ON u.id = x.user_id WHERE x.user_id = $1 ORDER BY x.created_at DESC LIMIT 20`, [userId])).rows;
      return {
        user: { userId: u.id, loginId: u.login_id, name: u.display_name, createdAt: u.created_at, lastLoginAt: u.last_login_at, accountStatus: u.status, operator: u.is_platform_admin, free: u.free, memo: u.memo,
          google: u.google ? { email: maskEmail(u.google_email) } : null, noPassword: !!u.no_password },
        pass: summarize(subs, { free: u.free, operator: u.is_platform_admin }),
        subscriptions: subs.map((s) => ({ provider: s.provider, ref: shortRef(s.ref), status: s.status, paidUntil: s.paid_until, nextBillingDate: s.next_billing_date || '', serviceEndsAt: s.service_ends_at,
          finalFailure: s.final_failure, lastPaidAt: s.last_paid_at, lastAmount: s.last_amount, plan: s.plan_name || '', createdAt: s.created_at })),
        events: events.map(eventView),
        refunds: refunds.map(refundView),
        cancels: cancels.map(cancelView),
      };
    },

    // [기간 연장(일수)] — 손 연장 줄: 지금 기한(없으면 오늘)부터 days 일 더. 웹훅이 끊긴 동안 메우는 안전망.
    async extend(userId, days) {
      return one(`INSERT INTO subscriptions (user_id, provider, ref, status, paid_until, occurred_at)
        VALUES ($1, 'manual', '', 'active', greatest(now(), coalesce((SELECT max(paid_until) FROM subscriptions WHERE user_id = $1), now())) + make_interval(days => $2), now())
        ON CONFLICT (user_id, provider, ref) DO UPDATE SET status = 'active', paid_until = EXCLUDED.paid_until, occurred_at = now(), updated_at = now() RETURNING paid_until`, [userId, days]);
    },
    // [이용권 끝내기] — 그 사람의 모든 줄을 지금 끝내고 무료 이용도 끈다. 그 뒤에 온 «더 이른» 소식은 되살리지 못한다(occurred_at = 지금).
    async end(userId) {
      const r = await pool.query(`UPDATE subscriptions SET status = 'ended', paid_until = least(coalesce(paid_until, now()), now()), occurred_at = greatest(coalesce(occurred_at, now()), now()), updated_at = now()
        WHERE user_id = $1 AND (status <> 'ended' OR paid_until > now())`, [userId]);
      await pool.query('UPDATE billing_customers SET free = false, updated_at = now() WHERE user_id = $1', [userId]);
      return r.rowCount;
    },
    async setFree(userId, on, by) {
      await pool.query(`INSERT INTO billing_customers (user_id, free, updated_by) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET free = EXCLUDED.free, updated_by = EXCLUDED.updated_by, updated_at = now()`, [userId, !!on, by]);
    },
    async setMemo(userId, memo, by) {
      await pool.query(`INSERT INTO billing_customers (user_id, memo, updated_by) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET memo = EXCLUDED.memo, updated_by = EXCLUDED.updated_by, updated_at = now()`, [userId, memo, by]);
    },

    // 결제 기록 — «확인 필요»를 맨 위에, 그 아래 받은 웹훅(최근 100). 이번 달(한국) 반영된 결제의 수 · 합계.
    async events({ limit = 100 } = {}) {
      const n = Math.max(1, Math.min(300, Number(limit) || 100));
      const review = (await pool.query(`SELECT ${EVENT_COLS} FROM billing_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.review ORDER BY e.received_at DESC, e.id DESC LIMIT 200`)).rows;
      const recent = (await pool.query(`SELECT ${EVENT_COLS} FROM billing_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.received_at DESC, e.id DESC LIMIT $1`, [n])).rows;
      const month = await one(`SELECT count(*)::int AS n, coalesce(sum(amount), 0)::bigint AS total FROM billing_events
        WHERE result = 'applied' AND type = 'subscription_payment.completed' AND received_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`, []);
      // 환불 건 — 끝나지 않은 것이 먼저(할 일 둘 가운데 무엇이 남았나), 그 아래 최근 것
      const refunds = (await pool.query(`SELECT ${REFUND_COLS} FROM refund_requests r JOIN users u ON u.id = r.user_id
        ORDER BY (r.status = 'open') DESC, r.created_at DESC LIMIT 100`)).rows;
      // 구독 취소 — 그로블 해지를 기다리는 것이 먼저(다음 결제일이 이른 차례), 그 아래 최근 것
      const cancels = (await pool.query(`SELECT ${CANCEL_COLS} FROM cancel_requests x JOIN users u ON u.id = x.user_id
        ORDER BY (x.status = 'open') DESC, x.next_billing NULLS LAST, x.created_at DESC LIMIT 100`)).rows;
      return { review: review.map(eventView), recent: recent.map(eventView), refunds: refunds.map(refundView), cancels: cancels.map(cancelView), month: { count: month.n, total: Number(month.total) } };
    },
    async event(id) {
      const r = await one(`SELECT e.*, u.login_id FROM billing_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.id = $1`, [Number(id) || 0]);
      return r;
    },

    /**
     * [이 계정에 연결] — 받은 결제 하나를 그 사람에게 반영한다(금액 검사 없이). 참조값이 있으면 그 사람에게 묶고(다른 사람에게 묶인 값이면 거절),
     * 없으면 구매자 이메일을 기억해 다음 소식부터 저절로 잇는다. 돌려주는 값: { ok, result, note } 또는 { ok:false, code }
     */
    async link(eventId, userId, by) {
      const row = await one('SELECT id, raw, ref FROM billing_events WHERE id = $1', [Number(eventId) || 0]);
      if (!row) return { ok: false, code: 'missing' };
      const ev = billing.adapter.parse(JSON.stringify(row.raw || {}));
      if (!ev.ok || ev.kind === 'unknown') return { ok: false, code: 'unreadable' };
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        if (ev.ref) {
          const bound = (await c.query(`SELECT user_id FROM billing_refs WHERE kind = 'link' AND ref = $1`, [ev.ref])).rows[0];
          if (bound && bound.user_id !== userId) { await c.query('ROLLBACK'); return { ok: false, code: 'ref_taken' }; }
          if (!bound) await c.query(`INSERT INTO billing_refs (kind, ref, user_id, used_at) VALUES ('link', $1, $2, now())`, [ev.ref, userId]);
        } else if (normEmail(ev.buyer.email)) {
          await c.query(`INSERT INTO billing_refs (kind, ref, user_id, used_at) VALUES ('email', $1, $2, now()) ON CONFLICT (kind, ref) DO UPDATE SET user_id = EXCLUDED.user_id`, [normEmail(ev.buyer.email), userId]);
        }
        const out = await billing.reflect(c, ev, { force: true, userId });
        await c.query(`UPDATE billing_events SET result = $2, note = $3, user_id = $4, subscription_id = $5, review = false, resolved_by = $6, resolved_at = now() WHERE id = $1`,
          [row.id, out.result, out.note || '', userId, out.subId || null, by]);
        await c.query('COMMIT');
        return { ok: true, result: out.result, note: out.note || '' };
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* 끊겼다 */ }
        throw e;
      } finally {
        c.release();
      }
    },
    // [무시] — «확인 필요»에서 내린다(기록은 그대로)
    async ignore(eventId, by) {
      return (await pool.query('UPDATE billing_events SET review = false, resolved_by = $2, resolved_at = now() WHERE id = $1 AND review', [Number(eventId) || 0, by])).rowCount > 0;
    },

    // 웹훅 상태 — 시크릿이 있나 · 마지막으로 받은 때 · 서명이 맞지 않은 요청 · 다음 결제일이 지났는데 소식이 없는 정기결제(웹훅이 끊겼을 수 있다)
    async health() {
      const last = await one('SELECT max(received_at) AS at FROM billing_events', []);
      const overdue = await one(`SELECT count(*)::int AS n FROM subscriptions WHERE provider = 'groble' AND status IN ('active', 'past_due')
        AND next_billing_date < ($1::date - 1) AND paid_until > now()`, [kstDay(Date.now())]);
      const review = await one('SELECT count(*)::int AS n FROM billing_events WHERE review', []);
      // 환불 건 — 끝나지 않은 것 · 환불은 됐는데 그로블 정기결제가 아직 살아 있는 것(다음 결제일에 다시 청구된다)
      const refunds = await one(`SELECT count(*)::int AS open, count(*) FILTER (WHERE refunded_at IS NOT NULL AND cancelled_at IS NULL)::int AS uncancelled
        FROM refund_requests WHERE status = 'open'`, []);
      // 구독 취소 — 그로블 해지를 기다리는 것 · 다음 결제일이 지났는데도 해지 확인이 없는 것(다시 청구됐을 수 있다)
      const cancels = await one(`SELECT count(*)::int AS open, count(*) FILTER (WHERE next_billing IS NOT NULL AND next_billing <= $1::date)::int AS late
        FROM cancel_requests WHERE status = 'open'`, [kstDay(Date.now())]);
      // 알림 메일 — 켜졌나(Secrets 의 키) · 받을 주소가 있나 · 보내지 못한 요청
      const mailFailed = await one(`SELECT (SELECT count(*) FROM refund_requests WHERE mailed_at IS NULL AND mail_error <> '')
        + (SELECT count(*) FROM cancel_requests WHERE mailed_at IS NULL AND mail_error <> '') AS n`, []);
      return { secret: billing.secretState(), lastReceivedAt: last.at, overdue: overdue.n, review: review.n, refundsOpen: refunds.open, refundsUncancelled: refunds.uncancelled,
        cancelsOpen: cancels.open, cancelsLate: cancels.late, mail: { on: billing.mailOn(), to: !!(await rulesOf(pool)).notifyEmail, failed: Number(mailFailed.n) },
        ...billing.health, path: '/api/billing/groble' };
    },

    // ---------------------------------------------------------------- 결제 옵션 · 이용 규칙
    async plans() {
      return (await pool.query('SELECT id, name, checkout_url, price, cycle_months, product_id, enabled, sort_order, created_at FROM billing_plans ORDER BY sort_order, created_at')).rows
        .map((p) => ({ id: p.id, name: p.name, checkoutUrl: p.checkout_url, price: p.price, cycleMonths: p.cycle_months, productId: p.product_id, enabled: p.enabled, sortOrder: p.sort_order, createdAt: p.created_at }));
    },
    /**
     * 결제 옵션 넣기 · 고치기. 가격 · 주기는 만든 뒤 바꾸지 않는다(그로블은 판매된 옵션을 고칠 수 없다 — 새 줄을 넣고 옛 줄을 끈다).
     * 상품 번호는 비어 있을 때 한 번 채울 수 있다. 돌려주는 값: { ok, plan } 또는 { ok:false, error }
     */
    async planSave(b) {
      const name = String(b.name == null ? '' : b.name).trim().slice(0, 60);
      const url = String(b.checkoutUrl == null ? '' : b.checkoutUrl).trim();
      const productId = String(b.productId == null ? '' : b.productId).trim().slice(0, 100);
      const linkOk = (u) => !!billing.adapter.checkoutUrl(u, 'check');
      if (b.id) {
        const cur = isUuid(b.id) ? await one('SELECT * FROM billing_plans WHERE id = $1', [b.id]) : null;
        if (!cur) return { ok: false, code: 'missing', error: '그 결제 옵션이 없습니다' };
        if ((b.price != null && Number(b.price) !== cur.price) || (b.cycleMonths != null && Number(b.cycleMonths) !== cur.cycle_months)) {
          return { ok: false, error: '가격 · 주기는 바꿀 수 없습니다 — 그로블에서 새 상품을 만들고 새 결제 옵션을 넣은 뒤 이것을 꺼 주세요' };
        }
        if (b.productId != null && cur.product_id && productId !== cur.product_id) return { ok: false, error: '상품 번호는 한 번 정하면 바꾸지 않습니다' };
        if (b.name != null && !name) return { ok: false, error: '이름이 필요합니다' };
        if (b.checkoutUrl != null && !linkOk(url)) return { ok: false, error: '결제창 링크는 https 주소여야 합니다' };
        const plan = await one(`UPDATE billing_plans SET name = coalesce($2, name), checkout_url = coalesce($3, checkout_url), product_id = coalesce($4, product_id),
            enabled = coalesce($5, enabled), sort_order = coalesce($6, sort_order), updated_at = now() WHERE id = $1 RETURNING id`,
          [cur.id, b.name != null ? name : null, b.checkoutUrl != null ? url : null, b.productId != null && !cur.product_id ? productId : null,
            typeof b.enabled === 'boolean' ? b.enabled : null, b.sortOrder != null && Number.isInteger(Number(b.sortOrder)) ? Number(b.sortOrder) : null]);
        return { ok: true, plan: { id: plan.id } };
      }
      const price = Number(b.price); const months = b.cycleMonths == null || b.cycleMonths === '' ? 1 : Number(b.cycleMonths);
      if (!name) return { ok: false, error: '이름이 필요합니다' };
      if (!linkOk(url)) return { ok: false, error: '결제창 링크는 https 주소여야 합니다(그로블 결제창 링크를 붙여 넣어 주세요)' };
      if (!Number.isInteger(price) || price < 100 || price > 10000000) return { ok: false, error: '가격은 100원 ~ 1,000만 원의 정수입니다' };
      if (!Number.isInteger(months) || months < 1 || months > 12) return { ok: false, error: '주기는 1~12개월입니다' };
      const plan = await one(`INSERT INTO billing_plans (name, checkout_url, price, cycle_months, product_id, enabled, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [name, url, price, months, productId, b.enabled !== false, Number.isInteger(Number(b.sortOrder)) ? Number(b.sortOrder) : 0]);
      return { ok: true, plan: { id: plan.id } };
    },
    async rules() { return { ...(await rulesOf(pool)), blocks: 'ai', mailOn: billing.mailOn() }; },
    // 이용 규칙 저장 — 보내지 않은 값은 지금 값 그대로(환불 칸이 없던 화면이 보내도 환불 규칙이 지워지지 않게)
    async rulesSave(b, by) {
      const cur = await rulesOf(pool);
      const pick = (k) => (b[k] == null || b[k] === '' ? cur[k] : Number(b[k]));
      const trialDays = pick('trialDays'); const graceDays = pick('graceDays'); const refundDays = pick('refundDays');
      const refundNoUse = typeof b.refundNoUse === 'boolean' ? b.refundNoUse : cur.refundNoUse;
      // 알림 메일 — 보낸 값이 있으면 그 값(빈 글은 지운다), 없으면 지금 값
      const notifyEmail = b.notifyEmail == null ? cur.notifyEmail : normEmail(b.notifyEmail);
      if (b.notifyEmail != null && String(b.notifyEmail).trim() && !notifyEmail) return { ok: false, error: '알림 메일 주소가 맞지 않습니다' };
      if (!Number.isInteger(trialDays) || trialDays < 0 || trialDays > 90) return { ok: false, error: '무료 체험은 0~90일입니다' };
      if (!Number.isInteger(graceDays) || graceDays < 0 || graceDays > 60) return { ok: false, error: '여유는 0~60일입니다' };
      if (!Number.isInteger(refundDays) || refundDays < 0 || refundDays > 30) return { ok: false, error: '환불 기간은 0~30일입니다(0 이면 환불 요청을 받지 않는다)' };
      const rules = { trialDays, graceDays, refundDays, refundNoUse, notifyEmail };
      await pool.query(`INSERT INTO app_settings (key, value, updated_by) VALUES ('billing.rules', $1, $2)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [rules, by]);
      return { ok: true, rules: { ...rules, blocks: 'ai', mailOn: billing.mailOn() } };
    },
  };
}
