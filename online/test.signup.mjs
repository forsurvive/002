// 자유 가입 시험 — 자유 가입판(SE_EDITION=open)의 POST /api/auth/signup. online/test.mjs 가 이어 부른다.
// 교육기관판에 가입 문이 없다는 것은 test.server.mjs 가 본다.

import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';

export async function run({ pool, ok, eq }) {
  resetThrottle();
  await createUser(pool, { loginId: 'su-root', password: 'long-enough-root', isPlatformAdmin: true });
  const servers = [];
  const start = async (edition = 'open') => {
    const srv = createOnlineServer({ pool, plan: onlinePlan({ SE_EDITION: edition }) });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const base = 'http://127.0.0.1:' + srv.address().port;
    return async (body, cookie = '') => {
      const r = await fetch(base + (body === 'me' ? '/api/me' : '/api/auth/signup'), body === 'me'
        ? { headers: { cookie } }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0], ...(await r.json().catch(() => ({}))) };
    };
  };
  const has = async (id) => (await pool.query('SELECT 1 FROM users WHERE login_id = $1', [id])).rowCount === 1;

  try {
    const signup = await start();

    // ---------------- 처음 설정 전에는 받지 않는다 — 낯선 사람의 첫 계정이 처음 설정 문을 닫지 못하게
    {
      const admins = (await pool.query('UPDATE users SET is_platform_admin = false WHERE is_platform_admin RETURNING id')).rows.map((r) => r.id);
      const early = await signup({ loginId: 'su-early', password: 'long-enough-early' });
      await pool.query('UPDATE users SET is_platform_admin = true WHERE id = ANY($1)', [admins]);
      ok('**운영자(처음 설정)가 없으면 가입을 받지 않는다**', early.status === 403 && early.code === 'setup_needed' && !(await has('su-early')), JSON.stringify(early));
    }

    // ---------------- 가입하면 곧바로 들어간다 — 보통 계정으로
    const one = await signup({ loginId: 'SU-One', displayName: '  하나  ', password: 'long-enough-one' });
    ok('가입한다(아이디는 소문자로) · 쿠키', one.status === 200 && one.ok && /^se_session=./.test(one.cookie), JSON.stringify(one));
    const me = await signup('me', one.cookie);
    ok('그 쿠키로 바로 들어와 있다', me.ok && me.me.loginId === 'su-one' && me.me.displayName === '하나' && me.me.edition === 'open');
    const row = (await pool.query("SELECT is_platform_admin, status FROM users WHERE login_id = 'su-one'")).rows[0];
    ok('**가입한 계정은 보통 계정이다(운영자가 아니다)**', row.is_platform_admin === false && row.status === 'active');
    const act = (await pool.query("SELECT a.ip, a.details FROM audit_logs a JOIN users u ON u.id = a.actor_user_id WHERE u.login_id = 'su-one' AND a.action = 'auth.signup'")).rows;
    ok('가입은 감사 기록에 남는다(비밀번호 없이)', act.length === 1 && !JSON.stringify(act).includes('long-enough-one'));
    eq('같은 아이디(대소문자만 다른 것도)는 409', (await signup({ loginId: 'su-one', password: 'long-enough-two' })).status, 409);
    eq('짧은 비밀번호는 422', (await signup({ loginId: 'su-short', password: 'short' })).status, 422);
    eq('이상한 아이디는 422', (await signup({ loginId: 'su one!', password: 'long-enough-x' })).status, 422);
    ok('실패한 가입으로는 계정이 생기지 않는다', !(await has('su-short')));
    await signup({ loginId: 'su-long', displayName: '가'.repeat(200), password: 'long-enough-long' });
    eq('이름은 60자까지', (await pool.query("SELECT length(display_name) AS n FROM users WHERE login_id = 'su-long'")).rows[0].n, 60);

    // ---------------- 고삐 — 같은 곳에서 1시간에 새 계정 5개 · 15분에 시도 20번
    {
      const made = await start();
      const r = [];
      for (let i = 1; i <= 6; i++) r.push((await made({ loginId: 'su-many-' + i, password: 'long-enough-many' })).status);
      ok('**같은 곳에서 새 계정은 1시간에 5개까지(여섯째는 429)**', r.slice(0, 5).every((x) => x === 200) && r[5] === 429 && !(await has('su-many-6')), r.join(','));
      // 동시에 몰려와도 — 자리는 묻는 순간에 잡는다(기다리는 동안 같은 빈자리를 보지 못한다)
      const race = await start();
      await Promise.all(Array.from({ length: 12 }, (_, i) => race({ loginId: 'su-race-' + i, password: 'long-enough-race' })));
      eq('**같은 곳에서 동시에 12개를 보내도 새 계정은 5개까지**', (await pool.query("SELECT count(*)::int AS n FROM users WHERE login_id LIKE 'su-race-%'")).rows[0].n, 5);
      const tries = await start();
      const t = [];
      for (let i = 1; i <= 21; i++) t.push((await tries({ loginId: 'su-try-' + i, password: 'short' })).status);
      ok('**같은 곳에서 시도는 15분에 20번까지(스물한째는 429)**', t.slice(0, 20).every((x) => x === 422) && t[20] === 429, t.join(','));
    }

    // ---------------- 교육기관판에는 이 길이 없다(로그인 전 401)
    const school = await start('school');
    eq('교육기관판 — 가입 문은 401(로그인 전)', (await school({ loginId: 'su-school', password: 'long-enough-school' })).status, 401);
    ok('교육기관판 — 계정이 생기지 않는다', !(await has('su-school')));
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
}
