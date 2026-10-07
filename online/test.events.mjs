// 바뀜 알림(LISTEN/NOTIFY → SSE) 시험 — online/test.mjs 가 이어 부른다. 실제 PostgreSQL 로.
import { createUser } from './auth.mjs';
import { createChangeHub } from './events.mjs';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createProjectStore } from './store.mjs';
import { createJobQueue } from './jobs.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ pool, ok, eq }) {
  const owner = (await createUser(pool, { loginId: 'ev-a', password: 'long-enough-a' })).user;
  await createUser(pool, { loginId: 'ev-b', password: 'long-enough-b' });
  const store = createProjectStore(pool);
  const hub = createChangeHub(pool, { probeMs: 2000 });
  await hub.start();
  ok('**허브가 LISTEN 을 스스로 확인하고 켠다**', hub.ready);
  const pid = await store.create({ name: '알림 작품' }, { ownerUserId: owner.id });
  const got = [];
  const off = hub.listen(['p:' + pid], () => got.push('p'));
  const offU = hub.listen(['u:' + owner.id], () => got.push('u'));
  await store.update(pid, (p) => { p.name = '알림 작품 2'; });
  await wait(300);
  ok('**작품을 고치면 그 작품 · 그 주인에게 알린다**', got.includes('p') && got.includes('u'), JSON.stringify(got));
  got.length = 0;
  const q = createJobQueue(pool);
  const j = await q.enqueue({ pid, kind: 'update', title: '알림 작업', requestedBy: owner.id });
  await wait(300);
  ok('작업이 들어오면 알린다', got.includes('p'), JSON.stringify(got) + ' ' + JSON.stringify(j).slice(0, 80));
  got.length = 0;
  const jid = (j && (j.id || (j.job && j.job.id))) || (await pool.query('SELECT id FROM jobs WHERE project_id = $1', [pid])).rows[0].id;
  await pool.query(`UPDATE jobs SET heartbeat_at = now(), lease_expires_at = now() WHERE id = $1`, [jid]);
  await wait(300);
  eq('**숨 쉬기(heartbeat)만 바뀌면 알리지 않는다**', got.length, 0);
  await pool.query(`UPDATE jobs SET step = 'x' WHERE id = $1`, [jid]);
  await wait(300);
  ok('화면에 보이는 칸이 바뀌면 알린다', got.length >= 1);
  off(); offU();
  eq('그만 들으면 구독이 빠진다', hub.size(), 0);

  // ---------------- 서버의 /api/events
  const srv = createOnlineServer({ pool, plan: onlinePlan({ SE2_PORT: '0' }), hub });
  const bare = createOnlineServer({ pool, plan: onlinePlan({ SE2_PORT: '0' }) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  await new Promise((r) => bare.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const cookieOf = async (b, who) => (await fetch(b + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'ev-' + who, password: 'long-enough-' + who }) })).headers.get('set-cookie').split(';')[0];
  try {
    const ca = await cookieOf(base, 'a'); const cb = await cookieOf(base, 'b');
    eq('로그인 전에는 401', (await fetch(base + '/api/events')).status, 401);
    eq('**남의 작품 알림은 «없음»(404)**', (await fetch(base + '/api/events?pid=' + pid, { headers: { cookie: cb } })).status, 404);
    const bareBase = 'http://127.0.0.1:' + bare.address().port;
    eq('허브가 없으면 503 — 화면은 묻기를 그대로', (await fetch(bareBase + '/api/events', { headers: { cookie: await cookieOf(bareBase, 'a') } })).status, 503);
    const ctl = new AbortController();
    const r = await fetch(base + '/api/events?pid=' + pid, { headers: { cookie: ca }, signal: ctl.signal });
    ok('SSE 로 열린다', r.status === 200 && /text\/event-stream/.test(r.headers.get('content-type')));
    const reader = r.body.getReader();
    let text = '';
    const read = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (/data: change/.test(text)) break; } } catch { /* 끊음 */ } })();
    await wait(200);
    await store.update(pid, (p) => { p.name = '알림 작품 3'; });
    await Promise.race([read, wait(2000)]);
    ok('**작품이 바뀌면 «data: change» 가 온다(내용은 싣지 않는다)**', /data: change/.test(text) && !/알림 작품/.test(text), JSON.stringify(text));
    ctl.abort();
    await wait(100);
  } finally {
    srv.closeAllConnections && srv.closeAllConnections(); srv.close();
    bare.closeAllConnections && bare.closeAllConnections(); bare.close();
    await hub.stop();
  }
}
