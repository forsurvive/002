// worker 만 따로 띄우기 — 웹(online/server.mjs 를 SE_WORKER=0 으로)과 다른 프로세스 · 다른 기계에서 같은 DB 의 작업 줄을 맡는다.
// 웹이 깨워 주지 못하므로 짧게(WORKER_POLL_MS, 기본 2초) 줄을 다시 본다. 마이그레이션은 웹이 맡는다(여기서는 하지 않는다).
// 콘솔은 ASCII 만. 키 · 원고는 찍지 않는다.

import { join } from 'node:path';
import { createPool } from './db.mjs';
import { buildAi } from './ai.mjs';
import { createJobQueue } from './jobs.mjs';
import { createProjectStore } from './store.mjs';
import { createOnlineCall } from './call.mjs';
import { createTenancy } from './tenancy.mjs';
import { createWorkflowSource } from './workflow.mjs';
import { createWorker } from './worker.mjs';

/** 돌려주는 값: { worker, stop() } — 서지 못하면 null */
export async function startWorker(env = process.env, { log = (m) => console.log(m) } = {}) {
  if (!env.DATABASE_URL) { log('  [STOP] DATABASE_URL is not set'); return null; }
  const pool = createPool(env.DATABASE_URL);
  const ai = buildAi(pool, env);
  for (const p of ai.problems) log('  [NOTE] ' + p);
  const queue = createJobQueue(pool);
  const store = createProjectStore(pool);
  const call = createOnlineCall({ pool, store, generator: ai.generator, ...(ai.aliasTiers ? { aliasTiers: ai.aliasTiers } : {}) });
  const tenancy = createTenancy(pool);
  const wfs = createWorkflowSource(pool);
  const worker = createWorker(
    { queue, store, call, allowed: (row) => tenancy.aiAllowed(row.project_id), workflow: (pid) => wfs.templateFor(pid) },
    { idleMs: Math.max(250, Number(env.WORKER_POLL_MS) || 2000), log: (m) => log('  [worker] ' + m) });
  await worker.start();
  log('  Story Engine (worker) : watching the job queue');
  return { worker, async stop() { await worker.stop(); await pool.end(); } };
}

if (process.argv[1] && process.argv[1].endsWith(join('online', 'worker-main.mjs'))) {
  const w = await startWorker(process.env);
  if (!w) process.exit(1);
  const bye = async () => { await w.stop(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
