// 마이그레이션 실행기 — migrations/*.sql 을 이름 차례로, **앞으로만** 적용한다(명세 부록 AH-8: DB 를 손으로 고치지 않는다).
// · 파일 하나 = 트랜잭션 하나. 실패하면 그 파일만 되돌리고 멈춘다.
// · 적용한 파일의 sha256 을 남긴다 — 이미 적용한 파일이 나중에 바뀌었으면 멈추고 알린다(고친 파일은 새 번호로).
// · 여러 프로세스가 동시에 띄워도 한쪽만 돈다(advisory lock).
// 실행: DATABASE_URL=… node online/migrate.mjs   (콘솔은 ASCII 만)

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createPool } from './db.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(dirname(HERE), 'migrations');
const LOCK_KEY = 7310021;   // 이 앱의 마이그레이션 잠금 번호

export function migrationFiles(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function migrate(pool, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map((await c.query('SELECT name, sha256 FROM schema_migrations')).rows.map((r) => [r.name, r.sha256]));
    const applied = [];
    for (const m of migrationFiles(dir)) {
      if (done.has(m.name)) {
        if (done.get(m.name) !== m.sha256) throw new Error('migration ' + m.name + ' was changed after it was applied - add a new migration instead');
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(m.sql);
        await c.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [m.name, m.sha256]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw new Error('migration ' + m.name + ' failed: ' + (e && e.message));
      }
      applied.push(m.name);
      log('  [MIGRATE] applied ' + m.name);
    }
    return { applied };
  } finally {
    try { await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch { /* 연결이 끊겼으면 잠금도 풀렸다 */ }
    c.release();
  }
}

if (process.argv[1] && process.argv[1].endsWith('migrate.mjs')) {
  const pool = createPool();
  try {
    const r = await migrate(pool, { log: console.log });
    console.log('  [MIGRATE] up to date (' + r.applied.length + ' applied)');
  } catch (e) {
    console.log('  [MIGRATE] STOP: ' + ((e && e.message) || e));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
