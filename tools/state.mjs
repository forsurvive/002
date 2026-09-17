// 메모리가 정본, 파일은 그 그림자.
// 모든 고침은 update() 하나를 지난다 — 한 프로세스 안에서 차례로 돌므로 서로를 덮어쓰지 않는다.

import { loadProject, saveProject, listProjects, createProject, deleteProject } from './store.mjs';

const cache = new Map();

export function get(pid) {
  if (cache.has(pid)) return cache.get(pid);
  const p = loadProject(pid);
  if (!p) return null;
  cache.set(pid, p);
  return p;
}

export function update(pid, fn) {
  const p = get(pid);
  if (!p) return { ok: false, error: '프로젝트를 찾을 수 없습니다' };
  const r = fn(p);
  // 기록이 한 번 미끄러져도 하던 일을 멈추지 않는다 — 메모리가 정본이고,
  // 프로젝트 파일은 저장할 때마다 통째로 다시 쓰므로 다음 저장이 밀린 것까지 함께 남긴다.
  try { saveProject(p); } catch (e) { console.log('  [저장 미끄러짐] ' + ((e && e.message) || e)); }
  return r === undefined ? { ok: true } : r;
}

export function create(fields) {
  const p = createProject(fields);
  cache.set(p.id, p);
  return p;
}

export function remove(pid) {
  cache.delete(pid);
  return deleteProject(pid);
}

export function list() { return listProjects(); }

export function exists(pid) { return !!get(pid); }

export function forget(pid) { cache.delete(pid); }
