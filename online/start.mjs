// Replit 의 [Run] 이 부르는 한 자리 — 사람이 명령을 칠 일이 없게 갈래를 스스로 고른다. 콘솔은 ASCII 만.
//
//   · DATABASE_URL 이 없으면(데이터베이스를 아직 만들지 않았으면) → 지금까지처럼 개인판을 호스팅 꼴로 띄운다(tools/server.mjs).
//   · 있으면 → 온라인판(online/server.mjs). 그 전에:
//       - 온라인판 의존성(pg)이 없으면 npm ci 를 스스로 돌린다.
//       - AI 키를 봉할 마스터 키(CREDENTIALS_KEY_V1)가 Secrets 에 없으면 data/online-master.key 를 만들어 쓴다
//         (data/ 는 저장소 밖 — .gitignore). 게시(배포)할 때는 이 값을 Secrets 로 옮기라고 알린다(다시 게시하면 파일이 사라질 수 있다).
//       - 플랫폼(Replit) 앞단 뒤에서 돌면 SE_TRUST_PROXY=1 을 기본으로 둔다.
// 개인판(로컬 · USB)은 이 파일을 부르지 않는다 — 실행기는 여전히 tools/server.mjs 를 띄운다.

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MASTER_FILE = join(ROOT, 'data', 'online-master.key');

const onPlatform = (env) => !!(env.REPL_ID || env.REPLIT_DOMAINS || env.REPLIT_DEV_DOMAIN);

// 마스터 키 — Secrets 가 먼저, 없으면 파일(없으면 만든다). 파일 값은 이 프로세스의 env 에만 꽂는다.
export function ensureMasterKey(env = process.env, file = MASTER_FILE) {
  if (Object.keys(env).some((k) => /^CREDENTIALS_KEY_V\d+$/.test(k) && env[k])) return 'secrets';
  let key = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  let made = false;
  if (Buffer.from(key, 'base64').length !== 32) {
    key = randomBytes(32).toString('base64');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, key + '\n', { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* 윈도 등 — 권한 비트가 없는 곳 */ }
    made = true;
  }
  env.CREDENTIALS_KEY_V1 = key;
  return made ? 'file-new' : 'file';
}

// pg 가 없으면 받아 온다(package-lock.json 그대로)
export function ensureDeps({ root = ROOT, run = spawnSync } = {}) {
  // pg 와 운영자 구독용 Claude Code(선택 의존성 — 깔리지 않아도 서버는 선다)가 다 있으면 그대로.
  // 먼저 받아 둔 작업 공간에는 Claude Code 가 없다 — 그러면 한 번 더 npm ci 로 받아 온다(실패해도 pg 가 있으면 계속 간다).
  const hasPg = existsSync(join(root, 'node_modules', 'pg', 'package.json'));
  if (hasPg && existsSync(join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json'))) return 'present';
  // pg 가 이미 있으면 ci(node_modules 를 지우고 다시)가 아니라 install — 실패해도 있던 pg 를 잃지 않는다
  console.log('  Installing online dependencies (npm ' + (hasPg ? 'install' : 'ci') + ') ...');
  const r = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [hasPg ? 'install' : 'ci', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit' });
  return r.status === 0 ? 'installed' : hasPg ? 'present' : 'failed';
}

export async function start(env = process.env) {
  if (!env.DATABASE_URL) {
    console.log('  [NOTE] No database yet - starting the personal edition (create a PostgreSQL database to switch to the online edition)');
    const personal = await import(pathToFileURL(join(ROOT, 'tools', 'server.mjs')).href);
    try { await personal.boot(); } catch { process.exit(1); }
    console.log('  Story Engine : listening on ' + personal.HOSTING.host + ':' + personal.HOSTING.port);
    for (const n of personal.HOSTING.notes) console.log('  [NOTE] ' + n);
    return 'personal';
  }
  if (ensureDeps() === 'failed') { console.log('  [STOP] npm ci failed - see the lines above'); process.exit(1); }
  const how = ensureMasterKey(env);
  if (how !== 'secrets') {
    console.log('  [NOTE] AI keys are sealed with data/online-master.key' + (how === 'file-new' ? ' (just created)' : ''));
    console.log('  [NOTE] Before publishing, copy that value into the Secrets as CREDENTIALS_KEY_V1');
  }
  if (onPlatform(env) && env.SE_TRUST_PROXY == null) env.SE_TRUST_PROXY = '1';
  const online = await import(pathToFileURL(join(ROOT, 'online', 'server.mjs')).href);
  if (!(await online.main(env))) process.exit(1);
  return 'online';
}

if (process.argv[1] && /online[\\/]start\.mjs$/.test(process.argv[1])) await start(process.env);
