// 운영자 도구 — 서버 안에서 계정을 만들고, 계정의 AI 키를 넣는다(가입 문은 닫혀 있다 — docs/SECURITY.md §7-0).
//   DATABASE_URL=… node online/admin.mjs create-user <아이디> [--name 표시이름] [--admin]
//   DATABASE_URL=… CREDENTIALS_KEY_V1=… node online/admin.mjs set-key <아이디> <anthropic|openai|google>
//   DATABASE_URL=… node online/admin.mjs list-users                 (아이디 · 운영자 표시 — 비밀번호는 어디에도 없으니 보여 줄 수 없다)
//   DATABASE_URL=… node online/admin.mjs reset-password <아이디>     (새 비밀번호를 표준 입력으로 — 운영자가 자기 비밀번호를 잊었을 때)
// 비밀번호와 키는 명령줄에 쓰지 않는다(셸 기록 · 프로세스 목록에 남는다) — 표준 입력으로 받는다. 키는 봉해서만 저장되고 다시 보여 주지 않는다.
//   대화형이면 화면에 찍지 않고 묻고, 파이프면 첫 줄을 읽는다. 콘솔은 ASCII 만.

import { createInterface } from 'node:readline';
import { createPool } from './db.mjs';
import { migrate } from './migrate.mjs';
import { createUser, audit } from './auth.mjs';
import { createCredentialService, keysFromEnv, PROVIDER_IDS } from '../ai/credentials.mjs';
import { pgCredentialStore } from './credentials.mjs';

function readSecret(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      rl._writeToOutput = () => {};   // 친 글자를 되비추지 않는다
    }
    // close 가 먼저 빈 값으로 풀지 않게, 받은 줄로 먼저 푼다
    rl.once('line', (line) => { resolve(line); if (process.stdin.isTTY) process.stdout.write('\n'); rl.close(); });
    rl.once('close', () => resolve(''));
  });
}

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(name);
const value = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] || '' : ''; };

const USAGE = [
  '  usage: node online/admin.mjs create-user <login-id> [--name <display name>] [--admin]',
  '         node online/admin.mjs set-key <login-id> <anthropic|openai|google>   (key from stdin)',
  '         node online/admin.mjs list-users',
  '         node online/admin.mjs reset-password <login-id>   (new password from stdin)',
  '         node online/admin.mjs disable-user <login-id> | enable-user <login-id>',
];
if (!['create-user', 'set-key', 'list-users', 'reset-password', 'disable-user', 'enable-user'].includes(cmd) || (cmd !== 'list-users' && (!rest[0] || rest[0].startsWith('--'))) || (cmd === 'set-key' && !PROVIDER_IDS.includes(rest[1]))) {
  for (const l of USAGE) console.log(l);
  process.exit(cmd ? 1 : 0);
}
if (!process.env.DATABASE_URL) { console.log('  [STOP] DATABASE_URL is not set'); process.exit(1); }

const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  if (cmd === 'list-users') {
    // 콘솔은 ASCII 만 — 아이디(영문)와 역할만 찍는다(이름은 한글일 수 있어 싣지 않는다)
    const { rows } = await pool.query('SELECT login_id, is_platform_admin, status, created_at FROM users ORDER BY created_at');
    if (!rows.length) console.log('  (no accounts yet - open the app to finish the first-run setup)');
    for (const r of rows) console.log('  ' + r.login_id.padEnd(24) + (r.is_platform_admin ? 'OPERATOR' : 'user') + (r.status !== 'active' ? ' (' + r.status + ')' : ''));
  } else if (cmd === 'disable-user' || cmd === 'enable-user') {
    // 멈추면 곧바로 로그인 · 세션이 막힌다(작품은 그대로)
    const status = cmd === 'disable-user' ? 'disabled' : 'active';
    const u = (await pool.query('SELECT id FROM users WHERE login_id = $1', [String(rest[0]).toLowerCase()])).rows[0];
    if (!u) { console.log('  [STOP] no such user'); process.exitCode = 1; }
    else {
      await pool.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [u.id, status]);
      if (status === 'disabled') await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      await audit(pool, { action: 'user.status', targetType: 'user', targetId: u.id, details: { status } });
      console.log('  ' + String(rest[0]).toLowerCase() + ': ' + status);
    }
  } else if (cmd === 'reset-password') {
    const u = (await pool.query('SELECT id FROM users WHERE login_id = $1', [String(rest[0]).toLowerCase()])).rows[0];
    if (!u) { console.log('  [STOP] no such user'); process.exitCode = 1; }
    else {
      const next = await readSecret('  new password (10+ chars): ');
      if (String(next).length < 10) { console.log('  [STOP] password must be 10+ characters'); process.exitCode = 1; }
      else {
        const { hashPassword } = await import('./auth.mjs');
        await pool.query('UPDATE users SET password_hash = $2, known_password_sealed = NULL, updated_at = now() WHERE id = $1', [u.id, await hashPassword(next)]);
        await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
        await audit(pool, { action: 'admin.password_reset', targetType: 'user', targetId: u.id });
        console.log('  password changed: ' + String(rest[0]).toLowerCase() + ' (other sessions signed out)');
      }
    }
  } else if (cmd === 'create-user') {
    const password = await readSecret('  password (10+ chars): ');
    const r = await createUser(pool, { loginId: rest[0], password, displayName: value('--name'), isPlatformAdmin: flag('--admin') });
    if (!r.ok) { console.log('  [STOP] ' + (r.code || 'failed') + (r.code === 'validation' ? ' - login id: a-z 0-9 . _ - (3-64), password: 10+ chars' : '')); process.exitCode = 1; }
    else {
      await audit(pool, { action: 'admin.user_created', targetType: 'user', targetId: r.user.id, details: { admin: flag('--admin') } });
      console.log('  created: ' + r.user.login_id);
    }
  } else {
    // 그 사람의 개인 프로젝트가 쓸 키(비용 주체 USER). 기관 키는 기관 기능과 함께(Sprint 10~12).
    const keys = keysFromEnv(process.env);
    const u = (await pool.query('SELECT id FROM users WHERE login_id = $1', [String(rest[0]).toLowerCase()])).rows[0];
    if (!keys.current) { console.log('  [STOP] CREDENTIALS_KEY_V1 is not set (32 random bytes, base64, in the platform secrets)'); process.exitCode = 1; }
    else if (!u) { console.log('  [STOP] no such user'); process.exitCode = 1; }
    else {
      const apiKey = await readSecret('  API key for ' + rest[1] + ': ');
      const r = await createCredentialService({ store: pgCredentialStore(pool), keys }).set({ ownerType: 'user', ownerId: u.id, provider: rest[1], apiKey, createdBy: 'admin' });
      if (!r.ok) { console.log('  [STOP] ' + r.error); process.exitCode = 1; }
      else {
        await audit(pool, { action: 'credential.set', targetType: 'user', targetId: u.id, details: { provider: rest[1], ownerType: 'user', credentialId: r.credential.id } });
        console.log('  stored (sealed): ' + rest[1] + ' ...' + r.credential.keyHint.slice(-4));   // 콘솔은 ASCII 만
      }
    }
  }
} finally {
  await pool.end();
}
