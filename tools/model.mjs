// 원소의 순수 동작 — 프로젝트 레코드를 받아 고치고 돌려준다. 파일 입출력도 호출도 하지 않는다.
//
// 뼈대가 되는 두 가지 단순화:
//  1) 문서·모순 검사·합평회는 «같은 레코드»다(kind 만 다르다). 그래서 원소 표의 칸이 저절로 채워진다.
//  2) '새로 추가된 문서' 카테고리는 레코드가 아니라 «categoryId 가 없는 문서들»이다.
//     그래서 비면 저절로 사라지고, 새 문서가 생기면 저절로 돌아온다.

import { newId, MODELS } from './store.mjs';
import { bookText } from './books.mjs';

export const INBOX = '__inbox__';
export const THREAD_NAME = '논의';
// 차림표가 한 글자도 받지 않고 지을 때 붙이는 이름 — 이것이 그대로면 아직 손대지 않은 것이다.
export const DOC_NAME = { doc: '문서', check: '모순 검사', review: '합평회' };   // 갓 만든 스레드의 이름 — 이것이 그대로면 아직 손대지 않은 것이다
export const INBOX_NAME = '새로 추가된 문서';

export const KIND_NAME = { doc: '문서', check: '모순 검사', review: '합평회' };

const now = () => Date.now();
const str = (v) => (v == null ? '' : String(v));

export function findDoc(p, id) { return p.docs.find((d) => d.id === id) || null; }
export function findCategory(p, id) { return p.categories.find((c) => c.id === id) || null; }
export function findThread(p, id) { return p.threads.find((t) => t.id === id) || null; }

// ---------------------------------------------------------------- 문서

// 문서의 본문 — src 를 가진 문서(작법서)는 그때그때 파일에서 푼다.
// 프로젝트 파일에도, 1.5초마다 도는 갱신에도 그 글자가 실리지 않는다.
export function bodyOf(d) {
  return d && d.src ? bookText(d.src) : str(d && d.body);
}

export function docCreate(p, fields = {}) {
  const d = {
    id: newId('d'),
    src: str(fields.src) || '',
    kind: fields.kind === 'check' || fields.kind === 'review' ? fields.kind : 'doc',
    title: str(fields.title).trim() || '제목 없음',
    body: str(fields.body),
    isFinal: false,
    categoryId: fields.categoryId && findCategory(p, fields.categoryId) ? fields.categoryId : null,
    request: str(fields.request),
    refIds: Array.isArray(fields.refIds) ? fields.refIds.slice() : [],
    targetIds: Array.isArray(fields.targetIds) ? fields.targetIds.slice() : [],
    agentIds: Array.isArray(fields.agentIds) ? fields.agentIds.slice() : [],
    versions: [],
    createdAt: now(),
    updatedAt: now(),
  };
  p.docs.push(d);
  return d;
}

// 편집·갱신·복원이 모두 이 문을 지난다 — 지나기 직전의 판이 이력에 남는다.
export function docWrite(p, id, next = {}, { keepHistory = true } = {}) {
  const d = findDoc(p, id);
  if (!d) return null;
  // 이력에 판을 남길 만한 바뀜은 제목·본문뿐이다.
  const changed = (next.title != null && str(next.title) !== d.title) || (next.body != null && str(next.body) !== d.body);
  if (changed && keepHistory) d.versions.push({ at: d.updatedAt || d.createdAt, title: d.title, body: d.body });
  // «언제 손댔는가»는 참조·대상·에이전트·요청사항·그릇까지 센다.
  // 폰은 이 시각이 그대로면 문서를 다시 받아 오지 않는다 — 여기서 안 찍으면 폰 화면이 옛 값에 머문다.
  const before = JSON.stringify([d.request, d.refIds, d.targetIds, d.agentIds, d.categoryId]);
  if (next.title != null) d.title = str(next.title).trim() || '제목 없음';
  if (next.body != null && !d.src) d.body = str(next.body);   // 가리키는 문서는 고쳐 쓰지 않는다
  if (next.request != null) d.request = str(next.request);
  if (next.refIds != null) d.refIds = next.refIds.slice();
  if (next.targetIds != null) d.targetIds = next.targetIds.slice();
  if (next.agentIds != null) d.agentIds = next.agentIds.slice();
  if (next.categoryId !== undefined) {
    d.categoryId = next.categoryId && findCategory(p, next.categoryId) ? next.categoryId : null;
    d.orphanFrom = null; // 손으로 옮긴 순간 옛 그릇과의 연고가 끊긴다
  }
  const touched = JSON.stringify([d.request, d.refIds, d.targetIds, d.agentIds, d.categoryId]) !== before;
  if (changed || touched) d.updatedAt = now();
  return d;
}

