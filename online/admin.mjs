// 운영자 도구 — 계정을 서버 안에서 만든다(가입 문은 열어 두지 않는다: 누가 계정을 받는가는 사람이 정할 일이다).
//   DATABASE_URL=… node online/admin.mjs create-user <아이디> [--name 표시이름] [--admin]
// 비밀번호는 명령줄에 쓰지 않는다(셸 기록 · 프로세스 목록에 남는다) — 표준 입력으로 받는다.
//   대화형이면 화면에 찍지 않고 묻고, 파이프면 첫 줄을 읽는다. 콘솔은 ASCII 만.

import { createInterface } from 'node:readline';
import { createPool } from './db.mjs';
import { migrate } from './migrate.mjs';
import { createUser, audit } from './auth.mjs';

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

if (cmd !== 'create-user' || !rest[0] || rest[0].startsWith('--')) {
  console.log('  usage: node online/admin.mjs create-user <login-id> [--name <display name>] [--admin]');
  process.exit(cmd ? 1 : 0);
}
if (!process.env.DATABASE_URL) { console.log('  [STOP] DATABASE_URL is not set'); process.exit(1); }

const pool = createPool(process.env.DATABASE_URL);
try {
  await migrate(pool);
  const password = await readSecret('  password (10+ chars): ');
  const r = await createUser(pool, { loginId: rest[0], password, displayName: value('--name'), isPlatformAdmin: flag('--admin') });
  if (!r.ok) { console.log('  [STOP] ' + (r.code || 'failed') + (r.code === 'validation' ? ' - login id: a-z 0-9 . _ - (3-64), password: 10+ chars' : '')); process.exitCode = 1; }
  else {
    await audit(pool, { action: 'admin.user_created', targetType: 'user', targetId: r.user.id, details: { admin: flag('--admin') } });
    console.log('  created: ' + r.user.login_id);
  }
} finally {
  await pool.end();
}
