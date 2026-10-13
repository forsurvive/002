// 평생 이용권 시험 — SE_BILLING=lifetime(docs/OPEN_EDITION.md §4-14): 그로블 단건 결제 한 번 → 기한 없는 이용권 · 환불이면 거둔다 ·
// 가입 3일 무료 체험 → 구매 제안(자동 결제 없음) · 정기결제 전용(구독 취소 · 계정 지울 때 자동 취소)은 서지 않는다. online/test.mjs 가 이어 부른다.

import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { createBilling, passActive, DEFAULT_RULES, LIFETIME_RULES, LIFETIME_UNTIL } from './billing/service.mjs';
import { billingOf } from './edition.mjs';
import { refundMail, grobleRefundMail } from './billing/notice.mjs';
import { sample, signed } from './test.billing.mjs';

const SECRET = 'test-lifetime-secret-' + 'z'.repeat(8);

export async function run({ pool, ok, eq }) {
  // ---------------- 스위치 — 없거나 모르는 값이면 지금 그대로(정기결제)
  eq('SE_BILLING 이 없으면 정기결제', billingOf({}), 'subscription');
  eq('SE_BILLING=lifetime(대소문자 · 띄어쓰기 무관)', billingOf({ SE_BILLING: ' Lifetime ' }), 'lifetime');
  eq('모르는 값은 정기결제(지금 앱이 저절로 바뀌지 않게)', billingOf({ SE_BILLING: 'forever' }), 'subscription');
  ok('모르는 값은 콘솔 알림', onlinePlan({ SE_EDITION: 'open', SE_BILLING: 'forever' }).notes.some((n) => /SE_BILLING/.test(n)));
  ok('교육기관판에서는 쓰지 않는다(알림)', onlinePlan({ SE_BILLING: 'lifetime' }).notes.some((n) => /only with SE_EDITION=open/.test(n)));
  ok('**평생 이용권 판의 기본 무료 체험은 3일 · 정기결제 판은 그대로 2일**', LIFETIME_RULES.trialDays === 3 && DEFAULT_RULES.trialDays === 2 && LIFETIME_RULES.refundDays === DEFAULT_RULES.refundDays);
  {
    const cols = (await pool.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'kind' AND table_name IN ('billing_plans', 'subscriptions')`)).rows.map((r) => r.table_name).sort();
    eq('마이그레이션 023 — 결제 옵션 · 이용권 줄에 종류', cols.join(','), 'billing_plans,subscriptions');
    eq('**지금 줄은 모두 정기결제(지금 앱들은 바뀌지 않는다)**', (await pool.query(`SELECT count(*)::int AS n FROM subscriptions WHERE kind <> 'subscription'`)).rows[0].n, 0);
  }

  // ---------------- 앱 — 자유 가입판 + 평생 이용권. 이용 규칙은 저장한 적이 없는 것처럼(알림 메일만) — 끝나면 되돌린다
  resetThrottle();
  const savedRules = (await pool.query(`SELECT value FROM app_settings WHERE key = 'billing.rules'`)).rows[0];
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('billing.rules', '{"notifyEmail": "ops@example.com"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const mails = [];
  const mailer = { on: () => true, send: async (m) => { if (!m.to) return { ok: false, reason: 'no_to' }; mails.push(m); return { ok: true }; } };
  const billing = createBilling({ pool, secrets: () => [SECRET], mailer, retryMs: 0, siteUrl: 'https://life.example', app: '전자책 오토', mode: 'lifetime' });
  const srv = createOnlineServer({ pool, plan: onlinePlan({ SE_EDITION: 'open', SE_PURPOSE: 'ebook', SE_BILLING: 'lifetime' }), billing });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const cookieOf = (list, name) => (list.find((c) => c.startsWith(name + '=')) || '').split(';')[0];
  const post = async (path, cookie, body) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}) });
    return { status: r.status, setCookie: r.headers.getSetCookie(), ...(await r.json().catch(() => ({}))) };
  };
  const login = async (id) => cookieOf((await post('/api/auth/login', '', { loginId: id, password: 'long-enough-' + id })).setCookie, 'se_session');
  const edu = (cookie, op, b = {}) => post('/api/edu', cookie, { op, ...b });
  const api = (cookie, op, b = {}) => post('/api', cookie, { op, ...b });
  const hook = async (bodyObj) => {
    const raw = JSON.stringify(bodyObj);
    return (await fetch(base + '/api/billing/groble', { method: 'POST', headers: signed(SECRET, raw), body: raw })).status;
  };
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0] || null;
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  // 웹훅 뒤의 운영자 메일은 기다리지 않고 보낸다 — 닿을 때까지 잠깐(최대 2초) 본다
  const mailed = async (fn) => { for (let i = 0; i < 40; i++) { if (mails.some(fn)) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  const lastEvent = () => one('SELECT result, note, review, subscription_id FROM billing_events ORDER BY id DESC LIMIT 1');
  // 그로블 단건 결제(가이드의 꼴 — 정기결제 칸 없음)
  const buy = (ref, merchantUid, { amount = 99000, at = ago(30), type = 'payment.completed', content = 'C-LIFE' } = {}) => sample({ type, occurredAt: at }, {
    sellerReference: ref, merchantUid, buyer: { displayName: '홍길동', email: 'life.buyer@example.com', phoneNumber: '010-1111-2222' },
    content: { id: content, paymentType: 'ONE_TIME' }, pricing: { finalAmount: amount }, subscription: undefined });

  const plan = (await pool.query(`INSERT INTO billing_plans (name, checkout_url, price, cycle_months, product_id, sort_order, kind)
    VALUES ('평생 이용권', 'https://www.groble.im/pay/life-once', 99000, 1, 'C-LIFE', 0, 'lifetime') RETURNING id`)).rows[0];
  const root = (await createUser(pool, { loginId: 'lf-root', password: 'long-enough-lf-root', isPlatformAdmin: true })).user;
  const rootIn = await login('lf-root');

  try {
    // ---------------- 로그인 전 — 소개 · 약관이 쓸 값
    const st = await (await fetch(base + '/api/setup')).json();
    ok('**/api/setup — 평생 이용권 · 체험 3일 · 값 99,000원**', st.billing === 'lifetime' && st.trialDays === 3 && st.price === 99000, JSON.stringify(st));

    // 읽기 쪽 — 이 앱의 이용권 축에 맞는 글만 보인다(스크립트 없이도 — 서버가 보낼 때 다른 축의 단락에 hidden)
    const page = async (p) => (await fetch(base + p)).text();
    const terms = await page('/terms'); const about = await page('/about'); const privacy = await page('/privacy');
    ok('**이용약관 — 평생 이용권 단락이 보이고 정기결제 · 구독 취소 단락은 감춰진다**', terms.includes('<li data-billing="lifetime">이용권은 한 번 결제하는 평생 이용권')
      && terms.includes('<li data-billing="subscription" hidden>이용권은 월 단위 정기결제') && terms.includes('<h2 data-billing="subscription" hidden>4. 환불과 구독 취소')
      && !/data-billing="lifetime" hidden/.test(terms) && terms.includes('<span data-trial>2</span>'));
    ok('소개 · 개인정보처리방침도 같다', about.includes('<span data-billing="subscription" hidden>(월 정기결제)') && privacy.includes('<span data-billing="subscription" hidden>(구독 중이면'));

    // ---------------- 가입 → 3일 무료 체험 · 구매 제안(값과 함께) · 자동 결제 없음
    const su = await post('/api/auth/signup', '', { loginId: 'lf-new', password: 'long-enough-lf-new' });
    const nu = await one(`SELECT u.id, s.paid_until FROM users u JOIN subscriptions s ON s.user_id = u.id AND s.provider = 'trial' WHERE u.login_id = 'lf-new'`);
    ok('**가입하면 3일 무료 체험**', su.status === 200 && su.trial === 3 && nu && Math.abs(new Date(nu.paid_until) - (Date.now() + 3 * 86400000)) < 60000, JSON.stringify(su));
    const newIn = cookieOf(su.setCookie, 'se_session');
    const p0 = (await edu(newIn, 'me.pass')).pass;
    ok('**체험 중 — 평생 이용권 결제 옵션(이름 · 값)이 보인다 · 정기결제 옵션은 없다**', p0.active && p0.provider === 'trial' && p0.mode === 'lifetime' && p0.plans.length === 1
      && p0.plans[0].name === '평생 이용권' && p0.plans[0].price === 99000 && !p0.cancel.can, JSON.stringify(p0));
    const meOf = async (cookie) => (await (await fetch(base + '/api/me', { headers: { cookie } })).json()).me;
    const m0 = await meOf(newIn);
    ok('**첫 화면 — 체험 중 구매 제안(체험 끝 · 값)**', m0.billing === 'lifetime' && m0.pass === true && m0.offer && m0.offer.price === 99000
      && Math.abs(new Date(m0.offer.trialUntil) - new Date(nu.paid_until)) < 1000, JSON.stringify(m0));
    eq('**체험 한 번 규칙은 그대로 — 체험을 받은 브라우저로 또 가입하면 체험 없음**',
      (await (await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'se_trial=1' }, body: JSON.stringify({ loginId: 'lf-again', password: 'long-enough-lf-again' }) })).json()).trialUsed, true);

    // 체험이 끝나면 — 새 AI 작업만 멈추고 편집 · 열람은 그대로. 저절로 결제되지 않는다.
    const made = await api(newIn, 'project.create', { name: '평생 시험', spec: { form: '실용서' }, materials: [{ name: '자료', text: '글' }] });
    const doc = (await api(newIn, 'doc.create', { pid: made.pid, title: '1장', body: '첫 글' })).id;
    await pool.query(`UPDATE subscriptions SET paid_until = now() - interval '1 minute' WHERE user_id = $1 AND provider = 'trial'`, [nu.id]);
    const p1 = (await edu(newIn, 'me.pass')).pass;
    ok('**체험이 끝나면 이용권 없음 — 구매는 사람이 고른다(결제 줄이 저절로 생기지 않는다)**', !p1.active && p1.plans.length === 1
      && (await one(`SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1 AND provider = 'groble'`, [nu.id])).n === 0);
    const w = await api(newIn, 'doc.write', { pid: made.pid, id: doc, body: '고친 글' });
    ok('체험이 끝나도 문서는 고친다', w.ok, JSON.stringify({ made, doc, w }));
    eq('**체험이 끝나면 새 AI 작업은 subscription_inactive**', (await api(newIn, 'doc.update', { pid: made.pid, id: doc })).code, 'subscription_inactive');

    // ---------------- [구매하기] — 결제창 링크 + ?ref= · 정기결제 옵션은 이 판에서 고를 수 없다
    const co = await edu(newIn, 'me.pass.checkout', { planId: plan.id });
    const ref = co.ok ? new URL(co.url).searchParams.get('ref') : '';
    ok('**[구매하기] — 단건 결제창 링크 + ?ref=<무작위 참조값>**', co.ok && co.url.startsWith('https://www.groble.im/pay/life-once?ref=') && !!ref);
    const sub = (await pool.query(`INSERT INTO billing_plans (name, checkout_url, price, cycle_months, product_id, sort_order) VALUES ('옛 월 이용권', 'https://www.groble.im/pay/old-month', 5000, 1, '', 99) RETURNING id`)).rows[0];
    eq('정기결제 옵션은 평생 이용권 판에서 404', (await edu(newIn, 'me.pass.checkout', { planId: sub.id })).status, 404);
    await pool.query('DELETE FROM billing_plans WHERE id = $1', [sub.id]);

    // ---------------- 단건 결제 → 평생 이용권
    eq('결제 소식 200', await hook(buy(ref, 'L-1')), 200);
    let row = await one(`SELECT kind, status, paid_until, next_billing_date, last_amount FROM subscriptions WHERE user_id = $1 AND provider = 'groble'`, [nu.id]);
    ok('**payment.completed → 평생 이용권(기한 없음 · 다음 결제일 없음)**', row && row.kind === 'lifetime' && row.status === 'active' && new Date(row.paid_until).getTime() === LIFETIME_UNTIL.getTime()
      && row.next_billing_date === null && row.last_amount === 99000, JSON.stringify(row));
    ok('이용권이 산다', await passActive(pool, nu.id));
    eq('**산 사람에게는 첫 화면 제안이 없다**', (await meOf(newIn)).offer, null);
    eq('운영자에게도 없다', (await meOf(rootIn)).offer, null);
    const p2 = (await edu(newIn, 'me.pass')).pass;
    ok('**내 이용권 — 평생 · 구독 취소 없음 · 환불 가능(구매 후 7일)**', p2.active && p2.lifetime && p2.nextBillingDate === '' && !p2.cancel.can && p2.refund && p2.refund.eligible, JSON.stringify(p2));
    eq('**[구독 취소]는 서지 않는다(끊을 정기결제가 없다)**', (await edu(newIn, 'me.pass.cancel', { reason: 'price' })).code, 'none');
    ok('결제 기록의 구매자 이름 · 전화는 걷는다', !JSON.stringify((await one(`SELECT raw FROM billing_events WHERE merchant_uid = 'L-1'`)).raw).includes('010-1111-2222'));

    // 겹친 결제 · 다른 금액 · 정기결제 소식
    const ref2 = new URL((await edu(newIn, 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
    await hook(buy(ref2, 'L-2', { at: ago(20) }));
    let e = await lastEvent();
    ok('**또 사면 반영하되 «확인 필요»(겹친 결제 — 하나는 환불)**', e.result === 'applied' && e.review && /이미 평생 이용권/.test(e.note), JSON.stringify(e));
    const ref3 = new URL((await edu(newIn, 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
    await hook(buy(ref3, 'L-3', { amount: 9900 }));
    e = await lastEvent();
    ok('**금액이 다르면 반영하지 않는다(확인 필요)**', e.result === 'amount_mismatch' && e.review);
    await hook(sample({ type: 'subscription_payment.completed', occurredAt: ago(10) }, { sellerReference: ref3, merchantUid: 'L-S', pricing: { finalAmount: 99000 } }));
    e = await lastEvent();
    ok('정기결제 소식은 평생 이용권 판에서 반영하지 않는다(맞는 정기결제 옵션이 없다)', e.result === 'amount_mismatch' && e.review);

    // ---------------- [환불 요청] — 구매 후 7일 안 · 이용권이 바로 멈춘다 · 할 일은 환불 하나
    mails.length = 0;
    const buyer = (await createUser(pool, { loginId: 'lf-buyer', password: 'long-enough-lf-buyer' })).user;
    const bIn = await login('lf-buyer');
    const bref = new URL((await edu(bIn, 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
    await hook(buy(bref, 'L-B1', { at: ago(60) }));
    const rq = await edu(bIn, 'me.pass.refund', { reason: 'quality' });
    ok('**환불 요청 → 이용권이 바로 멈춘다**', rq.status === 200 && !rq.pass.active && rq.pass.refund.reason === 'requested' && !(await passActive(pool, buyer.id)), JSON.stringify(rq));
    const req = await one('SELECT status, cancelled_at, refunded_at FROM refund_requests WHERE user_id = $1', [buyer.id]);
    ok('평생 이용권의 환불 건 — 끊을 정기결제가 없다(해지는 처음부터 된 것)', req.status === 'open' && !!req.cancelled_at && !req.refunded_at);
    const m1 = mails.find((m) => m.subject.includes('환불 요청'));
    ok('**운영자 메일 — «환불 요청(평생 이용권)» · 할 일은 환불 하나**', !!m1 && m1.subject.includes('평생 이용권') && m1.text.includes('끊을 정기결제는 없습니다') && !m1.text.includes('정기결제 해지'), m1 && m1.text);
    // 그로블에서 환불 → 환불 건이 끝나고 이용권은 끝난 그대로
    await hook(buy('', 'L-B1', { type: 'payment.refunded', at: ago(1) }));
    ok('**payment.refunded → 환불 건 끝 · 이용권 끝**', (await one('SELECT status FROM refund_requests WHERE user_id = $1', [buyer.id])).status === 'done'
      && (await one(`SELECT status FROM subscriptions WHERE user_id = $1 AND provider = 'groble'`, [buyer.id])).status === 'ended');

    // 그로블에서 먼저 한 환불(우리에게 낸 요청 없이) — 이용권을 거두고 알림만
    mails.length = 0;
    const g = (await createUser(pool, { loginId: 'lf-groble', password: 'long-enough-lf-groble' })).user;
    const gIn = await login('lf-groble');
    const gref = new URL((await edu(gIn, 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
    await hook(buy(gref, 'L-G1', { at: ago(90) }));
    ok('산 사람은 쓴다', await passActive(pool, g.id));
    await hook(buy('', 'L-G1', { type: 'payment.refunded', at: ago(5) }));
    ok('**그로블에서 환불하면 평생 이용권을 거둔다**', !(await passActive(pool, g.id)));
    const gr = await one('SELECT source, status FROM refund_requests WHERE user_id = $1', [g.id]);
    ok('그로블에서 먼저 한 환불 — 건을 남기고 곧바로 끝(할 일 없음)', gr && gr.source === 'groble' && gr.status === 'done');
    ok('**운영자 메일 — «그로블에서 환불됨(평생 이용권)» · 할 일 없음**', await mailed((m) => m.subject.includes('그로블에서 환불됨(평생 이용권)') && m.text.includes('할 일 없음')));

    // 도착 순서가 뒤바뀌어도 — 환불이 먼저 오면 늦은 결제는 이용권을 열지 않는다
    const late = (await createUser(pool, { loginId: 'lf-late', password: 'long-enough-lf-late' })).user;
    const lIn = await login('lf-late');
    const lref = new URL((await edu(lIn, 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
    await hook(buy(lref, 'L-L1', { type: 'payment.refunded', at: ago(2) }));
    await hook(buy(lref, 'L-L1', { at: ago(40) }));
    e = await lastEvent();
    ok('**환불이 먼저 오면 늦게 온 결제는 이용권을 열지 않는다**', !(await passActive(pool, late.id)) && e.review && /이미 환불된 결제/.test(e.note), JSON.stringify(e));

    // 구매자가 그로블에서 낸 취소(환불) 요청 — 판정과 함께 운영자에게(승인하면 이용권은 저절로 끝)
    mails.length = 0;
    await hook(buy('', 'L-2', { type: 'payment.cancel_requested', at: ago(1) }));
    e = await lastEvent();
    ok('**구매자의 취소 요청 — 구매일 기준 판정 · 확인 필요**', e.review && /구매 /.test(e.note), JSON.stringify(e));
    ok('운영자 메일 — 정기결제 해지 말이 없다', await mailed((m) => m.subject.includes('구매자가 그로블에서 취소') && m.text.includes('평생 이용권') && !m.text.includes('정기결제도 해지')), JSON.stringify(mails));

    // ---------------- 계정 지우기 — 구독 취소를 접수하지 않는다(다시 청구되지 않는다) · 이용권은 끝
    mails.length = 0;
    const delRes = await post('/api/auth/delete', newIn, { password: 'long-enough-lf-new' });
    ok('**평생 이용권 계정을 지우면 구독 취소 접수 없이 이용권만 끝**', delRes.status === 200
      && (await one('SELECT count(*)::int AS n FROM cancel_requests WHERE user_id = $1', [nu.id])).n === 0 && !(await passActive(pool, nu.id))
      && !mails.some((m) => m.subject.includes('구독 취소')), JSON.stringify(delRes));

    // ---------------- 운영 — 새 결제 옵션은 평생 이용권(주기 없음) · 이용 규칙은 이 판의 기본값
    const ps = await edu(rootIn, 'billing.plan.save', { name: '평생 이용권(새 값)', checkoutUrl: 'https://www.groble.im/pay/life-2', price: 129000 });
    ok('**운영 [결제 옵션] — 이 판에서 넣은 줄은 평생 이용권 · 주기 없음**', ps.status === 200 && ps.plans.some((p) => p.name === '평생 이용권(새 값)' && p.kind === 'lifetime' && p.cycleMonths === null));
    const ru = await edu(rootIn, 'billing.rules');
    ok('운영 [이용 규칙] — 이 판의 축과 기본 체험 3일', ru.rules.mode === 'lifetime' && ru.rules.trialDays === 3);
    const cu = await edu(rootIn, 'billing.customer', { userId: g.id });
    ok('운영 [고객] — 이용권 줄의 종류가 보인다', cu.customer.subscriptions.some((s) => s.lifetime) && cu.customer.refunds.every((r) => r.lifetime));
    const ev = await edu(rootIn, 'billing.events');
    ok('이번 달 반영된 결제에 단건 결제도 센다', ev.month.count >= 1);

    // ---------------- 메일 글(순수) — 정기결제 판은 그대로
    ok('정기결제 판의 환불 메일은 그대로(해지 둘째 일)', refundMail({ user: { loginId: 'a' }, at: new Date(), start: new Date(), until: '2026-10-20', inPolicy: true, payment: {}, aiRuns: 0 }).text.includes('2. 이 정기결제 해지'));
    ok('정기결제 판의 그로블 환불 메일도 그대로', grobleRefundMail({ user: { loginId: 'a' }, at: new Date(), payment: {}, cancelled: false }).subject.includes('정기결제 해지가 아직'));
  } finally {
    await new Promise((r) => srv.close(r));
    await pool.query(`UPDATE billing_plans SET enabled = false WHERE kind = 'lifetime'`);
    if (savedRules) await pool.query(`UPDATE app_settings SET value = $1 WHERE key = 'billing.rules'`, [savedRules.value]);
    else await pool.query(`DELETE FROM app_settings WHERE key = 'billing.rules'`);
    void root;
  }
}