export function docRestoreVersion(p, id, index) {
  const d = findDoc(p, id);
  if (!d) return null;
  const v = d.versions[index];
  if (!v) return null;
  return docWrite(p, id, { title: v.title, body: v.body });
}

export function docSetFinal(p, id, on) {
  const d = findDoc(p, id);
  if (!d) return null;
  d.isFinal = !!on;
  return d;
}

// 차림표에서 만들어지기만 하고 아무것도 담기지 않은 문서 — 이름까지 그대로여야 «갓 만든 것»이다.
export function docIsFresh(d) {
  return !!d && !str(d.body).trim() && !str(d.request).trim()
    && !(d.refIds || []).length && !(d.targetIds || []).length && !(d.agentIds || []).length
    && !(d.versions || []).length && !d.isFinal && !d.categoryId
    && d.title === DOC_NAME[d.kind || 'doc'];
}

// 거두기 — 휴지통을 거치지 않는다. 되살릴 것이 없는 껍데기이기 때문이다.
export function docDiscard(p, id) {
  const i = (p.docs || []).findIndex((x) => x.id === id);
  if (i < 0 || !docIsFresh(p.docs[i])) return null;
  const [d] = p.docs.splice(i, 1);
  return d;
}

export function docDelete(p, id) {
  const i = p.docs.findIndex((d) => d.id === id);
  if (i < 0) return null;
  const [d] = p.docs.splice(i, 1);
  p.trash.push({ id: newId('t'), at: now(), kind: 'doc', from: KIND_NAME[d.kind] || '문서', title: d.title, payload: d });
  return d;
}

// ---------------------------------------------------------------- 카테고리

export function categoryCreate(p, name) {
  const c = { id: newId('c'), name: str(name).trim() || '새 카테고리', createdAt: now() };
  p.categories.push(c);
  return c;
}

// 그릇만 휴지통으로 간다. 안에 있던 문서는 '새로 추가된 문서'로 돌아간다(지워지지 않는다).
export function categoryDelete(p, id) {
  const i = p.categories.findIndex((c) => c.id === id);
  if (i < 0) return null;
  const [c] = p.categories.splice(i, 1);
  const memberIds = [];
  for (const d of p.docs) if (d.categoryId === id) { memberIds.push(d.id); d.categoryId = null; d.orphanFrom = id; }
  p.trash.push({ id: newId('t'), at: now(), kind: 'category', from: '카테고리', title: c.name, payload: c, memberIds });
  return c;
}

// 화면이 그리는 목록 — '새로 추가된 문서'가 맨 앞, 비어 있으면 아예 없다.
export function categoriesView(p) {
  const out = [];
  const loose = p.docs.filter((d) => !d.categoryId || !findCategory(p, d.categoryId));
  if (loose.length) out.push({ id: INBOX, name: INBOX_NAME, virtual: true, docIds: loose.map((d) => d.id) });
  for (const c of p.categories) {
    out.push({ id: c.id, name: c.name, virtual: false, docIds: p.docs.filter((d) => d.categoryId === c.id).map((d) => d.id) });
  }
  return out;
}

export function categoryDocIds(p, catId) {
  if (catId === INBOX) return p.docs.filter((d) => !d.categoryId || !findCategory(p, d.categoryId)).map((d) => d.id);
  return p.docs.filter((d) => d.categoryId === catId).map((d) => d.id);
}

// ---------------------------------------------------------------- 논의 스레드

export function threadCreate(p, fields = {}) {
  const t = {
    id: newId('h'),
    title: str(fields.title).trim() || THREAD_NAME,
    refIds: Array.isArray(fields.refIds) ? fields.refIds.slice() : [],
    agentIds: Array.isArray(fields.agentIds) ? fields.agentIds.slice() : [],
    messages: [],
    headId: null,
    createdAt: now(),
    updatedAt: now(),
  };
  p.threads.push(t);
  return t;
}

