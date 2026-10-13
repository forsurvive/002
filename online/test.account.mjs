// 계정 지우기 · 받는 정보 시험 — 자유 가입판의 «내 계정 → 계정 지우기»(docs/OPEN_EDITION.md §4-11)와
// 받는 정보는 아이디 · 비밀번호 · 이메일뿐(사용자의 IP · 브라우저 정보를 남기지 않는다 — 운영자의 것만). online/test.mjs 가 이어 부른다.
// 구독 자동 취소는 서명한 그로블 웹훅 · 가짜 우편함으로, 비밀번호 없는 계정의 확인은 가짜 구글(토큰 주소)로 본다.

import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle, NO_PASSWORD, LOGIN_RE } from './auth.mjs';
import { createBilling, DEFAULT_RULES, kstDay } from './billing/service.mjs';
import { createJobQueue } from './jobs.mjs';
import { sample, signed } from './test.billing.mjs';

const SECRET = 'test-account-secret-' + 'y'.repeat(8);
const CLIENT = { clientId: 'cid-account.apps.googleusercontent.com', clientSecret: 'gsecret-account-never-shown' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64(claims) + '.' + Buffer.from('sig').toString('base64url');

export async function run({ pool, ok, eq }) {
  // ---------------------------------------------------------------- 가짜 구글(토큰 주소) — PKCE · 클라이언트를 진짜처럼 본다
  const codes = new Map();
  const tokenSrv = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const f = new URLSearchParams(raw);
    const c = codes.get(f.get('code'));
    codes.delete(f.get('code'));
    const fine = !!c && createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === c.challenge && f.get('client_secret') === CLIENT.clientSecret;
    res.writeHead(fine ? 200 : 400, { 'content-type': 'application/json' });
    res.end(fine ? JSON.stringify({ id_token: jwt(c.claims) }) : '{"error":"invalid_grant"}');
  });
  await new Promise((r) => tokenSrv.listen(0, '127.0.0.1', r));
  const google = { ...CLIENT, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'http://127.0.0.1:' + tokenSrv.address().port + '/token' };

  // ---------------------------------------------------------------- 앱 — 전자책 오토(자유 가입판) · 이용 규칙은 기본값 + 알림 메일 주소
  resetThrottle();
  await pool.query(`INSERT INTO app_settings (key, value) VALUES ('billing.rules', '{"notifyEmail": "ops@example.com"}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const mails = [];
  const mailer = { on: () => true, send: async (m) => { if (!m.to) return { ok: false, reason: 'no_to' }; mails.push(m); return { ok: true }; } };
  const billing = createBilling({ pool, secrets: () => [SECRET], mailer, retryMs: 0, siteUrl: 'https://book.example', app: '전자책 오토' });
  const servers = [];
  const start = async (env, extra = {}) => {
    const srv = createOnlineServer({ pool, plan: onlinePlan(env), ...extra });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    return 'http://127.0.0.1:' + srv.address().port;
  };
  const base = await start({ SE_EDITION: 'open', SE_PURPOSE: 'ebook' }, { billing, google });

  const plan = (await pool.query(`INSERT INTO billing_plans (name, checkout_url, price, cycle_months, product_id, sort_order)
    VALUES ('전자책 월 이용권', 'https://www.groble.im/pay/book-month', 7000, 1, 'C-ACC', 9) RETURNING id`)).rows[0];
  const mk = async (id, admin = false) => (await createUser(pool, { loginId: id, password: 'long-enough-' + id, isPlatformAdmin: admin })).user;
  const cookieOf = (list, name) => (list.find((c) => c.startsWith(name + '=')) || '').split(';')[0];
  const login = async (b, id, password = 'long-enough-' + id) => {
    const r = await fetch(b + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password }) });
    return { status: r.status, cookie: cookieOf(r.headers.getSetCookie(), 'se_session') };
  };
  const post = async (b, path, cookie, body) => {
    const r = await fetch(b + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body || {}) });
    return { status: r.status, setCookie: r.headers.getSetCookie(), ...(await r.json().catch(() => ({}))) };
  };
  const edu = (cookie, op, b = {}) => post(base, '/api/edu', cookie, { op, ...b });
  const api = (cookie, op, b = {}) => post(base, '/api', cookie, { op, ...b });
  const hook = async (bodyObj) => {
    const raw = JSON.stringify(bodyObj);
    const r = await fetch(base + '/api/billing/groble', { method: 'POST', headers: signed(SECRET, raw), body: raw });
    return r.status;
  };
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0] || null;
  const n = async (sql, args) => (await pool.query(sql, args)).rows[0].n;
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const nextDay = kstDay(Date.now() + 25 * 86400000);
  const pay = (ref, merchantUid, email, { reason = 'INITIAL', at = ago(60) } = {}) => sample({ type: 'subscription_payment.completed', occurredAt: at }, {
    sellerReference: ref, merchantUid, buyer: { displayName: '김작가', email, phoneNumber: '010-9999-8888' },
    content: { id: 'C-ACC', paymentType: 'SUBSCRIPTION' }, pricing: { finalAmount: 7000 },
    subscription: { billingReason: reason, currentRound: reason === 'INITIAL' ? 1 : 2, nextBillingDate: nextDay, status: 'ACTIVE', billingCycleMonths: 1 } });
  const checkoutRef = async (cookie) => new URL((await edu(cookie, 'me.pass.checkout', { planId: plan.id })).url).searchParams.get('ref');
  const userRow = async (id) => one('SELECT * FROM users WHERE id = $1', [id]);

  try {
    // ---------------- 무료 체험 2일 · 환불 7일(2026-10-11) — 기본값 · 로그인 전 화면(이용약관이 채운다)
    ok('**이용 규칙 기본값 — 무료 체험 2일 · 환불은 구독 시작 7일 안**', DEFAULT_RULES.trialDays === 2 && DEFAULT_RULES.refundDays === 7 && DEFAULT_RULES.refundNoUse === false);
    const st = await (await fetch(base + '/api/setup')).json();
    ok('**로그인 전 /api/setup 이 체험 · 환불 일수를 준다(이용약관 · 소개가 지금 값으로)**', st.trialDays === 2 && st.refundDays === 7, JSON.stringify(st));
    const school = await start({ SE_PURPOSE: 'ebook' });
    ok('교육기관판에는 체험 · 환불 일수가 없다', !('trialDays' in (await (await fetch(school + '/api/setup')).json())));
    const su = await post(base, '/api/auth/signup', '', { loginId: 'ac-new', password: 'long-enough-ac-new', displayName: '새 사람' });
    const nu = await one(`SELECT u.id, u.display_name, s.paid_until FROM users u LEFT JOIN subscriptions s ON s.user_id = u.id AND s.provider = 'trial' WHERE u.login_id = 'ac-new'`);
    ok('**가입하면 2일 무료 체험 · 이름은 받지 않는다**', su.status === 200 && nu && nu.display_name === 'ac-new' && Math.abs(new Date(nu.paid_until) - (Date.now() + 2 * 86400000)) < 60000, JSON.stringify(nu));

    // ---------------- 읽기 쪽 — 받는 정보 · AI(고른 회사 · 본인 키) · 계정 지우기
    const page = async (p) => (await fetch(base + p)).text();
    const privacy = await page('/privacy'); const terms = await page('/terms'); const about = await page('/about');
    ok('**개인정보처리방침 — 받는 것은 아이디 · 비밀번호 · 이메일, 이름 · 전화 · IP 는 남기지 않는다**', privacy.includes('받는 개인정보 — 아이디 · 비밀번호 · 이메일')
      && privacy.includes('이름 · 전화번호는 받아도 저장하지 않습니다') && privacy.includes('접속 IP · 브라우저 정보도 남기지 않습니다') && !privacy.includes('이름(표시 이름)'));
    ok('**AI 작업은 이용자가 고른 회사의 이용자 키로 — 개인정보처리방침 · 이용약관 · 소개**', privacy.includes('이용자가 «내 계정»에서 고른 AI 회사') && privacy.includes('이용자가 넣은 API 키로 실행')
      && terms.includes('회원이 «내 계정»에서 고른 AI 회사') && about.includes('사용자가 «내 계정»에서 고른 AI 회사'));
    ok('**탈퇴는 «내 계정 → 계정 지우기»에서 직접 — 구독 취소가 저절로**', terms.includes('«내 계정 → 계정 지우기»에서 직접 계정을 지울 수 있습니다') && terms.includes('구독 취소가 저절로 접수')
      && privacy.includes('«내 계정 → 계정 지우기»') && !terms.includes('연락처로 탈퇴'));
    ok('**정기결제 판의 읽기 쪽 — 평생 이용권 단락은 감춰진다(§4-14)**', terms.includes('<li data-billing="lifetime" hidden>') && !terms.includes('data-billing="subscription" hidden')
      && about.includes('<span data-billing="lifetime" hidden>'));
    ok('이용약관의 체험 · 환불 일수는 지금 값으로 채우는 자리', terms.includes('<span data-trial>2</span>') && terms.includes('<span data-refund>7</span>') && /data-if-trial/.test(terms));

    // ---------------- 사람들 — 운영자 · 지울 사람(작품 · 키 · 구글 · 구독) · 남는 사람
    const root = await mk('ac-root', true);
    const writer = await mk('ac-writer');
    const other = await mk('ac-other');
    const rootIn = await login(base, 'ac-root');
    const wIn = await login(base, 'ac-writer');
    const oIn = await login(base, 'ac-other');

    // 사용자의 IP · 브라우저 정보는 남기지 않는다 — 운영자의 것만(접속 기록)
    const sess = async (uid) => (await pool.query('SELECT ip, user_agent FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [uid])).rows[0];
    ok('**자유 가입판 — 사용자의 로그인 세션에 IP · 브라우저 정보가 없다**', (await sess(writer.id)).ip === '' && (await sess(writer.id)).user_agent === '');
    ok('**운영자의 로그인은 IP 를 남긴다(개인정보를 다루는 사람의 접속 기록)**', (await sess(root.id)).ip !== '');
    {
      const sIn = await login(school, 'ac-other');
      ok('교육기관판은 지금처럼 IP 를 남긴다', sIn.status === 200 && (await one('SELECT ip FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [other.id])).ip !== '');
    }

    // 지울 사람의 것 — 작품(문서 · 판 · 생성 기록과 그 입력 · 논의 · 작업) · AI 키 · 구글 · 이용권 · 운영자 메모
    const made = await api(wIn.cookie, 'project.create', { name: '지울 책', spec: { form: '실용서' }, materials: [{ name: '자료', text: '자료 글' }] });
    const pid = made.pid;
    const docId = (await api(wIn.cookie, 'doc.create', { pid, title: '1장', body: '첫 글' })).id;
    await api(wIn.cookie, 'doc.write', { pid, id: docId, body: '고친 글' });
    const vers = (await pool.query(`SELECT v.id, v.document_id FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.project_id = $1 AND d.legacy_id = $2 ORDER BY v.seq`, [pid, docId])).rows;
    const run = (await pool.query(`INSERT INTO generation_runs (project_id, requested_by, target_document_id, status, provider, model_id, output_tokens, result_version_id)
      VALUES ($1, $2, $3, 'succeeded', 'anthropic', 'test-model', 10, $4) RETURNING id`, [pid, writer.id, vers[0].document_id, vers[vers.length - 1].id])).rows[0].id;
    await pool.query(`INSERT INTO generation_run_inputs (run_id, role, document_id, document_version_id, title) VALUES ($1, 'reference', $2, $3, '1장')`, [run, vers[0].document_id, vers[0].id]);
    await pool.query('UPDATE document_versions SET generation_run_id = $2 WHERE id = $1', [vers[vers.length - 1].id, run]);
    const th = (await pool.query(`INSERT INTO threads (project_id, title) VALUES ($1, '논의') RETURNING id`, [pid])).rows[0].id;
    await pool.query(`INSERT INTO thread_messages (thread_id, project_id, role, text, generation_run_id) VALUES ($1, $2, 'assistant', '답', $3)`, [th, pid, run]);
    await createJobQueue(pool).enqueue({ pid, requestedBy: writer.id, kind: 'agents', title: '자료 분석' });
    await pool.query(`INSERT INTO provider_credentials (id, owner_type, owner_id, provider, key_hint, sealed) VALUES ('cred-ac-writer', 'user', $1, 'anthropic', '…abcd', '{}')`, [String(writer.id)]);
    await pool.query(`INSERT INTO user_identities (provider, subject, user_id, email) VALUES ('google', 'acc-g-writer', $1, 'ac.writer@gmail.com')`, [writer.id]);
    await pool.query(`UPDATE users SET email = 'ac.writer@gmail.com' WHERE id = $1`, [writer.id]);
    const ref = await checkoutRef(wIn.cookie);
    const unused = await checkoutRef(wIn.cookie);
    eq('지울 사람의 첫 결제 — 반영', await hook(pay(ref, 'M-ACC-1', 'acc.writer@example.com')), 200);
    await pool.query(`INSERT INTO billing_refs (kind, ref, user_id, used_at) VALUES ('email', 'acc.writer@example.com', $1, now())`, [writer.id]);
    ok('지우기 전 — 이용 중인 그로블 정기결제', (await one(`SELECT status FROM subscriptions WHERE user_id = $1 AND provider = 'groble'`, [writer.id])).status === 'active');
    eq('운영자 메모', (await edu(rootIn.cookie, 'billing.memo', { userId: writer.id, memo: '전화 문의 있었음' })).status, 200);
    eq('운영자 연장', (await edu(rootIn.cookie, 'billing.extend', { userId: writer.id, days: 1, reason: '시험' })).status, 200);
    ok('**운영자가 한 일의 감사 기록은 IP 를 남긴다 · 사용자가 한 일은 남기지 않는다**', (await one(`SELECT ip FROM audit_logs WHERE action = 'billing.memo' ORDER BY id DESC LIMIT 1`)).ip !== ''
      && (await one(`SELECT ip FROM audit_logs WHERE action = 'project.create' AND actor_user_id = $1`, [writer.id])).ip === '');
    const keepPid = (await api(oIn.cookie, 'project.create', { name: '남는 책', spec: { form: '실용서' }, materials: [{ name: '자료', text: '남는 글' }] })).pid;
    ok('지우기 전 — 작품 · 생성 기록 · 사용량 장부 · 키 · 구글이 있다', (await n('SELECT count(*)::int AS n FROM generation_runs WHERE project_id = $1', [pid])) === 1
      && (await n('SELECT count(*)::int AS n FROM usage_ledger WHERE owner_user_id = $1', [writer.id])) >= 1 && (await n(`SELECT count(*)::int AS n FROM jobs WHERE project_id = $1`, [pid])) >= 1);

    // ---------------- 지우기 — 막는 것부터
    eq('**로그인하지 않으면 401**', (await post(base, '/api/auth/delete', '', { password: 'x' })).status, 401);
    const opDel = await post(base, '/api/auth/delete', rootIn.cookie, { password: 'long-enough-ac-root' });
    ok('**운영자 계정은 지울 수 없다(403)**', opDel.status === 403 && opDel.code === 'operator' && !(await userRow(root.id)).deleted_at);
    const wrong = await post(base, '/api/auth/delete', wIn.cookie, { password: 'not-the-password' });
    ok('**비밀번호가 틀리면 지우지 않는다(403)**', wrong.status === 403 && wrong.code === 'unauthenticated' && !(await userRow(writer.id)).deleted_at && !!(await one('SELECT 1 AS y FROM projects WHERE id = $1', [pid])));
    {
      const sIn = await login(school, 'ac-other');
      eq('**교육기관판에는 계정 지우기 길이 없다(404)**', (await post(school, '/api/auth/delete', sIn.cookie, { password: 'long-enough-ac-other' })).status, 404);
    }

    // ---------------- 지운다
    const mailsBefore = mails.length;
    const del = await post(base, '/api/auth/delete', wIn.cookie, { password: 'long-enough-ac-writer' });
    ok('**지운다 — 200 · 구독 취소 하나를 저절로 접수 · 이 브라우저의 로그인도 끝(쿠키 지움)**', del.status === 200 && del.ok && del.cancels === 1
      && del.setCookie.some((c) => /^se_session=;/.test(c) && /Max-Age=0/.test(c)), JSON.stringify(del));
    const gone = await userRow(writer.id);
    ok('**계정 줄은 빈 껍데기 — 아이디 · 이메일 · 이름 · 비밀번호 · 설정이 없다**', /^_deleted-[0-9a-f]{16}$/.test(gone.login_id) && !LOGIN_RE.test(gone.login_id) && gone.email === null && gone.display_name === ''
      && gone.password_hash === NO_PASSWORD && gone.status === 'disabled' && !!gone.deleted_at && JSON.stringify(gone.settings) === '{}' && gone.last_login_at === null, JSON.stringify(gone));
    // 감사 기록은 옛 아이디로 로그인을 시도하기 전에 본다(그 시도는 «없는 아이디» 기록을 새로 남긴다)
    const auditText = JSON.stringify((await pool.query(`SELECT action, target_id, details, actor_user_id FROM audit_logs WHERE actor_user_id = $1 OR target_id = $2 OR details::text LIKE '%ac-writer%' OR target_id = 'ac-writer'`, [writer.id, String(writer.id)])).rows);
    ok('**감사 기록 — 그 사람이 한 일은 지우고 «계정 지움» 하나만, 운영자의 기록에서는 아이디를 걷었다**', !auditText.includes('ac-writer')
      && (await n(`SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id = $1 AND action <> 'auth.account_delete'`, [writer.id])) === 0
      && (await n(`SELECT count(*)::int AS n FROM audit_logs WHERE actor_user_id = $1 AND action = 'auth.account_delete'`, [writer.id])) === 1
      && (await n(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'billing.memo' AND target_id = $1`, [String(writer.id)])) === 1, auditText.slice(0, 400));
    eq('**그 쿠키로는 더 들어오지 못한다**', (await fetch(base + '/api/me', { headers: { cookie: wIn.cookie } })).status, 401);
    eq('**옛 아이디 · 비밀번호로 로그인하지 못한다**', (await login(base, 'ac-writer')).status, 401);
    const left = async (table, col = 'project_id') => n(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [pid]);
    ok('**작품이 통째로 지워졌다 — 문서 · 판 · 생성 기록 · 논의 · 작업**', (await left('projects', 'id')) === 0 && (await left('documents')) === 0 && (await left('document_versions')) === 0
      && (await left('generation_runs')) === 0 && (await left('threads')) === 0 && (await left('jobs')) === 0
      && (await n('SELECT count(*)::int AS n FROM generation_run_inputs WHERE run_id = $1', [run])) === 0);
    ok('**AI 키 · 세션 · 구글 연결 · 운영 메모 · 사용량 장부가 지워졌다**', (await n(`SELECT count(*)::int AS n FROM provider_credentials WHERE owner_type = 'user' AND owner_id = $1`, [String(writer.id)])) === 0
      && (await n('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [writer.id])) === 0 && (await n('SELECT count(*)::int AS n FROM user_identities WHERE user_id = $1', [writer.id])) === 0
      && (await n('SELECT count(*)::int AS n FROM billing_customers WHERE user_id = $1', [writer.id])) === 0 && (await n('SELECT count(*)::int AS n FROM usage_ledger WHERE owner_user_id = $1', [writer.id])) === 0);
    const refs = (await pool.query('SELECT kind, ref FROM billing_refs WHERE user_id = $1', [writer.id])).rows;
    ok('**결제 참조값 — 정기결제가 걸린 것만 남고(해지 소식을 받으려고) 이메일 잇기 · 쓰지 않은 것은 지운다**', refs.length === 1 && refs[0].kind === 'link' && refs[0].ref === ref && !refs.some((r) => r.ref === unused), JSON.stringify(refs));
    ok('**남는 사람의 작품은 그대로**', !!(await one('SELECT 1 AS y FROM projects WHERE id = $1 AND deleted_at IS NULL', [keepPid])) && !(await userRow(other.id)).deleted_at);

    // 구독 — 저절로 취소 접수 · 이용권 끝 · 운영자 메일(아이디 · 이메일 없이 결제 건 번호로)
    const cr = await one(`SELECT reason, status, next_billing::text AS nb, subscription_id FROM cancel_requests WHERE user_id = $1`, [writer.id]);
    ok('**구독 취소가 저절로 접수됐다(이유: 계정을 지움 · 다음 결제일)**', cr && cr.reason === 'account_deleted' && cr.status === 'open' && cr.nb === nextDay, JSON.stringify(cr));
    eq('**이용권은 모두 지금 끝났다(그로블 · 손 연장)**', await n('SELECT count(*)::int AS n FROM subscriptions WHERE user_id = $1 AND paid_until > now()', [writer.id]), 0);
    const m = mails.slice(mailsBefore);
    ok('**운영자에게 메일 한 통 — 제목에 앱 이름 · 계정 삭제 · 결제 건 번호**', m.length === 1 && m[0].to === 'ops@example.com' && m[0].subject.startsWith('[전자책 오토] ') && m[0].subject.includes('계정 삭제') && m[0].subject.includes('M-ACC-1')
      && m[0].text.includes('그로블') && m[0].text.includes(nextDay), JSON.stringify(m.map((x) => x.subject)));
    const body = m.length ? m[0].subject + '\n' + m[0].text : '';
    ok('**그 메일에는 아이디 · 이메일이 없다**', m.length === 1 && !body.includes('ac-writer') && !body.includes('acc.writer@example.com') && !body.includes('gmail.com'), body);
    ok('**결제 기록은 남되 구매자 정보는 걷었다(결제 건 번호 · 금액은 그대로)**', (await pool.query('SELECT raw, merchant_uid, amount FROM billing_events WHERE user_id = $1', [writer.id])).rows
      .every((e) => !e.raw.data.object.buyer && e.merchant_uid === 'M-ACC-1' && e.amount === 7000));

    // 운영 화면 — 고객 목록에는 없고, 결제 기록 · 구독 취소에는 «지운 계정»으로
    const cust = await edu(rootIn.cookie, 'billing.customers', { q: '' });
    ok('**고객 목록에 지운 계정은 없다**', cust.status === 200 && !cust.customers.some((c) => c.userId === writer.id || /^_deleted-/.test(c.loginId)));
    eq('지운 계정의 한 사람 보기는 404', (await edu(rootIn.cookie, 'billing.customer', { userId: writer.id })).status, 404);
    eq('지운 계정은 늘리지 못한다(404)', (await edu(rootIn.cookie, 'billing.extend', { userId: writer.id, days: 3 })).status, 404);
    const evs = await edu(rootIn.cookie, 'billing.events');
    const myCancel = evs.cancels.find((x) => x.user.userId === writer.id);
    ok('**운영 화면의 구독 취소 — «지운 계정»(아이디 없이) · 결제 건 번호 · 이유 «계정을 지움»**', !!myCancel && myCancel.user.deleted === true && myCancel.user.loginId === '' && myCancel.merchantUid === 'M-ACC-1'
      && myCancel.reasonSay === '계정을 지움' && !JSON.stringify(evs).includes('ac-writer'), JSON.stringify(myCancel));
    ok('운영 화면의 결제 기록 — 지운 계정의 줄에도 아이디가 없다', evs.recent.filter((e) => e.user && e.user.userId === writer.id).every((e) => e.user.deleted && e.user.loginId === '' && !e.buyer.email));

    // 그로블에서 해지되면 — 저절로 «해지 확인»(지운 계정의 결제 소식에는 구매자 정보를 남기지 않는다)
    eq('그로블 해지 예고 웹훅', await hook(sample({ type: 'subscription.cancel_requested', occurredAt: ago(1) }, { sellerReference: ref, merchantUid: 'M-ACC-1', buyer: { displayName: '김작가', email: 'acc.writer@example.com' } })), 200);
    const done = await one(`SELECT status, confirmed_at FROM cancel_requests WHERE user_id = $1`, [writer.id]);
    const lastRaw = (await one(`SELECT raw FROM billing_events WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [writer.id])).raw;
    ok('**그로블 해지 웹훅이 오면 자동 접수한 취소가 «해지 확인»으로 끝난다 · 그 소식에도 구매자 정보 없음**', done.status === 'done' && !!done.confirmed_at && !lastRaw.data.object.buyer, JSON.stringify(done));
    // 지운 계정에 새 결제가 왔다(취소 접수가 없는 결제) — 확인 필요로
    eq('지운 계정에 새 결제', await hook(pay(ref, 'M-ACC-9', 'acc.writer@example.com', { at: new Date().toISOString() })), 200);
    const late = await one(`SELECT review, note, raw FROM billing_events WHERE merchant_uid = 'M-ACC-9'`);
    ok('**지운 계정에 온 결제는 «확인 필요» — 환불 · 해지하라고**', late.review === true && /지운 계정에 온 결제/.test(late.note) && !late.raw.data.object.buyer, late.note);

    // 같은 아이디로 다시 가입할 수 있다(지운 아이디는 풀린다)
    const again = await post(base, '/api/auth/signup', '', { loginId: 'ac-writer', password: 'long-enough-ac-writer-2' });
    ok('**지운 아이디로 다시 가입할 수 있다(새 계정 — 옛 것과 잇지 않는다)**', again.status === 200 && (await one(`SELECT id FROM users WHERE login_id = 'ac-writer'`)).id !== writer.id);

    // ---------------- 취소 접수 뒤 갱신 결제(운영자의 그로블 해지가 늦었다) — «지운 계정»으로 운영자에게
    {
      await mk('ac-late');
      const lIn = await login(base, 'ac-late');
      const lref = await checkoutRef(lIn.cookie);
      eq('늦은 사람의 첫 결제', await hook(pay(lref, 'M-ACC-L1', 'late@example.com')), 200);
      eq('지운다', (await post(base, '/api/auth/delete', lIn.cookie, { password: 'long-enough-ac-late' })).status, 200);
      const before = mails.length;
      eq('갱신 결제가 왔다', await hook(pay(lref, 'M-ACC-L2', 'late@example.com', { reason: 'RENEWAL', at: new Date(Date.now() + 1000).toISOString() })), 200);
      const ev = await one(`SELECT review, note, raw FROM billing_events WHERE merchant_uid = 'M-ACC-L2'`);
      for (let i = 0; i < 40 && mails.length === before; i++) await new Promise((r) => setTimeout(r, 50));   // 메일은 웹훅 답을 늦추지 않게 기다리지 않는다
      const cm = mails.slice(before);
      ok('**지운 뒤 갱신 결제 — 확인 필요 · 운영자 메일(«지운 계정» · 아이디 없이)**', ev.review && /구독 취소를 접수한 뒤 다시 결제됐다/.test(ev.note) && !ev.raw.data.object.buyer
        && cm.length === 1 && cm[0].subject.includes('확인 필요') && cm[0].subject.includes('지운 계정') && cm[0].text.includes('계정을 지운 고객') && !JSON.stringify(cm[0]).includes('ac-late'), JSON.stringify(cm.map((x) => x.subject)));
    }

    // ---------------- 비밀번호 없는 계정(구글로 만든 계정) — 구글로 한 번 더 확인하고 지운다
    {
      // 지우기 확인은 POST 로 시작한다(돌려받은 구글 주소로 간다) — 로그인 · 잇기는 GET 시작
      const round = async ({ cookie = '', mode = 'login', claims = {} } = {}) => {
        let loc; let startCookies;
        if (mode === 'delete') {
          const s = await post(base, '/api/auth/google/delete', cookie, {});
          if (!s.ok) return { startStatus: s.status, code: s.code };
          loc = s.url; startCookies = s.setCookie;
        } else {
          const s = await fetch(base + '/api/auth/google/start' + (mode === 'login' ? '' : '?mode=' + mode), { redirect: 'manual', headers: cookie ? { cookie } : {} });
          loc = s.headers.get('location') || ''; startCookies = s.headers.getSetCookie();
        }
        if (!/^https:\/\/accounts\.google\.com\//.test(loc)) return { startLocation: loc };
        const p = new URL(loc).searchParams;
        const code = 'code-' + randomBytes(6).toString('hex');
        codes.set(code, { challenge: p.get('code_challenge'), claims: { iss: 'https://accounts.google.com', aud: CLIENT.clientId, exp: Math.floor(Date.now() / 1000) + 3600,
          email_verified: true, nonce: p.get('nonce'), ...claims } });
        const oc = cookieOf(startCookies, 'se_oauth');
        const cb = await fetch(base + '/api/auth/google/callback?' + new URLSearchParams({ state: p.get('state'), code }), { redirect: 'manual', headers: { cookie: [cookie, oc].filter(Boolean).join('; ') } });
        const cookies = cb.headers.getSetCookie();
        return { location: cb.headers.get('location') || '', cookies, session: cookieOf(cookies, 'se_session') };
      };
      const g1 = await round({ claims: { sub: 'acc-g-1', email: 'Acc.Google@gmail.com', name: '구글 이름' } });
      const gu = await one(`SELECT id, display_name, email, password_hash FROM users WHERE login_id = 'acc.google'`);
      ok('구글로 만든 계정 — 비밀번호 없음 · 이름은 받지 않는다', g1.location === '/account.html?google=new' && gu && gu.password_hash === NO_PASSWORD && gu.display_name === 'acc.google' && gu.email === 'acc.google@gmail.com', JSON.stringify(gu));
      const trialOf = async (uid) => (await pool.query(`SELECT 1 FROM subscriptions WHERE user_id = $1 AND provider = 'trial'`, [uid])).rowCount > 0;
      const marks = (await pool.query(`SELECT mark FROM trial_marks WHERE kind = 'google'`)).rows.map((r) => r.mark);
      const myMark = createHmac('sha256', 'se-trial-mark').update('google:acc-g-1').digest('hex');   // 이 시험의 billing 은 열쇠 없이(고정 값)
      ok('**구글로 처음 가입 — 무료 체험 · 그 구글 계정의 표시는 되돌릴 수 없는 값으로만(번호 원문 없음)**', await trialOf(gu.id) && g1.cookies.some((c) => /^se_trial=1;/.test(c) && /HttpOnly/.test(c))
        && marks.includes(myMark) && marks.every((m) => /^[0-9a-f]{64}$/.test(m)) && !marks.some((m) => m.includes('acc-g-1')), JSON.stringify(marks));
      const np = await post(base, '/api/auth/delete', g1.session, { password: 'anything-long-enough' });
      ok('**비밀번호 없는 계정은 비밀번호로 지우지 못한다(422 — 구글로 확인)**', np.status === 422 && np.code === 'no_password' && !(await userRow(gu.id)).deleted_at);
      const mis = await round({ cookie: g1.session, mode: 'delete', claims: { sub: 'acc-g-OTHER', email: 'someone@gmail.com' } });
      ok('**다른 구글 계정으로 확인하면 지우지 않는다(mismatch)**', mis.location === '/account.html?google=mismatch' && !(await userRow(gu.id)).deleted_at, mis.location);
      eq('**로그인하지 않고는 지우기 확인을 시작하지 못한다(401)**', (await round({ mode: 'delete' })).startStatus, 401);
      const viaLink = await fetch(base + '/api/auth/google/start?mode=delete', { redirect: 'manual', headers: { cookie: g1.session } });
      ok('**지우기 확인은 링크(GET)로 시작되지 않는다 — 남의 페이지가 링크 하나로 지우기를 시작하지 못하게(로그인 시작으로 읽혀 첫 화면으로)**',
        viaLink.status === 302 && viaLink.headers.get('location') === '/' && !(await userRow(gu.id)).deleted_at, viaLink.headers.get('location'));
      eq('운영자는 지우기 확인을 시작하지 못한다(403)', (await round({ cookie: rootIn.cookie, mode: 'delete' })).startStatus, 403);
      const gd = await round({ cookie: g1.session, mode: 'delete', claims: { sub: 'acc-g-1', email: 'acc.google@gmail.com' } });
      const gg = await userRow(gu.id);
      ok('**이어진 그 구글로 확인하면 지운다 — 로그인 화면(지웠다는 알림) · 쿠키 지움 · 구글 연결 없음**', gd.location === '/login?deleted=1' && gd.cookies.some((c) => /^se_session=;/.test(c) && /Max-Age=0/.test(c))
        && !!gg.deleted_at && gg.email === null && (await n('SELECT count(*)::int AS n FROM user_identities WHERE user_id = $1', [gu.id])) === 0, gd.location);
      const back = await round({ claims: { sub: 'acc-g-1', email: 'acc.google@gmail.com' } });
      const again = (await one(`SELECT id FROM users WHERE login_id = 'acc.google'`)).id;
      ok('그 구글로 다시 오면 새 계정(옛 것과 잇지 않는다)', back.location.startsWith('/account.html?google=new') && again !== gu.id);
      ok('**지우고 같은 구글로 다시 가입해도 무료 체험은 다시 없다(표시는 계정을 지워도 남는다) — «내 계정»에 까닭 한 줄**', back.location === '/account.html?google=new&trial=used'
        && !(await trialOf(again)) && (await pool.query(`SELECT count(*)::int AS n FROM trial_marks WHERE kind = 'google'`)).rows[0].n === marks.length, back.location);
    }

    // ---------------- 무료 체험은 한 사람에게 한 번(최소한의 막음 — §4-13): 같은 브라우저(표시 쿠키)로 새 계정을 만들어도 다시 없다
    {
      const tb = await start({ SE_EDITION: 'open', SE_PURPOSE: 'ebook' }, { billing });   // 가입 고삐(한 곳에서 1시간 5개)가 앞의 가입과 섞이지 않게 새 서버
      const trialOf = async (id) => (await pool.query(`SELECT 1 FROM subscriptions s JOIN users u ON u.id = s.user_id WHERE u.login_id = $1 AND s.provider = 'trial'`, [id])).rowCount > 0;
      const s1 = await post(tb, '/api/auth/signup', '', { loginId: 'tr-one', password: 'long-enough-tr-one' });
      const mark = cookieOf(s1.setCookie, 'se_trial');
      ok('**처음 가입 — 체험 2일 · 이 브라우저에 «체험 받음» 표시(1년 · HttpOnly)**', s1.status === 200 && s1.trial === 2 && !s1.trialUsed && await trialOf('tr-one') && mark === 'se_trial=1'
        && s1.setCookie.some((c) => /^se_trial=1;/.test(c) && /Max-Age=31536000/.test(c) && /HttpOnly/.test(c)), JSON.stringify(s1));
      const s2 = await post(tb, '/api/auth/signup', mark, { loginId: 'tr-two', password: 'long-enough-tr-two' });
      ok('**같은 브라우저로 새 계정 — 가입은 되지만 체험은 없다(trialUsed — 화면이 까닭을 보인다)**', s2.status === 200 && s2.trial === 0 && s2.trialUsed === true && !(await trialOf('tr-two'))
        && !s2.setCookie.some((c) => c.startsWith('se_trial=')), JSON.stringify(s2));
      const s3 = await post(tb, '/api/auth/signup', '', { loginId: 'tr-three', password: 'long-enough-tr-three' });
      ok('다른 브라우저(표시 없음)는 체험을 받는다', s3.trial === 2 && await trialOf('tr-three'));
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('billing.rules', '{"notifyEmail": "ops@example.com", "trialDays": 0}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
      const s4 = await post(tb, '/api/auth/signup', '', { loginId: 'tr-four', password: 'long-enough-tr-four' });
      ok('체험을 0일로 두면 체험도 · 표시 쿠키도 없다', s4.status === 200 && s4.trial === 0 && !s4.trialUsed && !s4.setCookie.some((c) => c.startsWith('se_trial=')) && !(await trialOf('tr-four')));
    }
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    await new Promise((r) => tokenSrv.close(r));
    await pool.query(`DELETE FROM app_settings WHERE key = 'billing.rules'`);
  }
}
