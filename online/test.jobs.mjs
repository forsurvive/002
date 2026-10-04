// 영속 작업 큐 시험 — online/test.mjs 가 이어 부른다. JOB_SYSTEM §12 의 목록을 실제 PostgreSQL 로.

import * as M from '../core/domain/model.mjs';
import { createJobQueue, retryPlan, viewOf } from './jobs.mjs';
import { createProjectStore } from './store.mjs';
import { createUser } from './auth.mjs';

export async function run({ pool, ok, eq }) {
  const q = createJobQueue(pool);
  const store = createProjectStore(pool);
  const u = (await createUser(pool, { loginId: 'jobber', password: 'long-enough-1' })).user;
  const pid = await store.create({ name: '작업 시험' }, { ownerUserId: u.id });
  let d1, d2, d3;
  await store.update(pid, (p) => { d1 = M.docCreate(p, { title: '하나' }).id; d2 = M.docCreate(p, { title: '둘' }).id; d3 = M.docCreate(p, { title: '셋' }).id; });
  const clear = () => pool.query("UPDATE jobs SET status = 'cancelled' WHERE status IN ('queued','running','paused','waiting_for_user')");

  await clear();   // 앞선 시험(서버)이 남긴 활성 작업 — 이 시험의 claim 셈을 흐리지 않게
  // ---------------- 넣기 · 중복
  const a = await q.enqueue({ pid, requestedBy: u.id, kind: 'update', title: '하나', targetId: d1, params: { docId: d1 } });
  ok('넣으면 곧바로 jobId', a.ok && /^[0-9a-f-]{36}$/.test(a.jobId));
  const dupe = await q.enqueue({ pid, requestedBy: u.id, kind: 'update', title: '하나', targetId: d1, params: { docId: d1 } });
  ok('**같은 대상에 도는 작업이 있으면 거절**', dupe.ok === false && dupe.code === 'conflict');
  const k1 = await q.enqueue({ pid, requestedBy: u.id, kind: 'update', targetId: d2, params: {}, idempotencyKey: 'click-1' });
  const k2 = await q.enqueue({ pid, requestedBy: u.id, kind: 'update', targetId: d2, params: {}, idempotencyKey: 'click-1' });
  ok('같은 클릭 두 번은 같은 작업', k1.ok && k2.ok && k1.jobId === k2.jobId && k2.again);
  ok('대상이 도는 중인가', await q.isTargetActive(pid, d1) && !(await q.isTargetActive(pid, d3)));
  const v = (await q.list(pid)).find((j) => j.id === a.jobId);
  ok('화면 꼴: 기다리는 것은 «대기 중»으로 도는 줄', v.status === 'running' && v.step === '대기 중' && v.targetId === d1 && v.kind === 'update');

  // ---------------- 두 worker 가 동시에 집어도 한 행은 한 번만
  const claims = await Promise.all(Array.from({ length: 6 }, (_, i) => q.claim('w' + i)));
  const got = claims.filter(Boolean).map((r) => r.id);
  eq('**두 작업을 여섯 worker 가 집어도 두 번만**', got.length, 2);
  eq('같은 행을 둘이 잡지 않는다', new Set(got).size, 2);
  const mine = claims.find((r) => r && r.id === a.jobId);
  const w = mine.locked_by;
  ok('집으면 attempt 1 · lease', mine.attempt === 1 && mine.lease_expires_at);
  eq('남은 것이 없으면 null', await q.claim('w9'), null);

  // ---------------- 숨 · 손잡이 요청
  ok('숨 쉬면 lease 를 민다', (await q.heartbeat(a.jobId, w)).cancel === false);
  eq('**남의 worker 는 숨을 쉴 수 없다**', await q.heartbeat(a.jobId, 'zombie'), null);
  await q.step(a.jobId, w, '하나 — 쓰는 중');
  eq('지금 하는 일', (await q.list(pid)).find((j) => j.id === a.jobId).step, '하나 — 쓰는 중');
  await q.pause(pid, a.jobId);
  ok('일시중지는 도는 worker 에게 요청으로 간다', (await q.heartbeat(a.jobId, w)).pause === true);
  ok('내려놓으면 멈춤', await q.park(a.jobId, w, { status: 'paused' }) && (await q.get(a.jobId)).status === 'paused');
  ok('멈춘 작업도 대상을 붙든다', await q.isTargetActive(pid, d1));
  ok('이어 하면 다시 줄에', (await q.resume(pid, a.jobId)).ok && (await q.get(a.jobId)).status === 'queued');

  // ---------------- 울타리 — lease 를 잃은 worker 는 끝낼 수 없다
  const c1 = await q.claim('w-a');
  eq('다시 집는다', c1.id, a.jobId);
  await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [a.jobId]);
  const reaped = await q.reap();
  ok('**lease 가 지나면 회수해 다시 줄 세운다**', reaped.some((r) => r.id === a.jobId && r.status === 'queued'));
  ok('**좀비 worker 의 끝내기는 먹히지 않는다**', !(await q.finish(a.jobId, 'w-a', { status: 'done' })) && (await q.get(a.jobId)).status === 'queued');
  ok('회수한 작업은 30초 뒤에', ms((await q.get(a.jobId)).run_after) > Date.now() + 20000);
  await pool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [a.jobId]);
  const c2 = await q.claim('w-b');
  ok('새 worker 가 잇는다(attempt 3)', c2.id === a.jobId && c2.attempt === 3);
  await q.addDoc(a.jobId, 'w-b', d1); await q.addDoc(a.jobId, 'w-b', d1);
  ok('끝내기', await q.finish(a.jobId, 'w-b', { status: 'done' }));
  const done = (await q.list(pid)).find((j) => j.id === a.jobId);
  ok('완료 · 산출 문서 한 번만', done.status === 'done' && done.docIds.join() === d1 && done.endedAt > 0);
  ok('끝나면 대상이 풀린다', !(await q.isTargetActive(pid, d1)));

  // ---------------- 시도를 다 쓰고 죽으면 실패
  const b = await q.enqueue({ pid, requestedBy: u.id, kind: 'update', targetId: d3, params: {}, maxAttempts: 1 });
  await q.claim('w-c');
  await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [b.jobId]);
  await q.reap();
  const bj = await q.get(b.jobId);
  ok('**시도가 없으면 실패(worker_lost)** · 까닭은 사람 말로', bj.status === 'failed' && bj.error_code === 'worker_lost' && /멈춰/.test(viewOf(bj).error));

  // ---------------- 취소
  const c = await q.enqueue({ pid, requestedBy: u.id, kind: 'update', targetId: d3, params: {} });
  await q.cancel(pid, c.jobId);
  eq('아직 아무도 안 잡았으면 곧바로 취소', (await q.get(c.jobId)).status, 'cancelled');
  eq('취소는 화면에서 «중지됨»', viewOf(await q.get(c.jobId)).status, 'stopped');
  const c3 = await q.enqueue({ pid, requestedBy: u.id, kind: 'update', targetId: d3, params: {} });
  await clear(); await pool.query("UPDATE jobs SET status = 'queued' WHERE id = $1", [c3.jobId]);
  await q.claim('w-d');
  await q.cancel(pid, c3.jobId);
  ok('**도는 중이면 worker 가 숨 쉴 때 본다**', (await q.heartbeat(c3.jobId, 'w-d')).cancel === true && (await q.get(c3.jobId)).status === 'running');
  ok('worker 가 끊고 취소로 끝낸다', await q.finish(c3.jobId, 'w-d', { status: 'cancelled' }));
  ok('**남의 프로젝트 작업은 손댈 수 없다**', !(await q.cancel('00000000-0000-0000-0000-000000000000', c3.jobId)).changed);

  // ---------------- 미루기 · 물음
  const r1 = await q.enqueue({ pid, requestedBy: u.id, kind: 'update', targetId: d2 + 'x', params: {} });
  await clear(); await pool.query("UPDATE jobs SET status = 'queued' WHERE id = $1", [r1.jobId]);
  await q.claim('w-e');
  ok('미루면 다시 줄에(run_after 뒤)', await q.retryLater(r1.jobId, 'w-e', { delayMs: 60000, errorCode: 'rate' }) && (await q.claim('w-f')) === null);
  await pool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [r1.jobId]);
  await q.claim('w-f');
  await q.park(r1.jobId, 'w-f', { status: 'waiting_for_user', ask: { reason: 'credential', say: 'AI 연결이 필요합니다' } });
  const asked = viewOf(await q.get(r1.jobId));
  ok('사람의 답을 기다리면 물음이 매달린다', asked.status === 'paused' && asked.ask && asked.ask.say === 'AI 연결이 필요합니다');
  ok('답(wait)하면 다시 줄에', (await q.answer(pid, r1.jobId, 'wait')).ok && (await q.get(r1.jobId)).status === 'queued');
  await q.dismiss(pid, r1.jobId);
  ok('치우면 목록에서 빠지고 취소된다', !(await q.list(pid)).some((j) => j.id === r1.jobId) && (await q.get(r1.jobId)).status === 'cancelled');

  // ---------------- 재시도 계획
  ok('rate 는 네 번까지, 늘어나는 간격', retryPlan('rate', 1).delayMs < retryPlan('rate', 3).delayMs && retryPlan('rate', 5) === null);
  ok('retry-after 가 더 길면 그것을 따른다', retryPlan('rate', 1, 120).delayMs >= 120000);
  ok('영구 실패는 재시도 없음', retryPlan('auth', 1) === null && retryPlan('credit', 1) === null && retryPlan('safety', 1) === null);

  // ---------------- 기관 동시 상한
  const org = (await pool.query("INSERT INTO organizations (name, slug, max_concurrent_jobs) VALUES ('학교', 'school-jobs', 1) RETURNING id")).rows[0].id;
  const opid = await store.create({ name: '기관 작품' }, { ownerUserId: u.id, organizationId: org });
  await clear();
  const o1 = await q.enqueue({ pid: opid, requestedBy: u.id, kind: 'agents', params: {} });
  const o2 = await q.enqueue({ pid: opid, requestedBy: u.id, kind: 'agents', params: {} });
  ok('대상 없는 작업은 여럿 넣을 수 있다', o1.ok && o2.ok);
  const g1 = await q.claim('w-o1');
  eq('**기관 상한(1)에 닿으면 그 기관 작업은 기다린다**', await q.claim('w-o2'), null);
  await q.finish(g1.id, 'w-o1', { status: 'done' });
  ok('하나가 끝나면 다음', !!(await q.claim('w-o2')));
}

const ms = (t) => new Date(t).getTime();