export function threadAddMessage(p, id, role, text, parentId, { moveHead = true } = {}) {
  const t = findThread(p, id);
  if (!t) return null;
  const m = {
    id: newId('g'),
    parentId: parentId !== undefined ? parentId : t.headId,
    role: role === 'assistant' ? 'assistant' : 'user',
    text: str(text),
    at: now(),
  };
  t.messages.push(m);
  if (moveHead) t.headId = m.id;
  t.updatedAt = now();
  return m;
}

// 과거 메시지를 고치면 같은 부모 아래 새 가지가 돋는다. 원래 흐름은 그대로 남는다.
export function threadEditMessage(p, id, messageId, text) {
  const t = findThread(p, id);
  if (!t) return null;
  const m = t.messages.find((x) => x.id === messageId);
  if (!m) return null;
  return threadAddMessage(p, id, m.role, text, m.parentId);
}

export function threadPath(t, headId) {
  const head = headId || t.headId;
  const byId = new Map(t.messages.map((m) => [m.id, m]));
  const path = [];
  let cur = byId.get(head);
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return path;
}

// 어떤 메시지에서 이어지는 «가장 끝»(그 가지의 마지막 메시지)
export function threadLeafOf(t, messageId) {
  let cur = messageId;
  for (;;) {
    const kids = t.messages.filter((m) => m.parentId === cur);
    if (!kids.length) return cur;
    cur = kids[kids.length - 1].id;
  }
}

export function threadSetHead(p, id, messageId) {
  const t = findThread(p, id);
  if (!t) return null;
  if (!t.messages.some((m) => m.id === messageId)) return null;
  t.headId = threadLeafOf(t, messageId);
  t.updatedAt = now();
  return t;
}

// 같은 부모를 둔 형제들 = 그 자리에서 갈라진 가지들
export function threadSiblings(t, messageId) {
  const m = t.messages.find((x) => x.id === messageId);
  if (!m) return [];
  return t.messages.filter((x) => x.parentId === m.parentId);
}

// 아직 아무것도 담기지 않은 스레드 — 차림표를 눌러 만들어지기만 한 그것.
// 이름까지 그대로여야 «갓 만든 것»이다(이름을 지어 주었으면 작가가 쓰려던 자리다).
export function threadIsFresh(t) {
  return !!t && !(t.messages || []).length && !t.headId
    && !(t.refIds || []).length && !(t.agentIds || []).length
    && t.title === THREAD_NAME;
}

// 거두기 — 휴지통을 거치지 않는다. 되살릴 것이 없는 껍데기이기 때문이다.
// 조건에 어긋나면 아무 일도 하지 않는다(화면이 잘못 재어도 글이 날아가지 않는다).
export function threadDiscard(p, id) {
  const i = (p.threads || []).findIndex((t) => t.id === id);
  if (i < 0 || !threadIsFresh(p.threads[i])) return null;
  const [t] = p.threads.splice(i, 1);
  return t;
}

export function threadDelete(p, id) {
  const i = p.threads.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const [t] = p.threads.splice(i, 1);
  p.trash.push({ id: newId('t'), at: now(), kind: 'thread', from: '논의 스레드', title: t.title, payload: t });
  return t;
}

// ---------------------------------------------------------------- 자료

// 붙여 넣은 글에 이름이 없으면 첫 줄 앞부분을 이름으로 삼는다(여럿이 같은 이름이 되지 않게).
export function firstLineName(text) {
  const first = str(text).split('\n').map((l) => l.trim()).find((l) => l) || '';
  return first.slice(0, 24) || '붙여 넣은 글';
}

export function materialAdd(p, name, text) {
  const t = str(text);
  if (!t.trim()) return null;
  const m = { id: newId('m'), name: str(name).trim() || '자료', text: t, addedAt: now() };
  p.materials.push(m);
  return m;
}

export function materialDelete(p, id) {
  const i = p.materials.findIndex((m) => m.id === id);
  if (i < 0) return null;
  return p.materials.splice(i, 1)[0];
}

// ---------------------------------------------------------------- 에이전트 (작가가 짓는다)
//
// 자리마다 붙어 있는 작법 프롬프트와는 다른 것이다. 이쪽은 «누가 쓰는가»이고,
// 문서에 걸어 두면 그 문서를 짓고 고칠 때마다 그 사람이 쓴다.

