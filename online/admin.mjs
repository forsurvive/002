// 운영자 도구 — 서버 안에서 계정을 만들고, 계정의 AI 키를 넣는다(가입 문은 닫혀 있다 — docs/SECURITY.md §7-0).
//   DATABASE_URL=… node online/admin.mjs create-user <아이디> [--name 표시이름] [--admin]
//   DATABASE_URL=… CREDENTIALS_KEY_V1=… node online/admin.mjs set-key <아이디> <anthropic|openai|google>
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
];
if (!['create-user', 'set-key'].includes(cmd) || !rest[0] || rest[0].startsWith('--') || (cmd === 'set-key' && !PROVIDER_IDS.includes(rest[1]))) {
  for (const l of USAGE) console.log(l);
  process.exit(cmd ? 1 : 0);
}
if (!process.env.DATABASE_URL) { console.log('  [STOP] DATABASE_URL is not set'); process.exit(1); }

const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  if (cmd === 'create-user') {
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
