// 이용권 · 그로블 정기결제 시험 — 어댑터(서명 · 본문 · 결제창 링크)와 표. online/test.mjs 가 이어 부른다.

import * as groble from './billing/groble.mjs';

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
}
