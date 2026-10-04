// 접근 판정 시험 — 학생 · 강사 · 기관 관리자 · 다른 기관 · 바깥 사람, 라이선스 만료, 기관을 떠난 학생. online/test.mjs 가 이어 부른다.

import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { createJobQueue } from './jobs.mjs';
import { createWorker } from './worker.mjs';
import { createProjectStore } from './store.mjs';
import { createTenancy } from './tenancy.mjs';

export async function run({ pool, ok, eq }) {
  resetThrottle();
  const mk = async (id) => (await createUser(pool, { loginId: id, password: 'long-enough-' + id })).user;
  const [s1, s2, i1, oa, x] = [await mk('ten-s1'), await mk('ten-s2'), await mk('ten-i1'), await mk('ten-oa'), await mk('ten-x')];
  const q1 = async (sql, args) => (await pool.query(sql, args)).rows[0];
  const orgA = (await q1("INSERT INTO organizations (name, slug) VALUES ('가 학교', 'ten-a') RETURNING id")).id;
  const orgB = (await q1("INSERT INTO organizations (name, slug) VALUES ('나 학교', 'ten-b') RETURNING id")).id;
  const lic = (await q1("INSERT INTO licenses (organization_id, plan, ends_at) VALUES ($1, 'trial', now() + interval '30 days') RETURNING id", [orgA])).id;
  await q1("INSERT INTO licenses (organization_id, plan, ends_at) VALUES ($1, 'trial', now() + interval '30 days') RETURNING id", [orgB]);
  const c1 = (await q1("INSERT INTO classes (organization_id, name) VALUES ($1, '1반') RETURNING id", [orgA])).id;
  const c2 = (await q1("INSERT INTO classes (organization_id, name) VALUES ($1, '2반') RETURNING id", [orgA])).id;
  const cB = (await q1("INSERT INTO classes (organization_id, name) VALUES ($1, '나 1반') RETURNING id", [orgB])).id;
  for (const [u, role] of [[s1, 'student'], [s2, 'student'], [i1, 'instructor'], [oa, 'organization_admin']]) {
    await pool.query('INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)', [orgA, u.id, role]);
  }
  await pool.query("INSERT INTO class_members (class_id, organization_id, user_id, role) VALUES ($1,$2,$3,'student'), ($1,$2,$4,'instructor'), ($5,$2,$6,'student')", [c1, orgA, s1.id, i1.id, c2, s2.id]);

  const srv = createOnlineServer({ pool, plan: onlinePlan({}) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const jar = {};
  for (const u of ['ten-s1', 'ten-s2', 'ten-i1', 'ten-oa', 'ten-x']) {
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: u, password: 'long-enough-' + u }) });
    jar[u] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
  const op = async (who, name, b = {}) => {
    const r = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar[who] }, body: JSON.stringify({ op: name, ...b }) });
    return { status: r.status, ...(await r.json()) };
  };
  const state = async (who, pid) => (await fetch(base + '/api/state?pid=' + pid, { headers: { cookie: jar[who] } })).json();

  try {
    // ---------------- 수업 안에 만들기
    const made = await op('ten-s1', 'project.create', { classId: c1, name: '1반 과제', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] });
    ok('학생이 자기 수업에 프로젝트를 만든다', made.ok && made.pid, JSON.stringify(made));
    const row = await q1('SELECT organization_id, class_id, owner_user_id FROM projects WHERE id = $1', [made.pid]);
    ok('그 프로젝트는 기관 · 수업에 묶인다', row.organization_id === orgA && row.class_id === c1 && row.owner_user_id === s1.id);
    eq('**남의 수업에는 만들 수 없다(404)**', (await op('ten-s1', 'project.create', { classId: c2, name: 'x', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).status, 404);
    eq('**다른 기관 수업에도(404)**', (await op('ten-s1', 'project.create', { classId: cB, name: 'x', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).status, 404);
    eq('이상한 수업 id 도 404', (await op('ten-s1', 'project.create', { classId: "x' OR 1=1", name: 'x', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).status, 404);
    const pid = made.pid;
    const doc = (await op('ten-s1', 'doc.create', { pid, title: '1장', body: '학생의 글' })).id;

    // ---------------- 읽기 · 쓰기
    ok('주인(학생)은 읽고 고친다', (await state('ten-s1', pid)).project && (await op('ten-s1', 'doc.write', { pid, id: doc, body: '고친 글' })).ok);
    const si = await state('ten-i1', pid);
    ok('**맡은 수업의 강사는 읽는다(읽기 전용 표시)**', si.ok && si.project.readOnly === true && si.project.docs.some((d) => d.body === '고친 글'));
    eq('**강사는 고치지 못한다(403)**', (await op('ten-i1', 'doc.write', { pid, id: doc, body: '강사가 고침' })).status, 403);
    eq('**강사는 지우지 못한다**', (await op('ten-i1', 'project.delete', { pid })).status, 403);
    eq('강사가 AI 를 돌리지 못한다', (await op('ten-i1', 'doc.update', { pid, id: doc })).status, 403);
    ok('강사도 펼쳐 보기는 된다(읽기 문)', (await op('ten-i1', 'peek', { pid, id: doc })).ok);
    eq('본문은 학생 것 그대로', (await state('ten-s1', pid)).project.docs.find((d) => d.id === doc).body, '고친 글');
    ok('**같은 기관의 다른 학생은 못 본다**', (await state('ten-s2', pid)).ok === false && (await op('ten-s2', 'doc.write', { pid, id: doc, body: 'x' })).status === 404);
    ok('**바깥 사람은 못 본다**', (await state('ten-x', pid)).ok === false);
    ok('**기관 관리자도 정책이 꺼져 있으면 못 본다(기본)**', (await state('ten-oa', pid)).ok === false);
    await pool.query(`UPDATE organizations SET settings = settings || '{"admin_can_read_projects": true}'::jsonb WHERE id = $1`, [orgA]);
    ok('정책을 켜면 기관 관리자가 읽는다', (await state('ten-oa', pid)).project.readOnly === true);
    eq('그래도 고치지는 못한다', (await op('ten-oa', 'doc.write', { pid, id: doc, body: 'x' })).status, 403);
    const dl = await fetch(base + '/api/download?pid=' + pid + '&kind=doc&id=' + doc, { headers: { cookie: jar['ten-x'] } });
    eq('바깥 사람은 내려받지 못한다', dl.status, 404);

    // ---------------- 라이선스 — AI 작업을 넣을 때마다 다시 본다
    const t = createTenancy(pool);
    ok('유효한 라이선스면 AI 를 받는다', (await t.aiAllowed(pid)).ok);
    await pool.query("UPDATE licenses SET ends_at = now() - interval '1 minute' WHERE id = $1", [lic]);
    const blocked = await op('ten-s1', 'doc.update', { pid, id: doc });
    ok('**라이선스가 끝나면 새 AI 작업을 받지 않는다(학생 말로)**', blocked.ok === false && /이용 기간/.test(blocked.error) && !/\$|원|비용|횟수|키/.test(blocked.error), blocked.error);
    ok('**편집 · 열람은 계속된다**', (await op('ten-s1', 'doc.write', { pid, id: doc, body: '만료 뒤 고친 글' })).ok);
    eq('**라이선스가 끝나면 수업에 새로 만들 수 없다(403)**', (await op('ten-s1', 'project.create', { classId: c1, name: 'x', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).status, 403);
    await pool.query("UPDATE licenses SET ends_at = now() + interval '30 days' WHERE id = $1", [lic]);
    await pool.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [orgA]);
    ok('기관이 멈추면 AI 도 멈춘다', /기관 이용이 멈춰/.test((await op('ten-s1', 'doc.update', { pid, id: doc })).error || ''));
    await pool.query("UPDATE organizations SET status = 'active' WHERE id = $1", [orgA]);

    // worker 도 돌리기 직전에 한 번 더 — 줄에 서 있던 사이 끝난 라이선스
    const queue = createJobQueue(pool);
    await pool.query("UPDATE jobs SET status = 'cancelled' WHERE status IN ('queued','running','paused','waiting_for_user')");
    const queued = await queue.enqueue({ pid, requestedBy: s1.id, kind: 'update', title: '1장', targetId: doc, params: { docId: doc } });
    await pool.query("UPDATE licenses SET status = 'suspended' WHERE id = $1", [lic]);
    let called = 0;
    const w = createWorker({ queue, store: createProjectStore(pool), call: async () => { called++; return { ok: true, text: 'x' }; }, allowed: (r) => t.aiAllowed(r.project_id) }, { heartbeatMs: 50 });
    await w.start();
    for (let i = 0; i < 60 && (await queue.get(queued.jobId)).status !== 'failed'; i++) await new Promise((r) => setTimeout(r, 30));
    const jr = await queue.get(queued.jobId);
    ok('**줄에 선 사이 라이선스가 멈추면 worker 가 돌리지 않는다**', jr.status === 'failed' && jr.error_code === 'license' && called === 0, jr.status + ' ' + jr.error_code);
    await w.stop({ graceMs: 200 });
    await pool.query("UPDATE licenses SET status = 'active' WHERE id = $1", [lic]);

    // ---------------- 기관을 떠난 학생 — 작품은 남고(읽기) 고치기 · AI 는 멈춘다
    await pool.query("UPDATE organization_members SET status = 'removed' WHERE organization_id = $1 AND user_id = $2", [orgA, s1.id]);
    ok('떠난 학생도 자기 작품을 읽는다', (await state('ten-s1', pid)).project.readOnly === true);
    eq('떠난 학생은 고치지 못한다', (await op('ten-s1', 'doc.write', { pid, id: doc, body: 'x' })).status, 403);

    // ---------------- 개인 프로젝트는 그대로
    const mine = (await op('ten-x', 'project.create', { name: '개인 작품', spec: { form: '단편' }, materials: [{ name: '자료', text: '글' }] })).pid;
    const pr = await q1('SELECT organization_id, class_id FROM projects WHERE id = $1', [mine]);
    ok('수업을 고르지 않으면 개인 프로젝트', pr.organization_id === null && pr.class_id === null);
    ok('개인 프로젝트는 주인만', (await state('ten-x', mine)).project && (await state('ten-i1', mine)).ok === false);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}
