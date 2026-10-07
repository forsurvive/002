// 바뀜 알림 허브 — DB 의 NOTIFY(se_change, migrations/012)를 연결 하나로 듣고, 그 작품 · 그 사람을 보고 있는 화면(SSE)에 «바뀌었다»만 건넨다.
// 화면은 그 말을 듣고 /api/state 를 한 번 더 묻는다(무엇이 바뀌었는지는 싣지 않는다 — 읽을 권리는 /api/state 가 다시 본다).
//
// 연결 풀(PgBouncer 의 transaction 모드 등) 뒤에서는 LISTEN 이 조용히 먹통일 수 있다 — 그래서 처음에 스스로 NOTIFY 를 하나 보내
// 정말 돌아오는지 본다. 안 돌아오면 허브를 끄고(ready=false) 화면은 지금처럼 묻기(폴링)를 그대로 한다.
// 콘솔은 ASCII 만.

const CHANNEL = 'se_change';

export function createChangeHub(pool, { log = () => {}, probeMs = 3000, retryMs = 15000 } = {}) {
  const subs = new Map();   // 'p:<pid>' | 'u:<userId>' → Set<fn>
  let client = null;
  let ready = false;
  let stopped = false;
  let timer = null;

  const fire = (key) => { const s = subs.get(key); if (s) for (const fn of [...s]) { try { fn(); } catch { /* 끊긴 화면 */ } } };
  const onNote = (msg) => {
    if (msg.channel !== CHANNEL) return;
    for (const key of String(msg.payload || '').split('|')) if (key) fire(key);
  };

  async function connect() {
    if (stopped) return;
    try {
      client = await pool.connect();
      client.on('notification', onNote);
      client.on('error', () => drop('error'));
      client.on('end', () => drop('end'));
      await client.query('LISTEN ' + CHANNEL);
      // 스스로 확인 — 보낸 것이 정말 돌아오는가
      const probe = 'probe:' + Math.random().toString(36).slice(2);
      const got = await new Promise((resolve) => {
        const t = setTimeout(() => { client && client.off('notification', on); resolve(false); }, probeMs);
        const on = (m) => { if (m.payload === probe) { clearTimeout(t); client.off('notification', on); resolve(true); } };
        client.on('notification', on);
        pool.query('SELECT pg_notify($1, $2)', [CHANNEL, probe]).catch(() => {});
      });
      if (!got) { log('change hub off (LISTEN does not deliver here) - screens keep polling'); release(); return; }
      ready = true;
      log('change hub on');
    } catch (e) {
      log('change hub could not listen (' + ((e && e.code) || 'error') + ') - retrying');
      release();
      timer = setTimeout(connect, retryMs);
    }
  }
  function release() {
    ready = false;
    if (client) { try { client.removeAllListeners('notification'); client.release(true); } catch { /* 이미 끊김 */ } }
    client = null;
  }
  function drop(why) {
    if (!client) return;
    log('change hub lost (' + why + ') - retrying');
    release();
    // 끊긴 동안 놓친 것이 있을 수 있다 — 듣던 화면 모두에게 한 번 알려 다시 묻게 한다
    for (const key of subs.keys()) fire(key);
    if (!stopped) timer = setTimeout(connect, retryMs);
  }

  return {
    start: connect,
    get ready() { return ready; },
    // 돌려주는 값: 그만 듣는 함수
    listen(keys, fn) {
      for (const k of keys) { if (!subs.has(k)) subs.set(k, new Set()); subs.get(k).add(fn); }
      return () => { for (const k of keys) { const s = subs.get(k); if (s) { s.delete(fn); if (!s.size) subs.delete(k); } } };
    },
    size: () => [...subs.values()].reduce((n, s) => n + s.size, 0),
    async stop() { stopped = true; clearTimeout(timer); if (client) { try { await client.query('UNLISTEN ' + CHANNEL); } catch { /* 끊김 */ } } release(); },
  };
}
