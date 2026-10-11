// 구독 취소 알림 시험 — 어떤 길의 구독 취소든 곧바로 운영자 메일, 운영자가 처리할 것은 처리될 때까지 다음 날부터 하루 한 번(한국 시각 아침) 다시 알림
// (docs/OPEN_EDITION.md §4-12). online/test.mjs 가 이어 부른다. 그로블 웹훅은 서명해서 보내고, 메일은 가짜 우편함 · 시각은 remindDue({ now }) 로 옮긴다.

import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { createBilling, kstDay, REMIND_HOUR } from './billing/service.mjs';
import { sample, signed } from './test.billing.mjs';

const SECRET = 'test-remind-secret-' + 'z'.repeat(8);

export async function run({ pool, ok, eq }) {
  resetThrottle();
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('billing.rules', '{"notifyEmail": "ops@example.com"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const mails = [];
  let mailMode = 'ok';
  const mailer = { on: () => true, send: async (m) => { if (!m.to) return { ok: false, reason: 'no_to' }; if (mailMode !== 'ok') return { ok: false, reason: mailMode }; mails.push(m); return { ok: true }; } };
  const billing = createBilling({ pool, secrets: () => [SECRET], mailer, retryMs: 0, siteUrl: 'https://book.example', app: '전자책 오토' });
  const srv = createOnlineServer({ pool, plan: onlinePlan({ SE_EDITION: 'open', SE_PURPOSE: 'ebook' }), billing });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const plan = (await pool.query(`INSERT INTO billing_plans (name, checkout_url, price, cycle_months, product_id, sort_order)
    VALUES ('알림 시험 이용권', 'https://www.groble.im/pay/remind', 6000, 1, 'C-RMD', 9) RETURNING id`)).rows[0];
  const cookieOf = (list) => (list.find((c) => c.startsWith('se_session=')) || '').split(';')[0];
  const person = async (id, admin = false) => {
    const u = (await createUser(pool, { loginId: id, password: 'long-enough-' + id, isPlatformAdmin: admin })).user;
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: 'long-enough-' + id }) });
    return { ...u, cookie: cookieOf(r.headers.getSetCookie()) };
  };
  const edu = async (who, op, b = {}) => {
    const r = await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json', cookie: who.cookie }, body: JSON.stringify({ op, ...b }) });
    return { status: r.status, ...(await r.json()) };
  };
  const hook = async (bodyObj) => {
    const raw = JSON.stringify(bodyObj);
    return (await fetch(base + '/api/billing/groble', { method: 'POST', headers: signed(SECRET, raw), body: raw })).status;
  };
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const nextDay = kstDay(Date.now() + 20 * 86400000);
  const pay = async (who, merchantUid, minutesAgo) => {
    const ref = new URL((await edu(who, 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
    const st = await hook(sample({ type: 'subscription_payment.completed', occurredAt: ago(minutesAgo) }, { sellerReference: ref, merchantUid, buyer: { email: who.login_id + '@example.com' },
      content: { id: 'C-RMD', paymentType: 'SUBSCRIPTION' }, pricing: { finalAmount: 6000 }, subscription: { billingReason: 'INITIAL', currentRound: 1, nextBillingDate: nextDay, status: 'ACTIVE', billingCycleMonths: 1 } }));
    return { ref, st };
  };
  const groble = (type, ref, merchantUid, minutesAgo, obj = {}) => hook(sample({ type, occurredAt: ago(minutesAgo) }, { sellerReference: ref, merchantUid, buyer: { email: 'x@example.com' }, ...obj }));
  const fresh = () => mails.splice(0);   // 지금까지 온 메일을 꺼내고 비운다
  const about = (list, word) => list.filter((m) => (m.subject + '\n' + m.text).includes(word));
  const wait = async (n = 1) => { for (let i = 0; i < 40 && mails.length < n; i++) await new Promise((r) => setTimeout(r, 25)); };
  // 한국 시각으로 «오늘 + d 일의 hh:mm»
  const kstAt = (d, hhmm) => new Date(kstDay(Date.now() + d * 86400000) + 'T' + hhmm + ':00+09:00');

  try {
    // 앞 시험들이 남긴 열린 요청은 닫아 둔다(이 시험은 다시 알림의 수를 센다 — 시험 DB 는 돌 때마다 새로 짓는다)
    await pool.query(`UPDATE cancel_requests SET status = 'done' WHERE status = 'open'`);
    await pool.query(`UPDATE refund_requests SET status = 'done' WHERE status = 'open'`);
    await pool.query(`UPDATE billing_events SET resolved_at = now() WHERE type = 'payment.cancel_requested' AND resolved_at IS NULL`);
    const root = await person('rm-root', true);

    // ---------------- 곧바로 — 우리에게 낸 구독 취소 · 환불 요청(있던 것)
    const cancelU = await person('rm-cancel');
    const c1 = await pay(cancelU, 'M-RC1', 10 * 1440);   // 열흘 전 첫 결제 — 환불 기간이 지나 [구독 취소]가 선다
    eq('구독 취소할 사람의 결제', c1.st, 200);
    fresh();
    eq('[구독 취소]', (await edu(cancelU, 'me.pass.cancel', { reason: 'price' })).status, 200);
    ok('**[구독 취소] — 곧바로 메일**', about(fresh(), 'rm-cancel').some((m) => m.subject.includes('구독 취소')));

    const refundU = await person('rm-refund');
    const r1 = await pay(refundU, 'M-RR1', 60);
    eq('[환불 요청]', (await edu(refundU, 'me.pass.refund', { reason: 'rarely' })).status, 200);
    ok('**[환불 요청] — 곧바로 메일**', about(fresh(), 'rm-refund').some((m) => m.subject.includes('환불 요청')));

    // ---------------- 곧바로 — 그로블 쪽에서 일어난 구독 취소(우리에게 낸 요청이 없던 것)
    const grobleU = await person('rm-groble');
    const g1 = await pay(grobleU, 'M-RG1', 60);
    fresh();
    eq('그로블에서 해지 예고', await groble('subscription.cancel_requested', g1.ref, 'M-RG1', 30, { serviceEndsAt: new Date(Date.now() + 5 * 86400000).toISOString() }), 200);
    await wait();
    const gm = about(fresh(), 'rm-groble');
    ok('**고객이 그로블에서 해지 — 곧바로 알림 메일(할 일 없음)**', gm.length === 1 && gm[0].subject.startsWith('[전자책 오토] 구독 해지(그로블에서)') && gm[0].text.includes('할 일 없음'), JSON.stringify(gm.map((m) => m.subject)));
    eq('그 뒤의 «해지 완료»', await groble('subscription.terminated', g1.ref, 'M-RG1', 20, { termination: { terminatedAt: ago(20) } }), 200);
    await new Promise((r) => setTimeout(r, 100));
    eq('**해지 예고를 이미 알렸으면 «해지 완료»는 또 알리지 않는다**', about(fresh(), 'rm-groble').length, 0);

    const endedU = await person('rm-ended');
    const e1 = await pay(endedU, 'M-RE1', 60);
    fresh();
    eq('예고 없이 해지 완료(결제 실패 등)', await groble('subscription.terminated', e1.ref, 'M-RE1', 10, { termination: { terminatedAt: ago(10) } }), 200);
    await wait();
    ok('**예고 없이 끝난 정기결제 — 곧바로 알림 메일**', about(fresh(), 'rm-ended').some((m) => m.subject.includes('구독 끝남')));

    const buyerU = await person('rm-ask');
    await pay(buyerU, 'M-RB1', 60);
    fresh();
    eq('구매자가 그로블에서 취소(환불) 요청', await hook(sample({ type: 'payment.cancel_requested', occurredAt: ago(5) }, { sellerReference: '', merchantUid: 'M-RB1', buyer: { email: 'x@example.com' } })), 200);
    await wait();
    const bm = about(fresh(), 'rm-ask');
    ok('**구매자가 그로블에서 낸 취소 요청 — 곧바로 메일(할 일: 승인 · 반려)**', bm.length === 1 && bm[0].subject.includes('구매자가 그로블에서 취소(환불) 요청') && bm[0].text.includes('M-RB1') && bm[0].text.includes('승인 또는 반려'),
      JSON.stringify(bm.map((m) => m.subject)));

    const buyer2 = await person('rm-approved');
    const b2 = await pay(buyer2, 'M-RB2', 60);
    await hook(sample({ type: 'payment.cancel_requested', occurredAt: ago(5) }, { sellerReference: '', merchantUid: 'M-RB2', buyer: { email: 'x@example.com' } }));
    await wait();
    fresh();
    eq('그 요청이 승인돼 환불', await hook(sample({ type: 'subscription_payment.refunded', occurredAt: ago(2) }, { sellerReference: '', merchantUid: 'M-RB2', buyer: {} })), 200);
    ok('**환불되면 구매자의 취소 요청은 저절로 닫힌다**', !!(await pool.query(`SELECT resolved_at FROM billing_events WHERE type = 'payment.cancel_requested' AND merchant_uid = 'M-RB2'`)).rows[0].resolved_at);
    eq('그 정기결제도 그로블에서 해지', await groble('subscription.cancel_requested', b2.ref, 'M-RB2', 1), 200);

    const grefundU = await person('rm-grefund');
    await pay(grefundU, 'M-RF1', 60);
    await wait();
    fresh();
    eq('그로블에서 먼저 환불(우리에게 낸 요청 없이)', await hook(sample({ type: 'subscription_payment.refunded', occurredAt: ago(3) }, { sellerReference: '', merchantUid: 'M-RF1', buyer: {} })), 200);
    await wait();
    const fm = about(fresh(), 'rm-grefund');
    ok('**그로블에서 먼저 한 환불 — 곧바로 메일(정기결제 해지가 아직이면 할 일)**', fm.length === 1 && fm[0].subject.includes('그로블에서 환불됨 · 정기결제 해지가 아직') && fm[0].text.includes('M-RF1'), JSON.stringify(fm.map((m) => m.subject)));

    // ---------------- 다시 알림 — 다음 날부터 하루 한 번, 한국 시각 아침부터
    fresh();
    eq('**오늘(요청한 날)은 다시 알리지 않는다**', (await billing.remindDue({ now: kstAt(0, '23:30') })).sent, 0);
    eq(`**다음 날이라도 ${REMIND_HOUR}시 전에는 보내지 않는다(밤중에 깨우지 않게)**`, (await billing.remindDue({ now: kstAt(1, '07:59') })).sent, 0);
    const d1 = await billing.remindDue({ now: kstAt(1, '09:30') });
    const m1 = fresh();
    const of = (word) => about(m1, word);
    ok('**다음 날 아침 — 처리 안 된 것마다 다시 알림 한 통(구독 취소 · 환불 요청 · 구매자의 취소 요청 · 그로블 환불의 해지)**', d1.sent >= 4 && d1.failed === 0
      && of('rm-cancel').length === 1 && of('rm-refund').length === 1 && of('rm-ask').length === 1 && of('rm-grefund').length === 1, JSON.stringify(m1.map((m) => m.subject)));
    ok('다시 알림은 제목에 «다시 알림(2일째)»', [of('rm-cancel')[0], of('rm-refund')[0], of('rm-ask')[0]].every((m) => m && m.subject.startsWith('[전자책 오토] 다시 알림(2일째) — ') && m.text.startsWith('아직 처리되지 않아 다시 알립니다')));
    ok('**환불 요청의 다시 알림은 남은 일을 적는다(① 환불 ② 해지)**', of('rm-refund')[0].text.includes('남은 일: ① 그로블에서 이 결제 환불 · ② 그로블에서 정기결제 해지'));
    ok('**할 일이 없는 것(그로블에서 해지 · 끝남 · 저절로 닫힌 요청)은 다시 알리지 않는다**', of('rm-groble').length === 0 && of('rm-ended').length === 0 && of('rm-approved').length === 0);
    eq('**같은 날 다시 불러도 또 보내지 않는다(하루 한 번)**', (await billing.remindDue({ now: kstAt(1, '18:00') })).sent, 0);

    // 처리되는 것들 — 그로블 해지 확인 · 환불(해지는 아직) · 운영자의 [처리함]
    eq('구독 취소한 사람 — 그로블에서 해지', await groble('subscription.cancel_requested', c1.ref, 'M-RC1', 1), 200);
    eq('환불 요청 — 그로블에서 환불만(해지는 아직)', await hook(sample({ type: 'subscription_payment.refunded', occurredAt: ago(1) }, { sellerReference: '', merchantUid: 'M-RR1', buyer: {} })), 200);
    eq('보통 사람은 [처리함]을 못 한다(403)', (await edu(cancelU, 'billing.request.done', { kind: 'refund', id: '00000000-0000-0000-0000-000000000000' })).status, 403);
    const gEv = (await pool.query(`SELECT id FROM billing_events WHERE type = 'payment.cancel_requested' AND merchant_uid = 'M-RB1'`)).rows[0].id;
    eq('구매자의 취소 요청 — 운영자가 [처리함]', (await edu(root, 'billing.ignore', { eventId: Number(gEv), reason: '그로블에서 반려' })).status, 200);
    fresh();
    const d2 = await billing.remindDue({ now: kstAt(2, '09:10') });
    const m2 = fresh();
    ok('**셋째 날 — 아직인 것만(그로블 환불의 해지 · 환불 요청의 해지), 처리된 것은 멈춘다**', about(m2, 'rm-cancel').length === 0 && about(m2, 'rm-ask').length === 0
      && about(m2, 'rm-grefund').length === 1 && about(m2, 'rm-refund').length === 1, JSON.stringify(m2.map((m) => m.subject)));
    ok('**환불은 됐는데 해지가 아직 — 남은 일은 해지만**', about(m2, 'rm-refund')[0].subject.includes('다시 알림(3일째)') && about(m2, 'rm-refund')[0].text.includes('남은 일: ② 그로블에서 정기결제 해지'));
    eq('셋째 날 보낸 수', d2.sent, 2);

    const rfId = (await pool.query(`SELECT id FROM refund_requests WHERE user_id = $1`, [refundU.id])).rows[0].id;
    const grId = (await pool.query(`SELECT id FROM refund_requests WHERE user_id = $1`, [grefundU.id])).rows[0].id;
    const done1 = await edu(root, 'billing.request.done', { kind: 'refund', id: rfId, reason: '그로블에서 해지했는데 웹훅이 안 옴' });
    ok('**운영자의 [처리함] — 그 건을 닫고 감사 기록에 남긴다**', done1.status === 200 && (await pool.query('SELECT status FROM refund_requests WHERE id = $1', [rfId])).rows[0].status === 'done'
      && (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'billing.request_done' AND target_id = $1`, [String(rfId)])).rows[0].n === 1);
    eq('끝난 건을 또 [처리함] — 409', (await edu(root, 'billing.request.done', { kind: 'refund', id: rfId })).status, 409);
    eq('없는 건 — 404', (await edu(root, 'billing.request.done', { kind: 'cancel', id: '00000000-0000-0000-0000-000000000000' })).status, 404);

    // 메일이 나가지 않으면 그날의 표시를 되돌려 — 다음 차례(10분 뒤)에 다시 보낸다
    mailMode = 'timeout';
    const d3 = await billing.remindDue({ now: kstAt(3, '09:05') });
    ok('**보내지 못하면 표시를 되돌린다**', d3.sent === 0 && d3.failed === 1 && (await pool.query('SELECT reminded_at FROM refund_requests WHERE id = $1', [grId])).rows[0].reminded_at !== null
      && kstDay((await pool.query('SELECT reminded_at FROM refund_requests WHERE id = $1', [grId])).rows[0].reminded_at) !== kstDay(kstAt(3, '09:05')), JSON.stringify(d3));
    mailMode = 'ok';
    fresh();
    const d4 = await billing.remindDue({ now: kstAt(3, '09:15') });
    ok('**다음 차례에 다시 보낸다(넷째 날)**', d4.sent === 1 && about(fresh(), 'rm-grefund').some((m) => m.subject.includes('다시 알림(4일째)')), JSON.stringify(d4));
    eq('그로블에서 해지되면', await groble('subscription.cancel_requested', (await pool.query(`SELECT s.ref FROM subscriptions s WHERE s.user_id = $1 AND s.provider = 'groble'`, [grefundU.id])).rows[0].ref, 'M-RF1', 0), 200);
    eq('**모두 처리되면 다시 알림이 없다**', (await billing.remindDue({ now: kstAt(5, '09:30') })).sent, 0);
  } finally {
    await new Promise((r) => srv.close(r));
    await pool.query(`DELETE FROM app_settings WHERE key = 'billing.rules'`);
  }
}
