// worker 시험 — 화면의 문(HTTP) → 작업 큐 → worker → Core 실행 → 가짜 Provider → 새 판. online/test.mjs 가 이어 부른다.

import * as M from '../core/domain/model.mjs';
import { success, failure } from '../ai/provider.mjs';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createJobQueue } from './jobs.mjs';
import { createWorker } from './worker.mjs';
import { createOnlineCall } from './call.mjs';
import { createProjectStore } from './store.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { fakeRouter } from './test.call.mjs';

const sleep = (n) => new Promise((r) => setTimeout(r, n));

export async function run({ pool, ok, eq }) {
  resetThrottle();
  const u = (await createUser(pool, { loginId: 'worker-a', password: 'long-enough-a' })).user;
  const store = createProjectStore(pool);
  const queue = createJobQueue(pool);

  // 가짜 Provider — 무엇을 할지 시험이 그때그때 정한다(느리게 · 실패 · 성공)
  let behave = async () => success({ text: '지은 글', usage: { input_tokens: 10, output_tokens: 5 } });
  const { credentials, generator, seen } = fakeRouter(pool, { reply: (input) => behave(input) });
  const call = createOnlineCall({ pool, store, generator });
  const worker = createWorker({ queue, store, call }, { concurrency: 2, heartbeatMs: 40, leaseMs: 5000 });
  await worker.start();

  const srv = createOnlineServer({ pool, plan: onlinePlan({}), queue, worker });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'worker-a', password: 'long-enough-a' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const op = async (name, b = {}) => (await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ op: name, ...b }) })).json();
  const state = async (pid) => (await (await fetch(base + '/api/state?pid=' + pid, { headers: { cookie } })).json()).project;
  const jobOf = async (pid, id) => (await state(pid)).jobs.find((j) => j.id === id);
  const until = async (pid, id, pred, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) { const j = await jobOf(pid, id); if (j && pred(j)) return j; if (Date.now() > end) return j; await sleep(30); }
  };

  try {
    const pid = (await op('project.create', { name: '돌아가는 작품', spec: { form: '단편' }, materials: [{ name: '노트', text: '자료' }] })).pid;
    const doc = (await op('doc.create', { pid, title: '1화' })).id;
    await op('doc.write', { pid, id: doc, request: '써 다오' });

    // ---------------- 키가 없으면 «AI 연결 필요»로 멈추고, 키를 넣고 답하면 잇는다
    const j0 = (await op('doc.update', { pid, id: doc })).jobId;
    const w0 = await until(pid, j0, (j) => !!j.ask);
    ok('**키가 없으면 실패가 아니라 «AI 연결 필요»로 멈춘다**', w0 && w0.status === 'paused' && w0.ask.say === 'AI 연결이 필요합니다', JSON.stringify(w0));
    eq('그동안 본문은 그대로', (await state(pid)).docs.find((d) => d.id === doc).body, '');
    await credentials.set({ ownerType: 'user', ownerId: u.id, provider: 'anthropic', apiKey: 'fake-worker-key-0000', createdBy: u.id });
    await op('job.answer', { pid, id: j0, choice: 'wait' });
    const d0 = await until(pid, j0, (j) => j.status === 'done');
    ok('**키를 넣고 답하면 끝까지 간다**', d0 && d0.status === 'done' && d0.docIds.includes(doc), JSON.stringify(d0));
    let p = await state(pid);
    eq('결과가 본문으로', p.docs.find((d) => d.id === doc).body, '지은 글');
    const runs = (await pool.query('SELECT status, job_id, requested_by FROM generation_runs WHERE job_id = $1 ORDER BY started_at', [j0])).rows;
    ok('생성 기록이 작업과 사람에 이어진다(실패 한 번 + 성공 한 번)', runs.length === 2 && runs[1].status === 'succeeded' && runs[1].requested_by === u.id);
    const by = (await pool.query("SELECT v.created_by FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.legacy_id = $1 ORDER BY v.seq DESC LIMIT 1", [doc])).rows[0];
    eq('새 판은 맡긴 사람의 이름으로', by.created_by, u.id);

    // 두 번째 갱신 — 앞 본문은 판으로 남는다(덮어쓰지 않는다)
    behave = async () => success({ text: '고친 글' });
    const j1 = (await op('doc.update', { pid, id: doc })).jobId;
    await until(pid, j1, (j) => j.status === 'done');
    p = await state(pid);
    const dd = p.docs.find((d) => d.id === doc);
    ok('**새 결과는 새 판 — 앞 글은 이력에**', dd.body === '고친 글' && dd.versions.some((v) => v.body === '지은 글'));

    // ---------------- 실패하면 기존 글을 건드리지 않는다
    behave = async () => failure('auth', 'AI 키가 맞지 않습니다');
    const j2 = (await op('doc.update', { pid, id: doc })).jobId;
    const f2 = await until(pid, j2, (j) => j.status === 'failed');
    ok('**영구 실패는 곧바로 실패 · 까닭은 사람 말로**', f2.status === 'failed' && f2.error === 'AI 키가 맞지 않습니다');
    eq('**실패해도 본문은 그대로**', (await state(pid)).docs.find((d) => d.id === doc).body, '고친 글');
    ok('실패 문구에 키가 없다', !JSON.stringify(await state(pid)).includes('fake-worker-key'));

    // ---------------- 잠깐 밀리면 다시 줄에(백오프) → 다음에 성공
    let n = 0;
    behave = async () => (++n === 1 ? failure('rate', '잠시 붐빕니다', { retryAfterMs: 0 }) : success({ text: '기다려 지은 글' }));
    const j3 = (await op('doc.update', { pid, id: doc })).jobId;
    const q3 = await until(pid, j3, (j) => j.step === '대기 중');
    ok('rate 면 다시 줄에 선다', q3 && q3.status === 'running' && q3.step === '대기 중');
    await pool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [j3]);
    worker.wake();
    ok('다시 집혀 끝난다', (await until(pid, j3, (j) => j.status === 'done')).status === 'done' && (await state(pid)).docs.find((d) => d.id === doc).body === '기다려 지은 글');

    // ---------------- 논의 — 말은 작업 앞에 한 번 저장, 답은 그 밑에
    behave = async (input) => success({ text: '답: ' + (input.userPrompt.includes('첫 물음') ? 'ok' : '?') });
    const th = (await op('thread.create', { pid, title: '논의' })).id;
    const jt = (await op('thread.send', { pid, id: th, text: '첫 물음' })).jobId;
    const midT = (await state(pid)).threads.find((t) => t.id === th);
    ok('**말은 작업이 돌기 전에 저장된다**', midT.messages.some((m) => m.role === 'user' && m.text === '첫 물음'));
    await until(pid, jt, (j) => j.status === 'done');
    const t1 = (await state(pid)).threads.find((t) => t.id === th);
    ok('답이 그 말 밑에 · 말은 한 번만', t1.messages.length === 2 && t1.messages[1].role === 'assistant' && t1.messages[1].text === '답: ok' && t1.messages[1].parentId === t1.messages[0].id);

    // ---------------- 취소 — 진행 중 호출을 끊고 글은 그대로
    behave = (input) => new Promise((resolve) => {
      const t = setTimeout(() => resolve(success({ text: '늦은 글' })), 3000);
      input.signal && input.signal.addEventListener('abort', () => { clearTimeout(t); resolve(failure('stopped', '중지됨')); });
    });
    const j4 = (await op('doc.update', { pid, id: doc })).jobId;
    await until(pid, j4, (j) => j.step && j.step !== '대기 중');
    const t0 = Date.now();
    await op('job.remove', { pid, id: j4 });
    for (let i = 0; i < 100 && (await queue.get(j4)).status !== 'cancelled'; i++) await sleep(30);
    ok('**삭제하면 도는 호출을 끊고 취소로 끝낸다**', (await queue.get(j4)).status === 'cancelled' && Date.now() - t0 < 2500);
    eq('취소해도 본문은 그대로', (await state(pid)).docs.find((d) => d.id === doc).body, '기다려 지은 글');
    ok('치운 작업은 목록에 없다', !(await state(pid)).jobs.some((j) => j.id === j4));

    // ---------------- 일시중지 — 돌던 호출은 끝까지, 다음 호출 앞에서 선다(합평 패널: 사람마다 한 번 + 모으기)
    behave = (input) => new Promise((resolve) => setTimeout(() => resolve(success({ text: '평 ' + seen.length })), 250));
    let a1, a2, rv;
    await op('agent.create', { pid, name: '하나', role: '읽는다' }); await op('agent.create', { pid, name: '둘', role: '읽는다' });
    p = await state(pid);
    [a1, a2] = p.crew.map((a) => a.id);
    rv = (await op('doc.create', { pid, kind: 'review', title: '합평' })).id;
    await op('doc.write', { pid, id: rv, targetIds: [doc], agentIds: [a1, a2] });
    const before = seen.length;
    const j5 = (await op('doc.update', { pid, id: rv })).jobId;
    await until(pid, j5, (j) => /하나/.test(j.step || ''));
    await op('job.pause', { pid, id: j5 });
    const pz = await until(pid, j5, (j) => j.status === 'paused');
    ok('**일시중지 — 돌던 호출을 끝내고 다음 호출 앞에서 멈춘다**', pz.status === 'paused' && seen.length - before === 1, String(seen.length - before));
    await sleep(150);
    eq('멈춘 동안 더 부르지 않는다', seen.length - before, 1);
    await op('job.resume', { pid, id: j5 });
    ok('이어 하면 끝까지', (await until(pid, j5, (j) => j.status === 'done', 8000)).status === 'done');
    ok('합평 글이 남는다', /^평 /.test((await state(pid)).docs.find((d) => d.id === rv).body));

    // ---------------- worker 가 죽어도 작업은 잃지 않는다 — 다른 worker 가 lease 뒤에 잇는다
    behave = async () => success({ text: '살아남은 글' });
    const dead = await queue.enqueue({ pid, requestedBy: u.id, kind: 'update', title: '1화', targetId: doc, params: { docId: doc } });
    const ghost = await queue.claim('ghost-worker');
    eq('죽을 worker 가 먼저 집었다', ghost.id, dead.jobId);
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [dead.jobId]);
    await queue.reap();
    await pool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [dead.jobId]);
    worker.wake();
    ok('**회수된 작업을 살아 있는 worker 가 끝낸다**', (await until(pid, dead.jobId, (j) => j.status === 'done')).status === 'done');
    ok('**죽었던 worker 가 돌아와도 끝내기를 덮어쓰지 못한다**', !(await queue.finish(dead.jobId, 'ghost-worker', { status: 'failed' })) && (await queue.get(dead.jobId)).status === 'done');

    // ---------------- 에이전트 준비 — 만들면 곧바로 선다(판정 → 자리 일곱 → 자료 분석), 개인판과 같은 본체
    behave = async () => success({ text: '분류: 에세이\n이름: 길잡이\n역할: 안내한다\n할 일: 쓴다\n작법:\n' + '가'.repeat(2100) });
    const np = (await op('project.create', { name: '에세이 작품', spec: { form: '에세이' }, materials: [{ name: '메모', text: '자료 글' }] })).pid;
    const prep = (await state(np)).jobs.find((j) => j.kind === 'agents');
    ok('**만들면 에이전트 준비 작업이 선다**', !!prep);
    const pd = await until(np, prep.id, (j) => j.status === 'done' || j.status === 'failed', 10000);
    ok('준비가 끝난다', pd.status === 'done', JSON.stringify(pd));
    const ps = await state(np);
    ok('비소설로 판정 · 자리마다 지은 프롬프트', ps.agentKind === '에세이' && ps.prompts.filter((x) => x.made).length >= 7 && ps.prepared === true);
    ok('이어서 «자료 분석» 문서', ps.docs.some((d) => d.title === '자료 분석') && pd.docIds.length === 1);
    const keys = (await pool.query('SELECT prompt_key, count(*)::int AS n FROM generation_runs WHERE project_id = $1 GROUP BY prompt_key', [np])).rows;
    const n2 = Object.fromEntries(keys.map((r) => [r.prompt_key, r.n]));
    ok('생성 기록: 판정 1 · 짓기 7 · 자료 분석 1', n2['F-KIND'] === 1 && n2['F-AGENT'] === 7 && n2.S02 === 1, JSON.stringify(n2));
    const kindRun = (await pool.query("SELECT model_source, status FROM generation_runs WHERE project_id = $1 AND prompt_key = 'F-KIND'", [np])).rows[0];
    ok('제어 호출도 기록된다(출처 control)', kindRun.model_source === 'control' && kindRun.status === 'succeeded');
    // 다시 눌러도 이미 된 자리는 다시 짓지 않는다
    ok('준비가 끝나면 [다시] 는 «이미 준비되어 있습니다»', /이미 준비/.test((await op('project.prepare', { pid: np })).error || ''));

    // ---------------- 남의 작업에는 손잡이가 없다
    await createUser(pool, { loginId: 'worker-b', password: 'long-enough-b' });
    const lb = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'worker-b', password: 'long-enough-b' }) });
    const ckb = (lb.headers.get('set-cookie') || '').split(';')[0];
    const other = await fetch(base + '/api', { method: 'POST', headers: { 'content-type': 'application/json', cookie: ckb }, body: JSON.stringify({ op: 'job.remove', pid, id: j1 }) });
    eq('**남의 프로젝트 작업을 치울 수 없다(404)**', other.status, 404);
    ok('그 작업은 그대로 목록에', (await state(pid)).jobs.some((j) => j.id === j1));
  } finally {
    await worker.stop({ graceMs: 2000 });
    await new Promise((r) => srv.close(r));
  }
}
