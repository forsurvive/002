// 저장소 — 프로젝트 하나가 파일 하나(data/projects/<id>.json).
// 쓰기는 임시 파일에 쓰고 rename 으로 갈아끼운다(중간에 죽어도 반쪽 파일이 남지 않는다).
// 한글 경로에서 fs.cpSync(recursive) 가 node 를 죽인 실측이 있어 재귀 복사는 쓰지 않는다.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = dirname(HERE);
export const DATA_DIR = process.env.SE2_DATA_DIR || join(ROOT, 'data');
const PROJ_DIR = join(DATA_DIR, 'projects');

let seq = 0;
export function newId(prefix = 'i') {
  seq += 1;
  return prefix + '_' + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

function ensureDirs() {
  mkdirSync(PROJ_DIR, { recursive: true });
}

function projPath(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(id || ''))) throw new Error('잘못된 프로젝트 id');
  return join(PROJ_DIR, id + '.json');
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  try { renameSync(tmp, file); } catch (e) { try { rmSync(tmp, { force: true }); } catch {} throw e; }
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

// 프로젝트 레코드의 빈 골격 — 모든 목록은 반드시 배열로 존재한다.
export function blankProject(id, name) {
  const at = Date.now();
  return {
    id,
    name: String(name || '새 작품'),
    spec: { outline: '', form: '', length: '' },
    standard: '',
    request: '',
    materials: [],
    docs: [],
    categories: [],
    threads: [],
    trash: [],
    jobs: [],
    auto: { feedbackRounds: 1, skipProse: false, lastFinishedAt: 0 },
    agents: null,
    createdAt: at,
    updatedAt: at,
  };
}

export function listProjects() {
  ensureDirs();
  let files = [];
  try { files = readdirSync(PROJ_DIR).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    const p = readJson(join(PROJ_DIR, f));
    if (p && p.id) out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt || 0, createdAt: p.createdAt || 0 });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out;
}

export function loadProject(id) {
  ensureDirs();
  const p = readJson(projPath(id));
  if (!p || !p.id) return null;
  // 옛 파일에 빠진 칸이 있어도 화면이 깨지지 않게 골격을 덮어씌운다.
  const base = blankProject(p.id, p.name);
  return {
    ...base, ...p,
    spec: { ...base.spec, ...(p.spec || {}) },
    auto: { ...base.auto, ...(p.auto || {}) },
    materials: p.materials || [],
    docs: p.docs || [],
    categories: p.categories || [],
    threads: p.threads || [],
    trash: p.trash || [],
    jobs: p.jobs || [],
  };
}

export function saveProject(p) {
  ensureDirs();
  p.updatedAt = Date.now();
  writeJson(projPath(p.id), p);
  return p;
}

export function createProject(fields = {}) {
  ensureDirs();
  const id = newId('p').replace(/[^A-Za-z0-9_-]/g, '');
  const p = blankProject(id, fields.name);
  if (fields.spec) p.spec = { ...p.spec, ...fields.spec };
  if (fields.standard) p.standard = String(fields.standard);
  if (fields.request) p.request = String(fields.request);
  if (Array.isArray(fields.materials)) {
    for (const m of fields.materials) {
      if (!m || !String(m.text || '').trim()) continue;
      p.materials.push({ id: newId('m'), name: String(m.name || '자료'), text: String(m.text), addedAt: Date.now() });
    }
  }
  saveProject(p);
  return p;
}

export function deleteProject(id) {
  const f = projPath(id);
  if (!existsSync(f)) return false;
  rmSync(f, { force: true });
  return true;
}
