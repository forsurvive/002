// 이용권 · 그로블 정기결제 시험 — 어댑터(서명 · 본문 · 결제창 링크)와 표. online/test.mjs 가 이어 부른다.

import * as groble from './billing/groble.mjs';
import { createBilling, passActive, summarize, dayEndPlus, kstDay } from './billing/service.mjs';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';

const SECRET = 'test-groble-secret-' + 'x'.repeat(8);
// 가이드의 꼴을 따른 본문(값은 지어낸 것)
export const sample = (over = {}, obj = {}) => ({
  id: 'evt_' + Math.random().toString(36).slice(2), type: 'subscription_payment.completed', version: '2026-04-30', occurredAt: '2026-10-09T10:00:00+09:00',
  data: { object: {
    merchantUid: 'M-1001', sellerReference: 'ref-abc_DEF.1', buyer: { displayName: '홍길동', email: 'Buyer@Example.com', phoneNumber: '010-1234-5678' },
    content: { id: 'C-77', paymentType: 'SUBSCRIPTION' }, pricing: { finalAmount: 5000 },
    subscription: { billingReason: 'INITIAL', currentRound: 1, nextBillingDate: '2026-11-09', status: 'ACTIVE', billingCycleMonths: 1 },
    questionAnswers: [], ...obj } },
  ...over,
});
export const signed = (secret, raw, { ts = Math.floor(Date.now() / 1000), key = 'idem-' + Math.random().toString(36).slice(2), previous = '' } = {}) => ({
  'content-type': 'application/json', 'user-agent': 'Groble-Webhook', 'x-groble-timestamp': String(ts), 'x-groble-signature': groble.sign(secret, ts, raw),
  'x-groble-idempotency-key': key, ...(previous ? { 'x-groble-signature-previous': groble.sign(previous, ts, raw) } : {}),
});

