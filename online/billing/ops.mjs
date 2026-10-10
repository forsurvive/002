// 이용권 · 고객 · 결제 관리의 문(POST /api/edu { op }) — 자유 가입판에만(online/edition.mjs isOpenOnlyOp). createEdu 가 문 표에 더한다.
//   me.pass · me.pass.checkout · me.pass.refund · me.pass.cancel — 내 이용권 · [결제하기] · [환불 요청] · [구독 취소](누구나 — 제 것만, 금액 없음)
//   billing.*                                                   — 고객 · 결제 기록 · 결제 옵션 · 이용 규칙 · 알림 메일(최상위 운영자만 — 다른 사람에게는 403)
// 손으로 바꾼 것은 모두 감사 기록(누가 · 언제 · 무엇을 · 왜). 메모 · 개인정보는 감사 기록에 싣지 않는다.

import { createBillingAdmin } from './admin.mjs';
import { readReason, mailSay } from './notice.mjs';
import { isUuid } from '../tenancy.mjs';



export function billingOps({ pool, billing, log = async () => {} }) {
  const admin = createBillingAdmin({ pool, billing });
  const ok = (extra = {}) => ({ status: 200, body: { ok: true, ...extra } });
  const no = (status, error, code) => ({ status, body: { ok: false, error, ...(code ? { code } : {}) } });
  const FORBIDDEN = no(403, '권한이 없습니다', 'forbidden');
  const NOT_FOUND = no(404, '찾을 수 없습니다');
  const why = (b) => String(b.reason || '').trim().slice(0, 200);
  // 운영자만 — 대상은 있는 사람이어야 한다
  const target = async (user, b) => {
    if (!user.isPlatformAdmin) return { err: FORBIDDEN };
    const u = isUuid(b.userId) ? (await pool.query('SELECT id, login_id FROM users WHERE id = $1', [b.userId])).rows[0] : null;
    return u ? { u } : { err: NOT_FOUND };
  };

  return {
    // ---------------- 내 것
    async 'me.pass'(user) { return ok({ pass: await billing.myPass(user) }); },
    async 'me.pass.checkout'(user, b) {
      const r = await billing.checkout(user, b.planId);
      if (r.ok) return ok({ url: r.url });
      return r.code === 'bad_link' ? no(422, '결제 링크가 맞지 않습니다 — 운영자에게 알려 주세요', 'bad_link') : no(404, '그 결제 옵션이 없습니다', 'missing');
    },
    // [환불 요청] — 구독 시작 뒤 기간 안에만. 이유를 받고 서버가 다시 판정한다(§4-8). 받으면 이용권이 바로 멈추고 운영자에게 메일 —
    // 운영자가 그로블에서 환불 · 정기결제 해지를 함께 한다.
    async 'me.pass.refund'(user, b, ip) {
      const why = readReason(b);
      if (!why.ok) return no(422, why.error, 'validation');
      const r = await billing.requestRefund(user, why);
      if (!r.ok) {
        const SAY = { off: '지금은 환불 요청을 받지 않습니다', no_payment: '환불할 결제가 없습니다', window_passed: '환불 기간(구독 시작 후 ' + r.check.refundDays + '일)이 지났습니다 — [구독 취소]를 눌러 주세요',
          ai_used: '구독 시작 뒤 AI 작업을 해서 환불 대상이 아닙니다', requested: '이미 환불을 요청했습니다 — 운영자가 처리하고 있습니다', refunded: '이미 환불된 결제입니다' };
        return no(422, SAY[r.code] || '환불할 수 없습니다', r.code);
      }
      const k = r.check;
      await log(user, null, 'billing.refund_request', 'user', user.id,
        { paidAt: k.payment.paidAt, start: k.start, until: k.deadline, aiRuns: k.aiRuns, merchantUid: k.payment.merchantUid, reason: why.reason, mailed: !!r.mail.ok }, ip);
      return ok({ pass: await billing.myPass(user) });
    },
    // [구독 취소] — 환불 기간이 지난 뒤. 이유를 받고 접수한 뒤 운영자에게 메일(그로블에 판매자 해지 API 가 없다 — 해지는 그로블 판매 관리에서).
    // 이용권은 지금 결제 기간 끝까지 그대로, 그로블 해지 웹훅이 오면 «해지 확인».
    async 'me.pass.cancel'(user, b, ip) {
      const why = readReason(b);
      if (!why.ok) return no(422, why.error, 'validation');
      const r = await billing.requestCancel(user, why);
      if (!r.ok) {
        const SAY = { none: '취소할 구독이 없습니다', pending: '이미 해지된 구독입니다 — 지금 결제 기간 끝까지 쓰고 끝납니다', requested: '이미 구독 취소를 접수했습니다',
          refund_window: '지금은 환불 기간입니다 — [환불 요청]을 눌러 주세요' };
        return no(422, SAY[r.code] || '구독을 취소할 수 없습니다', r.code);
      }
      await log(user, null, 'billing.cancel_request', 'user', user.id, { nextBilling: r.check.subscription.nextBillingDate, reason: why.reason, mailed: !!r.mail.ok }, ip);
      return ok({ pass: await billing.myPass(user) });
    },

    // ---------------- 고객(운영자)
    async 'billing.customers'(user, b) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      return ok(await admin.customers({ q: b.q, status: b.status, limit: b.limit, offset: b.offset }));
    },
    async 'billing.customer'(user, b) {
      const t = await target(user, b);
      if (t.err) return t.err;
      return ok({ customer: await admin.customer(t.u.id) });
    },
    async 'billing.extend'(user, b, ip) {
      const t = await target(user, b);
      if (t.err) return t.err;
      const days = Number(b.days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) return no(422, '연장은 1~3650일입니다', 'validation');
      const r = await admin.extend(t.u.id, days);
      await log(user, null, 'billing.extend', 'user', t.u.id, { loginId: t.u.login_id, days, reason: why(b) }, ip);
      return ok({ paidUntil: r.paid_until });
    },
    async 'billing.end'(user, b, ip) {
      const t = await target(user, b);
      if (t.err) return t.err;
      const n = await admin.end(t.u.id);
      await log(user, null, 'billing.end', 'user', t.u.id, { loginId: t.u.login_id, rows: n, reason: why(b) }, ip);
      return ok({ ended: n });
    },
    async 'billing.free'(user, b, ip) {
      const t = await target(user, b);
      if (t.err) return t.err;
      await admin.setFree(t.u.id, b.on === true, user.id);
      await log(user, null, 'billing.free', 'user', t.u.id, { loginId: t.u.login_id, on: b.on === true, reason: why(b) }, ip);
      return ok({ free: b.on === true });
    },
    async 'billing.memo'(user, b, ip) {
      const t = await target(user, b);
      if (t.err) return t.err;
      const memo = String(b.memo == null ? '' : b.memo).slice(0, 2000);
      await admin.setMemo(t.u.id, memo, user.id);
      await log(user, null, 'billing.memo', 'user', t.u.id, { loginId: t.u.login_id, length: memo.length }, ip);   // 메모 내용은 감사 기록에 싣지 않는다
      return ok();
    },

    // ---------------- 결제 기록(운영자)
    async 'billing.events'(user, b) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      return ok(await admin.events({ limit: b.limit }));
    },
    async 'billing.link'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      const login = String(b.loginId || '').trim().toLowerCase();
      const u = isUuid(b.userId) ? (await pool.query('SELECT id, login_id FROM users WHERE id = $1', [b.userId])).rows[0]
        : login ? (await pool.query('SELECT id, login_id FROM users WHERE login_id = $1', [login])).rows[0] : null;
      if (!u) return no(404, '그 아이디의 계정이 없습니다', 'missing');
      const r = await admin.link(b.eventId, u.id, user.id);
      if (!r.ok) {
        if (r.code === 'unreadable') return no(422, '읽지 못한 꼴은 연결할 수 없습니다 — [무시]로 닫아 주세요', 'unreadable');
        if (r.code === 'ref_taken') return no(409, '이 결제의 참조값은 다른 계정에 묶여 있습니다', 'conflict');
        return NOT_FOUND;
      }
      await log(user, null, 'billing.link', 'billing_event', String(b.eventId), { loginId: u.login_id, result: r.result, reason: why(b) }, ip);
      return ok({ result: r.result, note: r.note, loginId: u.login_id });
    },
    async 'billing.ignore'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      if (!(await admin.ignore(b.eventId, user.id))) return NOT_FOUND;
      await log(user, null, 'billing.ignore', 'billing_event', String(b.eventId), { reason: why(b) }, ip);
      return ok();
    },
    // [요청 되돌리기] — 환불 전에만, 멈춘 이용권을 되살린다(왜 · 감사 기록)
    async 'billing.refund.withdraw'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      const r = await billing.withdrawRefund(b.requestId, user.id);
      if (!r.ok) return r.code === 'missing' ? NOT_FOUND : no(409, r.code === 'refunded' ? '이미 환불된 건은 되돌릴 수 없습니다' : '끝난 건은 되돌릴 수 없습니다', 'conflict');
      await log(user, null, 'billing.refund_withdraw', 'refund_request', String(b.requestId), { reason: why(b) }, ip);
      return ok();
    },
    async 'billing.health'(user) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      return ok({ health: await admin.health() });
    },
    // 알림 메일 — [시험 메일 보내기] · 보내지 못한 요청의 [메일 다시 보내기]
    async 'billing.mail.test'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      const r = await billing.sendTestMail();
      await log(user, null, 'billing.mail_test', 'settings', 'billing.rules', { ok: !!r.ok, reason: r.ok ? '' : String(r.reason || '') }, ip);
      return r.ok ? ok() : no(422, mailSay(r.reason), 'mail');
    },
    async 'billing.mail.resend'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      if (!['refund', 'cancel'].includes(b.kind) || !isUuid(b.id)) return NOT_FOUND;
      const r = await billing.notify(b.kind, b.id);
      if (r.reason === 'missing') return NOT_FOUND;
      await log(user, null, 'billing.mail_resend', b.kind + '_request', b.id, { ok: !!r.ok }, ip);
      return r.ok ? ok() : no(422, mailSay(r.reason), 'mail');
    },

    // ---------------- 결제 옵션 · 이용 규칙(운영자)
    async 'billing.plans'(user) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      return ok({ plans: await admin.plans() });
    },
    async 'billing.plan.save'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      const r = await admin.planSave(b);
      if (!r.ok) return r.code === 'missing' ? NOT_FOUND : no(422, r.error, 'validation');
      const fields = Object.keys(b).filter((k) => ['name', 'checkoutUrl', 'price', 'cycleMonths', 'productId', 'enabled', 'sortOrder'].includes(k));
      await log(user, null, b.id ? 'billing.plan_update' : 'billing.plan_create', 'billing_plan', r.plan.id, { fields, ...(b.id ? {} : { price: Number(b.price) }) }, ip);
      return ok({ plan: r.plan, plans: await admin.plans() });
    },
    async 'billing.rules'(user) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      return ok({ rules: await admin.rules() });
    },
    async 'billing.rules.save'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      const r = await admin.rulesSave(b, user.id);
      if (!r.ok) return no(422, r.error, 'validation');
      // 감사 기록에는 알림 메일 주소 대신 «있음»만
      const { notifyEmail, ...rest } = r.rules;
      await log(user, null, 'billing.rules', 'settings', 'billing.rules', { ...rest, notifyEmail: !!notifyEmail }, ip);
      return ok({ rules: r.rules });
    },
  };
}
