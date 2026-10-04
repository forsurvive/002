// 온라인판 시험 — 실제 PostgreSQL 로 돈다. DATABASE_URL_TEST 가 없으면 건너뛴다(개인판 시험은 tools/test.mjs).
// **이름이 _test 로 끝나는 DB 에만** 붙는다 — 시험은 public 스키마를 통째로 지우고 다시 짓기 때문이다.
//   DATABASE_URL_TEST=postgres://se:…@127.0.0.1:5432/se_test node online/test.mjs

import { createPool } from './db.mjs';
import { migrate, migrationFiles } from './migrate.mjs';

const URL_ = process.env.DATABASE_URL_TEST || '';
if (!URL_) { console.log('  [SKIP] DATABASE_URL_TEST is not set - online tests need PostgreSQL'); process.exit(0); }
const dbName = (() => { try { return new URL(URL_).pathname.replace(/^\//, ''); } catch { return ''; } })();
if (!/_test$/.test(dbName)) { console.log('  [STOP] refusing to run on database "' + dbName + '" (name must end with _test)'); process.exit(1); }

let pass = 0;
const fails = [];
function ok(name, cond, detail) { if (cond) { pass++; return true; } fails.push(name + (detail ? ' — ' + detail : '')); return false; }
const eq = (name, a, b) => ok(name, a === b, JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

const pool = createPool(URL_, { max: 8 });
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

// ---------------------------------------------------------------- 마이그레이션

{
  const first = await migrate(pool);
  eq('마이그레이션이 처음부터 다 선다', first.applied.length, migrationFiles().length);
  eq('두 번째에는 할 일이 없다', (await migrate(pool)).applied.length, 0);
  const t = (await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n;
  ok('표가 다 섰다', t >= 22, String(t));
  // 이미 적용한 파일을 고치면 멈춘다
  await pool.query("UPDATE schema_migrations SET sha256 = 'tampered' WHERE name = '001_initial_schema.sql'");
  let stopped = '';
  try { await migrate(pool); } catch (e) { stopped = String(e.message); }
  ok('적용한 파일이 바뀌면 멈춘다', stopped.includes('was changed'), stopped);
  await pool.query("UPDATE schema_migrations SET sha256 = $1 WHERE name = '001_initial_schema.sql'", [migrationFiles()[0].sha256]);
}

// ---------------------------------------------------------------- 인증

const auth = await import('./auth.mjs');
{
  const h = await auth.hashPassword('correct horse battery', { n: 2 ** 14 });
  ok('비밀번호는 scrypt 로, 매개변수와 함께', h.startsWith('scrypt$16384$8$1$') && !h.includes('correct'));
  ok('맞는 비밀번호', await auth.verifyPassword('correct horse battery', h));
  ok('틀린 비밀번호', !(await auth.verifyPassword('wrong horse battery', h)));
  ok('기본 강도는 OWASP 권장(N=2^17)', (await auth.hashPassword('x'.repeat(10))).startsWith('scrypt$131072$8$1$'));

  eq('짧은 비밀번호는 받지 않는다', (await auth.createUser(pool, { loginId: 'kim', password: 'short' })).code, 'validation');
  eq('이상한 아이디는 받지 않는다', (await auth.createUser(pool, { loginId: 'Kim Lee!', password: 'long-enough-1' })).code, 'validation');
  const u = await auth.createUser(pool, { loginId: 'Writer01', password: 'long-enough-1', displayName: '작가' });
  ok('계정을 만든다(아이디는 소문자로)', u.ok && u.user.login_id === 'writer01');
  eq('같은 아이디는 둘이 될 수 없다', (await auth.createUser(pool, { loginId: 'writer01', password: 'long-enough-2' })).code, 'conflict');

  auth.resetThrottle();
  const bad1 = await auth.login(pool, { loginId: 'writer01', password: 'nope-nope-nope', ip: '1.1.1.1' });
  const bad2 = await auth.login(pool, { loginId: 'ghost', password: 'nope-nope-nope', ip: '1.1.1.1' });
  ok('**틀린 비밀번호와 없는 계정은 같은 말로 거절한다**', !bad1.ok && !bad2.ok && bad1.error === bad2.error);
  const good = await auth.login(pool, { loginId: 'WRITER01', password: 'long-enough-1', ip: '1.1.1.1', userAgent: 'test' });
  ok('로그인하면 세션 토큰을 준다', good.ok && typeof good.token === 'string' && good.token.length >= 40);
  const stored = (await pool.query('SELECT token_hash FROM sessions')).rows.map((r) => r.token_hash.toString('hex')).join(',');
  ok('**DB 에는 토큰 원문이 없다**', !stored.includes(Buffer.from(good.token).toString('hex')) && !stored.includes(good.token));
  const me = await auth.sessionUser(pool, good.token);
  ok('토큰으로 사람을 찾는다', me && me.loginId === 'writer01' && me.displayName === '작가');
  eq('엉뚱한 토큰은 아무도 아니다', await auth.sessionUser(pool, 'x'.repeat(43)), null);
  await auth.logout(pool, good.token);
  eq('로그아웃하면 그 토큰은 끝', await auth.sessionUser(pool, good.token), null);

  // 거듭 틀리면 잠시 막는다 — 맞는 비밀번호여도
  auth.resetThrottle();
  for (let i = 0; i < 5; i++) await auth.login(pool, { loginId: 'writer01', password: 'nope-nope-' + i, ip: '9.9.9.9' });
  eq('다섯 번 틀리면 잠시 막는다', (await auth.login(pool, { loginId: 'writer01', password: 'long-enough-1', ip: '9.9.9.9' })).code, 'rate_limited');
  ok('다른 곳에서는 들어온다', (await auth.login(pool, { loginId: 'writer01', password: 'long-enough-1', ip: '2.2.2.2' })).ok);

  // 비밀번호를 바꾸면 모든 세션이 끊긴다
  const s1 = (await auth.login(pool, { loginId: 'writer01', password: 'long-enough-1', ip: '3.3.3.3' })).token;
  eq('지금 비밀번호가 틀리면 못 바꾼다', (await auth.changePassword(pool, u.user.id, { current: 'nope', next: 'brand-new-pass' })).code, 'unauthenticated');
  ok('비밀번호를 바꾼다', (await auth.changePassword(pool, u.user.id, { current: 'long-enough-1', next: 'brand-new-pass' })).ok);
  eq('바꾸면 지난 세션이 끊긴다', await auth.sessionUser(pool, s1), null);
  const acts = (await pool.query('SELECT action FROM audit_logs ORDER BY id')).rows.map((r) => r.action);
  ok('감사 로그가 남는다(로그인 · 실패 · 비밀번호 변경)', acts.includes('auth.login') && acts.includes('auth.login_failed') && acts.includes('auth.password_changed'));
  ok('**감사 로그에 비밀번호가 없다**', !JSON.stringify((await pool.query('SELECT details, target_id FROM audit_logs')).rows).includes('long-enough-1'));

  const ck = auth.sessionCookie('tok123', { secure: true });
  ok('쿠키는 HttpOnly · SameSite=Lax · Secure', /HttpOnly/.test(ck) && /SameSite=Lax/.test(ck) && /Secure/.test(ck) && ck.startsWith('se_session=tok123'));
  eq('쿠키를 읽는다', auth.readCookie({ headers: { cookie: 'a=1; se_session=tok%2F9; b=2' } }), 'tok/9');
}

// 이어지는 시험 파일 — 각 파일은 run({ pool, ok, eq }) 하나를 내보낸다(이 파일을 거꾸로 import 하지 않는다).
for (const f of ['./test.store.mjs', './test.server.mjs', './test.import.mjs', './test.jobs.mjs', './test.call.mjs']) {
  let mod = null;
  try { mod = await import(f); } catch (e) { if (!(e && e.code === 'ERR_MODULE_NOT_FOUND')) throw e; }
  if (mod && mod.run) await mod.run({ pool, ok, eq });
}

await pool.end();
console.log('');
console.log('  [online] pass ' + pass + ' / fail ' + fails.length);
for (const f of fails) console.log('   x ' + f);
console.log('');
process.exit(fails.length ? 1 : 0);