export async function run({ pool, ok, eq }) {
  // ---------------- 서명
  {
    const raw = JSON.stringify(sample());
    const h = signed(SECRET, raw);
    eq('서명 — 시크릿이 없으면 no_secret(받는 문은 503)', groble.verify({ rawBody: raw, headers: h, secrets: [] }).reason, 'no_secret');
    ok('**서명 — 맞는 시크릿 · 원본 본문이면 통과**', groble.verify({ rawBody: Buffer.from(raw), headers: h, secrets: [SECRET] }).ok);
    eq('**본문이 한 글자라도 바뀌면 bad_signature**', groble.verify({ rawBody: raw.replace('5000', '5001'), headers: h, secrets: [SECRET] }).reason, 'bad_signature');
    eq('다른 시크릿이면 bad_signature', groble.verify({ rawBody: raw, headers: h, secrets: ['other-secret'] }).reason, 'bad_signature');
    eq('머리글이 없으면 missing', groble.verify({ rawBody: raw, headers: { 'content-type': 'application/json' }, secrets: [SECRET] }).reason, 'missing');
    const old = Math.floor(Date.now() / 1000) - 6 * 60;
    eq('**timestamp 가 5분 넘게 어긋나면 stale**', groble.verify({ rawBody: raw, headers: signed(SECRET, raw, { ts: old }), secrets: [SECRET] }).reason, 'stale');
    ok('4분 어긋남은 받는다', groble.verify({ rawBody: raw, headers: signed(SECRET, raw, { ts: Math.floor(Date.now() / 1000) - 240 }), secrets: [SECRET] }).ok);
    ok('timestamp 가 밀리초로 와도 받는다', groble.verify({ rawBody: raw, headers: signed(SECRET, raw, { ts: Date.now() }), secrets: [SECRET] }).ok);
    const loud = { ...h, 'x-groble-signature': 'sha256=' + h['x-groble-signature'].toUpperCase() };
    ok('서명 앞의 sha256= · 대문자 hex 도 받는다', groble.verify({ rawBody: raw, headers: loud, secrets: [SECRET] }).ok);
    // 시크릿 교체 — 그로블이 새 시크릿으로 바꾼 뒤 24시간은 옛 시크릿 서명(Previous)도 함께 온다
    const rotated = signed('new-secret-after-rotation', raw, { previous: SECRET });
    ok('**교체 중 — 서버가 아직 옛 시크릿이어도 Previous 서명으로 통과**', groble.verify({ rawBody: raw, headers: rotated, secrets: [SECRET] }).ok);
    ok('교체 뒤 — 서버에 새 시크릿 · 옛 시크릿(GROBLE_WEBHOOK_SECRET_PREVIOUS)을 두면 어느 쪽이든', groble.verify({ rawBody: raw, headers: signed(SECRET, raw), secrets: ['new-secret-after-rotation', SECRET] }).ok);
  }

  // ---------------- 본문 읽기
  {
    const ev = groble.parse(JSON.stringify(sample()));
    ok('본문 → 정규화한 사건(최초 결제)', ev.ok && ev.kind === 'paid' && ev.billingReason === 'INITIAL' && ev.amount === 5000 && ev.contentId === 'C-77' && ev.paymentType === 'SUBSCRIPTION'
      && ev.ref === 'ref-abc_DEF.1' && ev.merchantUid === 'M-1001' && ev.nextBillingDate === '2026-11-09' && ev.buyer.email === 'Buyer@Example.com' && ev.occurredAt instanceof Date);
    eq('참조값 규칙 밖(공백 · @)은 빈 값으로', groble.parse(JSON.stringify(sample({}, { sellerReference: 'a b@c' }))).ref, '');
    eq('다음 결제일에 시각이 붙어 오면 한국 날짜로', groble.parse(JSON.stringify(sample({}, { subscription: { nextBillingDate: '2026-11-08T16:30:00Z' } }))).nextBillingDate, '2026-11-09');
    eq('모르는 종류는 unknown', groble.parse(JSON.stringify(sample({ type: 'subscription.paused' }))).kind, 'unknown');
    eq('해지 완료 — terminatedAt', groble.parse(JSON.stringify(sample({ type: 'subscription.terminated' }, { termination: { terminatedAt: '2026-12-01T00:00:00+09:00' } }))).terminatedAt.toISOString(), '2026-11-30T15:00:00.000Z');
    const f = groble.parse(JSON.stringify(sample({ type: 'subscription_payment.failed' }, { failure: { isFinal: true, attempt: 3 } })));
    ok('갱신 실패 — isFinal 은 어디에 있든 찾는다', f.kind === 'failed' && f.isFinal === true);
    eq('JSON 이 아니면 읽지 못함', groble.parse('not json').ok, false);
    eq('배열이면 읽지 못함', groble.parse('[1,2]').ok, false);
    ok('금액이 글자로 와도 숫자로', groble.parse(JSON.stringify(sample({}, { pricing: { finalAmount: '5000' } }))).amount === 5000);
    eq('Idempotency-Key 머리글이 먼저', groble.idempotencyKey({ 'x-groble-idempotency-key': 'k-1' }, ev), 'k-1');
    eq('머리글이 없으면 사건 id 로', groble.idempotencyKey({}, ev), 'event:' + ev.id);
  }

  // ---------------- 결제창 링크 · 참조값
  {
    const r1 = groble.newRef(); const r2 = groble.newRef();
    ok('참조값 — 규칙 안의 무작위 값(매번 다르다)', groble.REF_RE.test(r1) && r1.length >= 20 && r1 !== r2);
    eq('결제창 링크 + ?ref=', groble.checkoutUrl('https://www.groble.im/pay/abc', 'R-1'), 'https://www.groble.im/pay/abc?ref=R-1');
    eq('이미 있는 쿼리는 두고 ref 만 바꾼다', groble.checkoutUrl('https://www.groble.im/pay/abc?x=1&ref=old', 'R-2'), 'https://www.groble.im/pay/abc?x=1&ref=R-2');
    eq('https 가 아니면 링크를 짓지 않는다', groble.checkoutUrl('http://www.groble.im/pay/abc', 'R-1'), '');
    eq('참조값이 규칙 밖이면 짓지 않는다', groble.checkoutUrl('https://www.groble.im/pay/abc', 'a b'), '');
  }

  // ---------------- 표
  {
    const t = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
      AND table_name IN ('billing_refs', 'billing_plans', 'subscriptions', 'billing_events', 'billing_customers', 'app_settings')`)).rows.map((r) => r.table_name).sort();
    eq('이용권 표 여섯', t.join(','), 'app_settings,billing_customers,billing_events,billing_plans,billing_refs,subscriptions');
    await pool.query("INSERT INTO billing_events (idem_key, type) VALUES (NULL, 'a'), (NULL, 'b'), ('same-key', 'c')");
    let dup = '';
    try { await pool.query("INSERT INTO billing_events (idem_key, type) VALUES ('same-key', 'd')"); } catch (e) { dup = e.code; }
    eq('**같은 Idempotency-Key 는 한 줄뿐(DB 가 막는다)**', dup, '23505');
    await pool.query("DELETE FROM billing_events WHERE type IN ('a', 'b', 'c')");
  }

  // ---------------- 사람 하나의 이용권(순수) — 대표 상태 · 기한
  {
    const fut = new Date(Date.now() + 5 * 86400000); const past = new Date(Date.now() - 86400000);
    eq('줄이 없으면 none', summarize([]).status, 'none');
    ok('기한이 지난 줄뿐이면 ended(쓸 수 없음)', summarize([{ provider: 'groble', status: 'active', paid_until: past }]).status === 'ended' && !summarize([{ provider: 'groble', status: 'active', paid_until: past }]).active);
    const two = summarize([{ provider: 'groble', status: 'past_due', paid_until: fut }, { provider: 'groble', status: 'active', paid_until: new Date(Date.now() + 2 * 86400000) }]);
    ok('살아 있는 줄 가운데 «이용 중»이 대표 · 결제 실패는 경고로', two.status === 'active' && two.active && two.warn);
    ok('운영자 · 무료 이용은 줄이 없어도 쓸 수 있다', summarize([], { operator: true }).active && summarize([], { free: true }).active);
    eq('그날 끝(한국) + 여유 10일', dayEndPlus('2026-11-09', 10).toISOString(), '2026-11-19T15:00:00.000Z');
  }

  // ---------------- 받는 문 · 반영 · 이용권 검사(자유 가입판)
  resetThrottle();
  const mk = async (id, admin = false) => (await createUser(pool, { loginId: id, password: 'long-enough-' + id, isPlatformAdmin: admin })).user;
  const buyer = await mk('bl-buyer'); const other = await mk('bl-other'); await mk('bl-root', true);
  const plan = (await pool.query(`INSERT INTO billing_plans (name, checkout_url, price, cycle_months, product_id, sort_order)
    VALUES ('월 이용권', 'https://www.groble.im/pay/se-month', 5000, 1, 'C-77', 1) RETURNING id`)).rows[0];
  const logs = [];
  const billing = createBilling({ pool, secrets: () => [SECRET], log: (m) => logs.push(m) });
  const srv = createOnlineServer({ pool, plan: onlinePlan({ SE_EDITION: 'open' }), billing });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const jar = {};
  for (const id of ['bl-buyer', 'bl-other', 'bl-root']) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: 'long-enough-' + id }) });
    jar[id] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
  const edu = async (who, op, b = {}) => {
    const r = await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar[who] }, body: JSON.stringify({ op, ...b }) });
    return { status: r.status, ...(await r.json()) };
  };
  const api = async (who, op, b = {}) => {
    const r = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar[who] }, body: JSON.stringify({ op, ...b }) });
    return { status: r.status, ...(await r.json()) };
  };
  // 그로블처럼 보낸다 — Origin · 쿠키 없이, 서명한 원본 본문으로
  const hook = async (bodyObj, opts = {}) => {
    const raw = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
    const headers = opts.headers || signed(opts.secret || SECRET, raw, opts);
    const r = await fetch(base + '/api/billing/groble', { method: opts.method || 'POST', headers, body: opts.method === 'GET' ? undefined : raw });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const t0 = Date.now() - 3 * 3600000;   // 사건의 때는 모두 지난 일로(3시간 전부터 분 단위로) — 해지 시각이 미래가 되지 않게
  const at = (min) => new Date(t0 + min * 60000).toISOString();
  const day = (d) => kstDay(t0 + d * 86400000);
  const ev = (type, ref, minute, obj = {}) => sample({ type, occurredAt: at(minute) }, { sellerReference: ref, ...obj });
  const subOf = async (ref) => (await pool.query(`SELECT status, paid_until, next_billing_date::text AS nbd, service_ends_at, final_failure FROM subscriptions WHERE ref = $1`, [ref])).rows[0];
  const lastEvent = async () => (await pool.query('SELECT result, review, user_id, note FROM billing_events ORDER BY id DESC LIMIT 1')).rows[0];
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM billing_events')).rows[0].n;

  try {
    // ---------------- 문지기 — 서명이 문을 지킨다. 410 은 돌려주지 않는다.
    const codes = new Set();
    const n0 = await count();
    const bad = await hook(sample(), { secret: 'wrong-secret' });
    codes.add(bad.status);
    ok('**서명이 틀리면 401 · 남기지 않는다**', bad.status === 401 && (await count()) === n0);
    const stale = await hook(sample(), { ts: Math.floor(t0 / 1000) - 600 });
    codes.add(stale.status);
    eq('**timestamp 가 5분 밖이면 401**', stale.status, 401);
    eq('GET 은 405', (await hook(sample(), { method: 'GET' })).status, 405);
    {
      // 시크릿이 서버에 없으면 503 — 그로블이 다시 보낸다(운영 화면에 «웹훅 시크릿 없음»)
      const noSecret = createOnlineServer({ pool, plan: onlinePlan({ SE_EDITION: 'open' }), billing: createBilling({ pool, secrets: () => ['', undefined] }) });
      await new Promise((r) => noSecret.listen(0, '127.0.0.1', r));
      const raw = JSON.stringify(sample());
      const r = await fetch('http://127.0.0.1:' + noSecret.address().port + '/api/billing/groble', { method: 'POST', headers: signed(SECRET, raw), body: raw });
      codes.add(r.status);
      eq('**시크릿이 서버에 없으면 503(다시 보내 달라)**', r.status, 503);
      await new Promise((r2) => noSecret.close(r2));
      // DB 가 안 되면 503 — 그로블이 최대 약 44시간 다시 보낸다
      const down = createBilling({ pool: { connect: async () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); } }, secrets: () => [SECRET] });
      const d = await down.receive({ rawBody: Buffer.from(raw), headers: signed(SECRET, raw) });
      codes.add(d.status);
      eq('**DB 가 잠깐 안 되면 503**', d.status, 503);
      // 교육기관판에는 이 길이 없다
      const school = createOnlineServer({ pool, plan: onlinePlan({}) });
      await new Promise((r) => school.listen(0, '127.0.0.1', r));
      const sr = await fetch('http://127.0.0.1:' + school.address().port + '/api/billing/groble', { method: 'POST', headers: signed(SECRET, raw), body: raw });
      ok('교육기관판에는 받는 문이 없다(로그인 문으로 떨어진다)', sr.status === 401 && (await sr.json()).code === 'login');
      await new Promise((r2) => school.close(r2));
    }

    // ---------------- 이용권 없음 → 새 AI 작업이 서지 않는다(편집은 된다)
    const before = await edu('bl-buyer', 'me.pass');
    ok('처음 — 이용권 없음 · 결제 옵션(이름만, 금액 없음)', before.ok && before.pass.active === false && before.pass.status === 'none'
      && before.pass.plans.length === 1 && before.pass.plans[0].name === '월 이용권' && !JSON.stringify(before.pass).includes('5000'));
    const made = await api('bl-buyer', 'project.create', { name: '이용권 시험', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] });
    ok('이용권이 없어도 작품은 만든다(편집 · 열람 · 내보내기는 늘 된다)', made.ok && !!made.pid);
    const pid = made.pid;
    eq('만들 때의 «자료 분석»은 서지 않는다(이용권 없음)', (await pool.query('SELECT count(*)::int AS n FROM jobs WHERE project_id = $1', [pid])).rows[0].n, 0);
    const doc = (await api('bl-buyer', 'doc.create', { pid, title: '1장', body: '첫 글' })).id;
    ok('문서는 고친다', (await api('bl-buyer', 'doc.write', { pid, id: doc, body: '고친 글' })).ok);
    const blocked = await api('bl-buyer', 'doc.update', { pid, id: doc });
    ok('**이용권이 없으면 새 AI 작업은 subscription_inactive**', blocked.ok === false && blocked.code === 'subscription_inactive' && /이용권/.test(blocked.error), JSON.stringify(blocked));
    ok('첫 화면은 «이용권 없음»을 안다', (await (await fetch(base + '/api/me', { headers: { cookie: jar['bl-buyer'] } })).json()).me.pass === false);

    // ---------------- [결제하기] — 누를 때마다 새 참조값
    const co1 = await edu('bl-buyer', 'me.pass.checkout', { planId: plan.id });
    const ref1 = co1.ok ? new URL(co1.url).searchParams.get('ref') : '';
    ok('**[결제하기] — 결제창 링크 + ?ref=<무작위 참조값>**', co1.ok && co1.url.startsWith('https://www.groble.im/pay/se-month?ref=') && groble.REF_RE.test(ref1));
    ok('참조값은 그 사람에게 묶인다', (await pool.query(`SELECT user_id FROM billing_refs WHERE kind = 'link' AND ref = $1`, [ref1])).rows[0].user_id === buyer.id);
    const co2 = await edu('bl-buyer', 'me.pass.checkout', { planId: plan.id });
    ok('다시 누르면 다른 참조값(정기결제 하나 = 참조값 하나)', co2.ok && new URL(co2.url).searchParams.get('ref') !== ref1);
    eq('없는 결제 옵션은 404', (await edu('bl-buyer', 'me.pass.checkout', { planId: '00000000-0000-0000-0000-000000000000' })).status, 404);

    // ---------------- 최초 결제 → 이용 중(다음 결제일 그날 끝 + 여유 10일)
    const nbd1 = day(30);
    const first = ev('subscription_payment.completed', ref1, -10, { subscription: { billingReason: 'INITIAL', currentRound: 1, nextBillingDate: nbd1 }, merchantUid: 'M-1' });
    const firstHeaders = signed(SECRET, JSON.stringify(first), { key: 'idem-first' });
    const r1 = await hook(JSON.stringify(first), { headers: firstHeaders });
    codes.add(r1.status);
    let sub = await subOf(ref1);
    ok('**최초 결제 → 200 · active**', r1.status === 200 && sub && sub.status === 'active' && sub.nbd === nbd1, JSON.stringify(sub));
    eq('**이용 기한 = 다음 결제일 그날 끝 + 여유 10일**', new Date(sub.paid_until).toISOString(), dayEndPlus(nbd1, 10).toISOString());
    const pass1 = (await edu('bl-buyer', 'me.pass')).pass;
    ok('내 이용권 — 이용 중 · 다음 결제일', pass1.active && pass1.status === 'active' && pass1.nextBillingDate === nbd1);
    ok('**이제 새 AI 작업이 선다**', (await api('bl-buyer', 'doc.update', { pid, id: doc })).ok);
    ok('받은 웹훅이 남는다(원문 · 연결된 사람)', (await pool.query(`SELECT user_id, result, raw FROM billing_events WHERE idem_key = 'idem-first'`)).rows.some((x) => x.user_id === buyer.id && x.result === 'applied' && x.raw.data.object.buyer.email === 'Buyer@Example.com'));
    const n1 = await count();
    const again = await hook(JSON.stringify(first), { headers: firstHeaders });
    ok('**같은 Idempotency-Key 는 두 번 처리하지 않는다(그대로 200)**', again.status === 200 && again.duplicate === true && (await count()) === n1);
    ok('응답에 개인정보를 싣지 않는다', !JSON.stringify(r1).includes('Example.com') && !JSON.stringify(again).includes('010-'));

    // ---------------- 도착 순서가 뒤바뀌어도 — 갱신(나중 일)이 먼저 오고 실패(이른 일)가 뒤에 오면 실패는 기록만
    const nbd2 = day(60);
    await hook(ev('subscription_payment.completed', ref1, 20, { subscription: { billingReason: 'RENEWAL', currentRound: 2, nextBillingDate: nbd2 }, merchantUid: 'M-2' }));
    await hook(ev('subscription_payment.failed', ref1, 5, { subscription: { billingReason: 'RENEWAL', nextBillingDate: nbd1 } }));
    sub = await subOf(ref1);
    ok('**늦게 온 이른 소식(실패)은 기록만 — 상태는 갱신 그대로**', sub.status === 'active' && sub.nbd === nbd2 && (await lastEvent()).result === 'stale');
    eq('갱신이 기한을 민다', new Date(sub.paid_until).toISOString(), dayEndPlus(nbd2, 10).toISOString());

    // ---------------- 갱신 실패 → past_due(이용은 그대로) → 해지 예고 → cancel_pending(막지 않는다) → 해지 완료 → ended(막는다)
    await hook(ev('subscription_payment.failed', ref1, 30, { failure: { isFinal: true } }));
    sub = await subOf(ref1);
    ok('**결제 실패 → past_due · 이용은 그대로**', sub.status === 'past_due' && sub.final_failure === true && (await passActive(pool, buyer.id)));
    const pd = (await edu('bl-buyer', 'me.pass')).pass;
    ok('내 화면 — 결제 실패 · 마지막 재시도', pd.status === 'past_due' && pd.finalFailure === true && pd.active);
    await hook(ev('subscription.cancel_requested', ref1, 40, { serviceEndsAt: at(60 * 24 * 7) }));
    sub = await subOf(ref1);
    ok('**해지 예고 → cancel_pending — 이 사건으로는 막지 않는다**', sub.status === 'cancel_pending' && !!sub.service_ends_at && (await passActive(pool, buyer.id)));
    const doc2 = (await api('bl-buyer', 'doc.create', { pid, title: '2장', body: '' })).id;
    ok('**해지 예고 중에도 새 AI 작업은 된다**', (await api('bl-buyer', 'doc.update', { pid, id: doc2 })).ok);
    await hook(ev('subscription.terminated', ref1, 50, { termination: { terminatedAt: at(50) } }));
    sub = await subOf(ref1);
    ok('**해지 완료 → ended · paid_until = terminatedAt — 막는다**', sub.status === 'ended' && new Date(sub.paid_until).toISOString() === at(50) && !(await passActive(pool, buyer.id)));
    await hook(ev('subscription_payment.completed', ref1, 45, { subscription: { billingReason: 'RENEWAL', nextBillingDate: day(90) } }));
    ok('**해지 뒤에 늦게 온 (더 이른) 갱신은 되살리지 않는다**', (await subOf(ref1)).status === 'ended' && !(await passActive(pool, buyer.id)) && (await lastEvent()).result === 'stale');
    const doc3 = (await api('bl-buyer', 'doc.create', { pid, title: '3장', body: '' })).id;
    eq('**끝난 뒤의 새 AI 작업은 다시 subscription_inactive**', (await api('bl-buyer', 'doc.update', { pid, id: doc3 })).code, 'subscription_inactive');

    // ---------------- 해지 뒤 다시 결제 — 새 참조값의 새 정기결제. 옛 정기결제의 소식은 새것을 건드리지 않는다.
    const ref2 = new URL((await edu('bl-buyer', 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
    await hook(ev('subscription_payment.completed', ref2, 60, { subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'M-3' }));
    ok('**다시 결제하면 다시 active**', (await subOf(ref2)).status === 'active' && (await passActive(pool, buyer.id)));
    await hook(ev('subscription.terminated', ref1, 70, { termination: { terminatedAt: at(70) } }));
    ok('**옛 정기결제(다른 참조값)의 해지 소식은 새 정기결제를 끝내지 않는다**', (await subOf(ref2)).status === 'active' && (await passActive(pool, buyer.id)));
    // 같은 사람이 또 결제하면(겹친 결제) — 반영하되 운영자에게 «확인 필요»
    const ref3 = new URL((await edu('bl-buyer', 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
    await hook(ev('subscription_payment.completed', ref3, 80, { subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'M-4' }));
    const dupEv = await lastEvent();
    ok('겹친 정기결제 — 반영하고 «확인 필요»', dupEv.result === 'applied' && dupEv.review === true && /겹친/.test(dupEv.note));

    // ---------------- 누구의 결제인가 — 모르는 참조값 · 이메일 · 결제 건 번호
    await hook(ev('subscription_payment.completed', 'unknown-ref-1', 90, { buyer: { email: 'nobody@example.com' } }));
    const un = await lastEvent();
    ok('**모르는 참조값 · 맞는 이메일 없음 → 200 · «연결 안 된 결제»(확인 필요)**', un.result === 'unlinked' && un.review === true && !un.user_id);
    await pool.query("UPDATE users SET email = 'other@example.com' WHERE id = $1", [other.id]);
    await hook(ev('subscription_payment.completed', '', 100, { buyer: { email: ' Other@Example.com ' }, subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'M-9' }));
    const byMail = await lastEvent();
    ok('**참조값이 없으면 가입 이메일이 같은 사람에게**', byMail.result === 'applied' && byMail.user_id === other.id && (await passActive(pool, other.id)));
    await hook(ev('subscription_payment.refunded', '', 110, { merchantUid: 'M-9', buyer: {} }));
    const refund = await lastEvent();
    ok('**회차 환불(참조값 없음)은 결제 건 번호로 잇고 기록만 · 확인 필요(이용권은 그대로)**', refund.user_id === other.id && refund.result === 'recorded' && refund.review && (await passActive(pool, other.id)));

    // ---------------- 맞는 결제인가 — 금액 · 상품
    await hook(ev('subscription_payment.completed', ref2, 120, { pricing: { finalAmount: 4000 }, subscription: { billingReason: 'RENEWAL', nextBillingDate: day(400) } }));
    const mis = await lastEvent();
    ok('**금액이 다르면 반영하지 않고 운영자에게**', mis.result === 'amount_mismatch' && mis.review && (await subOf(ref2)).nbd === day(31));
    await hook(ev('subscription_payment.completed', ref2, 125, { content: { id: 'C-OTHER', paymentType: 'SUBSCRIPTION' }, subscription: { billingReason: 'RENEWAL', nextBillingDate: day(400) } }));
    eq('상품 번호가 다른 결제도 반영하지 않는다', (await lastEvent()).result, 'amount_mismatch');

    // ---------------- 읽지 못한 꼴 · 모르는 종류 · 단건 결제 — 그래도 200
    const junk = await hook('this is not json');
    codes.add(junk.status);
    ok('**읽지 못한 꼴도 200 으로 받고 «확인 필요»**', junk.status === 200 && (await lastEvent()).result === 'unreadable' && (await lastEvent()).review);
    await hook(sample({ type: 'subscription.paused' }));
    eq('모르는 종류도 200 · 확인 필요', (await lastEvent()).result, 'unreadable');
    await hook(sample({ type: 'payment.completed' }, { content: { id: 'BOOK-1', paymentType: 'ONE_TIME' }, sellerReference: '' }));
    const once = await lastEvent();
    ok('다른 상품의 단건 결제는 기록만(확인 필요 아님)', once.result === 'recorded' && !once.review);

    // ---------------- 무료 체험(이용 규칙) — 가입 직후
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('billing.rules', '{"trialDays": 3, "graceDays": 10}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const su = await fetch(base + '/api/auth/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'bl-trial', password: 'long-enough-trial' }) });
    const trialUser = (await pool.query("SELECT id FROM users WHERE login_id = 'bl-trial'")).rows[0];
    const trial = (await pool.query(`SELECT status, paid_until FROM subscriptions WHERE user_id = $1 AND provider = 'trial'`, [trialUser.id])).rows[0];
    ok('**가입 직후 무료 체험 일수만큼 이용권**', su.status === 200 && trial && trial.status === 'active' && Math.abs(new Date(trial.paid_until) - (Date.now() + 3 * 86400000)) < 60000 && (await passActive(pool, trialUser.id)));
    await pool.query(`DELETE FROM app_settings WHERE key = 'billing.rules'`);

    // ---------------- 운영자 · 무료 이용
    ok('운영자는 이용권 없이 쓴다', await passActive(pool, (await pool.query("SELECT id FROM users WHERE login_id = 'bl-root'")).rows[0].id));
    const free = await mk('bl-free');
    await pool.query('INSERT INTO billing_customers (user_id, free) VALUES ($1, true)', [free.id]);
    ok('무료 이용 계정은 결제 없이 쓴다', await passActive(pool, free.id));

    // ---------------- 지킨 것 — 410 을 돌려준 적이 없다 · 로그에 개인정보 없음
    ok('**받는 문은 410 을 돌려주지 않는다**', ![...codes].includes(410) && [...codes].every((c) => [200, 401, 429, 503].includes(c)), [...codes].join(','));
    ok('로그에 개인정보 · 시크릿이 없다(ASCII)', logs.every((m) => /^[\x20-\x7e]*$/.test(m) && !m.includes(SECRET) && !/example\.com|010-/.test(m)), logs.join(' | '));
    // 고삐 — 같은 곳에서 서명이 거듭 틀리면 429(그로블의 정상 요청은 서명이 맞으므로 걸리지 않는다)
    const st = [];
    for (let i = 0; i < 31; i++) st.push((await hook(sample(), { secret: 'wrong-secret' })).status);
    ok('같은 곳에서 서명이 거듭 틀리면 429', st.slice(0, 28).every((x) => x === 401) && st[30] === 429, st.join(','));
  } finally {
    await new Promise((r) => srv.close(r));
  }
}
