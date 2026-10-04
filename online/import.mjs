// 개인판 프로젝트(JSON 한 파일) → 온라인판(PostgreSQL). 원본은 건드리지 않고, 옮긴 뒤 다시 지어 견준 보고서를 낸다.
//   DATABASE_URL=… node online/import.mjs <data/projects/p_….json> --owner <아이디>
//
// 옮기며 하는 일(개인판이 읽을 때 하는 일과 같다):
//   · 빠진 칸은 개인판 골격으로 채운다(tools/store.mjs normalizeProject) · 옛 판 자료(p.materials)는 «자료» 카테고리의 문서로
//   · 끊긴 참조(없는 문서 · 사람 · 카테고리를 가리키는 것)는 걸러 내고 몇 개였는지 보고한다
//   · 작업 기록(p.jobs)은 싣지 않는다 — 온라인판 작업은 jobs 표가 맡는다
// 못 옮기는 꼴(같은 id 가 둘 · 문서가 객체가 아님 등)이면 아무것도 쓰지 않고 멈춘다. 콘솔은 ASCII 만.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeProject } from '../tools/store.mjs';
import { materialsToDocs } from '../core/domain/model.mjs';
import { MODELS } from '../core/ids.mjs';
import { createProjectStore } from './store.mjs';
import { audit } from './auth.mjs';

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const str = (v) => (v == null ? '' : String(v));
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
const objs = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

// 표에 들어갈 꼴로 다듬는다 — 파일은 사람 손을 탔을 수 있다(타입이 어긋나면 DB 가 거절하기 전에 여기서 맞춘다)
function shape(p) {
  const problems = [];
  const at = Date.now();
  p.name = str(p.name).trim() || '새 작품';
  p.standard = str(p.standard); p.request = str(p.request);
  p.spec = Object.fromEntries(Object.entries(p.spec || {}).map(([k, v]) => [k, str(v)]));
  p.categories = objs(p.categories).map((c) => ({ id: str(c.id), name: str(c.name) || '카테고리', createdAt: num(c.createdAt, at) }));
  p.crew = objs(p.crew).map((a) => ({
    id: str(a.id), name: str(a.name) || '이름 없음', role: str(a.role), craft: str(a.craft),
    model: MODELS.includes(a.model) ? a.model : p.model, createdAt: num(a.createdAt, at),
  }));
  p.docs = objs(p.docs).map((d) => {
    const out = {
      id: str(d.id), src: str(d.src), kind: ['doc', 'check', 'review'].includes(d.kind) ? d.kind : 'doc',
      title: str(d.title).trim() || '제목 없음', body: str(d.body), isFinal: !!d.isFinal,
      categoryId: d.categoryId ? str(d.categoryId) : null, request: str(d.request),
      refIds: ids(d.refIds), targetIds: ids(d.targetIds), agentIds: ids(d.agentIds),
      versions: objs(d.versions).map((v) => ({ at: num(v.at, at), title: str(v.title), body: v.body == null ? undefined : str(v.body) }))
        .map((v) => (v.body === undefined ? { at: v.at, title: v.title } : v)),
      createdAt: num(d.createdAt, at), updatedAt: num(d.updatedAt, num(d.createdAt, at)),
    };
    if (d.material) out.material = true;
    if (d.orphanFrom) out.orphanFrom = str(d.orphanFrom);
    return out;
  });
  p.threads = objs(p.threads).map((t) => ({
    id: str(t.id), title: str(t.title) || '논의', refIds: ids(t.refIds), agentIds: ids(t.agentIds),
    messages: objs(t.messages).map((m) => ({
      id: str(m.id), parentId: m.parentId ? str(m.parentId) : null, role: m.role === 'assistant' ? 'assistant' : 'user', text: str(m.text), at: num(m.at, at),
    })),
    headId: t.headId ? str(t.headId) : null, createdAt: num(t.createdAt, at), updatedAt: num(t.updatedAt, num(t.createdAt, at)),
  }));
  p.trash = objs(p.trash).filter((e) => ['doc', 'category', 'thread'].includes(e.kind)).map((e) => ({
    id: str(e.id), at: num(e.at, at), kind: e.kind, from: str(e.from), title: str(e.title),
    payload: e.payload && typeof e.payload === 'object' ? e.payload : {},
    ...(e.kind === 'category' ? { memberIds: ids(e.memberIds) } : {}),
  }));

  // 한 표 안에서 id 가 겹치면 옮길 수 없다(어느 것이 어느 것인지 가릴 수 없다)
  const dup = (name, list) => {
    const seen = new Set();
    for (const x of list) {
      if (!x.id) { problems.push(name + ': an entry has no id'); return; }
      if (seen.has(x.id)) { problems.push(name + ': duplicate id ' + x.id); return; }
      seen.add(x.id);
    }
  };
  dup('docs', p.docs); dup('categories', p.categories); dup('agents', p.crew); dup('threads', p.threads); dup('trash', p.trash);
  dup('messages', p.threads.flatMap((t) => t.messages));
  return problems;
}

