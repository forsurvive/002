// worker 만 따로 띄우기(online/worker-main.mjs) 시험 — online/test.mjs 가 이어 부른다.
// 웹과 다른 프로세스라 깨워 주는 이가 없다 — 짧게 줄을 다시 보는지, DB 가 없으면 ASCII 로 멈추는지.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../core/domain/model.mjs';
import { startWorker } from './worker-main.mjs';
import { createWorker } from './worker.mjs';
import { redact, guardConsole } from './log.mjs';
import { createJobQueue } from './jobs.mjs';
import { createProjectStore } from './store.mjs';
import { createUser } from './auth.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ pool, ok, eq }) {
  const entry = fileURLToPath(new URL('./worker-main.mjs', import.meta.url));
  const env = { ...process.env }; delete env.DATABASE_URL;
  const r0 = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 20000 });
  ok('DB 가 없으면 멈춘다(ASCII 로)', r0.status === 1 && /\[STOP\] DATABASE_URL/.test(r0.stdout) && /^[\x00-\x7f]*$/.test(r0.stdout), r0.stdout + r0.stderr);

  const u = (await createUser(pool, { loginId: 'lone-worker', password: 'long-enough-1' })).user;
  const store = createProjectStore(pool);
  const pid = await store.create({ name: '따로 도는 worker' }, { ownerUserId: u.id });
  let doc;
  await store.update(pid, (p) => { doc = M.docCreate(p, { title: '1화', request: '써 다오' }).id; });
  const logs = [];
  const w = await startWorker({ DATABASE_URL: process.env.DATABASE_URL_TEST, CREDENTIALS_KEY_V1: randomBytes(32).toString('base64'), WORKER_POLL_MS: '200' }, { log: (m) => logs.push(m) });
  try {
    ok('worker 만 선다', !!w && logs.some((m) => m.includes('(worker)')) && logs.every((m) => /^[\x00-\x7f]*$/.test(m)), logs.join('|'));
    // 웹이 깨우지 않아도(다른 프로세스) 짧은 간격으로 집는다 — 키가 없으니 «AI 연결 필요»로 멈춘다
    const j = await createJobQueue(pool).enqueue({ pid, requestedBy: u.id, kind: 'update', title: '1화', targetId: doc, params: { docId: doc } });
    let row = null;
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(100)) {
      row = (await pool.query('SELECT status FROM jobs WHERE id = $1', [j.jobId])).rows[0];
      if (row.status !== 'queued') break;
    }
    ok('**깨우지 않아도 줄을 다시 보고 집는다**', row && row.status !== 'queued', JSON.stringify(row));
  } finally {
    if (w) await w.stop();
  }
  eq('멈춘 뒤에는 도는 것이 없다', w ? w.worker.busy : 0, 0);

  // ---------------- 수업 작품(기관 키)의 키 문제는 학생에게 «선생님께 알려 주세요»로(키 · 잔액 이야기를 하지 않는다)
  {
    const queue = createJobQueue(pool);
    const org = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('키 문제 기관', 'key-trouble-org') RETURNING id`)).rows[0].id;
    const opid = await store.create({ name: '수업 작품' }, { ownerUserId: u.id, organizationId: org });
    let od; await store.update(opid, (p) => { od = M.docCreate(p, { title: '1화', request: '써 다오' }).id; });
    const call = async () => ({ ok: false, reason: 'auth', error: 'AI 연결 정보를 확인해야 합니다' });
    const wk = createWorker({ queue, store, call }, { concurrency: 1, heartbeatMs: 50 });
    const j = await queue.enqueue({ pid: opid, requestedBy: u.id, kind: 'update', title: '1화', targetId: od, params: { docId: od } });
    await wk.start();
    let row = null;
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(100)) {
      row = (await pool.query('SELECT status, error_message_safe FROM jobs WHERE id = $1', [j.jobId])).rows[0];
      if (row.status === 'failed') break;
    }
    await wk.stop({ graceMs: 200 });
    ok('**수업 작품의 키 오류는 «선생님(기관)께 알려 주세요»**', row.status === 'failed' && /선생님/.test(row.error_message_safe) && !/키|잔액/.test(row.error_message_safe), JSON.stringify(row));
  }

  // ---------------- 콘솔 가리기(둘째 울타리)
  {
    const k1 = 'sk-ant-api03-' + 'a'.repeat(30); const k2 = 'sk-proj-' + 'b'.repeat(30); const k3 = 'AIza' + 'c'.repeat(35);
    const line = redact('keys ' + k1 + ' ' + k2 + ' ' + k3 + ' Authorization: Bearer abcdefghijkl x-goog-api-key=zzzzzzzz postgres://se:pw-secret@db/x CREDENTIALS_KEY_V1=QUJD');
    ok('**콘솔 줄에서 키 · 토큰 · DB 비밀번호 · 마스터 키가 지워진다**', ![k1, k2, k3, 'abcdefghijkl', 'zzzzzzzz', 'pw-secret', 'QUJD'].some((x) => line.includes(x)), line);
    eq('평범한 줄은 그대로', redact('  [worker] job 1234 threw TypeError'), '  [worker] job 1234 threw TypeError');
    const got = []; const fake = { log: (...a) => got.push(a.join(' ')), warn() {}, error: (...a) => got.push(a.join(' ')), info() {} };
    guardConsole(fake); guardConsole(fake);
    fake.log('oops ' + k2); fake.error(new Error('bad key ' + k3));
    ok('감싼 콘솔(한 겹)은 문자열 · 오류 모두 가린다', got.length === 2 && !got.some((x) => x.includes(k2) || x.includes(k3)));
  }

  // ---------------- 작업 하나의 상한 — 넘으면 끊고 failed(timeout), 본문은 그대로
  {
    const queue = createJobQueue(pool);
    // 끊길 때까지 돌아오지 않는 부르기
    const call = (args, ctx) => new Promise((resolve) => { ctx.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'stopped', error: '' })); });
    const slow = createWorker({ queue, store, call }, { concurrency: 1, heartbeatMs: 50, maxJobMs: 300 });
    const doc2 = await (async () => { let id; await store.update(pid, (p) => { id = M.docCreate(p, { title: '2화', request: '써 다오', body: '처음 글' }).id; }); return id; })();
    const j = await queue.enqueue({ pid, requestedBy: u.id, kind: 'update', title: '2화', targetId: doc2, params: { docId: doc2 } });
    await slow.start();
    let row = null;
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(100)) {
      row = (await pool.query('SELECT status, error_code, error_message_safe FROM jobs WHERE id = $1', [j.jobId])).rows[0];
      if (row.status === 'failed') break;
    }
    await slow.stop({ graceMs: 200 });
    ok('**작업이 상한을 넘으면 끊고 failed(timeout) · 사람 말로**', row.status === 'failed' && row.error_code === 'timeout' && /오래 걸려/.test(row.error_message_safe), JSON.stringify(row));
    eq('끊겨도 본문은 그대로', (await store.get(pid)).docs.find((x) => x.id === doc2).body, '처음 글');
  }
}
