// 작품 묶음(story-project) — 개인판(USB) ↔ 온라인판을 잇는 파일 하나(명세 §40 · docs/MIGRATION.md).
// 묶음 = { format, version, exportedAt, sha256, project } — project 는 개인판 project.json 과 같은 꼴(작업 줄은 빼고).
// 개인판 project.json 을 그대로 가져와도 받는다(옮기기 첫 판). 지문이 맞지 않으면 받지 않는다(반쯤 깨진 파일로 작품을 세우지 않는다).
// 문서의 그림(DESIGN §6-9)은 곁에 싣는다 — images: [{ id, mime, data(base64) }] + imagesSha256. 그림이 없으면 두 칸 다 없다(옛 파일과 같은 꼴).

import { createHash } from 'node:crypto';

export const BUNDLE_FORMAT = 'story-project';
const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

export function makeBundle(p, images = []) {
  const project = structuredClone(p);
  delete project.jobs;   // 도는 작업은 그 자리의 것이다 — 옮기지 않는다
  const out = { format: BUNDLE_FORMAT, version: 1, exportedAt: Date.now(), sha256: sha(JSON.stringify(project)), project };
  if (Array.isArray(images) && images.length) { out.images = images; out.imagesSha256 = sha(JSON.stringify(images)); }
  return out;
}

// 받은 것 → { project, images } 또는 { error }(사람 말)
export function readBundle(raw) {
  if (!raw || typeof raw !== 'object') return { error: '작품 파일이 아닙니다' };
  if (raw.format === BUNDLE_FORMAT) {
    if (!raw.project || typeof raw.project !== 'object' || !Array.isArray(raw.project.docs)) return { error: '작품 파일이 아닙니다' };
    if (Number(raw.version) > 1) return { error: '더 새 판에서 만든 파일입니다 — 프로그램을 새로 받은 뒤 가져오세요' };
    if (raw.sha256 && sha(JSON.stringify(raw.project)) !== raw.sha256) return { error: '파일이 손상되었습니다(지문이 맞지 않습니다)' };
    const images = Array.isArray(raw.images) ? raw.images.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && typeof x.data === 'string') : [];
    if (Array.isArray(raw.images) && raw.imagesSha256 && sha(JSON.stringify(raw.images)) !== raw.imagesSha256) return { error: '파일이 손상되었습니다(그림의 지문이 맞지 않습니다)' };
    return { project: raw.project, images };
  }
  if (raw.id && Array.isArray(raw.docs)) return { project: raw, images: [] };   // 개인판 project.json 그대로
  return { error: '작품 파일이 아닙니다' };
}
