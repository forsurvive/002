// 교육기관판 흐름 시험 — 플랫폼 관리자 → 기관 → 라이선스 → 기관 관리자 초대 → 수업 → 강사 초대 → 학생 초대(자리 상한) →
// 수업 프로젝트 → 수업 현황(비용 칸 없음) → 기관 키(쓰기 전용). online/test.mjs 가 이어 부른다.

import { randomBytes } from 'node:crypto';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { resetInviteThrottle } from './edu.mjs';
import { createCredentialService } from '../ai/credentials.mjs';
import { pgCredentialStore } from './credentials.mjs';
import { createKeyTester } from './ai.mjs';
import { createCatalog } from '../ai/catalog.mjs';

const FAKE_ORG_KEY = 'fake-org-key-' + randomBytes(5).toString('hex');

export async function run({ pool, ok, eq }) {
  resetThrottle(); resetInviteThrottle();
  await createUser(pool, { loginId: 'edu-root', password: 'long-enough-root', isPlatformAdmin: true });
  await createUser(pool, { loginId: 'edu-plain', password: 'long-enough-plain' });
  const credentials = createCredentialService({ store: pgCredentialStore(pool), keys: { keys: new Map([[1, randomBytes(32)]]), current: 1 } });
  // 키 연결 시험 — 가짜 회사: «sk-good» 으로 시작하는 키만 맞다
  const fakeCo = { validateCredential: async (c) => (c.apiKey.startsWith('sk-good') ? { ok: true } : { ok: false, reason: 'auth' }) };
  // 가짜 Anthropic: 워크스페이스에 묶이지 않은 키 — 워크스페이스 ID 가 있어야 붙는다(2026-10-06 실제 오류 문구)
  const fakeAnth = { validateCredential: async (c) => (c.workspaceId ? { ok: true } : { ok: false, reason: 'invalid', detail: 'HTTP 400 invalid_request_error: This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header' }) };
  const keyTester = createKeyTester({ catalog: createCatalog([{ provider: 'openai', tier: 'fast', modelId: 'gpt-fake' }, { provider: 'anthropic', tier: 'fast', modelId: 'claude-fake' }]), credentials, providers: { openai: fakeCo, anthropic: fakeAnth } });
  const codeKeys = { keys: new Map([[1, randomBytes(32)]]), current: 1 };
  // 운영자 구독 — 가짜 형편(처음엔 준비 안 됨)
  const subState = { available: false, cliFound: true, tokenSet: false };
  const subscription = { status: () => ({ ...subState }), test: async () => ({ ok: true }) };
  const srv = createOnlineServer({ pool, plan: onlinePlan({}), credentials, keyTester, codeKeys, subscription });
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
    const auto = await edu('edu-root', 'org.create', { name: '약칭 없는 학교' });
    ok('**영문 약칭을 비우면 서버가 지어 붙인다**', auto.ok && /^org-[a-z0-9]{6}$/.test(auto.organization.slug), JSON.stringify(auto));
    eq('기관 이름은 있어야 한다', (await edu('edu-root', 'org.create', { name: ' ', slug: 'x-school' })).status, 422);
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
    // ---------------- 수업의 맡은 강사 — 관리자가 링크 없이 바로 넣고 뺀다
    {
      const inId = (await pool.query("SELECT id FROM users WHERE login_id = 'edu-in'")).rows[0].id;
      const ci = await edu('edu-oa', 'class.instructors', { classId: c2.id });
      ok('맡은 강사 목록 — 그 기관의 강사 · 이 수업을 맡았는지', ci.ok && ci.instructors.some((x) => x.loginId === 'edu-in' && x.assigned === false));
      eq('**강사는 맡은 강사를 정하지 못한다**', (await edu('edu-in', 'class.assign', { classId: c2.id, userId: inId })).status, 404);
      ok('**기관 관리자가 강사를 2반에 넣는다**', (await edu('edu-oa', 'class.assign', { classId: c2.id, userId: inId })).ok
        && (await edu('edu-in', 'class.progress', { classId: c2.id })).ok);
      ok('두 번 넣어도 한 번', (await edu('edu-oa', 'class.assign', { classId: c2.id, userId: inId })).ok && (await edu('edu-oa', 'class.instructors', { classId: c2.id })).instructors.find((x) => x.loginId === 'edu-in').assigned);
      ok('**빼면 그 수업에서만 빠진다(1반은 그대로 · 기관에도 남는다)**', (await edu('edu-oa', 'class.assign', { classId: c2.id, userId: inId, on: false })).ok
        && (await edu('edu-in', 'class.progress', { classId: c2.id })).status === 404 && (await edu('edu-in', 'class.progress', { classId: c1.id })).ok);
      eq('**강사가 아닌 사람은 넣지 못한다**', (await edu('edu-oa', 'class.assign', { classId: c2.id, userId: (await pool.query("SELECT id FROM users WHERE login_id = 'edu-plain'")).rows[0].id })).status, 422);
    }
    eq('학생 초대는 수업을 골라야', (await edu('edu-oa', 'invite.create', { orgId: org.id, role: 'student' })).status, 422);

    // ---------------- 학생 — 자리 상한(2)
    const invS = (await edu('edu-in', 'invite.create', { orgId: org.id, classId: c1.id, role: 'student', maxUses: 10 })).invite;
    ok('강사가 맡은 수업 학생을 초대한다', !!invS);
    const ck = await edu(null, 'invite.check', { code: invS.code });
    ok('**첫 화면의 코드 확인 — 로그인 없이 기관 · 수업 · 역할만 알려 준다**', ck.ok && ck.role === 'student' && ck.className && ck.organizationName && !('id' in ck) && !('organizationId' in ck), JSON.stringify(ck));
    eq('코드 확인은 자리를 쓰지 않는다', (await pool.query('SELECT used_count FROM invites WHERE class_id = $1 AND role = $2 ORDER BY created_at DESC LIMIT 1', [c1.id, 'student'])).rows[0].used_count, 0);
    eq('틀린 코드는 확인되지 않는다', (await edu(null, 'invite.check', { code: 'XXXX-YYYY-ZZZZ' })).status, 404);
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
    const il = await edu('edu-oa', 'invite.list', { orgId: org.id });
    // 2026-10-05 사용자 지시 — 목록에 코드 자체를 보인다(DB 에는 봉해 둔 것만 — 위의 «DB 에는 코드 원문이 없다»는 그대로 지킨다)
    ok('**기관 관리자는 쓸 수 있는 초대 코드 목록을 코드와 함께 본다**', il.ok && il.invites.find((x) => x.id === rv.id).code === rv.code);
    ok('**DB 에는 봉한 것만 — 원문은 여전히 없다**', !JSON.stringify((await pool.query('SELECT * FROM invites WHERE id = $1', [rv.id])).rows).includes(rv.code.replace(/-/g, '')) && !JSON.stringify((await pool.query('SELECT * FROM invites WHERE id = $1', [rv.id])).rows).includes(rv.code));
    await pool.query("UPDATE invites SET code_sealed = jsonb_set(code_sealed, '{tag}', '\"AAAAAAAAAAAAAAAAAAAAAA==\"') WHERE id = $1", [rv.id]);
    ok('봉한 것이 깨졌으면 빈칸(목록은 그대로 선다)', (await edu('edu-oa', 'invite.list', { orgId: org.id })).invites.find((x) => x.id === rv.id).code === '');
    const ln = await fetch(base + '/login?invite=' + rv.code, { headers: { cookie: jar['edu-s1'] }, redirect: 'manual' });
    ok('**이미 로그인한 사람이 초대 링크를 열면 «내 계정»으로 코드를 들고 간다**', ln.status === 302 && ln.headers.get('location') === '/account.html?invite=' + rv.code);
    ok('로그인 전에는 초대 링크가 첫 화면을 연다', (await fetch(base + '/login?invite=' + rv.code, { redirect: 'manual' })).status === 200);
    eq('**학생은 초대 코드 목록을 못 본다**', (await edu('edu-s1', 'invite.list', { orgId: org.id })).status, 404);
    ok('강사는 제 수업 것만 본다', (await edu('edu-in', 'invite.list', { orgId: org.id })).invites.every((x) => x.classId === c1.id));
    await edu('edu-oa', 'invite.revoke', { inviteId: rv.id });
    ok('취소한 코드는 목록에서 빠진다', !(await edu('edu-oa', 'invite.list', { orgId: org.id })).invites.some((x) => x.id === rv.id));
    eq('거둔 코드', (await edu(null, 'invite.accept', { code: rv.code, loginId: 'edu-revoked', password: 'long-enough-rv' })).status, 404);

    // ---------------- 수업 프로젝트 → 수업 현황
    const proj = await api('edu-s1', 'project.create', { classId: c1.id, name: '하나의 과제', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] });
    ok('학생이 수업 프로젝트를 만든다', proj.ok);
    eq('**기관이 등급을 고르지 않았으면 수업 작품은 Balanced 로 시작한다(화면의 «기본»과 같게)**', (await pool.query(`SELECT model_policy->>'alias' AS a FROM projects WHERE id = $1`, [proj.pid])).rows[0].a, 'sonnet');
    const home = await (await fetch(base + '/api/state', { headers: { cookie: jar['edu-s1'] } })).json();
    ok('**«어디에 만들까요?» — 학생에게 열린 수업이 보인다**', home.me.places.some((x) => x.classId === c1.id && x.name && x.orgName));
    ok('**작업실 목록에 수업 작품의 소속(수업 이름)이 보인다**', home.projects.find((x) => x.id === proj.pid).place === '웹소설 1반');
    const solo = await api('edu-s1', 'project.create', { name: '내 것', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] });
    ok('수업을 고르지 않으면 개인 작품(소속 표시 없음)', solo.ok && !(await (await fetch(base + '/api/state', { headers: { cookie: jar['edu-s1'] } })).json()).projects.find((x) => x.id === solo.pid).place);
    ok('같은 수업에 작품을 또 만들 수 있다(개수 제한 없음)', (await api('edu-s1', 'project.create', { classId: c1.id, name: '과제 둘', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).ok);
    ok('수업이 없는 사람에게는 고를 수업이 없다', (await (await fetch(base + '/api/state', { headers: { cookie: jar['edu-plain'] } })).json()).me.places.length === 0);
    const pg = await edu('edu-in', 'class.progress', { classId: c1.id });
    // 학생 하나가 작품을 둘 만들었다 — 작품마다 한 줄
    const one = pg.students.find((s) => s.name === '학생 하나' && s.projectId === proj.pid);
    ok('**강사는 수업 현황을 본다(학생 · 프로젝트 · 최근 작업 — 작품마다 한 줄)**', pg.ok && one && pg.students.filter((s) => s.name === '학생 하나').length === 2 && pg.students.some((s) => s.name === '학생 둘' && !s.projectId));
    ok('**수업 현황에 비용 · 토큰 칸이 없다**', !/cost|token|usd|credential/i.test(JSON.stringify(pg)));
    eq('**학생은 수업 현황을 못 본다**', (await edu('edu-s1', 'class.progress', { classId: c1.id })).status, 404);
    eq('맡지 않은 수업 현황도 못 본다', (await edu('edu-in', 'class.progress', { classId: c2.id })).status, 404);
    ok('기관 관리자는 모든 수업 현황을 본다', (await edu('edu-oa', 'class.progress', { classId: c1.id })).ok);
    ok('**열람이 꺼져 있으면 기관 관리자 현황에 «읽기»가 없다(canRead) · 맡은 강사는 있다**', (await edu('edu-oa', 'class.progress', { classId: c1.id })).canRead === false
      && (await edu('edu-in', 'class.progress', { classId: c1.id })).canRead === true);
    ok('수업 목록(학생 수)', (await edu('edu-oa', 'class.list', { orgId: org.id })).classes.find((c) => c.id === c1.id).students === 2);
    await edu('edu-oa', 'class.archive', { classId: c1.id });
    eq('닫은 수업에는 새로 만들 수 없다', (await api('edu-s1', 'project.create', { classId: c1.id, name: 'x', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).status, 403);
    const invClosed = (await edu('edu-oa', 'invite.create', { orgId: org.id, classId: c1.id, role: 'student' })).invite;
    eq('**닫은 수업의 초대 코드로는 새로 들어오지 못한다**', (await edu(null, 'invite.check', { code: invClosed.code })).code, 'class_closed');
    await edu('edu-oa', 'class.archive', { classId: c1.id, reopen: true });
    // ---------------- 수업 기간 · 이용 기간 없는 기관
    const mkIn = (b) => api('edu-s1', 'project.create', { classId: c1.id, name: 'x', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }], ...b });
    eq('날짜 꼴이 틀리면 422', (await edu('edu-oa', 'class.dates', { classId: c1.id, startsAt: '3월 2일' })).status, 422);
    eq('끝이 시작보다 앞이면 422', (await edu('edu-oa', 'class.dates', { classId: c1.id, startsAt: '2030-03-02', endsAt: '2030-03-01' })).status, 422);
    eq('**강사는 수업 기간을 못 고친다**', (await edu('edu-in', 'class.dates', { classId: c1.id, startsAt: '2030-03-02' })).status, 404);
    const fut = await edu('edu-oa', 'class.dates', { classId: c1.id, startsAt: '2099-03-02', endsAt: '2099-06-30' });
    ok('기관 관리자가 수업 기간을 정한다', fut.ok && !!fut.class.starts_at && !!fut.class.ends_at);
    const early = await mkIn();
    ok('**시작 전 수업에는 새 작품을 만들지 않는다**', early.status === 403 && early.error === '아직 수업 기간이 아닙니다', JSON.stringify(early));
    ok('시작 전 수업은 «어디에 만들까요?»에 없다', !(await (await fetch(base + '/api/state', { headers: { cookie: jar['edu-s1'] } })).json()).me.places.some((x) => x.classId === c1.id));
    await edu('edu-oa', 'class.dates', { classId: c1.id, startsAt: '2020-03-02', endsAt: '2020-06-30' });
    eq('**끝난 수업에도 새로 만들지 않는다**', (await mkIn()).error, '수업 기간이 끝났습니다');
    ok('기간을 비우면 다시 만든다', (await edu('edu-oa', 'class.dates', { classId: c1.id })).class.ends_at === null && (await mkIn({ name: '기간 시험' })).ok);
    const bare = (await edu('edu-root', 'org.create', { name: '기간 없는 기관' })).organization;
    const nc = await edu('edu-root', 'class.create', { orgId: bare.id, name: '1반' });
    ok('**이용 기간이 없는 기관에는 수업을 열지 않는다**', nc.status === 403 && nc.code === 'license_inactive', JSON.stringify(nc));

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
    eq('**기관 관리자는 «작품 열람» 정책을 스스로 켜지 못한다(최상위 관리자만)**', (await edu('edu-oa', 'org.settings', { orgId: org.id, adminCanReadProjects: true })).status, 403);
    ok('최상위 관리자가 «작품 열람» 정책을 켠다', (await edu('edu-root', 'org.settings', { orgId: org.id, adminCanReadProjects: true })).settings.admin_can_read_projects === true);
    const acts = new Set((await pool.query('SELECT action FROM audit_logs WHERE organization_id = $1', [org.id])).rows.map((r) => r.action));
    ok('감사 로그(기관 · 라이선스 · 수업 · 초대 · 수락 · 키 · 설정)', ['org.create', 'license.issue', 'class.create', 'invite.create', 'invite.accept', 'credential.set', 'org.settings', 'class.archive'].every((a) => acts.has(a)), [...acts].join(','));
    // ---------------- 사용량 — 비용을 내는 쪽만
    await pool.query(`INSERT INTO generation_runs (project_id, organization_id, status, provider, model_id, input_tokens, output_tokens, cost_usd, credential_owner_type)
      VALUES ($1, $2, 'succeeded', 'anthropic', 'model-x', 1000, 200, 0.0123, 'organization'), ($1, $2, 'failed', 'anthropic', 'model-x', 10, 0, 0, 'organization')`, [proj.pid, org.id]);
    const us = await edu('edu-oa', 'usage.summary', { orgId: org.id });
    const u0 = us.usage && us.usage[0];
    ok('**기관 관리자는 기관 사용량(추정)을 본다**', us.ok && us.estimated && u0 && u0.calls === 2 && u0.input_tokens === 1010 && u0.cost_usd === 0.0123 && u0.failed === 1, JSON.stringify(us));
    eq('**학생은 기관 사용량을 못 본다**', (await edu('edu-s1', 'usage.summary', { orgId: org.id })).status, 404);
    eq('**강사도 못 본다**', (await edu('edu-in', 'usage.summary', { orgId: org.id })).status, 404);
    eq('학생의 «내 사용량»에 기관 키로 돈 것은 없다', (await edu('edu-s1', 'usage.summary')).usage.length, 0);

    // ---------------- 수업이 끝난 뒤 개인으로 이어 쓰기 — 내 AI 키 · 수업 작품을 개인 작품으로 복사
    const MY_KEY = 'fake-my-key-' + randomBytes(5).toString('hex');
    ok('**세 회사 키를 넣을 수 있다 — ChatGPT · Gemini 도**', (await edu('edu-s2', 'me.key.set', { provider: 'openai', apiKey: 'sk-fake-openai-0001' })).ok
      && (await edu('edu-s2', 'me.key.set', { provider: 'google', apiKey: 'AIza-fake-gemini-0001' })).ok
      && (await edu('edu-s2', 'me.key.list')).credentials.filter((c) => c.status === 'active').map((c) => c.provider).sort().join() === 'google,openai');
    eq('모르는 회사는 받지 않는다', (await edu('edu-s2', 'me.key.set', { provider: 'mystery', apiKey: 'x-0000000000' })).status, 422);
    // 키가 없어 «자료 분석»이 실패로 남은 개인 작품 — 키를 넣으면 저절로 다시 건다
    {
      const s2id = (await pool.query(`SELECT id FROM users WHERE login_id = 'edu-s2'`)).rows[0].id;
      const lone = (await pool.query(`INSERT INTO projects (owner_user_id, name) VALUES ($1, '키 없던 작품') RETURNING id`, [s2id])).rows[0].id;
      await pool.query(`INSERT INTO jobs (project_id, requested_by, kind, title, status, error_message_safe) VALUES ($1, $2, 'agents', '자료 분석', 'failed', 'AI 키가 없어')`, [lone, s2id]);
      const set = await edu('edu-s2', 'me.key.set', { provider: 'openai', apiKey: 'sk-fake-openai-0009' });
      const again = (await pool.query(`SELECT status FROM jobs WHERE project_id = $1 AND kind = 'agents' ORDER BY created_at DESC LIMIT 1`, [lone])).rows[0];
      ok('**키를 넣으면 실패로 남은 «자료 분석»을 저절로 다시 건다**', set.ok && set.prepRetried >= 1 && again.status === 'queued', JSON.stringify({ r: set.prepRetried, again }));
      await pool.query(`UPDATE jobs SET status = 'cancelled', ended_at = now() WHERE project_id = $1 AND status = 'queued'`, [lone]);
    }
    const bad = await edu('edu-s2', 'me.key.test', { provider: 'openai' });
    ok('**연결 확인 — 틀린 키는 «키가 맞지 않습니다»**', bad.ok && bad.verified === false && bad.say === '키가 맞지 않습니다', JSON.stringify(bad));
    await edu('edu-s2', 'me.key.set', { provider: 'openai', apiKey: 'sk-good-openai-0001' });
    const good = await edu('edu-s2', 'me.key.test', { provider: 'openai' });
    ok('**새 키를 넣으면 «키가 맞지 않음»이던 옛 줄은 사라진다**', (await edu('edu-s2', 'me.key.list')).credentials.filter((c) => c.provider === 'openai' && c.status !== 'revoked').length === 1);
    ok('**연결 확인 — 맞는 키는 «연결됩니다», 확인한 때가 남는다**', good.verified === true && (await edu('edu-s2', 'me.key.list')).credentials.find((c) => c.provider === 'openai' && c.status === 'active').lastVerifiedAt > 0);
    ok('**키 지우기 — 그 회사 키가 끊긴다**', (await edu('edu-s2', 'me.key.revoke', { provider: 'openai' })).ok
      && !(await edu('edu-s2', 'me.key.list')).credentials.some((c) => c.provider === 'openai' && c.status === 'active'));
    await edu('edu-s2', 'me.key.set', { provider: 'openai', apiKey: 'sk-fake-openai-0002' });
    await edu('edu-s2', 'me.key.test', { provider: 'openai' });
    // 워크스페이스에 묶이지 않은 Claude 키 — 할 일을 말하고, ID 를 함께 넣으면 붙는다
    await edu('edu-s2', 'me.key.set', { provider: 'anthropic', apiKey: 'sk-ant-noscope-0001' });
    const nows = await edu('edu-s2', 'me.key.test', { provider: 'anthropic' });
    ok('**워크스페이스가 필요한 키는 그렇게 말한다**', nows.verified === false && nows.reason === 'workspace' && /워크스페이스 ID/.test(nows.say), JSON.stringify(nows));
    eq('워크스페이스 ID 꼴이 아니면 받지 않는다', (await edu('edu-s2', 'me.key.set', { provider: 'anthropic', apiKey: 'sk-ant-noscope-0001', workspaceId: '워크 스페이스' })).status, 422);
    eq('**로그인 아이디 같은 것이 들어오면 받지 않는다(브라우저 자동 채움)**', (await edu('edu-s2', 'me.key.set', { provider: 'anthropic', apiKey: 'sk-ant-noscope-0001', workspaceId: 'nnagry' })).status, 422);
    ok('**워크스페이스 ID 와 함께 넣으면 붙는다**', (await edu('edu-s2', 'me.key.set', { provider: 'anthropic', apiKey: 'sk-ant-noscope-0001', workspaceId: ' wrkspc_01Abc ' })).ok
      && (await edu('edu-s2', 'me.key.test', { provider: 'anthropic' })).verified === true
      && (await edu('edu-s2', 'me.key.list')).credentials.find((c) => c.provider === 'anthropic' && c.status === 'active').workspaceId === 'wrkspc_01Abc');
    await edu('edu-s2', 'me.key.revoke', { provider: 'anthropic' });
    ok('**«키가 맞지 않음»으로 남은 키도 지운다**', (await edu('edu-s2', 'me.key.revoke', { provider: 'openai' })).ok
      && !(await edu('edu-s2', 'me.key.list')).credentials.some((c) => c.provider === 'openai' && c.status !== 'revoked'));
    // ---------------- 운영자 구독 — 운영자만 보고 켠다
    eq('**운영자가 아니면 구독 문이 없다(404)**', (await edu('edu-s2', 'me.sub.view')).status, 404);
    eq('운영자가 아니면 켜지도 못한다', (await edu('edu-s2', 'me.sub.set', { on: true })).status, 404);
    const sv = await edu('edu-root', 'me.sub.view');
    ok('운영자는 형편을 본다(토큰 원문 없이)', sv.ok && sv.on === false && sv.available === false && sv.tokenSet === false, JSON.stringify(sv));
    eq('**준비가 안 됐으면 켜지 못한다**', (await edu('edu-root', 'me.sub.set', { on: true })).code, 'not_ready');
    subState.available = true; subState.tokenSet = true;
    ok('**준비되면 켜고 · 끈다(감사 기록)**', (await edu('edu-root', 'me.sub.set', { on: true })).on === true && (await edu('edu-root', 'me.sub.view')).on === true
      && (await edu('edu-root', 'me.memberships')).aiBilling === 'subscription'
      && (await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'ai.billing'`)).rows[0].n === 1);
    ok('연결 확인', (await edu('edu-root', 'me.sub.test')).verified === true);
    ok('끈다', (await edu('edu-root', 'me.sub.set', { on: false })).on === false);
    ok('운영자가 아닌 사람의 memberships 에는 구독 칸이 없다', !('aiBilling' in (await edu('edu-s2', 'me.memberships'))));
    // ---------------- AI 회사 고르기 — 사람 기본 · 작품마다 · 기관
    ok('사람마다 기본 회사를 고른다', (await edu('edu-s2', 'me.ai.set', { provider: 'google' })).ok && (await edu('edu-s2', 'me.memberships')).aiProvider === 'google');
    eq('모르는 회사는 고르지 못한다', (await edu('edu-s2', 'me.ai.set', { provider: 'mystery' })).status, 422);
    const mine2 = await api('edu-s2', 'project.create', { name: '개인 것', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] });
    eq('**키가 없는 회사는 고르지 못한다(2026-10-05 — 키가 있는 회사만)**', (await edu('edu-s2', 'project.ai.set', { pid: mine2.pid, provider: 'openai' })).code, 'no_key');
    eq('사람 기본도 키 없는 회사는 못 고른다', (await edu('edu-s2', 'me.ai.set', { provider: 'anthropic' })).code, 'no_key');
    await edu('edu-s2', 'me.key.set', { provider: 'openai', apiKey: 'sk-good-openai-0002' });
    ok('**작품마다 회사를 고른다(개인 작품 — 키를 넣은 뒤)**', (await edu('edu-s2', 'project.ai.set', { pid: mine2.pid, provider: 'openai' })).ok);
    const st2 = (await (await fetch(base + '/api/state?pid=' + mine2.pid, { headers: { cookie: jar['edu-s2'] } })).json()).project;
    ok('**작품을 열어도 화면 위쪽 신분이 실린다(me.roles)**', (await (await fetch(base + '/api/state?pid=' + proj.pid, { headers: { cookie: jar['edu-s1'] } })).json()).me.roles.includes('student'));
    ok('작품 화면에 고른 회사 · 내 기본 · 키 있는 회사가 실린다', st2.ai && st2.ai.provider === 'openai' && st2.ai.ownerDefault === 'google' && !st2.ai.classWork, JSON.stringify(st2.ai));
    eq('**남의 작품 회사는 못 바꾼다**', (await edu('edu-s1', 'project.ai.set', { pid: mine2.pid, provider: 'google' })).status, 404);
    eq('**수업 작품 회사는 학생이 못 바꾼다(기관이 정한다)**', (await edu('edu-s1', 'project.ai.set', { pid: proj.pid, provider: 'google' })).status, 403);
    ok('기관이 회사를 고른다', (await edu('edu-oa', 'org.settings', { orgId: org.id, aiProvider: 'anthropic' })).settings.ai_provider === 'anthropic');
    eq('**기관도 키 없는 회사는 못 고른다**', (await edu('edu-oa', 'org.settings', { orgId: org.id, aiProvider: 'google' })).code, 'no_key');
    // 기본값 — 처음 넣은 키의 회사가 저절로 기본이 되고, 그 키를 지우면 키가 남은 회사로 옮긴다
    {
      const o2 = (await edu('edu-root', 'org.create', { name: '기본값 기관' })).organization;
      const k1 = await edu('edu-root', 'org.key.set', { orgId: o2.id, provider: 'google', apiKey: 'AIza-fake-key-for-default-0001' });
      eq('**첫 키를 넣으면 그 회사가 기본**', k1.aiProvider, 'google');
      const k2 = await edu('edu-root', 'org.key.set', { orgId: o2.id, provider: 'openai', apiKey: 'sk-fake-key-for-default-0002' });
      eq('둘째 키는 기본을 바꾸지 않는다', k2.aiProvider, 'google');
      eq('**기본 회사의 키를 지우면 남은 키의 회사로 옮긴다**', (await edu('edu-root', 'org.key.revoke', { orgId: o2.id, provider: 'google' })).aiProvider, 'openai');
      eq('키가 모두 없으면 비운다', (await edu('edu-root', 'org.key.revoke', { orgId: o2.id, provider: 'openai' })).aiProvider, '');
    }
    // ---------------- 기관 기본 등급 · 라이선스가 허락하는 회사 · 등급
    ok('기관이 시작 등급을 고른다', (await edu('edu-oa', 'org.settings', { orgId: org.id, aiTier: 'balanced' })).settings.ai_tier === 'balanced');
    eq('모르는 등급은 고르지 못한다', (await edu('edu-oa', 'org.settings', { orgId: org.id, aiTier: 'ultra' })).status, 422);
    eq('**허락 범위는 운영자만 고친다**', (await edu('edu-oa', 'license.limits', { licenseId: lic.id, allowedTiers: ['fast'] })).status, 403);
    eq('모르는 회사는 허락 범위에 못 넣는다', (await edu('edu-root', 'license.limits', { licenseId: lic.id, allowedProviders: ['mystery'] })).status, 422);
    const lim = await edu('edu-root', 'license.limits', { licenseId: lic.id, allowedProviders: ['anthropic', 'google'], allowedTiers: ['balanced', 'fast'] });
    ok('운영자가 허락 범위를 정한다', lim.ok && lim.license.allowed_providers.join() === 'anthropic,google' && lim.license.allowed_model_tiers.join() === 'balanced,fast', JSON.stringify(lim));
    ok('기관 관리자는 허락 범위를 본다', (await edu('edu-oa', 'license.read', { orgId: org.id })).licenses.some((l) => (l.allowed_model_tiers || []).includes('fast')));
    const tierWork = await api('edu-s1', 'project.create', { name: '등급 시험', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }], classId: c1.id });
    const tst = (await (await fetch(base + '/api/state?pid=' + tierWork.pid, { headers: { cookie: jar['edu-s1'] } })).json()).project;
    ok('**새 수업 작품은 기관 시작 등급으로 · 허락된 등급만 고르는 칸에**', tst.model === 'sonnet' && !tst.models.includes('opus') && !tst.models.includes('fable'), JSON.stringify([tst.model, tst.models]));
    // ---------------- 운영 현황 · 감사 기록 · 기관 멈추기
    eq('**운영 현황은 최상위 관리자만**', (await edu('edu-oa', 'ops.overview')).status, 403);
    const ov = await edu('edu-root', 'ops.overview');
    ok('운영 현황 — 작업 · 실패 · 호출 · 사용량(원고 · 키 없이)', ov.ok && Array.isArray(ov.jobs) && Array.isArray(ov.failures) && Array.isArray(ov.usage) && typeof ov.stuck === 'number'
      && !JSON.stringify(ov).includes(MY_KEY) && !JSON.stringify(ov).includes(FAKE_ORG_KEY), JSON.stringify(ov).slice(0, 300));
    const au = await edu('edu-oa', 'audit.list', { orgId: org.id });
    ok('기관 관리자는 제 기관 감사 기록을 본다(누가 · 무엇을)', au.ok && au.entries.some((e) => e.action === 'class.create' && e.actor === 'edu-oa') && au.entries.every((e) => !('ip' in e)));
    eq('**기관 관리자는 전체 감사 기록을 못 본다**', (await edu('edu-oa', 'audit.list')).status, 403);
    eq('**학생은 기관 감사 기록을 못 본다**', (await edu('edu-s1', 'audit.list', { orgId: org.id })).status, 404);
    ok('최상위 관리자는 전체를 본다(골라 보기)', (await edu('edu-root', 'audit.list', { action: 'org.create' })).entries.every((e) => e.action === 'org.create'));
    ok('**감사 기록에 키 원문이 없다**', !JSON.stringify((await edu('edu-root', 'audit.list', { limit: 200 })).entries).includes(FAKE_ORG_KEY));
    eq('**기관 관리자는 제 기관을 멈추지 못한다**', (await edu('edu-oa', 'org.status', { orgId: org.id, status: 'suspended' })).status, 403);
    ok('운영자가 기관을 멈춘다', (await edu('edu-root', 'org.status', { orgId: org.id, status: 'suspended' })).organization.status === 'suspended');
    const halt = await api('edu-s1', 'project.create', { classId: c1.id, name: '멈춤 시험', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] });
    ok('**멈춘 기관에는 새 작품이 서지 않는다**', halt.status === 403 && halt.code === 'org_suspended', JSON.stringify(halt));
    ok('다시 열면 된다', (await edu('edu-root', 'org.status', { orgId: org.id, status: 'active' })).ok
      && (await api('edu-s1', 'project.create', { classId: c1.id, name: '다시 연 뒤', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).ok);
    // ---------------- 계정 멈추기
    eq('**기관 관리자는 계정을 못 멈춘다**', (await edu('edu-oa', 'user.status', { loginId: 'edu-s2', status: 'disabled' })).status, 403);
    eq('자기 계정은 못 멈춘다', (await edu('edu-root', 'user.status', { loginId: 'edu-root', status: 'disabled' })).status, 422);
    ok('운영자가 계정을 멈춘다', (await edu('edu-root', 'user.status', { loginId: 'EDU-S2', status: 'disabled' })).ok);
    eq('**멈춘 계정의 세션은 곧바로 끊긴다**', (await edu('edu-s2', 'me.memberships')).status, 401);
    const relog = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'edu-s2', password: 'long-enough-s2' }) });
    eq('**멈춘 계정은 로그인하지 못한다**', relog.status, 401);
    await edu('edu-root', 'user.status', { loginId: 'edu-s2', status: 'active' });
    await login('edu-s2', 'long-enough-s2');
    ok('다시 열면 로그인한다', (await edu('edu-s2', 'me.memberships')).ok);
    ok('허락 범위를 비우면 모두', (await edu('edu-root', 'license.limits', { licenseId: lic.id, allowedProviders: [], allowedTiers: [] })).license.allowed_providers === null);
    eq('**남의 기관 키는 확인 · 지우기 못 한다**', (await edu('edu-s2', 'org.key.revoke', { orgId: org.id, provider: 'anthropic' })).status, 404);
    const mk = await edu('edu-s1', 'me.key.set', { apiKey: MY_KEY });
    ok('**누구나 내 AI 키를 넣는다 — 돌려받는 것은 끝 네 자리뿐**', mk.ok && !JSON.stringify(mk).includes(MY_KEY) && !JSON.stringify(await edu('edu-s1', 'me.key.list')).includes(MY_KEY)
      && (await edu('edu-s1', 'me.key.list')).credentials.length === 1);
    const st0 = async (who, pid) => (await (await fetch(base + '/api/state?pid=' + pid, { headers: { cookie: jar[who] } })).json()).project;
    const dc = await api('edu-s1', 'doc.create', { pid: proj.pid, title: '세계관', body: '첫 판' });
    await api('edu-s1', 'doc.write', { pid: proj.pid, id: dc.id, body: '둘째 판' });
    await api('edu-s1', 'doc.final', { pid: proj.pid, ids: [dc.id], on: true });
    const before = await st0('edu-s1', proj.pid);
    eq('**남의 수업 작품은 복사하지 못한다**', (await edu('edu-s2', 'project.copy_personal', { pid: proj.pid })).status, 404);
    const cp = await edu('edu-s1', 'project.copy_personal', { pid: proj.pid });
    ok('학생이 수업 작품을 개인 작품으로 복사한다(검증 통과)', cp.ok && cp.verified && cp.pid !== proj.pid, JSON.stringify(cp));
    const row = (await pool.query('SELECT owner_user_id, organization_id, class_id, name FROM projects WHERE id = $1', [cp.pid])).rows[0];
    const me1 = (await pool.query("SELECT id FROM users WHERE login_id = 'edu-s1'")).rows[0].id;
    ok('**복사본은 기관 · 수업에 묶이지 않는다(내 것, 내 키로 — 비용 주체 USER)**', row.owner_user_id === me1 && !row.organization_id && !row.class_id && row.name.endsWith('(개인)'));
    const after = await st0('edu-s1', cp.pid);
    const d0 = before.docs.find((d) => d.id === dc.id); const d1 = after.docs.find((d) => d.id === dc.id);
    ok('**문서 · 판 이력 · 확정본이 그대로 따라간다**', d1 && d1.body === '둘째 판' && d1.isFinal && d1.versions.length === d0.versions.length && JSON.stringify(d1.versions.map((v) => v.body)) === JSON.stringify(d0.versions.map((v) => v.body)), JSON.stringify([d0 && d0.versions.length, d1 && d1.versions.length, d1 && d1.body, d1 && d1.isFinal]));
    ok('원본은 기관에 그대로', (await pool.query('SELECT organization_id FROM projects WHERE id = $1', [proj.pid])).rows[0].organization_id === org.id && (await st0('edu-s1', proj.pid)).docs.length === before.docs.length);
    eq('개인 작품은 다시 복사할 것이 없다', (await edu('edu-s1', 'project.copy_personal', { pid: cp.pid })).status, 422);
    await edu('edu-oa', 'org.settings', { orgId: org.id, allowCopy: false });
    const blocked = await edu('edu-s1', 'project.copy_personal', { pid: proj.pid });
    ok('**기관이 막아 두면 복사하지 못한다**', blocked.status === 403 && blocked.code === 'copy_blocked');
    await edu('edu-oa', 'org.settings', { orgId: org.id, allowCopy: true });
    ok('복사도 감사 로그에', (await pool.query("SELECT 1 FROM audit_logs WHERE action = 'project.copy_personal' AND organization_id = $1", [org.id])).rowCount === 1);

    // ---------------- 아이디 중복 확인 — 맞는 초대 코드를 쥔 사람 · 관리자만
    // 학생 자리(2)가 다 찼다 — 강사 초대 코드로 본다(학생 코드면 자리부터 알려 준다)
    const codeNow = (await edu('edu-oa', 'invite.create', { orgId: org.id, classId: c1.id, role: 'instructor' })).invite.code;
    const la = await edu(null, 'login.available', { code: codeNow, loginId: 'EDU-S1' });
    ok('**가입 중(코드 있음): 쓰고 있는 아이디는 «이미 사용 중»(대소문자 무시)**', la.ok && la.available === false && la.reason === 'taken');
    ok('새 아이디는 «사용할 수 있음»', (await edu(null, 'login.available', { code: codeNow, loginId: 'brand-new-id' })).available === true);
    ok('꼴이 틀린 아이디는 꼴을 알려 준다', (await edu(null, 'login.available', { code: codeNow, loginId: 'A!' })).reason === 'format');
    eq('**코드 없이 아무나 아이디를 더듬지 못한다**', (await edu(null, 'login.available', { loginId: 'edu-s1' })).status, 404);
    eq('학생(관리자 아님)도 코드 없이는 못 묻는다', (await edu('edu-s1', 'login.available', { loginId: 'edu-s2' })).status, 404);
    ok('관리자는 코드 없이 묻는다(강사 계정 만들기)', (await edu('edu-oa', 'login.available', { loginId: 'edu-s2' })).available === false
      && (await edu('edu-root', 'login.available', { loginId: 'someone-new' })).available === true);
    ok('확인만으로 코드 자리를 쓰지 않는다', (await pool.query('SELECT used_count FROM invites ORDER BY created_at DESC LIMIT 1')).rows[0].used_count === 0);

    // ---------------- 계정 직접 만들기 — 최상위 관리자만(기관 관리자 · 강사 · 학생 모두). 비밀번호는 운영자가 정하거나 서버가 짓는다
    const mi = await edu('edu-root', 'member.create', { orgId: org.id, role: 'instructor', classId: c1.id, loginId: 'edu-made-in', displayName: '만든 강사', password: 'support-known-pass' });
    ok('**최상위 관리자가 강사 계정을 직접 만든다(운영자가 정한 비밀번호 — 돌려주지 않는다)**', mi.ok && mi.loginId === 'edu-made-in' && !('password' in mi));
    await login('edu-made-in', 'support-known-pass');
    ok('**만든 강사는 그 수업을 맡는다(수업 현황을 본다)**', (await edu('edu-made-in', 'class.progress', { classId: c1.id })).ok);
    const autoMade = await edu('edu-root', 'member.create', { orgId: org.id, role: 'instructor', loginId: 'edu-made-in2', displayName: '둘' });
    ok('비밀번호를 비우면 서버가 지어 이번에만 돌려준다', autoMade.ok && typeof autoMade.password === 'string' && autoMade.password.length >= 12);
    eq('**기관 관리자는 계정을 직접 만들지 못한다(초대 코드로)**', (await edu('edu-oa', 'member.create', { orgId: org.id, role: 'instructor', loginId: 'edu-made-x2' })).status, 403);
    ok('최상위 관리자는 기관 관리자 계정을 만든다', (await edu('edu-root', 'member.create', { orgId: org.id, role: 'organization_admin', loginId: 'edu-made-oa', displayName: '관리', password: 'support-known-oa' })).ok);
    eq('학생은 수업을 골라야 한다', (await edu('edu-root', 'member.create', { orgId: org.id, role: 'student', loginId: 'edu-made-st' })).status, 422);
    const seatsNow = (await pool.query(`SELECT count(DISTINCT user_id)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'student' AND status = 'active'`, [org.id])).rows[0].n;
    eq('**학생 계정도 자리 상한을 지킨다**', (await edu('edu-root', 'member.create', { orgId: org.id, role: 'student', classId: c1.id, loginId: 'edu-made-st', password: 'student-pass-123' })).code, seatsNow >= 2 ? 'seats_full' : undefined);
    eq('**강사 · 학생은 계정을 만들지 못한다**', (await edu('edu-in', 'member.create', { orgId: org.id, role: 'instructor', loginId: 'edu-made-x' })).status, 404);
    eq('이미 있는 아이디는 만들지 않는다', (await edu('edu-root', 'member.create', { orgId: org.id, role: 'instructor', loginId: 'edu-s1', password: 'whatever-pass-1' })).status, 409);
    const known = await edu('edu-root', 'org.members', { orgId: org.id });
    ok('**운영자가 만든 계정의 비밀번호는 최상위 관리자에게 다시 보인다**', known.members.find((m) => m.loginId === 'edu-made-in').knownPassword === 'support-known-pass');
    ok('**기관 관리자에게는 보이지 않는다**', !(await edu('edu-oa', 'org.members', { orgId: org.id })).members.some((m) => 'knownPassword' in m));
    ok('**DB 에 원문은 없다(봉한 사본만)**', !JSON.stringify((await pool.query("SELECT * FROM users WHERE login_id = 'edu-made-in'")).rows).includes('support-known-pass'));
    await fetch(base + '/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar['edu-made-in'] }, body: JSON.stringify({ current: 'support-known-pass', next: 'only-i-know-this' }) });
    ok('**본인이 바꾸면 운영자도 모른다(사본을 지운다)**', !(await edu('edu-root', 'org.members', { orgId: org.id })).members.find((m) => m.loginId === 'edu-made-in').knownPassword);
    ok('계정 만들기도 감사 로그에(비밀번호 없이)', (await pool.query("SELECT details FROM audit_logs WHERE action = 'member.create'")).rows.length === 3
      && !JSON.stringify((await pool.query("SELECT * FROM audit_logs WHERE action = 'member.create'")).rows).includes('support-known-pass'));

    // ---------------- 한 사람 한 계정 — 같은 초대 코드로 들어와도 계정은 따로다
    const ids = (await pool.query("SELECT id, login_id, password_hash FROM users WHERE login_id IN ('edu-s1', 'edu-s2')")).rows;
    ok('**같은 코드로 들어온 두 학생은 다른 계정(다른 비밀번호)**', ids.length === 2 && ids[0].id !== ids[1].id && ids[0].password_hash !== ids[1].password_hash);
    const p2 = await api('edu-s2', 'project.create', { classId: c1.id, name: '둘의 과제', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] });
    const peek = await fetch(base + '/api/state?pid=' + proj.pid, { headers: { cookie: jar['edu-s2'] } }).then((r) => r.json());
    ok('**같은 수업 학생끼리도 서로의 작품을 못 본다**', p2.ok && peek.ok === false);

    // ---------------- 관리 단추 · 사람 목록 · 비밀번호 재설정 · 내보내기
    const meOf = async (who) => (await (await fetch(base + '/api/me', { headers: { cookie: jar[who] } })).json()).me;
    ok('**운영자 · 기관 관리자에게만 «관리»**', (await meOf('edu-root')).manage === true && (await meOf('edu-oa')).manage === true
      && (await meOf('edu-in')).manage === false && (await meOf('edu-s1')).manage === false);
    ok('학생은 수업이 있다고 안다', (await meOf('edu-s1')).classes === 1);
    const rolesOf = async (who) => ((await meOf(who)).roles || []).join(',');
    ok('**화면 위쪽에 보일 신분 — 최상위 · 기관 관리자 · 강사 · 학생 · 개인**', (await rolesOf('edu-root')).includes('platform_admin') && (await rolesOf('edu-oa')).includes('organization_admin')
      && (await rolesOf('edu-in')).includes('instructor') && (await rolesOf('edu-s1')) === 'student' && (await rolesOf('edu-plain')) === '', [await rolesOf('edu-root'), await rolesOf('edu-s1')].join(' | '));
    ok('신분과 함께 아이디가 온다', (await meOf('edu-s1')).loginId === 'edu-s1' && (await edu('edu-s1', 'me.memberships')).loginId === 'edu-s1');
    const ml = await edu('edu-oa', 'org.members', { orgId: org.id });
    const s1row = ml.members && ml.members.find((m) => m.loginId === 'edu-s1');
    ok('기관 관리자는 사람 목록을 본다(아이디 · 이름 · 역할 · 수업)', ml.ok && s1row && s1row.name === '학생 하나' && s1row.roles.includes('student') && s1row.classes.includes('웹소설 1반'));
    ok('사람 목록에 비밀번호 · 해시가 없다', !/password|scrypt/.test(JSON.stringify(ml)));
    eq('**학생 · 강사는 사람 목록을 못 본다**', (await edu('edu-in', 'org.members', { orgId: org.id })).status, 404);
    // 비밀번호를 잊었을 때 — 재설정 코드(2026-10-05 사용자 결정: 관리자는 남의 비밀번호를 모른다 · 한 단계 위 사람이 코드를 준다)
    const reset = (b) => edu(null, 'password.reset', b);
    const rp = await edu('edu-oa', 'member.reset_password', { orgId: org.id, userId: s1row.userId });
    ok('**기관 관리자가 학생에게 재설정 코드를 준다(비밀번호가 아니다)**', rp.ok && /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(rp.resetCode) && rp.days === 7 && !('tempPassword' in rp));
    ok('코드를 줘도 지금 비밀번호 · 세션은 그대로(기억나면 그냥 들어온다)', (await fetch(base + '/api/me', { headers: { cookie: jar['edu-s1'] } })).status === 200);
    ok('**쓰기 전까지 사용자 목록에서 다시 보인다**', (await edu('edu-oa', 'org.members', { orgId: org.id })).members.find((m) => m.loginId === 'edu-s1').resetCode === rp.resetCode);
    ok('**DB 에 코드 원문이 없다**', !JSON.stringify((await pool.query("SELECT * FROM users WHERE login_id = 'edu-s1'")).rows).includes(rp.resetCode.replace(/-/g, '')));
    const rpi = await edu('edu-in', 'member.reset_password', { orgId: org.id, userId: s1row.userId });
    ok('**맡은 수업의 강사도 제 학생에게 재설정 코드를 준다(새 코드 — 앞 코드는 끝)**', rpi.ok && rpi.resetCode !== rp.resetCode
      && (await edu('edu-in', 'class.progress', { classId: c1.id })).students.find((x) => x.userId === s1row.userId).resetCode === rpi.resetCode);
    eq('**강사는 다른 강사 · 기관 관리자의 비밀번호는 못 건드린다**', (await edu('edu-in', 'member.reset_password', { orgId: org.id, userId: (await pool.query("SELECT id FROM users WHERE login_id = 'edu-oa'")).rows[0].id })).status, 404);
    eq('**지난 코드로는 못 바꾼다**', (await reset({ loginId: 'edu-s1', code: rp.resetCode, password: 'brand-new-s1-pass' })).status, 403);
    eq('짧은 비밀번호는 안 된다', (await reset({ loginId: 'edu-s1', code: rpi.resetCode, password: 'short' })).status, 422);
    const rs = await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'password.reset', loginId: 'EDU-S1', code: rpi.resetCode.toLowerCase(), password: 'brand-new-s1-pass' }) });
    ok('**학생이 코드로 새 비밀번호를 정하고 바로 들어온다(대소문자 무시)**', rs.status === 200 && /se_session=/.test(rs.headers.get('set-cookie') || ''));
    eq('**한 번 쓴 코드는 끝**', (await reset({ loginId: 'edu-s1', code: rpi.resetCode, password: 'another-s1-pass' })).status, 403);
    ok('목록에서도 코드가 사라진다', !(await edu('edu-oa', 'org.members', { orgId: org.id })).members.find((m) => m.loginId === 'edu-s1').resetCode);
    eq('**옛 비밀번호는 끝**', (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'edu-s1', password: 'long-enough-s1' }) })).status, 401);
    await login('edu-s1', 'brand-new-s1-pass');
    ok('새 비밀번호로 들어온다', (await meOf('edu-s1')).loginId === 'edu-s1');
    eq('**운영자 계정은 기관 코드로 재설정할 수 없다(SE2_RECOVERY_CODE 없으면 막힘)**', (await reset({ loginId: 'edu-root', code: 'anything-long-enough-1', password: 'root-new-pass-123' })).status, 403);
    const pw = await fetch(base + '/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar['edu-s1'] }, body: JSON.stringify({ current: 'brand-new-s1-pass', next: 'brand-new-s1-pass2' }) });
    ok('**학생이 제 비밀번호를 바꾼다(이 브라우저는 새로 들어온다)**', pw.status === 200 && /se_session=/.test(pw.headers.get('set-cookie') || ''));
    jar['edu-s1'] = (pw.headers.get('set-cookie') || '').split(';')[0];
    ok('바꾼 비밀번호로만 들어온다', (await meOf('edu-s1')).loginId === 'edu-s1');
    eq('틀린 지금 비밀번호로는 못 바꾼다', (await fetch(base + '/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar['edu-s1'] }, body: JSON.stringify({ current: 'wrong-current', next: 'whatever-long-1' }) })).status, 403);
    eq('**자기 비밀번호는 재설정이 아니라 «바꾸기»로**', (await edu('edu-oa', 'member.reset_password', { orgId: org.id, userId: (await pool.query("SELECT id FROM users WHERE login_id = 'edu-oa'")).rows[0].id })).status, 422);
    const out = await edu('edu-oa', 'member.remove', { orgId: org.id, userId: s1row.userId });
    ok('내보내면 수업에서 빠진다(계정 · 작품은 남는다)', out.ok && (await meOf('edu-s1')).classes === 0 && (await fetch(base + '/api/state?pid=' + proj.pid, { headers: { cookie: jar['edu-s1'] } }).then((r) => r.json())).project.readOnly === true);
    eq('내보낸 사람은 수업 현황에서도 빠진다', (await edu('edu-in', 'class.progress', { classId: c1.id })).students.filter((x) => x.name === '학생 하나').length, 0);

    eq('모르는 문은 404', (await edu('edu-root', 'org.delete', { orgId: org.id })).status, 404);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}