// 끊긴 참조를 걸러 낸다 — 몇 개를 걸렀는지 센다
function dropBroken(p) {
  const docs = new Set(p.docs.map((d) => d.id));
  const agents = new Set(p.crew.map((a) => a.id));
  const cats = new Set(p.categories.map((c) => c.id));
  let n = 0;
  const keep = (list, have) => { const out = list.filter((x) => have.has(x)); n += list.length - out.length; return out; };
  for (const d of p.docs) {
    d.refIds = keep(d.refIds, docs); d.targetIds = keep(d.targetIds, docs); d.agentIds = keep(d.agentIds, agents);
    if (d.categoryId && !cats.has(d.categoryId)) { d.categoryId = null; n += 1; }
  }
  for (const t of p.threads) {
    t.refIds = keep(t.refIds, docs); t.agentIds = keep(t.agentIds, agents);
    const msgs = new Set(t.messages.map((m) => m.id));
    for (const m of t.messages) if (m.parentId && !msgs.has(m.parentId)) { m.parentId = null; n += 1; }
    if (t.headId && !msgs.has(t.headId)) { t.headId = null; n += 1; }
  }
  return n;
}

// 견줄 지문 — 본문은 sha256 으로(판은 본문이 남아 있는 것만)
function prints(p) {
  return {
    // 본문이 마른 판(개인판 휴지통을 지나온 것)은 «있었다»는 표시뿐이라 판으로 세우지 않는다 — 따로 센다
    docs: p.docs.map((d) => d.id + ':' + sha(d.title) + ':' + sha(d.body) + ':' + (d.versions || []).filter((v) => v.body != null).map((v) => sha(v.title) + '/' + sha(v.body)).join(',')).sort(),
    categories: p.categories.map((c) => c.id + ':' + c.name).sort(),
    agents: p.crew.map((a) => a.id + ':' + sha(a.role + a.craft) + ':' + a.model).sort(),
    threads: p.threads.map((t) => t.id + ':' + t.headId + ':' + t.messages.map((m) => m.id + '<' + (m.parentId || '') + ':' + sha(m.text)).join(',')).sort(),
    refs: p.docs.map((d) => d.id + '>' + d.refIds.join(',') + '|' + d.targetIds.join(',') + '|' + d.agentIds.join(',')).sort(),
    trash: p.trash.map((e) => e.id + ':' + e.kind).sort(),
  };
}

/**
 * raw(파일에서 읽은 객체) → 새 프로젝트. 돌려주는 것: { ok, pid, report } 또는 { ok:false, problems }.
 * report = { counts, droppedRefs, bodilessVersions, checks: { 이름: true|false } }
 */
