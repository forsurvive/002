// 이용권 · 그로블 정기결제 시험 — 어댑터(서명 · 본문 · 결제창 링크)와 표. online/test.mjs 가 이어 부른다.

import * as groble from './billing/groble.mjs';
import { createBilling, passActive, summarize, dayEndPlus, kstDay, judgeRefund, refundCheck, cancelCheck, DEFAULT_RULES } from './billing/service.mjs';
import { readReason, refundMail, cancelMail, CANCEL_REASONS } from './billing/notice.mjs';
import { sendMail, mailConfig, transient } from './mail.mjs';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { maskName, maskPhone, maskEmail } from './billing/admin.mjs';

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

  // ---------------- 알림 메일 · 이유(순수) — online/mail.mjs · billing/notice.mjs
  {
    eq('이유를 고르지 않으면 받지 않는다', readReason({}).ok, false);
    eq('목록에 없는 이유는 받지 않는다', readReason({ reason: 'x' }).ok, false);
    eq('«기타»는 적은 말이 있어야 한다', readReason({ reason: 'other', detail: ' \n ' }).ok, false);
    const rr = readReason({ reason: 'other', detail: '  너무\u0000 비싸요 ' + '가'.repeat(600) });
    ok('적은 말은 제어 글자를 걷고 500자까지', rr.ok && rr.detail.startsWith('너무 비싸요') && rr.detail.length === 500 && !rr.detail.includes('\u0000'));
    ok('이유 목록 — 코드와 말(«기타»가 끝)', CANCEL_REASONS.length >= 5 && CANCEL_REASONS.at(-1).code === 'other' && CANCEL_REASONS.every((r) => r.code && r.say));
    const m1 = refundMail({ user: { loginId: 'kim', name: '김' }, at: '2026-10-10T01:00:00Z', start: '2026-10-08T01:00:00Z', until: '2026-10-15', inPolicy: true,
      payment: { merchantUid: 'M-9', amount: 5000, paidAt: '2026-10-08T01:00:00Z' }, aiRuns: 2, reason: 'price', detail: '', site: 'https://x.example' });
    ok('환불 메일 — 제목 · 기한 · 결제 건 번호 · 금액 · AI 작업 · 할 일 둘', /환불 요청 — kim/.test(m1.subject) && m1.text.includes('김(kim)') && m1.text.includes('2026-10-15까지 → 기한 안')
      && m1.text.includes('결제 건 번호 M-9 · 5,000원') && m1.text.includes('AI 작업: 2회') && m1.text.includes('1. 위 결제 환불') && m1.text.includes('2. 이 정기결제 해지') && m1.text.includes('https://x.example/manage.html'), m1.text);
    const m2 = cancelMail({ user: { loginId: 'lee', name: 'lee' }, at: '2026-10-10T01:00:00Z', nextBilling: '2026-11-08', reason: 'switch', detail: '다른 곳' });
    ok('취소 메일 — 다음 결제일 전에 해지 · 이유', /구독 취소 — lee/.test(m2.subject) && m2.text.startsWith('lee 님이') && m2.text.includes('다음 결제일: 2026-11-08') && m2.text.includes('다른 서비스를 쓰기로 했어요 — 다른 곳'), m2.text);

    eq('Resend 키가 없으면 메일은 꺼짐', mailConfig({}), null);
    const mc = mailConfig({ RESEND_API_KEY: ' re_test_key ' });
    ok('키가 있으면 켬 — 보내는 주소는 Resend 의 시험 주소가 기본', mc && mc.key === 're_test_key' && /onboarding@resend\.dev/.test(mc.from));
    const seen = [];
    const fakeFetch = (status, body) => async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(body), { status }); };
    const s1 = await sendMail(mc, { to: 'ops@example.com', subject: '제목', text: '본문' }, { fetchImpl: fakeFetch(200, { id: 'email_1' }) });
    const sent = JSON.parse(seen[0].init.body);
    ok('**보내기 — Resend 주소 · Bearer 키 · User-Agent · 받는 이 하나 · 글 본문**', s1.ok && s1.id === 'email_1' && seen[0].url === 'https://api.resend.com/emails'
      && seen[0].init.headers.authorization === 'Bearer re_test_key' && !!seen[0].init.headers['user-agent'] && sent.to.join() === 'ops@example.com' && sent.subject === '제목' && sent.text === '본문');
    const s2 = await sendMail(mc, { to: 'ops@example.com', subject: 's', text: 't' }, { fetchImpl: fakeFetch(403, { message: 'You can only send testing emails to your own email address ops@example.com' }) });
    ok('**거절이면 상태 번호만(Resend 의 설명 · 주소는 돌려주지 않는다)**', !s2.ok && s2.reason === 'http_403' && !JSON.stringify(s2).includes('ops@example.com'));
    eq('받는 주소가 없으면 보내지 않는다', (await sendMail(mc, { to: '', subject: 's', text: 't' }, { fetchImpl: fakeFetch(200, { id: 'x' }) })).reason, 'no_to');
    eq('키가 없으면 «꺼짐»', (await sendMail(null, { to: 'a@b.c', subject: 's', text: 't' })).reason, 'off');
    eq('닿지 않으면 «network»', (await sendMail(mc, { to: 'a@b.c', subject: 's', text: 't' }, { fetchImpl: async () => { throw new Error('ECONNRESET re_test_key'); } })).reason, 'network');
    ok('잠깐의 실패만 한 번 더(닿지 않음 · 시간 초과 · 429 · 5xx)', transient('network') && transient('timeout') && transient('http_429') && transient('http_503') && !transient('http_403') && !transient('no_to') && !transient('off'));
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
    ok('가리기 — 이름 · 전화 · 이메일', maskName('홍길동') === '홍*동' && maskName('김수') === '김*' && maskPhone('010-1234-5678') === '***-****-5678' && maskEmail('Buyer@Example.com') === 'Bu***@Example.com' && maskEmail('') === '');
  }

  // ---------------- 받는 문 · 반영 · 이용권 검사(자유 가입판)
  resetThrottle();
  const mk = async (id, admin = false) => (await createUser(pool, { loginId: id, password: 'long-enough-' + id, isPlatformAdmin: admin })).user;
  const buyer = await mk('bl-buyer'); const other = await mk('bl-other'); await mk('bl-root', true);
  const plan = (await pool.query(`INSERT INTO billing_plans (name, checkout_url, price, cycle_months, product_id, sort_order)
    VALUES ('월 이용권', 'https://www.groble.im/pay/se-month', 5000, 1, 'C-77', 1) RETURNING id`)).rows[0];
  const logs = [];
  // 가짜 우편함 — 보낸 것을 모으고, mailMode 가 'ok' 가 아니면 그 까닭으로 실패한다(진짜와 같이 받는 주소가 없으면 no_to)
  const mails = [];
  let mailMode = 'ok';
  const mailer = { on: () => true, send: async (m) => { if (!m.to) return { ok: false, reason: 'no_to' }; mails.push(m); return mailMode === 'ok' ? { ok: true, id: 'm-' + mails.length } : { ok: false, reason: mailMode }; } };
  const billing = createBilling({ pool, secrets: () => [SECRET], log: (m) => logs.push(m), mailer, retryMs: 0, siteUrl: 'https://open.example' });
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
    // 이번 회차의 환불은 이용권을 끝낸다(§4-8 «구독 취소와 환불이 함께») — 지난 회차의 환불은 아래 «7일 환불»에서 그대로 «기록만»
    ok('**이번 회차 환불(참조값 없음)은 결제 건 번호로 잇고 — 이용권을 환불 때로 끝낸다**', refund.user_id === other.id && refund.result === 'applied' && !(await passActive(pool, other.id)), JSON.stringify(refund));
    const gRow = (await pool.query('SELECT source, status, refunded_at, cancelled_at, in_policy FROM refund_requests WHERE user_id = $1', [other.id])).rows[0];
    ok('**그로블에서 먼저 한 환불도 환불 건으로 남는다 — 판정(규정 안) · 해지는 «아직»**', !!gRow && gRow.source === 'groble' && gRow.status === 'open' && !!gRow.refunded_at && !gRow.cancelled_at
      && gRow.in_policy === true && /해지가 아직/.test(refund.note) && !refund.review, JSON.stringify(gRow));

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

    // ================================================================ 7일 환불(§4-8) — 판정 · 요청 · 즉시 멈춤 · 그로블 환불 · 해지 «둘 다»
    {
      const login = async (id) => {
        const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: 'long-enough-' + id }) });
        jar[id] = (r.headers.get('set-cookie') || '').split(';')[0];
      };
      const rf = await mk('bl-refund'); await login('bl-refund');
      const rfProject = (await api('bl-refund', 'project.create', { name: '환불 시험', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).pid;
      const run = async (userId, minute, status, out) => (await pool.query(`INSERT INTO generation_runs (project_id, requested_by, status, started_at, output_tokens)
        VALUES ($1, $2, $3, $4, $5) RETURNING id`, [rfProject, userId, status, at(minute), out])).rows[0].id;
      const refA = new URL((await edu('bl-refund', 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
      await hook(ev('subscription_payment.completed', refA, 120, { subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'R-1' }));
      const paidAt = new Date(at(120));
      const until = kstDay(dayEndPlus(kstDay(paidAt), 7).getTime() - 1);

      // ---- 판정 — 기한(결제한 날은 세지 않는다) · 결제 뒤 AI 작업
      const j0 = await judgeRefund(pool, rf.id, paidAt);
      ok('**기한 = 결제한 날 + 7일의 그날 끝(한국 날짜)**', j0.ok && kstDay(j0.deadline.getTime() - 1) === until && j0.deadline.getTime() === dayEndPlus(kstDay(paidAt), 7).getTime());
      eq('기한 1밀리초 전은 규정 안', (await judgeRefund(pool, rf.id, paidAt, { at: new Date(j0.deadline.getTime() - 1) })).reason, 'ok');
      eq('**기한이 되면 «기간 지남»**', (await judgeRefund(pool, rf.id, paidAt, { at: j0.deadline })).reason, 'window_passed');
      const p0 = (await edu('bl-refund', 'me.pass')).pass;
      ok('**내 이용권 — «환불 가능 ~까지»**(금액 없음)', p0.active && p0.refund && p0.refund.reason === 'ok' && p0.refund.until === until && p0.refund.paidOn === kstDay(paidAt) && !JSON.stringify(p0.refund).includes('5000'), JSON.stringify(p0.refund));
      const before = await run(rf.id, 100, 'succeeded', 900);
      eq('결제 전의 AI 작업은 세지 않는다', (await refundCheck(pool, rf.id)).reason, 'ok');
      const failed = await run(rf.id, 125, 'failed', 0);
      eq('출력 없이 실패한 작업은 세지 않는다', (await refundCheck(pool, rf.id)).aiRuns, 0);
      const used = await run(rf.id, 130, 'succeeded', 1200);
      ok('**«AI 작업 전까지만»은 기본 끔 — 기간 안이면 AI 작업을 했어도 규정 안(작업 수는 메일에 실린다)**', DEFAULT_RULES.refundNoUse === false && (await refundCheck(pool, rf.id)).reason === 'ok' && (await refundCheck(pool, rf.id)).aiRuns === 1);
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('billing.rules', '{"refundNoUse": true}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      const cu = await refundCheck(pool, rf.id);
      ok('**규칙을 켜면 — 결제 뒤 AI 작업을 했으면 «AI 작업을 함»(1회)**', cu.reason === 'ai_used' && cu.aiRuns === 1 && !cu.eligible);
      const no1 = await edu('bl-refund', 'me.pass.refund', { reason: 'price' });
      ok('**그때 [환불 요청]은 422 — 서버가 다시 판정한다**', no1.status === 422 && no1.code === 'ai_used' && !(await pool.query('SELECT 1 FROM refund_requests WHERE user_id = $1', [rf.id])).rowCount);
      const pAi = (await edu('bl-refund', 'me.pass')).pass;
      ok('내 화면도 까닭을 안다 — 그때는 [구독 취소]가 선다', pAi.refund.reason === 'ai_used' && pAi.cancel.can === true);
      await pool.query(`UPDATE app_settings SET value = '{"refundNoUse": false}' WHERE key = 'billing.rules'`);
      eq('이용 규칙 «AI 작업을 안 했을 때만»을 끄면 AI 작업을 했어도 규정 안', (await refundCheck(pool, rf.id)).reason, 'ok');
      await pool.query(`UPDATE app_settings SET value = '{"refundDays": 0}' WHERE key = 'billing.rules'`);
      eq('환불 기간 0일이면 받지 않는다', (await edu('bl-refund', 'me.pass.refund', { reason: 'price' })).code, 'off');
      await pool.query(`DELETE FROM app_settings WHERE key = 'billing.rules'`);
      await pool.query('DELETE FROM generation_runs WHERE id = ANY($1)', [[before, failed, used]]);
      // 알림 메일 주소(이용 규칙) — 운영자만, 꼴이 맞아야, 감사 기록에는 «있음»만
      eq('보통 사람은 이용 규칙을 못 바꾼다', (await edu('bl-refund', 'billing.rules.save', { notifyEmail: 'x@example.com' })).status, 403);
      eq('알림 메일 주소의 꼴이 틀리면 422', (await edu('bl-root', 'billing.rules.save', { notifyEmail: 'not-an-email' })).status, 422);
      const ms = await edu('bl-root', 'billing.rules.save', { notifyEmail: ' Ops@Example.com ' });
      ok('**알림 메일 주소를 저장한다(소문자 · 빈칸 없이) — 다른 규칙은 그대로**', ms.ok && ms.rules.notifyEmail === 'ops@example.com' && ms.rules.refundDays === 7 && ms.rules.mailOn === true);
      ok('감사 기록에는 알림 메일 주소가 없다', !JSON.stringify((await pool.query(`SELECT details FROM audit_logs WHERE action = 'billing.rules'`)).rows).includes('ops@example.com'));
      eq('[시험 메일 보내기]는 운영자만', (await edu('bl-refund', 'billing.mail.test')).status, 403);
      const tm = await edu('bl-root', 'billing.mail.test');
      ok('**[시험 메일 보내기] — 알림 메일 주소로 한 통**', tm.ok && mails.at(-1).to === 'ops@example.com' && /알림 메일 시험/.test(mails.at(-1).subject));
      mailMode = 'http_403';
      const tm2 = await edu('bl-root', 'billing.mail.test');
      ok('보내지 못하면 까닭을 사람 말로(키 · 주소 없이)', tm2.status === 422 && /Resend/.test(tm2.error) && !tm2.error.includes('ops@example.com'));
      mailMode = 'ok';
      eq('[환불 요청] — 이유를 고르지 않으면 422', (await edu('bl-refund', 'me.pass.refund')).code, 'validation');
      eq('«기타»는 적은 말이 있어야 한다', (await edu('bl-refund', 'me.pass.refund', { reason: 'other', detail: '  ' })).code, 'validation');

      // ---- [환불 요청] — 남기고 · 이용권을 바로 멈춘다(편집은 된다)
      const prevUntil = (await subOf(refA)).paid_until;
      const sentBefore = mails.length;
      const rq = await edu('bl-refund', 'me.pass.refund', { reason: 'quality', detail: '원하던 문체가 안 나와요' });
      const row = (await pool.query('SELECT * FROM refund_requests WHERE user_id = $1', [rf.id])).rows[0];
      ok('**[환불 요청] — 판정 · 이유와 함께 남는다(사용자 요청 · 처리 중 · 규정 안 · AI 작업 0)**', rq.ok && row && row.source === 'user' && row.status === 'open' && row.in_policy && row.ai_runs === 0
        && row.merchant_uid === 'R-1' && new Date(row.paid_at).getTime() === paidAt.getTime() && new Date(row.prev_paid_until).getTime() === new Date(prevUntil).getTime()
        && row.reason === 'quality' && row.detail === '원하던 문체가 안 나와요', JSON.stringify(row));
      const rm = mails.at(-1);
      ok('**[환불 요청] — 운영자에게 메일(아이디 · 결제 건 번호 · 기한 · AI 작업 수 · 이유 · 할 일)**', mails.length === sentBefore + 1 && rm.to === 'ops@example.com'
        && /환불 요청 — bl-refund/.test(rm.subject) && rm.text.includes('R-1') && rm.text.includes(until) && rm.text.includes('AI 작업: 0회') && rm.text.includes('AI 결과가 기대와 달라요 — 원하던 문체가 안 나와요')
        && rm.text.includes('https://open.example/manage.html') && !!row.mailed_at, rm.text);
      ok('**메일에는 구매자 이름 · 전화 · 이메일 원문과 시크릿이 없다**', !rm.text.includes('010-1234-5678') && !rm.text.includes('홍길동') && !rm.text.includes('Buyer@Example.com') && !rm.text.includes(SECRET));
      ok('**요청하면 이용권이 바로 멈춘다**', !(await passActive(pool, rf.id)) && rq.pass.active === false && rq.pass.refund.reason === 'requested');
      const rdoc = (await api('bl-refund', 'doc.create', { pid: rfProject, title: '환불 뒤', body: '글' })).id;
      ok('**멈춘 뒤에도 편집은 되고, 새 AI 작업만 막힌다**', !!rdoc && (await api('bl-refund', 'doc.update', { pid: rfProject, id: rdoc })).code === 'subscription_inactive');
      const aud = ((await pool.query(`SELECT details FROM audit_logs WHERE action = 'billing.refund_request' ORDER BY id DESC LIMIT 1`)).rows[0] || {}).details || {};
      ok('요청은 감사 기록에(결제 때 · 기한 · AI 작업 수)', aud.aiRuns === 0 && !!aud.paidAt && !!aud.until);
      eq('**두 번 누르면 422 — 이미 요청했다**', (await edu('bl-refund', 'me.pass.refund', { reason: 'price' })).code, 'requested');
      eq('남의 요청을 되돌리는 문은 운영자만(403)', (await edu('bl-refund', 'billing.refund.withdraw', { requestId: row.id })).status, 403);
      const wd = await edu('bl-root', 'billing.refund.withdraw', { requestId: row.id, reason: '고객이 취소함' });
      ok('**[요청 되돌리기] — 멈춘 이용권이 되살아난다(감사 기록)**', wd.ok && (await passActive(pool, rf.id))
        && (await pool.query('SELECT status FROM refund_requests WHERE id = $1', [row.id])).rows[0].status === 'withdrawn');
      mailMode = 'network';
      const rq2 = await edu('bl-refund', 'me.pass.refund', { reason: 'price' });
      mailMode = 'ok';
      const row2 = (await pool.query(`SELECT * FROM refund_requests WHERE user_id = $1 AND status = 'open'`, [rf.id])).rows[0];
      ok('되돌린 뒤에는 다시 요청할 수 있다', rq2.ok && !!row2 && !(await passActive(pool, rf.id)));
      ok('**메일을 못 보내도 요청은 남는다 — 까닭의 이름만 적는다**', !row2.mailed_at && row2.mail_error === 'network' && logs.some((l) => l === 'notice mail not sent (network)'));
      const hm = (await edu('bl-root', 'billing.health')).health;
      ok('운영 화면 — 메일을 보내지 못한 요청을 센다', hm.mail.on === true && hm.mail.to === true && hm.mail.failed >= 1);
      const ev1 = (await edu('bl-root', 'billing.events')).refunds.find((r) => r.id === row2.id);
      ok('운영 화면의 환불 줄 — 이유 · 못 보낸 까닭(사람 말)', ev1 && ev1.reasonSay === '가격이 부담돼요' && ev1.mailError === 'network' && /닿지 않았습니다/.test(ev1.mailErrorSay));
      eq('[메일 다시 보내기]는 운영자만', (await edu('bl-refund', 'billing.mail.resend', { kind: 'refund', id: row2.id })).status, 403);
      const rs1 = await edu('bl-root', 'billing.mail.resend', { kind: 'refund', id: row2.id });
      ok('**[메일 다시 보내기] — 보내면 «보냄»으로(되돌린 요청은 «이전 환불»에 세지 않는다)**', rs1.ok && !!(await pool.query('SELECT mailed_at FROM refund_requests WHERE id = $1', [row2.id])).rows[0].mailed_at
        && /이전 환불: 없음/.test(mails.at(-1).text), mails.at(-1).text);

      // ---- 그로블 환불 웹훅 → «환불됨», 해지는 아직(붉게) → 해지 예고가 오면 «끝남»
      await hook(ev('subscription_payment.refunded', refA, 140, { merchantUid: 'R-1' }));
      const re = await lastEvent();
      const row3 = (await pool.query('SELECT * FROM refund_requests WHERE id = $1', [row2.id])).rows[0];
      ok('**그로블 환불 → 그 요청에 «환불됨», 이용권은 끝난 채**', re.result === 'applied' && !re.review && !!row3.refunded_at && !row3.cancelled_at && row3.status === 'open' && !(await passActive(pool, rf.id)), JSON.stringify(re));
      eq('환불 뒤에는 되돌리지 못한다(409)', (await edu('bl-root', 'billing.refund.withdraw', { requestId: row2.id })).status, 409);
      const h1 = (await edu('bl-root', 'billing.health')).health;
      ok('**운영 화면 — «환불은 됐는데 정기결제가 살아 있다»를 센다**', h1.refundsOpen >= 1 && h1.refundsUncancelled >= 1);
      const mine = (await edu('bl-refund', 'me.pass')).pass.refund;
      ok('내 화면 — 환불됐다 · 해지 처리 중', mine.reason === 'refunded' && mine.request && mine.request.refunded && !mine.request.cancelled);
      await hook(ev('subscription.cancel_requested', refA, 150, { serviceEndsAt: at(60 * 24 * 30) }));
      const row4 = (await pool.query('SELECT * FROM refund_requests WHERE id = $1', [row2.id])).rows[0];
      ok('**해지가 오면 «둘 다 됨» → 끝남 · 이용권은 살아나지 않는다**', row4.status === 'done' && !!row4.cancelled_at && !!row4.resolved_at && !(await passActive(pool, rf.id)));
      await hook(ev('subscription.terminated', refA, 160, { termination: { terminatedAt: at(60 * 24 * 30) } }));
      ok('**뒤늦은 «해지 완료»(이용 기간 끝)도 환불한 이용권을 되살리지 않는다**', (await subOf(refA)).status === 'ended' && !(await passActive(pool, rf.id)));
      const E2 = await edu('bl-root', 'billing.events');
      ok('결제 기록 — 환불 건(판정 · 할 일 둘)', E2.refunds.some((r) => r.id === row2.id && r.status === 'done' && r.inPolicy && r.until === until && !!r.refundedAt && !!r.cancelledAt && r.user.loginId === 'bl-refund'));
      ok('고객 한 사람 — 그 사람의 환불 건', (await edu('bl-root', 'billing.customer', { userId: rf.id })).customer.refunds.length === 2);
      await hook(ev('subscription_payment.completed', refA, 170, { subscription: { billingReason: 'RENEWAL', currentRound: 2, nextBillingDate: day(62) }, merchantUid: 'R-2' }));
      const again = await lastEvent();
      ok('**환불한 정기결제에서 다시 결제가 오면 — 반영하되(돈을 냈다) «확인 필요»**', again.result === 'applied' && again.review && /환불한 정기결제/.test(again.note), JSON.stringify(again));

      // ---- 지난 회차의 환불은 기록만(이용권 그대로) · 구매자의 취소 요청에는 판정을 붙인다
      const rf2 = await mk('bl-refund2'); await login('bl-refund2');
      const refB = new URL((await edu('bl-refund2', 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
      await hook(ev('subscription_payment.completed', refB, 60, { subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'R-21' }));
      await hook(ev('subscription_payment.completed', refB, 70, { subscription: { billingReason: 'RENEWAL', currentRound: 2, nextBillingDate: day(62) }, merchantUid: 'R-22' }));
      await hook(ev('subscription_payment.refunded', refB, 80, { merchantUid: 'R-21' }));
      const old = await lastEvent();
      ok('**지난 회차의 환불은 기록만 · 확인 필요 — 이용권은 그대로**', old.result === 'recorded' && old.review && /지난 회차/.test(old.note) && (await passActive(pool, rf2.id)));
      await hook(sample({ type: 'payment.cancel_requested', occurredAt: at(90) }, { merchantUid: 'R-22', sellerReference: '' }));
      const cr = await lastEvent();
      ok('**구매자가 그로블에서 낸 취소 요청 — 그때의 판정을 붙여 «확인 필요»**', cr.result === 'recorded' && cr.review && cr.user_id === rf2.id && /규정 안/.test(cr.note) && /그로블에서/.test(cr.note), JSON.stringify(cr));

      // ---- 환불 기간은 «구독 시작»부터(2026-10-10 사용자 지시 «가입 후 7일») — 지나면 [구독 취소](이유를 묻고 운영자에게 메일)
      const cx = await mk('bl-quit'); await login('bl-quit');
      const refX = new URL((await edu('bl-quit', 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
      await hook(ev('subscription_payment.completed', refX, -60 * 24 * 40, { subscription: { billingReason: 'INITIAL', nextBillingDate: day(-9) }, merchantUid: 'X-1' }));
      await hook(ev('subscription_payment.completed', refX, 30, { subscription: { billingReason: 'RENEWAL', currentRound: 2, nextBillingDate: day(21) }, merchantUid: 'X-2' }));
      const xc = await refundCheck(pool, cx.id);
      ok('**이번 회차 결제가 오늘이어도 구독 시작(40일 전)부터 세면 기간 지남**', xc.reason === 'window_passed' && xc.payment.merchantUid === 'X-2' && kstDay(xc.start) === kstDay(at(-60 * 24 * 40)));
      const px = (await edu('bl-quit', 'me.pass')).pass;
      ok('**내 이용권 — 환불 줄은 없고 [구독 취소]가 선다 · 이유 목록은 서버에서**', px.active && px.refund === null && px.cancel.can === true && px.cancel.nextBillingDate === day(21)
        && px.reasons.length === CANCEL_REASONS.length && px.reasons.some((r) => r.code === 'other'));
      eq('[환불 요청]은 422 — 기간 지남', (await edu('bl-quit', 'me.pass.refund', { reason: 'price' })).code, 'window_passed');
      eq('[구독 취소] — 이유를 고르지 않으면 422', (await edu('bl-quit', 'me.pass.cancel', {})).code, 'validation');
      eq('모르는 이유는 422', (await edu('bl-quit', 'me.pass.cancel', { reason: 'hack' })).code, 'validation');
      const sentC = mails.length;
      const cr1 = await edu('bl-quit', 'me.pass.cancel', { reason: 'rarely', detail: '바빠서 못 써요' });
      const crow = (await pool.query(`SELECT *, next_billing::text AS nb FROM cancel_requests WHERE user_id = $1`, [cx.id])).rows[0];
      ok('**[구독 취소] — 이유 · 다음 결제일과 함께 접수(그로블 해지 대기)**', cr1.ok && crow && crow.status === 'open' && crow.reason === 'rarely' && crow.detail === '바빠서 못 써요' && crow.nb === day(21) && !!crow.mailed_at, JSON.stringify(crow));
      ok('**이용권은 지금 결제 기간 끝까지 그대로**', (await passActive(pool, cx.id)) && cr1.pass.cancel.can === false && cr1.pass.cancel.request && cr1.pass.cancel.request.nextBilling === day(21));
      const cm = mails.at(-1);
      ok('**[구독 취소] — 운영자에게 메일(다음 결제일 전에 그로블에서 해지 · 마지막 결제 · 이유)**', mails.length === sentC + 1 && /구독 취소 — bl-quit/.test(cm.subject)
        && cm.text.includes('다음 결제일: ' + day(21)) && cm.text.includes('X-2') && cm.text.includes('자주 쓰지 않아요 — 바빠서 못 써요'), cm.text);
      eq('**두 번 누르면 422 — 이미 접수했다**', (await edu('bl-quit', 'me.pass.cancel', { reason: 'price' })).code, 'requested');
      const aud2 = ((await pool.query(`SELECT details FROM audit_logs WHERE action = 'billing.cancel_request' ORDER BY id DESC LIMIT 1`)).rows[0] || {}).details || {};
      ok('구독 취소는 감사 기록에(이유 코드 · 다음 결제일 — 적은 말은 싣지 않는다)', aud2.reason === 'rarely' && aud2.nextBilling === day(21) && !JSON.stringify(aud2).includes('바빠서'));
      const E3 = await edu('bl-root', 'billing.events');
      ok('운영 화면 — 구독 취소 줄(이유 · 다음 결제일 · 그로블 해지 대기 · 메일 보냄)', E3.cancels.some((x) => x.id === crow.id && x.status === 'open' && x.reasonSay === '자주 쓰지 않아요' && x.nextBilling === day(21) && !!x.mailedAt));
      ok('고객 한 사람 — 그 사람의 구독 취소', (await edu('bl-root', 'billing.customer', { userId: cx.id })).customer.cancels.length === 1);
      const h3 = (await edu('bl-root', 'billing.health')).health;
      ok('운영 화면 — 그로블 해지를 기다리는 취소를 센다', h3.cancelsOpen >= 1);
      await hook(ev('subscription.cancel_requested', refX, 40, { serviceEndsAt: at(60 * 24 * 21) }));
      const crow2 = (await pool.query('SELECT status, confirmed_at FROM cancel_requests WHERE id = $1', [crow.id])).rows[0];
      ok('**그로블 해지 웹훅이 오면 «해지 확인»(끝남) · 내 화면은 «해지 예정»**', crow2.status === 'done' && !!crow2.confirmed_at && (await edu('bl-quit', 'me.pass')).pass.status === 'cancel_pending');
      eq('해지 예정에서는 다시 취소할 것이 없다', (await edu('bl-quit', 'me.pass.cancel', { reason: 'price' })).code, 'pending');

      // ---- 구독 시작 기간 안에는 [구독 취소] 대신 [환불 요청] · 그로블 해지가 늦어 다시 결제되면 «확인 필요» + 메일
      const cy = await mk('bl-quit2'); await login('bl-quit2');
      const refY = new URL((await edu('bl-quit2', 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
      await hook(ev('subscription_payment.completed', refY, 20, { subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'Y-1' }));
      ok('**기간 안에는 [환불 요청]만 — [구독 취소]는 서지 않는다**', (await cancelCheck(pool, cy.id)).reason === 'refund_window' && (await edu('bl-quit2', 'me.pass.cancel', { reason: 'price' })).code === 'refund_window');
      await pool.query(`UPDATE billing_events SET occurred_at = occurred_at - interval '9 days' WHERE merchant_uid = 'Y-1'`);
      ok('기간이 지나면 [구독 취소]', (await cancelCheck(pool, cy.id)).eligible);
      await edu('bl-quit2', 'me.pass.cancel', { reason: 'switch' });
      const sentY = mails.length;
      // 갱신은 취소를 접수한 «뒤»에 일어난 일이어야 한다(먼저 일어나 늦게 온 갱신은 해당하지 않는다)
      await hook(sample({ type: 'subscription_payment.completed', occurredAt: new Date(Date.now() + 1000).toISOString() },
        { sellerReference: refY, subscription: { billingReason: 'RENEWAL', currentRound: 2, nextBillingDate: day(62) }, merchantUid: 'Y-2' }));
      const ren = await lastEvent();
      ok('**취소를 접수한 정기결제에서 다시 결제 — 반영하되(돈을 냈다) «확인 필요»**', ren.result === 'applied' && ren.review && /구독 취소를 접수한 뒤/.test(ren.note), JSON.stringify(ren));
      ok('그 취소 줄에 «다시 결제됨»', !!(await pool.query(`SELECT charged_at FROM cancel_requests WHERE user_id = $1`, [cy.id])).rows[0].charged_at);
      for (let i = 0; i < 50 && mails.length === sentY; i++) await new Promise((r) => setTimeout(r, 20));
      ok('**운영자에게 메일 — 이 결제 환불 · 정기결제 해지**', mails.length === sentY + 1 && /다시 결제됨 — bl-quit2/.test(mails.at(-1).subject) && mails.at(-1).text.includes('Y-2'));
      eq('내 화면 — 취소 뒤 결제가 됐다', (await edu('bl-quit2', 'me.pass')).pass.cancel.request.charged, true);
      await pool.query(`UPDATE cancel_requests SET next_billing = current_date - 1 WHERE user_id = $1`, [cy.id]);
      ok('**다음 결제일이 지났는데 해지 확인이 없으면 운영 화면이 붉게 센다**', (await edu('bl-root', 'billing.health')).health.cancelsLate >= 1);

      // ---- 도착 순서가 뒤바뀌어도 — 환불이 결제보다 먼저 오면, 늦게 온 결제는 이용권을 늘리지 않는다
      const rf3 = await mk('bl-refund3'); await login('bl-refund3');
      const refC = new URL((await edu('bl-refund3', 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
      await hook(ev('subscription_payment.refunded', refC, 100, { merchantUid: 'R-31' }));
      await hook(ev('subscription_payment.completed', refC, 90, { subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'R-31' }));
      const late = await lastEvent();
      ok('**환불이 먼저 오고 결제가 늦게 와도 이용권은 서지 않는다(확인 필요)**', late.result === 'applied' && late.review && /이미 환불된/.test(late.note) && !(await passActive(pool, rf3.id)), JSON.stringify(late));
    }

    // ================================================================ 운영 화면 — 고객 · 결제 관리(최상위 운영자만)
    {
      eq('**보통 사람에게 고객 목록은 없다(403)**', (await edu('bl-buyer', 'billing.customers')).status, 403);
      eq('보통 사람은 남의 이용권을 늘리지 못한다(403)', (await edu('bl-buyer', 'billing.extend', { userId: buyer.id, days: 30 })).status, 403);
      {
        const school = createOnlineServer({ pool, plan: onlinePlan({}) });
        await new Promise((r) => school.listen(0, '127.0.0.1', r));
        const lr = await fetch('http://127.0.0.1:' + school.address().port + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'bl-root', password: 'long-enough-bl-root' }) });
        const ck = (lr.headers.get('set-cookie') || '').split(';')[0];
        const call = async (op) => (await fetch('http://127.0.0.1:' + school.address().port + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck }, body: JSON.stringify({ op }) })).status;
        ok('**교육기관판에는 이용권 · 고객 · 결제 문이 없다(404)**', (await call('me.pass')) === 404 && (await call('billing.customers')) === 404 && (await call('billing.events')) === 404);
        await new Promise((r) => school.close(r));
      }

      // ---------------- 고객 목록 · 찾기 · 거르기
      const all = await edu('bl-root', 'billing.customers', { q: 'bl-' });
      const row = (id) => all.customers.find((c) => c.loginId === id) || {};
      ok('**고객 목록 — 아이디 · 가입일 · 이용권 상태 · 기한 · 다음 결제일**', all.ok && row('bl-buyer').status === 'active' && !!row('bl-buyer').nextBilling && row('bl-root').operator === true && row('bl-free').free === true, JSON.stringify(row('bl-buyer')));
      eq('찾기(아이디 일부)', (await edu('bl-root', 'billing.customers', { q: 'bl-buy' })).customers.map((c) => c.loginId).join(), 'bl-buyer');
      ok('상태로 거르기 — 무료 이용', (await edu('bl-root', 'billing.customers', { q: 'bl-', status: 'free' })).customers.every((c) => c.free) && (await edu('bl-root', 'billing.customers', { q: 'bl-', status: 'free' })).total >= 1);
      ok('상태로 거르기 — 없음', (await edu('bl-root', 'billing.customers', { q: 'bl-', status: 'none' })).customers.every((c) => c.status === 'none'));
      const one = (await edu('bl-root', 'billing.customer', { userId: buyer.id })).customer;
      ok('**한 사람 — 이용권 줄 · 결제 기록(이름 · 전화 · 이메일은 가려서)**', one.subscriptions.length >= 3 && one.events.length >= 3 && one.events.some((e) => e.buyer.name === '홍*동' && e.buyer.email === 'Bu***@Example.com' && e.buyer.phone === '***-****-5678')
        && !JSON.stringify(one).includes('010-1234-5678') && !JSON.stringify(one).includes('Buyer@Example.com'));

      // ---------------- 손으로 바꾸기 — 연장 · 끝내기 · 무료 이용 · 메모(모두 감사 기록)
      const audits = async (action) => ((await pool.query('SELECT details FROM audit_logs WHERE action = $1 ORDER BY id DESC LIMIT 1', [action])).rows[0] || {}).details || {};
      const before2 = (await pool.query('SELECT max(paid_until) AS m FROM subscriptions WHERE user_id = $1', [other.id])).rows[0].m;
      const ext = await edu('bl-root', 'billing.extend', { userId: other.id, days: 30, reason: '웹훅이 끊긴 동안 메움' });
      // 지금 기한(지났으면 지금)부터 — 이 사람은 위에서 이번 회차가 환불돼 기한이 지났다
      ok('**[기간 연장] — 지금 기한부터 30일 더(손 연장 줄)**', ext.ok && Math.abs(new Date(ext.paidUntil) - (Math.max(Date.now(), new Date(before2).getTime()) + 30 * 86400000)) < 5000
        && (await audits('billing.extend')).reason === '웹훅이 끊긴 동안 메움');
      eq('연장 일수는 1~3650', (await edu('bl-root', 'billing.extend', { userId: other.id, days: 0 })).status, 422);
      ok('**[이용권 끝내기] — 곧바로 막힌다(감사 기록)**', (await edu('bl-root', 'billing.end', { userId: other.id, reason: '환불' })).ok && !(await passActive(pool, other.id)) && (await audits('billing.end')).reason === '환불');
      ok('[무료 이용 켜기] — 결제 없이 쓴다', (await edu('bl-root', 'billing.free', { userId: other.id, on: true })).ok && (await passActive(pool, other.id)));
      ok('[무료 이용 끄기]', (await edu('bl-root', 'billing.free', { userId: other.id, on: false })).ok && !(await passActive(pool, other.id)));
      ok('메모 — 저장되고 감사 기록에는 길이만', (await edu('bl-root', 'billing.memo', { userId: other.id, memo: '전화로 환불 요청함' })).ok
        && (await edu('bl-root', 'billing.customer', { userId: other.id })).customer.user.memo === '전화로 환불 요청함' && !JSON.stringify(await audits('billing.memo')).includes('환불'));
      eq('없는 사람은 404', (await edu('bl-root', 'billing.customer', { userId: '00000000-0000-0000-0000-000000000000' })).status, 404);

      // ---------------- 결제 기록 — 확인 필요 · [이 계정에 연결] · [무시]
      const E = await edu('bl-root', 'billing.events');
      ok('**결제 기록 — «확인 필요»(연결 안 됨 · 금액 다름 · 읽지 못함)를 따로**', E.ok && ['unlinked', 'amount_mismatch', 'unreadable'].every((r) => E.review.some((e) => e.result === r)) && E.recent.length > 0);
      ok('이번 달 반영된 결제 수 · 합계(운영자에게만)', E.month.count >= 3 && E.month.total >= 15000);
      ok('결제 기록도 가려서', !JSON.stringify(E).includes('010-1234-5678'));
      const evId = async (where, args) => Number((await pool.query('SELECT id FROM billing_events WHERE ' + where + ' ORDER BY id DESC LIMIT 1', args)).rows[0].id);
      const unlinkedId = await evId(`ref = 'unknown-ref-1'`, []);
      const lk = await edu('bl-root', 'billing.link', { eventId: unlinkedId, loginId: 'bl-other', reason: '고객이 결제 내역을 보내옴' });
      ok('**[이 계정에 연결] — 그 사람에게 반영되고 확인 필요에서 내려간다**', lk.ok && lk.result === 'applied' && (await passActive(pool, other.id))
        && (await pool.query('SELECT review, user_id FROM billing_events WHERE id = $1', [unlinkedId])).rows[0].review === false);
      await hook(ev('subscription_payment.completed', 'unknown-ref-1', 130, { subscription: { billingReason: 'RENEWAL', nextBillingDate: day(62) } }));
      ok('**연결한 참조값은 기억한다 — 다음 갱신부터 저절로 잇는다**', (await lastEvent()).user_id === other.id && (await lastEvent()).result === 'applied');
      const takenId = await evId(`ref = $1 AND result = 'amount_mismatch'`, [ref2]);
      eq('다른 사람에게 묶인 참조값의 결제는 다른 계정에 연결하지 못한다(409)', (await edu('bl-root', 'billing.link', { eventId: takenId, loginId: 'bl-other' })).status, 409);
      eq('읽지 못한 꼴은 연결하지 못한다(422)', (await edu('bl-root', 'billing.link', { eventId: await evId(`result = 'unreadable' AND type = ''`, []), loginId: 'bl-other' })).status, 422);
      await hook(ev('subscription_payment.completed', '', 140, { buyer: { email: 'alias@example.com' }, subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) } }));
      const aliasId = await evId(`result = 'unlinked'`, []);
      ok('참조값 · 이메일 없는 결제는 연결 안 됨', (await lastEvent()).result === 'unlinked');
      ok('참조값이 없는 결제를 연결하면 구매자 이메일을 기억한다', (await edu('bl-root', 'billing.link', { eventId: aliasId, loginId: 'bl-free' })).ok);
      await hook(ev('subscription_payment.completed', '', 150, { buyer: { email: 'ALIAS@example.com' }, subscription: { billingReason: 'RENEWAL', nextBillingDate: day(62) } }));
      ok('**다음부터 그 이메일의 결제는 저절로 그 사람에게**', (await lastEvent()).user_id === free.id && (await lastEvent()).result === 'applied');
      const ig = await evId(`result = 'amount_mismatch' AND review`, []);
      ok('[무시] — 확인 필요에서 내린다(기록은 그대로 · 감사 기록)', (await edu('bl-root', 'billing.ignore', { eventId: ig, reason: '할인 결제' })).ok
        && (await pool.query('SELECT review, result FROM billing_events WHERE id = $1', [ig])).rows[0].review === false && (await audits('billing.ignore')).reason === '할인 결제');

      // ---------------- 웹훅 상태
      await pool.query(`INSERT INTO subscriptions (user_id, provider, ref, status, paid_until, next_billing_date, occurred_at) VALUES ($1, 'groble', 'overdue-ref', 'active', now() + interval '5 days', current_date - 5, now())`, [free.id]);
      const H = (await edu('bl-root', 'billing.health')).health;
      ok('**웹훅 상태 — 시크릿 있음 · 마지막으로 받은 때 · 서명이 틀린 요청 · 소식이 늦은 정기결제**', H.secret.current === true && !!H.lastReceivedAt && H.rejected >= 2 && H.overdue >= 1 && H.path === '/api/billing/groble' && !JSON.stringify(H).includes(SECRET));

      // ---------------- 결제 옵션(요금제)
      eq('결제창 링크는 https 만', (await edu('bl-root', 'billing.plan.save', { name: '잘못', checkoutUrl: 'http://x.example/pay', price: 5000 })).status, 422);
      const np = await edu('bl-root', 'billing.plan.save', { name: '월 이용권(새 가격)', checkoutUrl: 'https://www.groble.im/pay/se-month-2', price: 6000, cycleMonths: 1, productId: '', sortOrder: 2 });
      ok('결제 옵션을 넣는다', np.ok && np.plans.some((p) => p.price === 6000));
      eq('**가격은 바꾸지 못한다 — 새 줄을 넣고 옛 줄을 끈다**', (await edu('bl-root', 'billing.plan.save', { id: np.plan.id, price: 7000 })).status, 422);
      ok('상품 번호는 비어 있을 때 한 번 채운다', (await edu('bl-root', 'billing.plan.save', { id: np.plan.id, productId: 'C-88' })).ok
        && (await edu('bl-root', 'billing.plan.save', { id: np.plan.id, productId: 'C-99' })).status === 422);
      ok('옛 줄을 끈다 — 사용자의 [결제하기]에서 빠진다', (await edu('bl-root', 'billing.plan.save', { id: plan.id, enabled: false })).ok
        && (await edu('bl-buyer', 'me.pass')).pass.plans.map((p) => p.name).join() === '월 이용권(새 가격)');
      await hook(ev('subscription_payment.completed', ref2, 160, { subscription: { billingReason: 'RENEWAL', nextBillingDate: day(93) } }));
      ok('**꺼진 옛 상품의 갱신도 계속 받는다**', (await lastEvent()).result === 'applied' && (await subOf(ref2)).nbd === day(93));
      eq('보통 사람에게 결제 옵션(금액)은 없다', (await edu('bl-buyer', 'billing.plans')).status, 403);

      // ---------------- 이용 규칙
      eq('여유는 0~60일', (await edu('bl-root', 'billing.rules.save', { trialDays: 0, graceDays: 100 })).status, 422);
      const rs = await edu('bl-root', 'billing.rules.save', { trialDays: 2, graceDays: 7 });
      ok('이용 규칙 저장 — 막는 범위는 «새 AI 작업만»(바꿀 수 없다)', rs.ok && (await edu('bl-root', 'billing.rules')).rules.graceDays === 7 && (await edu('bl-root', 'billing.rules')).rules.blocks === 'ai');
      await pool.query(`DELETE FROM app_settings WHERE key = 'billing.rules'`);

      // ---------------- 비밀번호를 잊었을 때 — 운영자가 재설정 코드(자유 가입판에는 «윗사람»이 없다)
      eq('보통 사람은 재설정 코드를 못 만든다', (await edu('bl-buyer', 'user.reset_code', { userId: other.id })).status, 403);
      eq('운영자 계정은 이 길로 되찾지 않는다', (await edu('bl-root', 'user.reset_code', { userId: (await pool.query("SELECT id FROM users WHERE login_id = 'bl-root'")).rows[0].id })).status, 422);
      const rc = await edu('bl-root', 'user.reset_code', { userId: other.id });
      const pr = await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'password.reset', loginId: 'bl-other', code: rc.resetCode, password: 'brand-new-other-pw' }) });
      ok('**운영자가 준 재설정 코드로 새 비밀번호를 정하고 들어간다**', rc.ok && pr.status === 200 && /se_session=/.test(pr.headers.get('set-cookie') || ''));
    }

    // ---------------- 지킨 것 — 410 을 돌려준 적이 없다 · 로그에 개인정보 없음
    ok('**받는 문은 410 을 돌려주지 않는다**', ![...codes].includes(410) && [...codes].every((c) => [200, 401, 429, 503].includes(c)), [...codes].join(','));
    ok('로그에 개인정보 · 시크릿이 없다(ASCII)', logs.every((m) => /^[\x20-\x7e]*$/.test(m) && !m.includes(SECRET) && !/example\.com|010-/.test(m)), logs.join(' | '));
    // 고삐 — 같은 곳에서 서명이 거듭 틀리면 429(그로블의 정상 요청은 서명이 맞으므로 걸리지 않는다)
    const st = [];
    for (let i = 0; i < 31; i++) st.push((await hook(sample(), { secret: 'wrong-secret' })).status);
    ok('같은 곳에서 서명이 거듭 틀리면 429', st.slice(0, 28).every((x) => x === 401) && st[30] === 429, st.join(','));
    // 틀린 서명이 쏟아져도(같은 곳 — 플랫폼 앞단 뒤라 주소가 하나로 보일 때) 그로블의 맞는 서명은 막히지 않는다
    const good = await hook(sample({}, { sellerReference: '' , buyer: { email: 'nobody2@example.com' } }));
    eq('**틀린 서명이 쏟아지는 중에도 맞는 서명의 웹훅은 200**', good.status, 200);

    // ---------------- 구매자가 넣은 글자 — 이스케이프된 «\\u0000» 도, 진짜 NUL 글자도 원문을 남긴다(저장이 막혀 503 이 되풀이되지 않게)
    {
      const r1 = await hook(sample({}, { sellerReference: '', buyer: { displayName: 'a\\u0000b', email: 'nul1@example.com' } }));
      const r2 = await hook(sample({}, { sellerReference: '', buyer: { displayName: 'c\u0000d', email: 'nul2@example.com' } }));
      const names = (await pool.query(`SELECT raw->'data'->'object'->'buyer'->>'displayName' AS n FROM billing_events WHERE raw->'data'->'object'->'buyer'->>'email' IN ('nul1@example.com', 'nul2@example.com') ORDER BY id`)).rows.map((r) => r.n);
      ok('**이름에 글자 «\\u0000» 이 있어도 · 진짜 NUL 이 있어도 200 으로 남긴다**', r1.status === 200 && r2.status === 200 && names[0] === 'a\\u0000b' && names[1] === 'cd', JSON.stringify([r1.status, r2.status, names]));
    }

    // ---------------- 해지 예고 — 끝나는 날 + 하루에 저절로 끝나게 · 즉시 해지(예고와 완료가 같은 때)도 «해지 완료»를 잃지 않는다
    {
      const cu = await mk('bl-cancel');
      await pool.query(`INSERT INTO billing_refs (kind, ref, user_id) VALUES ('link', 'cancel-ref-1', $1)`, [cu.id]);
      await hook(ev('subscription_payment.completed', 'cancel-ref-1', 165, { subscription: { billingReason: 'INITIAL', nextBillingDate: day(30) }, merchantUid: 'M-C1' }));
      const ends = new Date(Date.now() + 3 * 86400000);
      await hook(ev('subscription.cancel_requested', 'cancel-ref-1', 170, { serviceEndsAt: ends.toISOString() }));
      const c1 = await subOf('cancel-ref-1');
      ok('**해지 예고 — 지금은 쓰고, 끝나는 날 + 하루에 저절로 끝난다(해지 완료를 못 받아도)**', c1.status === 'cancel_pending' && Math.abs(new Date(c1.paid_until) - (ends.getTime() + 86400000)) < 2000 && (await passActive(pool, cu.id)));
      const same = at(175);
      await hook(sample({ type: 'subscription.cancel_requested', occurredAt: same }, { sellerReference: 'cancel-ref-1', serviceEndsAt: ends.toISOString() }));
      await hook(sample({ type: 'subscription.terminated', occurredAt: same }, { sellerReference: 'cancel-ref-1', termination: { terminatedAt: same } }));
      ok('**예고와 완료가 같은 때에 와도 «해지 완료»를 반영한다**', (await subOf('cancel-ref-1')).status === 'ended' && !(await passActive(pool, cu.id)) && (await lastEvent()).result === 'applied');
      await hook(sample({ type: 'subscription.terminated', occurredAt: same }, { sellerReference: 'cancel-ref-1', termination: { terminatedAt: same } }));
      eq('같은 때 같은 소식이 다른 열쇠로 다시 오면 기록만', (await lastEvent()).result, 'stale');
    }

    // ---------------- 참조값 없이 온 정기결제는 사람마다 한 줄로 모인다 — 살아 있는 줄에 새 최초 결제가 오면 겹친 결제로 «확인 필요»
    {
      const mu = await mk('bl-mail');
      await pool.query("UPDATE users SET email = 'mail@example.com' WHERE id = $1", [mu.id]);
      await hook(ev('subscription_payment.completed', '', 171, { buyer: { email: 'mail@example.com' }, subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'M-R1' }));
      const a1 = await lastEvent();
      await hook(ev('subscription_payment.completed', '', 172, { buyer: { email: 'mail@example.com' }, subscription: { billingReason: 'INITIAL', nextBillingDate: day(31) }, merchantUid: 'M-R2' }));
      const a2 = await lastEvent();
      ok('**참조값 없는 두 번째 최초 결제 — 반영하고 겹친 결제로 «확인 필요»**', a1.result === 'applied' && !a1.review && a2.result === 'applied' && a2.review && /한 줄로 모인다/.test(a2.note), JSON.stringify([a1, a2]));
    }
  } finally {
    await new Promise((r) => srv.close(r));
  }
}
