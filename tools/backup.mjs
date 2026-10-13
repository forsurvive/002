// 백업 한 벌 — 켤 때마다 작품 파일을 data/backup/projects/ 로 한 벌 옮겨 적는다(docs/PERSONAL_USB.md §3).
// 설정 항목이 아니다(정해 둔 때 · 여러 벌 · 다른 자리로의 자동 복사 없음). USB 를 쓰는 중에 뽑혀 작품 파일이 깨졌을 때
// 지난번에 켰을 때의 모습으로 돌아갈 길 하나를 남기는 것뿐이다.
//   · 읽히는(JSON 으로 풀리고 id 가 있는) 파일만 옮겨 적는다 — 깨진 파일이 멀쩡한 백업을 덮지 않는다.
//   · 깨진 파일의 백업은 그대로 둔다. 지운 작품의 백업은 걷는다(한 벌이 늘 지금 작품들의 거울이 되게).
//   · 재귀 복사(fs.cpSync)는 쓰지 않는다 — 한글 경로에서 node 를 죽인 실측(store.mjs).

import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeText } from './store.mjs';

export function backupProjects(dataDir) {
  const from = join(dataDir, 'projects');
  const to = join(dataDir, 'backup', 'projects');
  const out = { copied: 0, broken: [], pruned: 0 };
  if (!existsSync(from)) return out;
  const names = readdirSync(from).filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f));
  for (const f of names) {
    let text = '';
    try {
      text = readFileSync(join(from, f), 'utf8');
      const p = JSON.parse(text);
      if (!p || !p.id) throw new Error('no id');
    } catch { out.broken.push(f); continue; }
    writeText(join(to, f), text);
    out.copied++;
  }
  if (existsSync(to)) {
    for (const f of readdirSync(to)) {
      if (!names.includes(f)) { try { rmSync(join(to, f), { force: true }); out.pruned++; } catch {} }
    }
  }
  return out;
}
