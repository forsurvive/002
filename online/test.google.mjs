// 구글 로그인 시험 — 자유 가입판의 /api/auth/google/start · /callback(docs/OPEN_EDITION.md §4-9). online/test.mjs 가 이어 부른다.
// 진짜 구글 대신 이 자리의 가짜 토큰 주소를 띄운다 — 가짜도 PKCE(verifier ↔ challenge) · 클라이언트 · 돌아오는 주소를 진짜처럼 본다.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle, NO_PASSWORD, LOGIN_RE } from './auth.mjs';
import { googleConfig, freshStart, authorizeUrl, exchangeCode, readIdToken, loginIdFrom } from './google.mjs';

const CLIENT = { clientId: 'cid-test.apps.googleusercontent.com', clientSecret: 'gsecret-never-shown-1234' };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' }) + '.' + b64(claims) + '.' + Buffer.from('sig').toString('base64url');
const claimsOf = (over = {}) => ({ iss: 'https://accounts.google.com', aud: CLIENT.clientId, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000),
  sub: '1000001', email: 'writer@gmail.com', email_verified: true, name: '구글 작가', ...over });

export async function run({ pool, ok, eq }) {
  // ---------------------------------------------------------------- 낱개(online/google.mjs)
  {
    eq('구글 설정 — 둘 중 하나라도 없으면 끈다', googleConfig({ GOOGLE_CLIENT_ID: 'a' }), null);
    const cfg = googleConfig({ GOOGLE_CLIENT_ID: ' a ', GOOGLE_CLIENT_SECRET: ' b ' });
    ok('구글 설정 — 둘 다 있으면 켠다(앞뒤 빈칸은 지운다)', cfg && cfg.clientId === 'a' && cfg.clientSecret === 'b' && /^https:\/\/oauth2\.googleapis\.com\//.test(cfg.tokenUrl));
    const s = freshStart(); const s2 = freshStart();
    ok('PKCE — challenge 는 verifier 의 SHA-256(base64url)', s.challenge === createHash('sha256').update(s.verifier).digest('base64url') && s.verifier.length >= 43);
    ok('시작마다 state · nonce · verifier 가 새로', s.state !== s2.state && s.nonce !== s2.nonce && s.verifier !== s2.verifier && s.state !== s.nonce);
    const u = new URL(authorizeUrl({ ...CLIENT, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth' }, { redirectUri: 'https://x.example/api/auth/google/callback', ...s }));
    const q = u.searchParams;
    ok('구글로 보내는 주소 — 코드 · S256 · openid email profile 만', q.get('response_type') === 'code' && q.get('code_challenge_method') === 'S256' && q.get('scope') === 'openid email profile'
      && q.get('code_challenge') === s.challenge && q.get('state') === s.state && q.get('nonce') === s.nonce && q.get('client_id') === CLIENT.clientId);
    ok('**구글로 보내는 주소에 시크릿 · verifier 원문이 없다**', !u.toString().includes(CLIENT.clientSecret) && !u.toString().includes(s.verifier));

    const n = 'nonce-1';
    const good = readIdToken(jwt(claimsOf({ nonce: n, email: ' Writer@Gmail.com ', name: '  구글   작가 ' })), { clientId: CLIENT.clientId, nonce: n });
    ok('id_token — 맞으면 sub · 확인된 이메일(소문자) · 이름', good.ok && good.sub === '1000001' && good.email === 'writer@gmail.com' && good.name === '구글 작가', JSON.stringify(good));
    eq('id_token — 발급자가 구글이 아니면', readIdToken(jwt(claimsOf({ nonce: n, iss: 'https://evil.example' })), { clientId: CLIENT.clientId, nonce: n }).reason, 'issuer');
    eq('id_token — 받는 쪽이 이 앱이 아니면', readIdToken(jwt(claimsOf({ nonce: n, aud: 'other-app' })), { clientId: CLIENT.clientId, nonce: n }).reason, 'audience');
    ok('id_token — 받는 쪽이 여럿이어도 이 앱이 들어 있으면', readIdToken(jwt(claimsOf({ nonce: n, aud: ['other', CLIENT.clientId] })), { clientId: CLIENT.clientId, nonce: n }).ok);
    eq('id_token — 기한이 지났으면', readIdToken(jwt(claimsOf({ nonce: n, exp: Math.floor(Date.now() / 1000) - 5 })), { clientId: CLIENT.clientId, nonce: n }).reason, 'expired');
    eq('**id_token — nonce 가 다르면(다른 시작의 토큰)**', readIdToken(jwt(claimsOf({ nonce: 'other' })), { clientId: CLIENT.clientId, nonce: n }).reason, 'nonce');
    eq('id_token — nonce 를 모르면 받지 않는다', readIdToken(jwt(claimsOf({ nonce: '' })), { clientId: CLIENT.clientId, nonce: '' }).reason, 'nonce');
    eq('id_token — 꼴이 아니면', readIdToken('a.b', { clientId: CLIENT.clientId, nonce: n }).reason, 'malformed');
    eq('id_token — 몸통이 JSON 이 아니면', readIdToken('a.' + Buffer.from('nope').toString('base64url') + '.c', { clientId: CLIENT.clientId, nonce: n }).reason, 'malformed');
    eq('**id_token — 확인되지 않은 이메일은 쓰지 않는다**', readIdToken(jwt(claimsOf({ nonce: n, email_verified: false })), { clientId: CLIENT.clientId, nonce: n }).email, '');

    eq('아이디 후보 — 이메일 앞부분을 아이디 규칙대로', loginIdFrom('Kim.Writer+novel@gmail.com'), 'kim.writer-novel');
    ok('아이디 후보 — 짧으면 g- + 무작위', /^g-[0-9a-f]{10}$/.test(loginIdFrom('ab@gmail.com')) && /^g-/.test(loginIdFrom('')));
    ok('아이디 후보 — 언제나 아이디 규칙에 맞는다', ['__x__y@a.com', '한글@a.com', '-.-abc-.@a.com', 'a'.repeat(80) + '@a.com', 'A.B.C@a.com'].every((e) => LOGIN_RE.test(loginIdFrom(e))),
      ['__x__y@a.com', '한글@a.com', '-.-abc-.@a.com'].map(loginIdFrom).join(','));

    // 코드 교환 — 구글의 오류 본문은 돌려주지 않는다(이름만)
    const sent = [];
    const fake = (status, body) => async (url, init) => { sent.push({ url, body: String(init.body) }); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }); };
    const cfgT = { ...CLIENT, tokenUrl: 'https://token.example/token' };
    const x1 = await exchangeCode(cfgT, { code: 'c1', verifier: 'v1', redirectUri: 'https://x.example/cb', fetchImpl: fake(200, { id_token: 'a.b.c', access_token: 'at' }) });
    const form = new URLSearchParams(sent[0].body);
    ok('코드 교환 — 인가 코드 · verifier · 클라이언트 · 돌아오는 주소를 실어 보낸다', x1.ok && x1.idToken === 'a.b.c' && form.get('grant_type') === 'authorization_code' && form.get('code') === 'c1'
      && form.get('code_verifier') === 'v1' && form.get('client_secret') === CLIENT.clientSecret && form.get('redirect_uri') === 'https://x.example/cb');
    const x2 = await exchangeCode(cfgT, { code: 'c', verifier: 'v', redirectUri: 'r', fetchImpl: fake(400, { error: 'invalid_grant', error_description: 'secret ' + CLIENT.clientSecret }) });
    ok('코드 교환 — 거절이면 이름과 상태 번호만(구글의 설명은 버린다)', !x2.ok && x2.reason === 'token_http' && x2.status === 400 && !JSON.stringify(x2).includes(CLIENT.clientSecret));
    eq('코드 교환 — id_token 이 없으면', (await exchangeCode(cfgT, { code: 'c', verifier: 'v', redirectUri: 'r', fetchImpl: fake(200, { access_token: 'x' }) })).reason, 'token_shape');
    eq('코드 교환 — 닿지 않으면', (await exchangeCode(cfgT, { code: 'c', verifier: 'v', redirectUri: 'r', fetchImpl: async () => { throw new Error('ECONNRESET ' + CLIENT.clientSecret); } })).reason, 'token_network');
  }

  // ---------------------------------------------------------------- 가짜 구글(토큰 주소) — 사람이 구글 화면에서 동의한 셈 치고 코드를 내준다
  const codes = new Map();   // 코드 → { challenge, redirectUri, claims }
  const tokenHits = [];
  let tokenDown = false;
  const tokenSrv = createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const f = new URLSearchParams(raw);
    tokenHits.push(Object.fromEntries(f));
    const c = codes.get(f.get('code'));
    codes.delete(f.get('code'));   // 코드는 한 번만
    const pkce = !!c && createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === c.challenge;
    const fine = c && pkce && !tokenDown && f.get('grant_type') === 'authorization_code' && f.get('client_id') === CLIENT.clientId
      && f.get('client_secret') === CLIENT.clientSecret && f.get('redirect_uri') === c.redirectUri;
    res.writeHead(fine ? 200 : 400, { 'content-type': 'application/json' });
    res.end(fine ? JSON.stringify({ access_token: 'at-' + randomBytes(4).toString('hex'), id_token: jwt(c.claims), token_type: 'Bearer', expires_in: 3599 })
      : JSON.stringify({ error: 'invalid_grant', error_description: 'Bad Request ' + CLIENT.clientSecret }));
  });
  await new Promise((r) => tokenSrv.listen(0, '127.0.0.1', r));
  const google = { ...CLIENT, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'http://127.0.0.1:' + tokenSrv.address().port + '/token' };

  resetThrottle();
  await createUser(pool, { loginId: 'gl-root', password: 'long-enough-root', isPlatformAdmin: true });
  const servers = [];
  const start = async (edition = 'open', g = google) => {
    const srv = createOnlineServer({ pool, plan: onlinePlan({ SE_EDITION: edition }), google: g });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    return 'http://127.0.0.1:' + srv.address().port;
  };
  const cookieOf = (list, name) => (list.find((c) => c.startsWith(name + '=')) || '').split(';')[0];
  const getMe = async (base, cookie) => (await (await fetch(base + '/api/me', { headers: { cookie } })).json()).me || null;
  const memberships = async (base, cookie) => (await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ op: 'me.memberships' }) })).json();
  const passwordLogin = async (base, loginId, password) => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId, password }) });
    return { status: r.status, cookie: cookieOf(r.headers.getSetCookie(), 'se_session'), ...(await r.json()) };
  };
  // 한 바퀴 — 시작 → (가짜 구글) → 돌아옴. 어긋난 경우를 만들려고 각 칸을 바꿀 수 있다.
  const round = async (base, { cookie = '', mode = 'login', claims = {}, oauthCookie = null, query = {}, beforeBack = null } = {}) => {
    const s = await fetch(base + '/api/auth/google/start' + (mode === 'link' ? '?mode=link' : ''), { redirect: 'manual', headers: cookie ? { cookie } : {} });
    const loc = s.headers.get('location') || '';
    const startCookies = s.headers.getSetCookie();
    if (!/^https:\/\/accounts\.google\.com\//.test(loc)) return { start: s, startLocation: loc };
    const p = new URL(loc).searchParams;
    const code = 'code-' + randomBytes(6).toString('hex');
    codes.set(code, { challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), claims: claimsOf({ nonce: p.get('nonce'), ...claims }) });
    if (beforeBack) await beforeBack(p);
    const oc = oauthCookie != null ? oauthCookie : cookieOf(startCookies, 'se_oauth');
    const cb = await fetch(base + '/api/auth/google/callback?' + new URLSearchParams({ state: p.get('state'), code, ...query }), { redirect: 'manual', headers: { cookie: [cookie, oc].filter(Boolean).join('; ') } });
    const cookies = cb.headers.getSetCookie();
    return { start: s, startLocation: loc, startCookies, params: p, cb, location: cb.headers.get('location') || '', cookies, session: cookieOf(cookies, 'se_session'), state: p.get('state') };
  };
  const userOf = async (loginId) => (await pool.query('SELECT id, login_id, display_name, email, password_hash, status FROM users WHERE login_id = $1', [loginId])).rows[0] || null;
  const linkOf = async (sub) => (await pool.query(`SELECT i.user_id, i.email, i.last_login_at, u.login_id FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.provider = 'google' AND i.subject = $1`, [sub])).rows[0] || null;

  try {
    const base = await start();

    // ---------------- 켜짐 · 꺼짐 — 로그인 화면이 단추를 세울 근거(/api/setup)
    eq('자유 가입판 + 구글 설정 — /api/setup 이 google: true', (await (await fetch(base + '/api/setup')).json()).google, true);
    const off = await start('open', null);
    eq('자유 가입판 + 설정 없음 — google: false', (await (await fetch(off + '/api/setup')).json()).google, false);
    eq('자유 가입판 + 설정 없음 — 시작 문은 없다(로그인 전 401)', (await fetch(off + '/api/auth/google/start', { redirect: 'manual' })).status, 401);
    const school = await start('school');
    eq('**교육기관판 — 설정을 줘도 구글 로그인은 없다(google: false)**', (await (await fetch(school + '/api/setup')).json()).google, false);
    eq('교육기관판 — 시작 문은 없다(로그인 전 401)', (await fetch(school + '/api/auth/google/start', { redirect: 'manual' })).status, 401);
    eq('교육기관판 — 돌아오는 문도 없다(로그인 전 401)', (await fetch(school + '/api/auth/google/callback?state=x&code=y', { redirect: 'manual' })).status, 401);

    // ---------------- 시작 — 구글로 보내고, 한 번용 값은 서버 표와 쿠키에
    const first = await round(base, { claims: { sub: 'g-new-1', email: 'Novel.Writer@gmail.com', name: '김 작가' } });
    const sc = first.startCookies.find((c) => c.startsWith('se_oauth=')) || '';
    ok('시작 — 302 로 구글에, 돌아오는 주소는 이 자리의 /api/auth/google/callback', first.start.status === 302 && first.params.get('redirect_uri') === base + '/api/auth/google/callback', first.startLocation);
    ok('시작 — state 쿠키는 HttpOnly · SameSite=Lax · 구글 길에만 · 10분', /HttpOnly/.test(sc) && /SameSite=Lax/.test(sc) && /Path=\/api\/auth\/google/.test(sc) && /Max-Age=600/.test(sc), sc);

    // ---------------- 처음 온 구글 계정 — 새 계정(비밀번호 없음) · 곧바로 들어간다
    ok('처음 — «내 계정»으로(가입했다는 알림과 함께) · 세션 쿠키 · state 쿠키는 지운다', first.cb.status === 302 && first.location === '/account.html?google=new' && /^se_session=./.test(first.session)
      && first.cookies.some((c) => /^se_oauth=;/.test(c) && /Max-Age=0/.test(c)), first.location + ' ' + first.cookies.join(' | '));
    const nu = await userOf('novel.writer');
    ok('새 계정 — 아이디는 이메일 앞부분 · 이름은 구글의 이름 · 이메일은 구글이 확인한 것', nu && nu.display_name === '김 작가' && nu.email === 'novel.writer@gmail.com', JSON.stringify(nu));
    ok('**새 계정 — 비밀번호가 없다(어떤 비밀번호로도 들어오지 못한다)**', nu && nu.password_hash === NO_PASSWORD);
    const l1 = await linkOf('g-new-1');
    ok('새 계정 — 구글 계정과 이어졌다', l1 && l1.user_id === nu.id && l1.email === 'novel.writer@gmail.com' && !!l1.last_login_at);
    ok('그 쿠키로 들어와 있다(보통 계정)', (await getMe(base, first.session)).loginId === 'novel.writer');
    eq('**한 번용 값은 쓰고 나면 없다**', (await pool.query('SELECT count(*)::int AS n FROM oauth_states WHERE state = $1', [first.state])).rows[0].n, 0);
    const acts = (await pool.query('SELECT action, details FROM audit_logs WHERE actor_user_id = $1 ORDER BY id', [nu.id])).rows;
    ok('감사 기록 — 가입(구글) · 구글로 로그인', acts.some((a) => a.action === 'auth.signup' && a.details.via === 'google') && acts.some((a) => a.action === 'auth.google_login'), JSON.stringify(acts));
    ok('**가짜 구글이 받은 것 — PKCE verifier 와 클라이언트 시크릿(서버끼리만)**', tokenHits.length >= 1 && tokenHits.at(-1).code_verifier && tokenHits.at(-1).client_secret === CLIENT.clientSecret);
    ok('**시작 주소(브라우저가 보는 것)에 시크릿 · verifier 가 없다**', !first.startLocation.includes(CLIENT.clientSecret) && !first.startLocation.includes(tokenHits.at(-1).code_verifier));

    // 비밀번호 없는 계정 — 비밀번호 로그인 · 바꾸기
    resetThrottle();
    const pw1 = await passwordLogin(base, 'novel.writer', 'anything-long-1');
    const pw2 = await passwordLogin(base, 'gl-nobody', 'anything-long-1');
    ok('**비밀번호 없는 계정에 비밀번호로는 못 들어온다 — 없는 계정과 같은 말로**', pw1.status === 401 && pw2.status === 401 && pw1.error === pw2.error);
    const ch = await fetch(base + '/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json', cookie: first.session }, body: JSON.stringify({ current: '', next: 'brand-new-pass-1' }) });
    const chj = await ch.json();
    ok('**세션만으로는 비밀번호를 정하지 못한다(운영자의 재설정 코드로)**', ch.status === 403 && chj.code === 'no_password' && (await userOf('novel.writer')).password_hash === NO_PASSWORD, JSON.stringify(chj));
    const mm = await memberships(base, first.session);
    ok('내 계정 — 구글: 켜짐 · 이어짐(이메일) · 비밀번호 없음', mm.ok && mm.google.on === true && mm.google.linked === true && mm.google.email === 'novel.writer@gmail.com' && mm.noPassword === true, JSON.stringify(mm.google));

    // ---------------- 다시 오면 — 같은 계정으로(새 계정을 만들지 않는다)
    const again = await round(base, { claims: { sub: 'g-new-1', email: 'novel.writer@gmail.com' } });
    ok('이은 구글 계정 — 그 계정으로 들어간다(첫 화면)', again.location === '/' && (await getMe(base, again.session)).loginId === 'novel.writer', again.location);
    eq('이은 구글 계정 — 계정은 하나 그대로', (await pool.query("SELECT count(*)::int AS n FROM users WHERE login_id LIKE 'novel.writer%'")).rows[0].n, 1);

    // ---------------- 아이디가 겹치면 숫자를 붙인다
    await createUser(pool, { loginId: 'gl-taken', password: 'long-enough-taken' });
    const dup = await round(base, { claims: { sub: 'g-dup', email: 'gl-taken@gmail.com', name: '' } });
    ok('아이디가 겹치면 -2', dup.location === '/account.html?google=new' && !!(await userOf('gl-taken-2')) && (await linkOf('g-dup')).login_id === 'gl-taken-2');
    eq('구글 이름이 비면 이름은 아이디로', (await userOf('gl-taken-2')).display_name, 'gl-taken-2');

    // ---------------- **이메일이 같다고 저절로 잇지 않는다** — 남이 그 이메일로 먼저 만든 계정에 들어가지 않는다
    await createUser(pool, { loginId: 'gl-mail', password: 'long-enough-mail', email: 'same@gmail.com' });
    const same = await round(base, { claims: { sub: 'g-same', email: 'same@gmail.com' } });
    const who = await getMe(base, same.session);
    ok('**이메일이 같은 계정이 있어도 그 계정으로 들어가지 않는다(새 계정)**', same.location === '/account.html?google=new' && who && who.loginId !== 'gl-mail' && (await linkOf('g-same')).login_id === who.loginId, JSON.stringify(who));

    // ---------------- 확인되지 않은 이메일 — 계정 이메일로 쓰지 않는다
    const unv = await round(base, { claims: { sub: 'g-unverified', email: 'maybe@gmail.com', email_verified: false } });
    const unvUser = (await pool.query('SELECT u.email, u.login_id FROM user_identities i JOIN users u ON u.id = i.user_id WHERE i.subject = $1', ['g-unverified'])).rows[0];
    ok('확인되지 않은 이메일은 계정에 넣지 않는다(아이디는 g- + 무작위)', unv.location === '/account.html?google=new' && unvUser && unvUser.email === null && /^g-[0-9a-f]{10}$/.test(unvUser.login_id), JSON.stringify(unvUser));

    // ---------------- 어긋난 돌아옴 — 세션을 주지 않고 까닭의 이름만
    const noCookie = await round(base, { claims: { sub: 'g-x1' }, oauthCookie: '' });
    ok('**state 쿠키가 없으면(다른 브라우저 · 남이 보낸 링크) 받지 않는다**', noCookie.location === '/login?google=state' && !noCookie.session && !(await linkOf('g-x1')));
    const wrongCookie = await round(base, { claims: { sub: 'g-x2' }, oauthCookie: 'se_oauth=' + 'A'.repeat(32) });
    ok('state 쿠키가 다르면 받지 않는다', wrongCookie.location === '/login?google=state' && !wrongCookie.session && !(await linkOf('g-x2')));
    ok('어긋나도 그 한 번용 값은 지운다(다시 쓰지 못한다)', (await pool.query('SELECT count(*)::int AS n FROM oauth_states WHERE state = ANY($1)', [[noCookie.state, wrongCookie.state]])).rows[0].n === 0);
    // 같은 돌아옴을 두 번 — 두 번째는 없다
    const once = await round(base, { claims: { sub: 'g-once' } });
    const replay = await fetch(base + '/api/auth/google/callback?' + new URLSearchParams({ state: once.state, code: 'code-replay' }), { redirect: 'manual', headers: { cookie: cookieOf(once.startCookies, 'se_oauth') } });
    ok('**같은 state 로 두 번 돌아오면 두 번째는 받지 않는다**', once.session && replay.headers.get('location') === '/login?google=state' && !cookieOf(replay.headers.getSetCookie(), 'se_session'));
    const late = await round(base, { claims: { sub: 'g-late' }, beforeBack: async (p) => { await pool.query("UPDATE oauth_states SET created_at = now() - interval '11 minutes' WHERE state = $1", [p.get('state')]); } });
    ok('10분이 지나면 받지 않는다', late.location === '/login?google=expired' && !late.session && !(await linkOf('g-late')));
    const cancel = await round(base, { claims: { sub: 'g-cancel' }, query: { error: 'access_denied' } });
    ok('구글 화면에서 그만두면 «그만뒀다»', cancel.location === '/login?google=cancel' && !cancel.session);
    const badNonce = await round(base, { claims: { sub: 'g-nonce', nonce: 'someone-else' } });
    ok('**nonce 가 다른 토큰은 받지 않는다**', badNonce.location === '/login?google=failed' && !badNonce.session && !(await linkOf('g-nonce')));
    const badAud = await round(base, { claims: { sub: 'g-aud', aud: 'another-app.apps.googleusercontent.com' } });
    ok('**다른 앱에 준 토큰은 받지 않는다**', badAud.location === '/login?google=failed' && !(await linkOf('g-aud')));
    const pkce = await round(base, { claims: { sub: 'g-pkce' }, beforeBack: async (p) => { await pool.query("UPDATE oauth_states SET verifier = 'not-the-verifier' WHERE state = $1", [p.get('state')]); } });
    ok('**PKCE verifier 가 맞지 않으면 구글이 거절 → 받지 않는다**', pkce.location === '/login?google=failed' && !(await linkOf('g-pkce')));
    // 구글이 거절해도 시크릿 · 구글의 설명은 화면 · 콘솔에 싣지 않는다
    const logged = [];
    const keep = console.log;
    console.log = (...a) => { logged.push(a.join(' ')); };
    let down;
    try { tokenDown = true; down = await round(base, { claims: { sub: 'g-down' } }); } finally { tokenDown = false; console.log = keep; }
    ok('구글이 거절하면 «마치지 못했다»', down.location === '/login?google=failed' && !down.session);
    ok('**콘솔에는 까닭의 이름만 — 시크릿 · 구글의 오류 설명이 없다**', logged.some((l) => l.includes('token_http')) && !logged.join('\n').includes(CLIENT.clientSecret) && !logged.join('\n').includes('Bad Request'), logged.join(' | '));

    // ---------------- 멈춘 계정
    await pool.query("UPDATE users SET status = 'disabled' WHERE login_id = 'gl-taken-2'");
    const stopped = await round(base, { claims: { sub: 'g-dup' } });
    ok('**멈춘 계정은 구글로도 못 들어온다**', stopped.location === '/login?google=disabled' && !stopped.session);
    await pool.query("UPDATE users SET status = 'active' WHERE login_id = 'gl-taken-2'");

    // ---------------- 잇기 — 이미 있는 계정(비밀번호)에 로그인한 뒤 «내 계정»에서
    await createUser(pool, { loginId: 'gl-link', password: 'long-enough-link' });
    resetThrottle();
    const li = await passwordLogin(base, 'gl-link', 'long-enough-link');
    const mm0 = await memberships(base, li.cookie);
    ok('잇기 전 — 내 계정은 «켜짐 · 안 이어짐 · 비밀번호 있음»', mm0.google.on && !mm0.google.linked && mm0.noPassword === false, JSON.stringify(mm0.google));
    const noSession = await fetch(base + '/api/auth/google/start?mode=link', { redirect: 'manual' });
    eq('잇기는 로그인한 사람만 — 아니면 로그인 화면으로', noSession.headers.get('location'), '/login');
    const link = await round(base, { cookie: li.cookie, mode: 'link', claims: { sub: 'g-link', email: 'link.me@gmail.com' } });
    ok('잇기 — «내 계정»으로 돌아와 «이었다»', link.location === '/account.html?google=linked' && (await linkOf('g-link')).login_id === 'gl-link', link.location);
    ok('잇기 — 세션은 그대로(새 세션을 만들지 않는다) · 감사 기록', !link.session && (await pool.query("SELECT 1 FROM audit_logs a JOIN users u ON u.id = a.actor_user_id WHERE u.login_id = 'gl-link' AND a.action = 'auth.google_link'")).rowCount === 1);
    eq('잇기 — 계정의 비밀번호 · 이메일은 그대로', (await userOf('gl-link')).email, null);
    const viaGoogle = await round(base, { claims: { sub: 'g-link' } });
    ok('이은 뒤에는 구글로 그 계정에 들어간다', viaGoogle.location === '/' && (await getMe(base, viaGoogle.session)).loginId === 'gl-link');
    resetThrottle();
    ok('이어도 비밀번호로도 그대로 들어간다', (await passwordLogin(base, 'gl-link', 'long-enough-link')).ok);
    const second = await round(base, { cookie: li.cookie, mode: 'link', claims: { sub: 'g-link-2' } });
    ok('우리 계정 하나에 구글 하나 — 다른 구글을 또 이으면 «이미 있음»', second.location === '/account.html?google=one' && !(await linkOf('g-link-2')));
    const same2 = await round(base, { cookie: li.cookie, mode: 'link', claims: { sub: 'g-link' } });
    eq('같은 구글을 또 이으면 «이미 이어짐»', same2.location, '/account.html?google=already');
    await createUser(pool, { loginId: 'gl-other', password: 'long-enough-other' });
    resetThrottle();
    const other = await passwordLogin(base, 'gl-other', 'long-enough-other');
    const steal = await round(base, { cookie: other.cookie, mode: 'link', claims: { sub: 'g-link' } });
    ok('**남의 계정에 이은 구글은 내 계정에 잇지 못한다**', steal.location === '/account.html?google=taken' && (await linkOf('g-link')).login_id === 'gl-link');
    // 잇기를 시작한 사람과 돌아온 사람이 다르면(그사이 다른 계정으로 바꿔 들어왔다) 받지 않는다
    const s0 = await fetch(base + '/api/auth/google/start?mode=link', { redirect: 'manual', headers: { cookie: li.cookie } });
    const p0 = new URL(s0.headers.get('location')).searchParams;
    const code0 = 'code-swap';
    codes.set(code0, { challenge: p0.get('code_challenge'), redirectUri: p0.get('redirect_uri'), claims: claimsOf({ nonce: p0.get('nonce'), sub: 'g-swap-2' }) });
    const back0 = await fetch(base + '/api/auth/google/callback?' + new URLSearchParams({ state: p0.get('state'), code: code0 }),
      { redirect: 'manual', headers: { cookie: [other.cookie, cookieOf(s0.headers.getSetCookie(), 'se_oauth')].join('; ') } });
    ok('**잇기를 시작한 사람이 아닌 세션으로 돌아오면 받지 않는다**', back0.headers.get('location') === '/account.html?google=state' && !(await linkOf('g-swap-2')));

    // ---------------- 처음 설정 전에는 구글로도 새 계정을 받지 않는다(이은 계정의 로그인은 된다)
    {
      const admins = (await pool.query('UPDATE users SET is_platform_admin = false WHERE is_platform_admin RETURNING id')).rows.map((r) => r.id);
      let early; let known;
      try {
        early = await round(base, { claims: { sub: 'g-early', email: 'early@gmail.com' } });
        known = await round(base, { claims: { sub: 'g-new-1' } });
      } finally { await pool.query('UPDATE users SET is_platform_admin = true WHERE id = ANY($1)', [admins]); }
      ok('**운영자(처음 설정)가 없으면 구글로도 가입을 받지 않는다**', early.location === '/login?google=setup' && !(await linkOf('g-early')));
      eq('…이은 계정의 로그인은 그대로', known.location, '/');
    }

    // ---------------- 고삐 — 구글 가입도 자유 가입과 같은 자리를 쓴다(같은 곳 1시간에 5개) · 시작은 10분에 30번
    {
      const fresh = await start();
      const got = [];
      for (let i = 1; i <= 6; i++) got.push((await round(fresh, { claims: { sub: 'g-many-' + i, email: 'many' + i + '@gmail.com' } })).location);
      ok('**같은 곳에서 구글 가입도 1시간에 5개까지(여섯째는 «잠시 뒤»)**', got.slice(0, 5).every((l) => l === '/account.html?google=new') && got[5] === '/login?google=busy' && !(await linkOf('g-many-6')), got.join(','));
      const starts = await start();
      const st = [];
      for (let i = 0; i < 31; i++) st.push((await fetch(starts + '/api/auth/google/start', { redirect: 'manual' })).headers.get('location'));
      ok('시작은 같은 곳에서 10분에 30번까지', st.slice(0, 30).every((l) => l.startsWith('https://accounts.google.com/')) && st[30] === '/login?google=busy', st[30]);
    }

    // ---------------- 운영 화면 — 고객 한 사람에 구글(가려서) · 비밀번호 없음
    {
      resetThrottle();
      const root = await passwordLogin(base, 'gl-root', 'long-enough-root');
      const c = await (await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json', cookie: root.cookie }, body: JSON.stringify({ op: 'billing.customer', userId: nu.id }) })).json();
      ok('고객 — 구글 로그인(이메일은 가려서) · 비밀번호 없음', c.ok && c.customer.user.google && c.customer.user.google.email === 'no***@gmail.com' && c.customer.user.noPassword === true, JSON.stringify(c.customer && c.customer.user));
    }
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
    await new Promise((r) => tokenSrv.close(r));
  }
}
