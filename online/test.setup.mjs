// 처음 설정 · 한 번에 띄우기(online/start.mjs) 시험 — online/test.mjs 가 맨 먼저 이어 부른다(계정이 없는 상태가 필요하다).

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { ensureMasterKey, ensureDeps } from './start.mjs';
import { createCredentialService, keysFromEnv } from '../ai/credentials.mjs';
import { pgCredentialStore } from './credentials.mjs';
import { loadCatalog } from './ai.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FAKE_KEY = 'fake-setup-key-' + randomBytes(5).toString('hex');

async function serve(pool, plan, credentials) {
  const srv = createOnlineServer({ pool, plan, credentials });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, base: 'http://127.0.0.1:' + srv.address().port };
}

export async function run({ pool, ok, eq }) {
  // 앞선 인증 시험이 만든 계정을 걷어 «처음» 상태로(시험 DB 에서만 돈다 — 이름이 _test 로 끝나는 DB)
  await pool.query('DELETE FROM sessions'); await pool.query('DELETE FROM audit_logs'); await pool.query('DELETE FROM users');
  const keys = { keys: new Map([[1, randomBytes(32)]]), current: 1 };
  const credentials = createCredentialService({ store: pgCredentialStore(pool), keys });
  const body = { loginId: 'owner', password: 'long-enough-owner', displayName: '주인', apiKey: FAKE_KEY };
  const post = (base, path, b, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });

  // ---------------- 바깥에 열면 출입 열쇠 없이 계정으로만 — 처음 설정은 서버 콘솔의 «설정 코드»가 있어야(낯선 사람이 먼저 차지하지 못하게)
  {
    ok('**온라인판은 SE2_ACCESS_KEY 가 있어도 출입 열쇠를 세우지 않는다(SE2_ONLINE_GATE=1 일 때만)**', !onlinePlan({ SE2_HOST: '0.0.0.0', SE2_PORT: '0', SE2_ACCESS_KEY: 'k'.repeat(24) }).gate
      && !!onlinePlan({ SE2_HOST: '0.0.0.0', SE2_PORT: '0', SE2_ACCESS_KEY: 'k'.repeat(24), SE2_ONLINE_GATE: '1' }).gate);
    const { srv, base } = await serve(pool, onlinePlan({ SE2_HOST: '0.0.0.0', SE2_PORT: '0', SE2_ACCESS_KEY: 'k'.repeat(24) }), credentials);
    const st = await (await fetch(base + '/api/setup')).json();
    ok('바깥에 열면 «설정 필요 · 설정 코드 칸» 을 알린다', st.needed === true && st.code === true);
    ok('설정 코드는 XXXX-XXXX-XXXX 꼴', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(srv.setupCode), srv.setupCode);
    eq('**설정 코드 없이는 처음 설정 거절(403)**', (await post(base, '/api/setup', body)).status, 403);
    eq('틀린 설정 코드도 거절', (await post(base, '/api/setup', { ...body, setupCode: 'AAAA-BBBB-CCCC' })).status, 403);
    eq('계정이 생기지 않았다', (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
    const r = await post(base, '/api/setup', { ...body, setupCode: srv.setupCode.toLowerCase() });
    ok('**맞는 설정 코드면 처음 설정(소문자도)**', r.status === 200 && (await r.json()).ok);
    ok('출입 열쇠 없이 화면 · 로그인이 열린다', (await fetch(base + '/login')).status !== 401 && (await post(base, '/api/auth/login', { loginId: body.loginId, password: body.password })).status === 200);
    for (const path of ['/', '/school.html', '/manage.html']) {
      const rr = await fetch(base + path, { redirect: 'manual' });
      ok('로그인 전 ' + path + ' → 첫 화면(/login)', rr.status === 302 && rr.headers.get('location') === '/login');
    }
    await new Promise((r2) => srv.close(r2));
    await pool.query('DELETE FROM sessions'); await pool.query('DELETE FROM audit_logs'); await pool.query('DELETE FROM provider_credentials'); await pool.query('DELETE FROM users');
  }
  {
    const { srv, base } = await serve(pool, onlinePlan({ SE2_HOST: '0.0.0.0', SE2_PORT: '0' }), credentials);
    for (let i = 0; i < 5; i++) await post(base, '/api/setup', { ...body, setupCode: 'WRNG-CODE-' + i });
    eq('**설정 코드 맞히기는 몇 번 틀리면 잠시 막힌다**', (await post(base, '/api/setup', { ...body, setupCode: srv.setupCode })).status, 429);
    await new Promise((r2) => srv.close(r2));
  }

  // ---------------- 출입 열쇠를 지나온 요청이면 처음 설정
  const gateKey = randomBytes(12).toString('hex');
  const basic = { authorization: 'Basic ' + Buffer.from('x:' + gateKey).toString('base64') };
  const { srv, base } = await serve(pool, onlinePlan({ SE2_HOST: '0.0.0.0', SE2_PORT: '0', SE2_ACCESS_KEY: gateKey, SE2_ONLINE_GATE: '1' }), credentials);
  try {
    eq('열쇠가 없으면 문 앞에서(401)', (await fetch(base + '/api/setup')).status, 401);
    const quiet = await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"op":"invite.accept"}' });
    ok('**화면 안의 요청에는 브라우저 로그인 창을 띄우지 않는다(code:gate → 화면이 다시 연다)**', quiet.status === 401 && !quiet.headers.get('www-authenticate') && (await quiet.json()).code === 'gate');
    const nav = await fetch(base + '/school.html', { headers: { 'sec-fetch-mode': 'navigate' } });
    const navText = await nav.text();
    ok('**열쇠 전에는 어느 주소든 로그인 화면(열쇠 칸) — 브라우저 창을 띄우지 않는다**', nav.status === 200 && !nav.headers.get('www-authenticate') && navText.includes('login.js') && !navText.includes('school.js'));
    eq('열쇠 전에도 로그인 화면의 파일은 받는다', (await fetch(base + '/login.js')).status, 200);
    eq('열쇠 전에는 다른 화면 파일을 주지 않는다', (await (await fetch(base + '/school.js')).text()).includes('joinBox'), false);
    const gp = (key, headers = {}) => fetch(base + '/api/gate', { method: 'POST', headers: { 'content-type': 'application/json', origin: base, ...headers }, body: JSON.stringify({ key }) });
    eq('틀린 열쇠는 받지 않는다', (await gp('wrong-key')).status, 401);
    eq('남의 Origin 에서 온 열쇠는 받지 않는다', (await gp(gateKey, { origin: 'https://evil.example' })).status, 403);
    const g = await gp(gateKey);
    const gck = (g.headers.get('set-cookie') || '').split(';')[0];
    ok('**맞는 열쇠 → 출입 쿠키(열쇠 원문은 쿠키에 없다)**', g.status === 200 && /^se_gate=/.test(gck) && !gck.includes(gateKey) && /HttpOnly/.test(g.headers.get('set-cookie')));
    ok('출입 쿠키로 지나간다', (await (await fetch(base + '/api/setup', { headers: { cookie: gck } })).json()).needed === true);
    ok('틀린 쿠키로는 못 지나간다', (await (await fetch(base + '/api/setup', { headers: { cookie: 'se_gate=' + 'x'.repeat(43) } })).json()).code === 'gate');
    for (let i = 0; i < 5; i++) await gp('wrong-' + i);
    eq('**열쇠 맞히기는 몇 번 틀리면 잠시 막힌다**', (await gp(gateKey)).status, 429);
    const st = await (await fetch(base + '/api/setup', { headers: basic })).json();
    ok('계정이 없으면 «처음 설정» 을 알린다', st.ok && st.needed === true && st.ai === true);
    eq('짧은 비밀번호는 받지 않는다', (await post(base, '/api/setup', { ...body, password: 'short' }, basic)).status, 422);
    const r = await post(base, '/api/setup', body, basic);
    const out = await r.json();
    const ck = (r.headers.get('set-cookie') || '').split(';')[0];
    ok('**처음 설정 — 계정을 만들고 바로 들어간다**', r.status === 200 && out.ok && /^se_session=/.test(ck), JSON.stringify(out));
    ok('**응답에 키가 없다**', !JSON.stringify(out).includes(FAKE_KEY));
    const me = await (await fetch(base + '/api/me', { headers: { ...basic, cookie: ck } })).json();
    ok('그 계정으로 들어와 있다', me.me && me.me.loginId === 'owner' && me.me.displayName === '주인');
    const u = (await pool.query("SELECT id, is_platform_admin FROM users WHERE login_id = 'owner'")).rows[0];
    ok('처음 계정은 운영자', u.is_platform_admin === true);
    const resolved = await credentials.resolve({ ownerUserId: u.id }, 'anthropic');
    ok('**AI 키가 그 계정의 키로 봉해 들어갔다**', resolved.ok && resolved.credential.apiKey === FAKE_KEY);
    ok('**DB 에 키 원문이 없다**', !JSON.stringify((await pool.query('SELECT * FROM provider_credentials')).rows).includes(FAKE_KEY));
    ok('감사 로그(처음 설정 · 키 등록, 키 값 없이)', (await pool.query("SELECT action, details FROM audit_logs WHERE action IN ('setup.first_admin', 'credential.set')")).rows.length === 2
      && !JSON.stringify((await pool.query('SELECT * FROM audit_logs')).rows).includes(FAKE_KEY));
    eq('**두 번째 처음 설정은 없다(409)**', (await post(base, '/api/setup', { ...body, loginId: 'intruder' }, basic)).status, 409);
    eq('계정이 생기면 «설정 필요» 도 사라진다', (await (await fetch(base + '/api/setup', { headers: basic })).json()).needed, false);
  } finally {
    await new Promise((res) => srv.close(res));
  }

  // ---------------- 운영자 도구 — 계정 목록 · 비밀번호 재설정(운영자가 자기 비밀번호를 잊었을 때)
  {
    const { spawnSync } = await import('node:child_process');
    const admin = join(ROOT, 'online', 'admin.mjs');
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL_TEST };
    const ls = spawnSync(process.execPath, [admin, 'list-users'], { env, encoding: 'utf8' });
    ok('계정 목록 — 운영자 표시 · ASCII 만 · 비밀번호 없음', ls.status === 0 && /owner\s+OPERATOR/.test(ls.stdout) && /^[\x00-\x7f]*$/.test(ls.stdout) && !/scrypt/.test(ls.stdout), ls.stdout + ls.stderr);
    const rp = spawnSync(process.execPath, [admin, 'reset-password', 'owner'], { env, encoding: 'utf8', input: 'reset-by-shell-1\n' });
    ok('셸에서 운영자 비밀번호를 다시 정한다', rp.status === 0 && /password changed: owner/.test(rp.stdout), rp.stdout + rp.stderr);
    const { login } = await import('./auth.mjs');
    ok('새 비밀번호로 들어온다', (await login(pool, { loginId: 'owner', password: 'reset-by-shell-1', ip: '7.7.7.7' })).ok);
    eq('짧은 비밀번호는 거절', spawnSync(process.execPath, [admin, 'reset-password', 'owner'], { env, encoding: 'utf8', input: 'short\n' }).status, 1);
  }

  // ---------------- 한 번에 띄우기 — 마스터 키는 Secrets 가 먼저, 없으면 저장소 밖 파일
  {
    const file = join(ROOT, '.tmp', 'test-master-' + randomBytes(3).toString('hex') + '.key');
    const env1 = {};
    eq('Secrets 에도 파일에도 없으면 만든다', ensureMasterKey(env1, file), 'file-new');
    ok('만든 키는 32바이트 · env 에 꽂힌다', keysFromEnv(env1).current === 1 && keysFromEnv(env1).problems.length === 0);
    ok('파일은 나만 읽는다(0600)', process.platform === 'win32' || (statSync(file).mode & 0o077) === 0);
    const env2 = {};
    eq('다시 띄우면 같은 파일을 쓴다', ensureMasterKey(env2, file), 'file');
    eq('같은 키', env2.CREDENTIALS_KEY_V1, env1.CREDENTIALS_KEY_V1);
    const env3 = { CREDENTIALS_KEY_V1: randomBytes(32).toString('base64') };
    eq('Secrets 에 있으면 그것을', ensureMasterKey(env3, file), 'secrets');
    rmSync(file, { force: true });
    ok('data/ 는 저장소 밖', /^data\/$/m.test(readFileSync(join(ROOT, '.gitignore'), 'utf8')));
    eq('pg 가 있으면 설치하지 않는다', ensureDeps({ run: () => { throw new Error('should not run'); } }), 'present');
    let ran = null;
    eq('없으면 npm ci', ensureDeps({ root: join(ROOT, '.tmp', 'nowhere'), run: (cmd, args) => { ran = args.join(' '); return { status: 0 }; } }), 'installed');
    eq('lock 그대로(ci)', ran, 'ci --no-audit --no-fund');
  }

  // ---------------- 모델 표 — 저장소의 config/models.json 이 바로 쓸 수 있는 꼴이다
  {
    const c = loadCatalog();
    ok('모델 표에 문제가 없다', c.problems.length === 0, c.problems.join(' / '));
    ok('세 tier 가 다 있다(Anthropic)', ['high_reasoning', 'balanced', 'fast'].every((t) => c.catalog.resolve('anthropic', t)));
    ok('개인판 별칭이 tier 로 이어진다', c.aliasTiers && c.aliasTiers.opus === 'high_reasoning' && c.aliasTiers.sonnet === 'balanced');
    ok('가격이 있어 비용을 추정한다', c.catalog.entries().every((e) => e.price && e.price.inputPerMTok > 0 && e.price.outputPerMTok > 0));
  }
}
