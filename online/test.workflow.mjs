// 단계형 작업 흐름(온라인) 시험 — 단계 생성(worker · 가짜 Provider) · 생성 기록 · 고쳐 쓰기(운영자 → 기관) · 강의 카드 · 강사 «지금 단계».
// online/test.mjs 가 이어 부른다.


import { success } from '../ai/provider.mjs';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createJobQueue } from './jobs.mjs';
import { createWorker } from './worker.mjs';
import { createOnlineCall } from './call.mjs';
import { createProjectStore } from './store.mjs';
import { createWorkflowSource } from './workflow.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { fakeRouter } from './test.call.mjs';

const sleep = (n) => new Promise((r) => setTimeout(r, n));

export async function run({ pool, ok, eq }) {
  resetThrottle();
  const root = (await createUser(pool, { loginId: 'wf-root', password: 'long-enough-root', isPlatformAdmin: true })).user;
  const writer = (await createUser(pool, { loginId: 'wf-writer', password: 'long-enough-w' })).user;
  const oa = (await createUser(pool, { loginId: 'wf-oa', password: 'long-enough-oa' })).user;
  const inst = (await createUser(pool, { loginId: 'wf-in', password: 'long-enough-in' })).user;
  const stu = (await createUser(pool, { loginId: 'wf-st', password: 'long-enough-st' })).user;
  const q1 = async (sql, a) => (await pool.query(sql, a)).rows[0];
  const org = (await q1("INSERT INTO organizations (name, slug) VALUES ('흐름 학교', 'wf-school') RETURNING id")).id;
  await pool.query("INSERT INTO licenses (organization_id, ends_at) VALUES ($1, now() + interval '30 days')", [org]);
  const cls = (await q1("INSERT INTO classes (organization_id, name) VALUES ($1, '흐름반') RETURNING id", [org])).id;
  for (const [u, r] of [[oa, 'organization_admin'], [inst, 'instructor'], [stu, 'student']]) await pool.query('INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)', [org, u.id, r]);
  await pool.query("INSERT INTO class_members (class_id, organization_id, user_id, role) VALUES ($1,$2,$3,'instructor'), ($1,$2,$4,'student')", [cls, org, inst.id, stu.id]);

  const store = createProjectStore(pool);
  const queue = createJobQueue(pool);
  const wfs = createWorkflowSource(pool);
  const { credentials, generator, seen } = fakeRouter(pool, { reply: () => success({ text: '단계의 글', usage: { input_tokens: 5, output_tokens: 3 } }) });
  await credentials.set({ ownerType: 'user', ownerId: writer.id, provider: 'anthropic', apiKey: 'fake-wf-key-0001' });
  await credentials.set({ ownerType: 'organization', ownerId: org, provider: 'anthropic', apiKey: 'fake-wf-key-0002' });
  const call = createOnlineCall({ pool, store, generator });
  const worker = createWorker({ queue, store, call, workflow: (pid) => wfs.templateFor(pid) }, { heartbeatMs: 40 });
  await worker.start();
  const srv = createOnlineServer({ pool, plan: onlinePlan({}), queue, worker, credentials });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const jar = {};
  for (const id of ['wf-root', 'wf-writer', 'wf-oa', 'wf-in', 'wf-st']) {
    const pw = { 'wf-root': 'long-enough-root', 'wf-writer': 'long-enough-w', 'wf-oa': 'long-enough-oa', 'wf-in': 'long-enough-in', 'wf-st': 'long-enough-st' }[id];
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: id, password: pw }) });
    jar[id] = (r.headers.get('set-cookie') || '').split(';')[0];
  }
  const api = async (who, op, b = {}) => (await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar[who] }, body: JSON.stringify({ op, ...b }) })).json();
  const edu = async (who, op, b = {}) => { const r = await fetch(base + '/api/edu', { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar[who] }, body: JSON.stringify({ op, ...b }) }); return { status: r.status, ...(await r.json()) }; };
  const state = async (who, pid) => (await (await fetch(base + '/api/state?pid=' + pid, { headers: { cookie: jar[who] } })).json()).project;
  const until = async (who, pid, pred, ms = 6000) => { const end = Date.now() + ms; for (;;) { const s = await state(who, pid); if (pred(s) || Date.now() > end) return s; await sleep(40); } };

  try {
    // ---------------- 개인 프로젝트 — 단계 생성
    const pid = (await api('wf-writer', 'project.create', { name: '흐름 작품', spec: { form: '단편' }, materials: [{ name: '노트', text: '바닷가' }] })).pid;
    let s = await state('wf-writer', pid);
    ok('상태에 16단계 · 개인 프로젝트는 카드 꺼짐', s.workflow && s.workflow.stages.length === 16 && s.workflow.cards === false && s.workflow.stages[0].status === 'approved');
    const r1 = await api('wf-writer', 'stage.start', { pid, key: 'world', requestOnce: '이번엔 바다 무역 중심으로' });
    ok('단계 시작 → 작업', r1.ok && r1.jobId, JSON.stringify(r1));
    s = await until('wf-writer', pid, (x) => x.workflow.stages.find((y) => y.key === 'world').status === 'draft' && x.jobs.some((j) => j.id === r1.jobId && j.status === 'done'));
    const w = s.workflow.stages.find((x) => x.key === 'world');
    const wd = s.docs.find((d) => d.id === w.docId);
    ok('**worker 가 단계를 생성한다 — 결과는 «세계관» 문서, 상태 초안**', w.status === 'draft' && wd && wd.title === '세계관' && wd.body === '단계의 글');
    const run = await q1("SELECT workflow_stage, request_once_text, request_text, status, model_tier FROM generation_runs WHERE project_id = $1 AND workflow_stage = 'world'", [pid]);
    eq('**단계의 기본 등급으로 돈다(작품 기본 High Reasoning 보다 단계 Balanced 가 앞)**', run.model_tier, 'balanced');
    ok('**생성 기록에 단계 · 이번 요청사항이 남는다(문서에는 없다)**', run && run.status === 'succeeded' && run.request_once_text === '이번엔 바다 무역 중심으로' && wd.request === '');
    ok('«이번 단계에 할 일»이 프롬프트에 실린다', seen[seen.length - 1].userPrompt.includes('세계의 규칙'));
    ok('승인 · 확정본 제안', (await api('wf-writer', 'stage.approve', { pid, key: 'world', final: true })).ok && (await state('wf-writer', pid)).docs.find((d) => d.id === w.docId).isFinal);
    eq('**온라인은 누가 승인했는지 남긴다**', (await state('wf-writer', pid)).workflow.stages.find((x) => x.key === 'world').approvedBy, 'wf-writer');
    const reload = await store.get(pid);
    ok('**단계 상태가 표에 남는다(다시 지어도)**', reload.stages.world && reload.stages.world.status === 'approved');

    // ---------------- 고쳐 쓰기 — 운영자(전체)
    eq('**보통 사람은 단계를 고치지 못한다**', (await edu('wf-writer', 'workflow.save', { stageKey: 'world', data: { title: 'x' } })).status, 403);
    eq('**학생도 못 한다**', (await edu('wf-st', 'workflow.save', { orgId: org, stageKey: 'world', data: { title: 'x' } })).status, 404);
    const sv = await edu('wf-root', 'workflow.save', { stageKey: 'world', data: { title: '세계 만들기', task: '운영자가 바꾼 할 일', output: 'final', inputs: ['study', 'plan'] } });
    ok('운영자가 단계를 고친다(고칠 수 없는 칸은 버린다)', sv.ok && sv.saved.title === '세계 만들기' && !('output' in sv.saved) && sv.saved.inputs.join() === 'study');
    const ev = (await edu('wf-root', 'workflow.view')).workflow.stages.find((x) => x.key === 'world');
    ok('편집 화면 꼴: 원문 · 운영자 층 · 합친 결과', ev.original.title === '세계관' && ev.platform.title === '세계 만들기' && ev.effective.title === '세계 만들기');
    ok('고친 이름이 작품에 보인다', (await state('wf-writer', pid)).workflow.stages.find((x) => x.key === 'world').title === '세계 만들기');
    await api('wf-writer', 'stage.start', { pid, key: 'world' });
    await until('wf-writer', pid, (x) => x.jobs.filter((j) => j.kind === 'stage' && j.status === 'done').length >= 2);
    ok('**고친 «할 일»로 생성한다**', seen[seen.length - 1].userPrompt.includes('운영자가 바꾼 할 일'));

    // ---------------- 고쳐 쓰기 — 기관(제 기관에만) · 강의 카드
    const spid = (await api('wf-st', 'project.create', { classId: cls, name: '학생 작품', spec: { form: '단편' }, materials: [{ name: '노트', text: '산골' }] })).pid;
    let ss = await state('wf-st', spid);
    ok('**기관 프로젝트는 강의 카드가 켜져 있다(기본)**', ss.workflow.cards === true && ss.workflow.stages.find((x) => x.key === 'world').card.what);
    ok('학생 화면에 강사 메모가 없다', !JSON.stringify(ss).includes('teachingNote'));
    eq('**다른 기관 관리자 · 보통 사람은 이 기관 단계를 못 고친다**', (await edu('wf-writer', 'workflow.save', { orgId: org, stageKey: 'world', data: { title: 'x' } })).status, 404);
    const os = await edu('wf-oa', 'workflow.save', { orgId: org, stageKey: 'world', data: { card: { what: '우리 학교의 설명', look: ['하나'], ask: '질문?' } } });
    ok('기관 관리자가 카드를 고친다', os.ok);
    ss = await state('wf-st', spid);
    const sw = ss.workflow.stages.find((x) => x.key === 'world');
    ok('**기관 프로젝트: 운영자 이름 + 기관 카드가 겹쳐 보인다**', sw.title === '세계 만들기' && sw.card.what === '우리 학교의 설명');
    ok('**개인 프로젝트에는 기관 것이 섞이지 않는다**', !JSON.stringify((await state('wf-writer', pid)).workflow).includes('우리 학교의 설명'));
    await edu('wf-oa', 'org.settings', { orgId: org, studentCards: false });
    ok('기관이 카드를 끈다', (await state('wf-st', spid)).workflow.cards === false && !(await state('wf-st', spid)).workflow.stages.some((x) => x.card));
    await edu('wf-oa', 'org.settings', { orgId: org, studentCards: true });
    await edu('wf-oa', 'workflow.save', { orgId: org, stageKey: 'world', data: {} });
    ok('비우면 원래대로(기관 층 지움)', (await state('wf-st', spid)).workflow.stages.find((x) => x.key === 'world').card.what !== '우리 학교의 설명');

    // ---------------- 강사 — 학생의 «지금 단계» · 강의 포인트
    await api('wf-st', 'stage.start', { pid: spid, key: 'plan' });
    await until('wf-st', spid, (x) => x.workflow.stages.find((y) => y.key === 'plan').status === 'draft');
    const pg = await edu('wf-in', 'class.progress', { classId: cls });
    const me = pg.students.find((x) => x.projectId === spid);
    ok('**강사는 학생의 지금 단계 · 상태 · 강의 포인트를 본다**', me && me.stage && me.stage.key === 'plan' && me.stage.status === 'draft' && me.stage.teachingNote.length > 0, JSON.stringify(me && me.stage));
    const acts = (await pool.query("SELECT action FROM audit_logs WHERE action LIKE 'workflow.%'")).rows.map((r) => r.action);
    ok('단계 고쳐 쓰기도 감사 로그에', acts.includes('workflow.save_platform') && acts.includes('workflow.save_org'));
    await edu('wf-root', 'workflow.save', { stageKey: 'world', data: {} });   // 뒤 시험에 남기지 않는다
  } finally {
    await worker.stop({ graceMs: 500 });
    await new Promise((r) => srv.close(r));
  }
}

