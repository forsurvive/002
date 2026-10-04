// PostgreSQL 연결 — 온라인판만 쓴다(개인판은 이 파일을 부르지 않는다).
// DATABASE_URL 은 플랫폼(Replit 등)이 Secrets/환경 변수로 준다. 코드에 박지 않는다.

import pg from 'pg';

export function createPool(url = process.env.DATABASE_URL, { max = Number(process.env.DB_POOL_MAX) || 5 } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new pg.Pool({ connectionString: url, max, idleTimeoutMillis: 30000 });
}

// 한 트랜잭션 — fn(client) 가 throw 하면 되돌린다.
export async function tx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* 연결이 끊겼으면 되돌릴 것도 없다 */ }
    throw e;
  } finally {
    c.release();
  }
}
