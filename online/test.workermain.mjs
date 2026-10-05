// worker 만 따로 띄우기(online/worker-main.mjs) 시험 — online/test.mjs 가 이어 부른다.
// 웹과 다른 프로세스라 깨워 주는 이가 없다 — 짧게 줄을 다시 보는지, DB 가 없으면 ASCII 로 멈추는지.

import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../core/domain/model.mjs';
import { startWorker } from './worker-main.mjs';
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
}