export async function importProject(pool, raw, { ownerUserId, organizationId = null } = {}) {
  const src = normalizeProject(structuredClone(raw));
  if (!src) return { ok: false, problems: ['not a project file (no id)'] };
  const problems = shape(src);
  if (problems.length) return { ok: false, problems };
  materialsToDocs(src);
  src.jobs = [];
  const droppedRefs = dropBroken(src);
  const bodilessVersions = src.docs.reduce((n, d) => n + d.versions.filter((v) => v.body == null).length, 0);

  const store = createProjectStore(pool);
  const pid = await store.create({ name: src.name, spec: src.spec, standard: src.standard, request: src.request }, { ownerUserId, organizationId });
  try {
    await pool.query('UPDATE projects SET legacy_id = $2, created_at = $3 WHERE id = $1', [pid, src.id, new Date(num(src.createdAt, Date.now()))]);
    await store.update(pid, (p) => {
      for (const k of Object.keys(p)) delete p[k];
      Object.assign(p, structuredClone(src), { id: pid });
    }, { userId: ownerUserId });
  } catch (e) {
    // 반쯤 옮긴 프로젝트를 남기지 않는다 — 방금 만든 빈 행이라 지워도 잃는 것이 없다
    await pool.query('DELETE FROM projects WHERE id = $1', [pid]);
    throw e;
  }

  const back = await store.get(pid);
  const a = prints(src); const b = prints(back);
  const checks = Object.fromEntries(Object.keys(a).map((k) => [k, JSON.stringify(a[k]) === JSON.stringify(b[k])]));
  checks.settings = JSON.stringify([src.name, src.spec, src.standard, src.request, src.model, src.noCount, src.prompts, src.slotModels])
    === JSON.stringify([back.name, back.spec, back.standard, back.request, back.model, back.noCount, back.prompts, back.slotModels]);
  const counts = {
    docs: back.docs.length, versions: back.docs.reduce((n, d) => n + d.versions.length, 0), categories: back.categories.length,
    agents: back.crew.length, threads: back.threads.length, messages: back.threads.reduce((n, t) => n + t.messages.length, 0), trash: back.trash.length,
  };
  await audit(pool, { actor: ownerUserId, organizationId, action: 'project.import', targetType: 'project', targetId: pid, details: { legacyId: src.id, counts, droppedRefs, bodilessVersions } });
  return { ok: Object.values(checks).every(Boolean), pid, report: { counts, droppedRefs, bodilessVersions, checks } };
}

// 직접 부를 때
if (process.argv[1] && /online[\\/]import\.mjs$/.test(process.argv[1])) {
  const { createPool } = await import('./db.mjs');
  const { migrate } = await import('./migrate.mjs');
  const args = process.argv.slice(2);
  const file = args.find((x) => !x.startsWith('--') && x !== args[args.indexOf('--owner') + 1]);
  const owner = args.includes('--owner') ? String(args[args.indexOf('--owner') + 1] || '').toLowerCase() : '';
  if (!file || !owner) { console.log('  usage: node online/import.mjs <project.json> --owner <login-id>'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.log('  [STOP] DATABASE_URL is not set'); process.exit(1); }
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { console.log('  [STOP] cannot read JSON: ' + file); process.exit(1); }
  const pool = createPool(process.env.DATABASE_URL);
  try {
    await migrate(pool);
    const u = (await pool.query('SELECT id FROM users WHERE login_id = $1', [owner])).rows[0];
    if (!u) { console.log('  [STOP] no such user: ' + owner); process.exitCode = 1; }
    else {
      const r = await importProject(pool, raw, { ownerUserId: u.id });
      if (!r.pid) { for (const p of r.problems) console.log('  [STOP] ' + p); process.exitCode = 1; }
      else {
        console.log('  project : ' + r.pid);
        for (const [k, v] of Object.entries(r.report.counts)) console.log('  ' + k.padEnd(10) + ': ' + v);
        console.log('  dropped broken references: ' + r.report.droppedRefs);
        console.log('  version marks without text (not imported): ' + r.report.bodilessVersions);
        for (const [k, v] of Object.entries(r.report.checks)) console.log('  check ' + k.padEnd(10) + ': ' + (v ? 'OK' : 'MISMATCH'));
        if (!r.ok) process.exitCode = 2;
      }
    }
  } finally {
    await pool.end();
  }
}
