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
  saveProject(p);
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