export function agentCreate(p, fields = {}) {
  p.crew = p.crew || [];
  const a = {
    id: newId('g'),
    name: str(fields.name).trim() || '이름 없음',
    role: str(fields.role),
    craft: str(fields.craft),
    model: MODELS.includes(str(fields.model)) ? str(fields.model) : (p.model || 'opus'),   // 비워 두지 않는다
    createdAt: now(),
  };
  p.crew.push(a);
  return a;
}

export function findAgent(p, id) { return (p.crew || []).find((a) => a.id === id) || null; }

export function agentWrite(p, id, next = {}) {
  const a = findAgent(p, id);
  if (!a) return null;
  if (next.name != null) a.name = str(next.name).trim() || a.name;
  if (next.role != null) a.role = str(next.role);
  if (next.craft != null) a.craft = str(next.craft);
  if (next.model != null && MODELS.includes(str(next.model))) a.model = str(next.model);
  return a;
}

// 지운 사람은 문서에서도 떨어진다 — 걸어 둔 자리가 허공을 가리키지 않게.
export function agentDelete(p, id) {
  const i = (p.crew || []).findIndex((a) => a.id === id);
  if (i < 0) return null;
  const [a] = p.crew.splice(i, 1);
  for (const d of p.docs) {
    if (Array.isArray(d.agentIds) && d.agentIds.includes(id)) d.agentIds = d.agentIds.filter((x) => x !== id);
  }
  for (const t of p.threads) {
    if (Array.isArray(t.agentIds) && t.agentIds.includes(id)) t.agentIds = t.agentIds.filter((x) => x !== id);
  }
  return a;
}

export function agentsByIds(p, ids = []) {
  const out = [];
  for (const id of ids) {
    const a = findAgent(p, id);
    if (a) out.push({ id: a.id, name: a.name, role: a.role, craft: a.craft, model: a.model || '' });
  }
  return out;
}

// ---------------------------------------------------------------- 휴지통

export function trashRestore(p, trashId) {
  const i = p.trash.findIndex((e) => e.id === trashId);
  if (i < 0) return null;
  const [e] = p.trash.splice(i, 1);
  if (e.kind === 'doc') {
    const d = e.payload;
    if (d.categoryId && !findCategory(p, d.categoryId)) d.categoryId = null;
    // 담겨 있는 동안 지워진 사람은 떨어뜨린다(허공을 가리키는 칩을 세우지 않는다).
    if (Array.isArray(d.agentIds)) d.agentIds = d.agentIds.filter((id) => findAgent(p, id));
    p.docs.push(d);
  } else if (e.kind === 'category') {
    p.categories.push(e.payload);
    for (const did of e.memberIds || []) {
      const d = findDoc(p, did);
      // 그 사이 다른 그릇을 거쳐 온 문서는 도로 빨아들이지 않는다.
      if (d && !d.categoryId && d.orphanFrom === e.payload.id) { d.categoryId = e.payload.id; d.orphanFrom = null; }
    }
  } else if (e.kind === 'thread') {
    const t = e.payload;
    if (Array.isArray(t.agentIds)) t.agentIds = t.agentIds.filter((id) => findAgent(p, id));
    p.threads.push(t);
  }
  return e;
}

export function trashPurge(p, trashId) {
  const i = p.trash.findIndex((e) => e.id === trashId);
  if (i < 0) return null;
  return p.trash.splice(i, 1)[0];
}

// ---------------------------------------------------------------- 내려받기

export function docToText(d) {
  return '# ' + d.title + '\n\n' + bodyOf(d) + '\n';
}

export function categoryToText(p, catId) {
  const view = categoriesView(p).find((c) => c.id === catId);
  const name = view ? view.name : '카테고리';
  const ids = categoryDocIds(p, catId);
  const parts = ids.map((id) => findDoc(p, id)).filter(Boolean).map(docToText);
  return '# ' + name + '\n\n' + parts.join('\n---\n\n');
}

export function threadToText(t) {
  const path = threadPath(t);
  const lines = path.map((m) => (m.role === 'user' ? '## 작가\n\n' : '## 클로드\n\n') + m.text + '\n');
  return '# ' + t.title + '\n\n' + lines.join('\n');
}

export function safeFileName(s) {
  return str(s).replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '문서';
}
