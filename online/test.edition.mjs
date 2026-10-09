// 판 스위치 시험 — SE_EDITION=open(자유 가입판)에서 기관 · 수업 · 초대에 딸린 문은 404, 남긴 기능은 그대로. online/test.mjs 가 이어 부른다.
// 편집기 문 · 격리 · 문지기는 test.server.mjs 가 두 판에서 각각 돈다.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { editionOf, eduOpAllowed, isOpenOnlyOp, SCHOOL_ONLY_OPS, ORG_SCOPED_OPS } from './edition.mjs';
import { createEdu } from './edu.mjs';
import { createBilling } from './billing/service.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export async function run({ pool, ok, eq }) {
  // ---------------- 판 읽기 — 모르는 값은 닫힌 쪽(school)
  eq('판 — 적지 않으면 school', editionOf({}), 'school');
  eq('판 — open', editionOf({ SE_EDITION: ' Open ' }), 'open');
  eq('**판 — 모르는 값은 school(가입 문이 저절로 열리지 않게)**', editionOf({ SE_EDITION: 'opne' }), 'school');
  ok('school 에서는 모든 교육기관 문이 그대로', [...SCHOOL_ONLY_OPS, ...ORG_SCOPED_OPS].every((op) => eduOpAllowed('school', op, { orgId: 'x' })));
  ok('open 에서 기관 문은 없다 · 운영자 전체 문은 기관을 가리킬 때만 없다',
    [...SCHOOL_ONLY_OPS].every((op) => !eduOpAllowed('open', op)) && [...ORG_SCOPED_OPS].every((op) => eduOpAllowed('open', op, {}) && !eduOpAllowed('open', op, { orgId: 'x' })));
  {
    // 판 스위치가 가리키는 문이 실제로 있는 문인가 — 이름이 어긋나면 막는 줄이 헛돈다
    const names = createEdu({ pool }).OP_NAMES;
    const stray = [...SCHOOL_ONLY_OPS, ...ORG_SCOPED_OPS].filter((op) => !names.includes(op));
    ok('판 스위치의 문 이름은 모두 교육기관 문 표에 있다', stray.length === 0, stray.join(' '));
    ok('이용권 · 결제 문은 자유 가입판에만', isOpenOnlyOp('me.pass') && isOpenOnlyOp('me.pass.checkout') && isOpenOnlyOp('billing.events') && !isOpenOnlyOp('me.key.set')
      && !eduOpAllowed('school', 'billing.customers') && eduOpAllowed('open', 'billing.customers') && eduOpAllowed('open', 'me.pass'));
    // 화면(school.js)이 부르는 문은 모두 있는 문이다 — 자유 가입판 문 표(이용권 · 고객 · 결제)까지. 이름이 어긋나면 단추가 404 를 받는다.
    const used = [...new Set([...readFileSync(join(ROOT, 'web', 'school.js'), 'utf8').matchAll(/edu\('([a-z_.]+)'/g)].map((m) => m[1]))];
    const all = createEdu({ pool, edition: 'open', billing: createBilling({ pool }) }).OP_NAMES;
    const missing = used.filter((op) => !all.includes(op));
    ok('**화면이 부르는 교육기관 문은 모두 문 표에 있다**', used.length > 30 && missing.length === 0, missing.join(' ') || String(used.length));
  }

  resetThrottle();
  const mk = async (id, admin = false) => (await createUser(pool, { loginId: id, password: 'long-enough-' + id, isPlatformAdmin: admin })).user;
  const root = await mk('ed-root', true); const plain = await mk('ed-plain'); const inst = await mk('ed-inst');
  await mk('ed-temp');
  // 교육기관판에서 쓰던 자료가 같은 DB 에 있어도(판을 바꿔 띄워도) 자유 가입판은 그 길을 열지 않는다
  const q1 = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const org = (await q1("INSERT INTO organizations (name, slug) VALUES ('판 학교', 'ed-school') RETURNING id")).id;
  await q1("INSERT INTO licenses (organization_id, plan, ends_at) VALUES ($1, 'trial', now() + interval '30 days') RETURNING id", [org]);
  const cls = (await q1("INSERT INTO classes (organization_id, name) VALUES ($1, '판 1반') RETURNING id", [org])).id;
  await pool.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'student'), ($1,$3,'instructor')", [org, plain.id, inst.id]);
  await pool.query("INSERT INTO class_members (class_id, organization_id, user_id, role) VALUES ($1,$2,$3,'student'), ($1,$2,$4,'instructor')", [cls, org, plain.id, inst.id]);
  const classPid = (await q1("INSERT INTO projects (owner_user_id, organization_id, class_id, name) VALUES ($1, $2, $3, '수업 과제') RETURNING id", [plain.id, org, cls])).id;

  const servers = [];
  const open = async (edition) => {
    const srv = createOnlineServer({ pool, plan: onlinePlan({ SE_EDITION: edition }) });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const base = 'http://127.0.0.1:' + srv.address().port;
    const jar = {};
    for (const id of ['ed-root', 'ed-plain', 'ed-inst']) {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: 'long-enough-' + id }) });
      jar[id] = (r.headers.get('set-cookie') || '').split(';')[0];
    }
    const call = async (path, who, b) => {
      const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(who ? { cookie: jar[who] } : {}) }, body: JSON.stringify(b) });
      return { status: r.status, ...(await r.json().catch(() => ({}))) };
    };
    const get = (path, who) => fetch(base + path, { headers: who ? { cookie: jar[who] } : {}, redirect: 'manual' });
    return { edu: (who, op, b = {}) => call('/api/edu', who, { op, ...b }), api: (who, op, b = {}) => call('/api', who, { op, ...b }), get };
  };

  try {
    const O = await open('open');
    const S = await open('school');

    // ---------------- 뺀 문은 open 에서 404 — 운영자가 불러도, 로그인 없이 불러도
    const gone = [];
    for (const op of SCHOOL_ONLY_OPS) {
      const r = await O.edu('ed-root', op, { orgId: org, classId: cls, pid: classPid, code: 'ABCD-EFGH-JKLM', loginId: 'ed-new', role: 'student' });
      if (r.status !== 404) gone.push(op + ':' + r.status);
    }
    ok('**open — 기관 · 이용 기간 · 수업 · 초대 · 기관 키 · 수업 현황 · 복사 문은 모두 404**', gone.length === 0, gone.join(' '));
    for (const op of ['invite.accept', 'invite.check', 'login.available']) eq('open — 로그인 없이도 ' + op + ' 는 404', (await O.edu(null, op, { code: 'ABCD-EFGH-JKLM', loginId: 'ed-x', password: 'long-enough-x' })).status, 404);
    ok('open — 그 문으로는 계정이 생기지 않는다', (await pool.query("SELECT 1 FROM users WHERE login_id IN ('ed-x', 'ed-new')")).rowCount === 0);
    for (const op of ORG_SCOPED_OPS) eq('open — ' + op + ' 에 기관을 실으면 404', (await O.edu('ed-root', op, { orgId: org, stageKey: 'world', data: {} })).status, 404);

    // ---------------- 남긴 것은 그대로 — 운영 화면(운영자) · 내 키 · 내 사용량 · 계정 멈추기
    ok('open — 운영 현황', (await O.edu('ed-root', 'ops.overview')).ok);
    ok('open — 감사 기록(전체)', (await O.edu('ed-root', 'audit.list')).ok);
    ok('open — 단계 · 강의 카드(전체 기본)', (await O.edu('ed-root', 'workflow.view')).ok);
    ok('open — 내 사용량', (await O.edu('ed-plain', 'usage.summary')).ok);
    ok('open — 내 AI 키 목록', (await O.edu('ed-plain', 'me.key.list')).ok);
    const mm = await O.edu('ed-plain', 'me.memberships');
    ok('open — 내 계정은 판을 안다', mm.ok && mm.edition === 'open');
    eq('school — 내 계정의 판', (await S.edu('ed-plain', 'me.memberships')).edition, 'school');
    ok('open — 운영자가 계정을 멈추고 다시 연다', (await O.edu('ed-root', 'user.status', { loginId: 'ed-temp', status: 'disabled' })).ok && (await O.edu('ed-root', 'user.status', { loginId: 'ed-temp', status: 'active' })).ok);
    eq('open — 보통 사람에게 운영 현황은 없다', (await O.edu('ed-plain', 'ops.overview')).status, 403);

    // ---------------- 화면에 알리기 — me.edition · 수업 자리 없음
    {
      const re = await (await O.get('/api/me', 'ed-plain')).json();
      ok('**open — me.edition 과 «수업 없음»(내 수업 · 수업 자리 · 기관 신분이 서지 않는다)**', re.me.edition === 'open' && re.me.classes === 0 && re.me.places.length === 0 && re.me.roles.length === 0 && re.me.manage === false);
      const ro = await (await O.get('/api/me', 'ed-root')).json();
      ok('open — 운영자에게는 관리(운영 화면) 단추', ro.me.manage === true && ro.me.roles.join() === 'platform_admin');
      const rs = await (await S.get('/api/me', 'ed-plain')).json();
      ok('school — 같은 사람이 수업 · 신분을 그대로 본다', rs.me.edition === 'school' && rs.me.classes === 1 && rs.me.roles.includes('student'));
      eq('open — 상태에도 판', (await (await O.get('/api/state', 'ed-plain')).json()).me.edition, 'open');
      eq('open — 첫 화면(로그인 전)도 판을 안다', (await (await O.get('/api/setup')).json()).edition, 'open');
      eq('open — «내 수업» 화면은 첫 화면으로', (await O.get('/school.html', 'ed-plain')).headers.get('location'), '/');
      eq('school — «내 수업» 화면은 그대로', (await S.get('/school.html', 'ed-plain')).status, 200);
      eq('open — 초대 링크를 들고 와도 내 계정으로 데려가지 않는다', (await O.get('/login?invite=ABCD-EFGH-JKLM', 'ed-plain')).headers.get('location'), '/');
    }

    // ---------------- 수업 작품 — open 에서는 수업에 만들지 못하고, 강사 열람도 없다
    eq('**open — 수업에 새 작품을 만들지 못한다(404)**', (await O.api('ed-plain', 'project.create', { classId: cls, name: 'x', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).status, 404);
    eq('school — 강사는 맡은 수업의 작품을 읽는다', (await S.api('ed-inst', 'peek', { pid: classPid, id: 'none' })).status, 200);
    eq('**open — 강사 · 기관 관리자 열람이 없다(404)**', (await O.api('ed-inst', 'peek', { pid: classPid, id: 'none' })).status, 404);
    eq('open — 주인은 제 작품을 그대로 읽는다', (await O.api('ed-plain', 'peek', { pid: classPid, id: 'none' })).status, 200);
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
}
