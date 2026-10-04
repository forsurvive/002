// 교육기관판 흐름 시험 — 플랫폼 관리자 → 기관 → 라이선스 → 기관 관리자 초대 → 수업 → 강사 초대 → 학생 초대(자리 상한) →
// 수업 프로젝트 → 수업 현황(비용 칸 없음) → 기관 키(쓰기 전용). online/test.mjs 가 이어 부른다.

import { randomBytes } from 'node:crypto';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { resetInviteThrottle } from './edu.mjs';
import { createCredentialService } from '../ai/credentials.mjs';
import { pgCredentialStore } from './credentials.mjs';

const FAKE_ORG_KEY = 'fake-org-key-' + randomBytes(5).toString('hex');

export async function run({ pool, ok, eq }) {
  resetThrottle(); resetInviteThrottle();
  await createUser(pool, { loginId: 'edu-root', password: 'long-enough-root', isPlatformAdmin: true });
  await createUser(pool, { loginId: 'edu-plain', password: 'long-enough-plain' });
  const credentials = createCredentialService({ store: pgCredentialStore(pool), keys: { keys: new Map([[1, randomBytes(32)]]), current: 1 } });
  const srv = createOnlineServer({ pool, plan: onlinePlan({}), credentials });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const jar = {};
  const login = async (id, pw) => {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw }) });
    jar[id] = (r.headers.get('set-cookie') || '').split(';')[0];
  };
  const edu = async (who, op, b = {}) => {
    const r = await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json', ...(who && jar[who] ? { cookie: jar[who] } : {}) }, body: JSON.stringify({ op, ...b }) });
    const out = { status: r.status, ...(await r.json()) };
    const ck = r.headers.get('set-cookie');
    if (ck && b.loginId) jar[b.loginId] = ck.split(';')[0];
    return out;
  };
  const api = async (who, op, b = {}) => {
    const r = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar[who] }, body: JSON.stringify({ op, ...b }) });
    return { status: r.status, ...(await r.json()) };
  };
  await login('edu-root', 'long-enough-root'); await login('edu-plain', 'long-enough-plain');

  try {
    // ---------------- 기관 · 라이선스 — 플랫폼 관리자만
    eq('로그인 없이는 401', (await edu(null, 'org.list')).status, 401);
    eq('**보통 사람은 기관을 만들지 못한다**', (await edu('edu-plain', 'org.create', { name: '몰래', slug: 'sneaky' })).status, 403);
    eq('주소 이름 형식', (await edu('edu-root', 'org.create', { name: '학교', slug: 'Bad Slug' })).status, 422);
    const org = (await edu('edu-root', 'org.create', { name: '스토리 학교', slug: 'story-school' })).organization;
    ok('기관을 만든다', org && org.id && org.status === 'active');
    eq('같은 주소 이름은 둘이 될 수 없다', (await edu('edu-root', 'org.create', { name: '또', slug: 'story-school' })).status, 409);
    eq('**보통 사람은 라이선스를 못 낸다**', (await edu('edu-plain', 'license.issue', { orgId: org.id, days: 30 })).status, 403);
    const lic = (await edu('edu-root', 'license.issue', { orgId: org.id, plan: 'education_standard', days: 90, seatLimit: 2 })).license;
    ok('라이선스(학생 자리 2)', lic && lic.status === 'active' && lic.seat_limit === 2);

    // ---------------- 기관 관리자 초대 → 수락(새 계정)
    const invA = (await edu('edu-root', 'invite.create', { orgId: org.id, role: 'organization_admin' })).invite;
    ok('초대 코드는 한 번 보인다(사람이 받아 적기 쉬운 꼴)', /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(invA.code));
    ok('**DB 에는 코드 원문이 없다**', !JSON.stringify((await pool.query('SELECT * FROM invites')).rows).includes(invA.code) && !JSON.stringify((await pool.query('SELECT * FROM invites')).rows).includes(invA.code.replace(/-/g, '')));
    const accA = await edu(null, 'invite.accept', { code: invA.code.toLowerCase(), loginId: 'edu-oa', password: 'long-enough-oa', displayName: '관리 선생' });
    ok('초대로 계정을 만들고 바로 들어간다(소문자로 쳐도)', accA.ok && accA.role === 'organization_admin' && !!jar['edu-oa'], JSON.stringify(accA));
    eq('한 번 쓴 1회용 코드는 끝', (await edu(null, 'invite.accept', { code: invA.code, loginId: 'edu-oa2', password: 'long-enough-oa' })).status, 404);
    ok('기관 관리자는 제 기관을 본다', (await edu('edu-oa', 'org.list')).organizations.some((o) => o.id === org.id));
    eq('**기관 관리자도 라이선스는 못 낸다**', (await edu('edu-oa', 'license.issue', { orgId: org.id, days: 999 })).status, 403);
    const lr = await edu('edu-oa', 'license.read', { orgId: org.id });
    ok('기관 관리자는 라이선스를 읽는다', lr.ok && lr.licenses.length === 1 && lr.seatsUsed === 0);

    // ---------------- 수업 · 강사
    const c1 = (await edu('edu-oa', 'class.create', { orgId: org.id, name: '웹소설 1반' })).class;
    const c2 = (await edu('edu-oa', 'class.create', { orgId: org.id, name: '웹소설 2반' })).class;
    ok('수업을 만든다', c1 && c2);
    eq('**보통 사람은 남의 기관에 수업을 못 만든다(404)**', (await edu('edu-plain', 'class.create', { orgId: org.id, name: 'x' })).status, 404);
    const invI = (await edu('edu-oa', 'invite.create', { orgId: org.id, classId: c1.id, role: 'instructor' })).invite;
    ok('강사 초대 → 수락', (await edu(null, 'invite.accept', { code: invI.code, loginId: 'edu-in', password: 'long-enough-in', displayName: '김 강사' })).ok);
    eq('**강사는 맡지 않은 수업에 초대하지 못한다**', (await edu('edu-in', 'invite.create', { orgId: org.id, classId: c2.id, role: 'student' })).status, 404);
    eq('**강사는 강사를 초대하지 못한다**', (await edu('edu-in', 'invite.create', { orgId: org.id, classId: c1.id, role: 'instructor' })).status, 404);
    eq('학생 초대는 수업을 골라야', (await edu('edu-oa', 'invite.create', { orgId: org.id, role: 'student' })).status, 422);

    // ---------------- 학생 — 자리 상한(2)
    const invS = (await edu('edu-in', 'invite.create', { orgId: org.id, classId: c1.id, role: 'student', maxUses: 10 })).invite;
    ok('강사가 맡은 수업 학생을 초대한다', !!invS);
    const sa = await edu(null, 'invite.accept', { code: invS.code, loginId: 'edu-s1', password: 'long-enough-s1', displayName: '학생 하나' });
    const sb = await edu(null, 'invite.accept', { code: invS.code, loginId: 'edu-s2', password: 'long-enough-s2', displayName: '학생 둘' });
    ok('학생 둘이 들어온다', sa.ok && sb.ok && sa.role === 'student');
    const sc = await edu(null, 'invite.accept', { code: invS.code, loginId: 'edu-s3', password: 'long-enough-s3' });
    ok('**자리가 다 차면 셋째는 못 들어온다 — 학생 말로**', sc.status === 403 && sc.code === 'seats_full' && !/\$|원|비용/.test(sc.error));
    eq('못 들어온 사람의 계정은 생기지 않는다', (await pool.query("SELECT count(*)::int AS n FROM users WHERE login_id = 'edu-s3'")).rows[0].n, 0);
    eq('이미 있는 아이디로는 새 계정 불가', (await edu(null, 'invite.accept', { code: invS.code, loginId: 'edu-s1', password: 'long-enough-xx' })).status, 403);
    const mem = await edu('edu-s1', 'me.memberships');
    ok('학생은 제 기관 · 수업을 안다', mem.organizations.some((o) => o.id === org.id && o.roles.includes('student')) && mem.classes.some((c) => c.id === c1.id && c.role === 'student'));
    eq('**학생은 라이선스를 못 본다**', (await edu('edu-s1', 'license.read', { orgId: org.id })).status, 404);

    // 틀린 코드를 거듭 치면 잠시 막는다
    resetInviteThrottle();
    for (let i = 0; i < 10; i++) await edu(null, 'invite.accept', { code: 'AAAA-BBBB-CCC' + i, loginId: 'guess' + i, password: 'long-enough-g' });
    eq('**코드 맞히기는 막힌다(429)**', (await edu(null, 'invite.accept', { code: invS.code, loginId: 'guessed', password: 'long-enough-g' })).status, 429);
    resetInviteThrottle();

    // 마지막 한 자리를 둘이 동시에 — 하나만
    const last = (await edu('edu-oa', 'invite.create', { orgId: org.id, classId: c2.id, role: 'instructor', maxUses: 1 })).invite;
    const both = await Promise.all([1, 2].map((n) => edu(null, 'invite.accept', { code: last.code, loginId: 'edu-race' + n, password: 'long-enough-race' })));
    eq('**1회용 코드를 동시에 써도 한 사람만**', both.filter((r) => r.ok).length, 1);
    eq('진 쪽의 빈 계정은 남지 않는다', (await pool.query("SELECT count(*)::int AS n FROM users WHERE login_id LIKE 'edu-race%'")).rows[0].n, 1);
    // 끝난 코드 · 거둔 코드
    const old = (await edu('edu-oa', 'invite.create', { orgId: org.id, classId: c2.id, role: 'student' })).invite;
    await pool.query("UPDATE invites SET expires_at = now() - interval '1 second' WHERE id = $1", [old.id]);
    eq('기한이 지난 코드', (await edu(null, 'invite.accept', { code: old.code, loginId: 'edu-late', password: 'long-enough-late' })).status, 404);
    const rv = (await edu('edu-oa', 'invite.create', { orgId: org.id, classId: c2.id, role: 'student' })).invite;
    await edu('edu-oa', 'invite.revoke', { inviteId: rv.id });
    eq('거둔 코드', (await edu(null, 'invite.accept', { code: rv.code, loginId: 'edu-revoked', password: 'long-enough-rv' })).status, 404);

    // ---------------- 수업 프로젝트 → 수업 현황
    const proj = await api('edu-s1', 'project.create', { classId: c1.id, name: '하나의 과제', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] });
    ok('학생이 수업 프로젝트를 만든다', proj.ok);
    const pg = await edu('edu-in', 'class.progress', { classId: c1.id });
    const one = pg.students.find((s) => s.name === '학생 하나');
    ok('**강사는 수업 현황을 본다(학생 · 프로젝트 · 최근 작업)**', pg.ok && one && one.projectId === proj.pid && pg.students.some((s) => s.name === '학생 둘' && !s.projectId));
    ok('**수업 현황에 비용 · 토큰 칸이 없다**', !/cost|token|usd|credential/i.test(JSON.stringify(pg)));
    eq('**학생은 수업 현황을 못 본다**', (await edu('edu-s1', 'class.progress', { classId: c1.id })).status, 404);
    eq('맡지 않은 수업 현황도 못 본다', (await edu('edu-in', 'class.progress', { classId: c2.id })).status, 404);
    ok('기관 관리자는 모든 수업 현황을 본다', (await edu('edu-oa', 'class.progress', { classId: c1.id })).ok);
    ok('수업 목록(학생 수)', (await edu('edu-oa', 'class.list', { orgId: org.id })).classes.find((c) => c.id === c1.id).students === 2);
    await edu('edu-oa', 'class.archive', { classId: c1.id });
    eq('닫은 수업에는 새로 만들 수 없다', (await api('edu-s1', 'project.create', { classId: c1.id, name: 'x', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).status, 403);
    await edu('edu-oa', 'class.archive', { classId: c1.id, reopen: true });

    // ---------------- 기관 키 — 쓰기 전용, 기관 프로젝트는 기관 키로
    eq('**학생은 기관 키를 넣지 못한다**', (await edu('edu-s1', 'org.key.set', { orgId: org.id, provider: 'anthropic', apiKey: FAKE_ORG_KEY })).status, 404);
    eq('**강사도 못 넣는다**', (await edu('edu-in', 'org.key.set', { orgId: org.id, provider: 'anthropic', apiKey: FAKE_ORG_KEY })).status, 404);
    const ks = await edu('edu-oa', 'org.key.set', { orgId: org.id, provider: 'anthropic', apiKey: FAKE_ORG_KEY });
    ok('**기관 관리자가 넣고, 돌려받는 것은 끝 네 자리뿐**', ks.ok && ks.credential.keyHint === '…' + FAKE_ORG_KEY.slice(-4) && !JSON.stringify(ks).includes(FAKE_ORG_KEY));
    ok('목록에도 원문 없음', !JSON.stringify(await edu('edu-oa', 'org.key.list', { orgId: org.id })).includes(FAKE_ORG_KEY));
    const res = await credentials.resolve({ organizationId: org.id, ownerUserId: 'whoever' }, 'anthropic');
    ok('**기관 프로젝트는 기관 키로 돈다(비용 주체 ORGANIZATION)**', res.ok && res.ownerType === 'organization' && res.credential.apiKey === FAKE_ORG_KEY);
    ok('**DB · 감사 로그에 키 원문 없음**', !JSON.stringify((await pool.query('SELECT * FROM provider_credentials')).rows).includes(FAKE_ORG_KEY)
      && !JSON.stringify((await pool.query('SELECT * FROM audit_logs')).rows).includes(FAKE_ORG_KEY));

    // ---------------- 기관 설정 · 감사 로그
    eq('학생은 기관 설정을 못 고친다', (await edu('edu-s1', 'org.settings', { orgId: org.id, adminCanReadProjects: true })).status, 404);
    ok('기관 관리자는 «작품 열람» 정책을 켠다', (await edu('edu-oa', 'org.settings', { orgId: org.id, adminCanReadProjects: true })).settings.admin_can_read_projects === true);
    const acts = new Set((await pool.query('SELECT action FROM audit_logs WHERE organization_id = $1', [org.id])).rows.map((r) => r.action));
    ok('감사 로그(기관 · 라이선스 · 수업 · 초대 · 수락 · 키 · 설정)', ['org.create', 'license.issue', 'class.create', 'invite.create', 'invite.accept', 'credential.set', 'org.settings', 'class.archive'].every((a) => acts.has(a)), [...acts].join(','));
    eq('모르는 문은 404', (await edu('edu-root', 'org.delete', { orgId: org.id })).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}
