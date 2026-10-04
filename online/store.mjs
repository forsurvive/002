// 온라인판 프로젝트 저장소 — PostgreSQL 표 ↔ Core 가 다루는 «프로젝트 덩어리»(개인판 JSON 과 같은 모양).
//
// Core(core/domain/model.mjs)는 덩어리를 받아 고치는 순수 함수다. 그래서 온라인판도 개인판의 state.update 와 같은 약속을 지킨다:
//   update(pid, fn) = 한 트랜잭션 — 프로젝트 행을 잠그고(같은 프로젝트의 고침은 차례로) · 덩어리를 짓고 · fn 으로 고치고 ·
//                     고치기 전과 견주어 바뀐 행만 쓴다. fn 이 throw 하면 아무것도 쓰지 않는다.
// 표가 개인판보다 더 지키는 것:
//   · 판은 지우지 않는다(덩어리에는 최근 KEEP_VERSIONS 판만 싣는다 — 개인판과 같은 모습). 현재 본문도 한 판이다.
//   · 휴지통으로 간 문서·스레드·카테고리 행은 deleted_at 으로 남는다. 영구 삭제도 purged_at 만 찍는다(생성 기록이 가리킬 수 있다).
//   · 갓 만든 빈 문서·스레드를 거두는 일(discard)만 행을 지운다 — 되살릴 것도 가리킬 것도 없는 껍데기다.
// Core 의 id(d_… 등)는 legacy_id 에, 표의 키는 uuid 다. 덩어리의 프로젝트 id 는 표의 uuid 그대로.

import { randomUUID, createHash } from 'node:crypto';
import { blankProject } from '../tools/store.mjs';
import { KEEP_VERSIONS } from '../core/domain/model.mjs';
import { MODELS } from '../core/ids.mjs';

const ms = (t) => (t ? new Date(t).getTime() : 0);
const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- 덩어리 짓기

export async function loadAggregate(db, pid, { lock = false } = {}) {
  const pr = (await db.query(
    `SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [pid])).rows[0];
  if (!pr) return null;
  // 한 연결(트랜잭션) 위에서는 질의를 겹쳐 보낼 수 없다 — 차례로 묻는다
  const sqls = [
    'SELECT id, legacy_id, name, sort_order, created_at, deleted_at FROM categories WHERE project_id = $1 ORDER BY sort_order, created_at',
    'SELECT * FROM documents WHERE project_id = $1 ORDER BY sort_order, created_at',
    `SELECT v.id, v.document_id, v.seq, v.title, v.body, v.at_ms, v.created_at FROM document_versions v
        WHERE v.project_id = $1 ORDER BY v.document_id, v.seq`,
    'SELECT source_document_id, target_document_id, role, sort_order FROM document_links WHERE project_id = $1 ORDER BY sort_order',
    'SELECT da.document_id, da.agent_id, da.sort_order FROM document_agents da JOIN documents d ON d.id = da.document_id WHERE d.project_id = $1 ORDER BY da.sort_order',
    'SELECT * FROM agents WHERE project_id = $1 ORDER BY sort_order, created_at',
    'SELECT * FROM project_prompt_layers WHERE project_id = $1',
    'SELECT * FROM project_slot_models WHERE project_id = $1',
    'SELECT * FROM threads WHERE project_id = $1 ORDER BY sort_order, created_at',
    'SELECT id, thread_id, parent_id, role, text, legacy_id, created_at FROM thread_messages WHERE project_id = $1 ORDER BY sort_order, created_at',
    'SELECT tl.thread_id, tl.target_document_id, tl.sort_order FROM thread_links tl JOIN threads t ON t.id = tl.thread_id WHERE t.project_id = $1 ORDER BY tl.sort_order',
    'SELECT ta.thread_id, ta.agent_id, ta.sort_order FROM thread_agents ta JOIN threads t ON t.id = ta.thread_id WHERE t.project_id = $1 ORDER BY ta.sort_order',
    'SELECT * FROM trash_entries WHERE project_id = $1 ORDER BY at_ms, created_at',
  ];
  const got = [];
  for (const sql of sqls) got.push((await db.query(sql, [pid])).rows);
  const [cats, docs, vers, links, dagents, agents, layers, slots, threads, msgs, tlinks, tagents, trash] = got;

  // 표의 uuid ↔ Core id. 지운(deleted) 행까지 담는다 — 휴지통에서 되살아날 수 있으므로.
  const maps = { cat: new Map(), doc: new Map(), agent: new Map(), thread: new Map(), msg: new Map(), ver: new Map() };
  const back = { cat: new Map(), doc: new Map(), agent: new Map(), thread: new Map(), msg: new Map() };
  for (const [k, rows] of [['cat', cats], ['doc', docs], ['agent', agents], ['thread', threads], ['msg', msgs]]) {
    for (const r of rows) { maps[k].set(r.legacy_id, r.id); back[k].set(r.id, r.legacy_id); }
  }

  const p = blankProject(pr.id, pr.name);
  p.spec = { ...p.spec, ...(pr.spec || {}) };
  p.standard = pr.standard; p.request = pr.request;
  p.materials = Array.isArray(pr.materials_legacy) ? pr.materials_legacy : [];
  p.model = MODELS.includes((pr.model_policy || {}).alias) ? pr.model_policy.alias : 'opus';
  p.noCount = pr.no_count;
  p.createdAt = ms(pr.created_at); p.updatedAt = ms(pr.updated_at);

  p.categories = cats.filter((c) => !c.deleted_at).map((c) => ({ id: c.legacy_id, name: c.name, createdAt: ms(c.created_at) }));

  const versByDoc = new Map();
  for (const v of vers) { if (!versByDoc.has(v.document_id)) versByDoc.set(v.document_id, []); versByDoc.get(v.document_id).push(v); maps.ver.set(v.id, v); }
  const linksOf = (docId, role) => links.filter((l) => l.source_document_id === docId && l.role === role).map((l) => back.doc.get(l.target_document_id)).filter(Boolean);
  p.docs = docs.filter((d) => !d.deleted_at).map((d) => {
    const all = versByDoc.get(d.id) || [];
    const cur = all.find((v) => v.id === d.current_version_id) || { title: d.title, body: '' };
    const prev = all.filter((v) => v.id !== d.current_version_id);
    const out = {
      id: d.legacy_id, src: d.src, kind: d.kind, title: cur.title, body: cur.body, isFinal: d.is_final,
      categoryId: d.category_id ? back.cat.get(d.category_id) || null : null,
      request: d.request, refIds: linksOf(d.id, 'reference'), targetIds: linksOf(d.id, 'target'),
      agentIds: dagents.filter((a) => a.document_id === d.id).map((a) => back.agent.get(a.agent_id)).filter(Boolean),
      versions: prev.slice(-KEEP_VERSIONS).map((v) => ({ at: Number(v.at_ms) || ms(v.created_at), title: v.title, body: v.body })),
      createdAt: ms(d.created_at), updatedAt: ms(d.updated_at),
    };
    if (d.is_material) out.material = true;
    if (d.orphan_from_category_id) out.orphanFrom = back.cat.get(d.orphan_from_category_id) || null;
    return out;
  });

  p.crew = agents.filter((a) => !a.deleted_at).map((a) => ({
    id: a.legacy_id, name: a.name, role: a.role, craft: a.craft,
    model: MODELS.includes((a.model_policy || {}).alias) ? a.model_policy.alias : p.model, createdAt: ms(a.created_at),
  }));

  p.prompts = {};
  const made = {};
  for (const l of layers) {
    const v = { name: l.name, role: l.role, task: l.task, craft: l.craft };
    if (l.layer === 'override') p.prompts[l.code] = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== ''));
    else made[l.code] = { code: l.code, ...v };
  }
  p.agents = pr.agent_kind || Object.keys(made).length ? { ...(pr.agent_kind ? { __kind: pr.agent_kind } : {}), ...made } : null;
  p.slotModels = {};
  for (const s of slots) if (MODELS.includes((s.model_policy || {}).alias)) p.slotModels[s.code] = s.model_policy.alias;

  p.threads = threads.filter((t) => !t.deleted_at).map((t) => ({
    id: t.legacy_id, title: t.title,
    refIds: tlinks.filter((l) => l.thread_id === t.id).map((l) => back.doc.get(l.target_document_id)).filter(Boolean),
    agentIds: tagents.filter((a) => a.thread_id === t.id).map((a) => back.agent.get(a.agent_id)).filter(Boolean),
    messages: msgs.filter((m) => m.thread_id === t.id).map((m) => ({
      id: m.legacy_id, parentId: m.parent_id ? back.msg.get(m.parent_id) || null : null, role: m.role, text: m.text, at: ms(m.created_at),
    })),
    headId: t.head_message_id ? back.msg.get(t.head_message_id) || null : null,
    createdAt: ms(t.created_at), updatedAt: ms(t.updated_at),
  }));

  p.trash = trash.map((e) => ({
    id: e.legacy_id, at: Number(e.at_ms), kind: e.kind, from: e.from_label, title: e.title, payload: e.payload,
    ...(e.kind === 'category' ? { memberIds: e.member_ids || [] } : {}),
  }));
  p.jobs = [];   // 작업은 jobs 표가 따로 맡는다(online/jobs) — 덩어리에 싣지 않는다
  return { project: p, maps };
}

// ---------------------------------------------------------------- 견주어 쓰기

const ts = (n) => new Date(Number(n) || Date.now());

// 이력 a 뒤에 b 가 되었을 때 새로 붙은 판들 — a 의 꼬리와 b 의 머리가 가장 길게 겹치는 자리 뒤
function newHistory(a, b) {
  const key = (v) => JSON.stringify([v.at, v.title, v.body]);
  const A = a.map(key); const B = b.map(key);
  for (let k = Math.min(A.length, B.length); k > 0; k--) {
    if (A.slice(A.length - k).every((x, i) => x === B[i])) return b.slice(k);
  }
  return b.slice();
}

async function saveAggregate(db, pid, before, after, maps, { userId = null } = {}) {
  const orgId = (await db.query('SELECT organization_id FROM projects WHERE id = $1', [pid])).rows[0].organization_id;
  const idOf = (kind, legacy) => {
    if (legacy == null) return null;
    if (!maps[kind].has(legacy)) maps[kind].set(legacy, randomUUID());
    return maps[kind].get(legacy);
  };
  const known = (kind, legacy) => legacy != null && maps[kind].has(legacy);

  // 프로젝트 칸
  const pf = (x) => [x.name, x.spec, x.standard, x.request, x.model, x.noCount, x.materials, (x.agents && x.agents.__kind) || ''];
  if (!same(pf(before), pf(after))) {
    await db.query(
      `UPDATE projects SET name=$2, spec=$3, standard=$4, request=$5, model_policy = model_policy || jsonb_build_object('alias', $6::text),
              no_count=$7, materials_legacy=$8, agent_kind=$9, updated_at=now(), row_version = row_version + 1 WHERE id=$1`,
      [pid, after.name, after.spec, after.standard, after.request, after.model, after.noCount !== false, JSON.stringify(after.materials || []), (after.agents && after.agents.__kind) || '']);
  }

  // 카테고리 — 새로 · 이름/차례 · 빠짐(휴지통으로 갔으면 deleted_at)
  const bCat = new Map(before.categories.map((c, i) => [c.id, { ...c, i }]));
  for (const [i, c] of after.categories.entries()) {
    const b = bCat.get(c.id);
    if (!b && !known('cat', c.id)) {
      await db.query('INSERT INTO categories (id, project_id, name, sort_order, legacy_id, created_at) VALUES ($1,$2,$3,$4,$5,$6)', [idOf('cat', c.id), pid, c.name, i, c.id, ts(c.createdAt)]);
    } else if (!b || b.name !== c.name || b.i !== i) {
      await db.query('UPDATE categories SET name=$2, sort_order=$3, deleted_at=NULL WHERE id=$1', [idOf('cat', c.id), c.name, i]);
    }
  }
  const aCat = new Set(after.categories.map((c) => c.id));
  for (const c of before.categories) if (!aCat.has(c.id)) await db.query('UPDATE categories SET deleted_at = now() WHERE id=$1', [idOf('cat', c.id)]);

  // 에이전트(작가가 지은 사람) — 지운 사람은 deleted_at(생성 기록이 가리킬 수 있다)
  const bAg = new Map(before.crew.map((a, i) => [a.id, { ...a, i }]));
  for (const [i, a] of after.crew.entries()) {
    const b = bAg.get(a.id);
    const policy = JSON.stringify({ alias: a.model || '' });
    if (!b && !known('agent', a.id)) {
      await db.query(`INSERT INTO agents (id, scope, project_id, name, role, craft, model_policy, sort_order, legacy_id, created_at)
        VALUES ($1,'project',$2,$3,$4,$5,$6,$7,$8,$9)`, [idOf('agent', a.id), pid, a.name, a.role || '', a.craft || '', policy, i, a.id, ts(a.createdAt)]);
    } else if (!b || !same([b.name, b.role, b.craft, b.model, b.i], [a.name, a.role, a.craft, a.model, i])) {
      await db.query('UPDATE agents SET name=$2, role=$3, craft=$4, model_policy=$5, sort_order=$6, updated_at=now(), deleted_at=NULL WHERE id=$1',
        [idOf('agent', a.id), a.name, a.role || '', a.craft || '', policy, i]);
    }
  }
  const aAg = new Set(after.crew.map((a) => a.id));
  for (const a of before.crew) if (!aAg.has(a.id)) await db.query('UPDATE agents SET deleted_at = now() WHERE id=$1', [idOf('agent', a.id)]);

  // 문서 — 먼저 행(참조가 서로를 가리키므로), 그다음 판 · 참조 · 사람
  const bDoc = new Map(before.docs.map((d, i) => [d.id, { ...d, i }]));
  const trashedIds = new Set(after.trash.filter((e) => e.kind === 'doc').map((e) => e.payload && e.payload.id));
  for (const [i, d] of after.docs.entries()) {
    const b = bDoc.get(d.id);
    const isNew = !b && !known('doc', d.id);   // idOf 가 표에 새 키를 매기기 전에 본다
    const docId = idOf('doc', d.id);
    const cols = [d.kind, d.categoryId ? idOf('cat', d.categoryId) : null, d.orphanFrom ? idOf('cat', d.orphanFrom) : null, d.title,
      !!d.isFinal, d.request || '', !!d.material, d.src || '', i, ts(d.updatedAt)];
    if (isNew) {
      await db.query(`INSERT INTO documents (id, project_id, organization_id, kind, category_id, orphan_from_category_id, title, is_final,
          request, is_material, src, sort_order, updated_at, legacy_id, created_at, finalized_at, finalized_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [docId, pid, orgId, ...cols, d.id, ts(d.createdAt), d.isFinal ? new Date() : null, d.isFinal ? userId : null]);
      // 가져온 덩어리라면 지난 판들도 함께 — 그다음 현재 판
      let seq = 0;
      for (const v of d.versions || []) {
        if (v.body == null) continue;   // 휴지통을 지나 본문이 마른 판은 판으로 세우지 않는다
        seq += 1;
        await db.query(`INSERT INTO document_versions (document_id, project_id, seq, title, body, body_sha256, char_count, source, created_by, at_ms)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'import',$8,$9)`, [docId, pid, seq, v.title, v.body, sha(v.body), String(v.body).length, userId, Number(v.at) || null]);
      }
      const vid = randomUUID();
      await db.query(`INSERT INTO document_versions (id, document_id, project_id, seq, title, body, body_sha256, char_count, source, created_by, at_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'user',$9,$10)`, [vid, docId, pid, seq + 1, d.title, d.body || '', sha(d.body || ''), String(d.body || '').length, userId, Number(d.updatedAt) || null]);
      await db.query('UPDATE documents SET current_version_id = $2 WHERE id = $1', [docId, vid]);
      continue;
    }
    const was = b || null;
    // 휴지통에서 돌아온 문서는 이전 덩어리에 없다 — 표의 현재 판과 견준다(되살렸다고 판을 새로 쌓지 않는다)
    const cur = was ? { title: was.title, body: was.body }
      : (await db.query('SELECT v.title, v.body FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = $1', [docId])).rows[0] || null;
    if (!cur || cur.title !== d.title || cur.body !== d.body) {
      // 이번 고침 안에서 Core 가 이력에 새로 쌓은 판(docWrite) — 이전 이력의 꼬리와 겹치는 만큼을 뺀 나머지다
      // (상한을 넘으면 앞에서 잘리므로 앞머리가 아니라 꼬리-머리 겹침으로 잰다).
      const pushed = was ? newHistory(was.versions || [], d.versions || []) : [];
      // 그 첫 판이 표의 현재 판이면 «쌓인 시각»만 Core 가 적은 값으로 맞추고, 그 뒤의 판(거듭 쓴 것)은 새 판으로 넣는다
      let rest = pushed;
      if (pushed.length && pushed[0].title === cur.title && pushed[0].body === cur.body) {
        await db.query('UPDATE document_versions SET at_ms = $2 WHERE id = (SELECT current_version_id FROM documents WHERE id = $1)', [docId, Number(pushed[0].at) || null]);
        rest = pushed.slice(1);
      }
      const rows = [...rest.filter((v) => v.body != null), { title: d.title, body: d.body || '', at: d.updatedAt }];
      for (const v of rows) {
        const vid = randomUUID();
        await db.query(`INSERT INTO document_versions (id, document_id, project_id, seq, title, body, body_sha256, char_count, source, created_by, at_ms)
          SELECT $1, $2, $3, coalesce(max(seq), 0) + 1, $4, $5, $6, $7, 'user', $8, $9 FROM document_versions WHERE document_id = $2`,
          [vid, docId, pid, v.title, v.body, sha(v.body), String(v.body).length, userId, Number(v.at) || null]);
        await db.query('UPDATE documents SET current_version_id = $2 WHERE id = $1', [docId, vid]);
      }
    }
    if (!was || !same(cols, [was.kind, was.categoryId ? idOf('cat', was.categoryId) : null, was.orphanFrom ? idOf('cat', was.orphanFrom) : null, was.title,
      !!was.isFinal, was.request || '', !!was.material, was.src || '', was.i, ts(was.updatedAt)])) {
      await db.query(`UPDATE documents SET kind=$2, category_id=$3, orphan_from_category_id=$4, title=$5, is_final=$6, request=$7, is_material=$8,
          src=$9, sort_order=$10, updated_at=$11, deleted_at=NULL, purged_at=NULL, row_version = row_version + 1,
          finalized_at = CASE WHEN $6 AND NOT is_final THEN now() WHEN NOT $6 THEN NULL ELSE finalized_at END,
          finalized_by = CASE WHEN $6 AND NOT is_final THEN $12::uuid WHEN NOT $6 THEN NULL ELSE finalized_by END
        WHERE id=$1`, [docId, ...cols, userId]);
    }
  }
  // 참조 · 사람 — 바뀐 문서만 통째로 다시 적는다(순서가 뜻을 가진다)
  for (const d of after.docs) {
    const b = bDoc.get(d.id);
    const docId = idOf('doc', d.id);
    if (!b || !same([b.refIds, b.targetIds], [d.refIds, d.targetIds])) {
      await db.query('DELETE FROM document_links WHERE source_document_id = $1', [docId]);
      for (const [role, ids] of [['reference', d.refIds || []], ['target', d.targetIds || []]]) {
        for (const [k, t] of ids.entries()) {
          if (!known('doc', t)) continue;   // 가리키는 문서가 아예 없다(영구 삭제 뒤의 끊긴 참조) — 개인판처럼 조용히 건너뛴다
          await db.query(`INSERT INTO document_links (project_id, source_document_id, target_document_id, role, sort_order) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (source_document_id, target_document_id, role) DO NOTHING`, [pid, docId, idOf('doc', t), role, k]);
        }
      }
    }
    if (!b || !same(b.agentIds, d.agentIds)) {
      await db.query('DELETE FROM document_agents WHERE document_id = $1', [docId]);
      for (const [k, a] of (d.agentIds || []).entries()) if (known('agent', a)) await db.query('INSERT INTO document_agents (document_id, agent_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [docId, idOf('agent', a), k]);
    }
  }
  // 빠진 문서 — 휴지통으로 갔으면 deleted_at, 아니면(갓 만든 빈 껍데기를 거둔 것) 행을 지운다
  const aDoc = new Set(after.docs.map((d) => d.id));
  for (const d of before.docs) {
    if (aDoc.has(d.id)) continue;
    if (trashedIds.has(d.id)) await db.query('UPDATE documents SET deleted_at = now(), deleted_by = $2 WHERE id = $1', [idOf('doc', d.id), userId]);
    else await db.query('DELETE FROM documents WHERE id = $1', [idOf('doc', d.id)]);
  }

  // 스레드 · 말
  const bTh = new Map(before.threads.map((t) => [t.id, t]));
  const trashedThreads = new Set(after.trash.filter((e) => e.kind === 'thread').map((e) => e.payload && e.payload.id));
  const bThOrder = new Map(before.threads.map((t, i) => [t.id, i]));
  for (const [ti, t] of after.threads.entries()) {
    const b = bTh.get(t.id);
    const isNew = !b && !known('thread', t.id);
    const thId = idOf('thread', t.id);
    if (isNew) {
      await db.query('INSERT INTO threads (id, project_id, title, legacy_id, created_at, updated_at, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)', [thId, pid, t.title, t.id, ts(t.createdAt), ts(t.updatedAt), ti]);
    }
    // 말은 쌓이기만 한다(고치면 새 가지가 돋는다) — 표에 없는 말만 넣는다
    for (const [k, m] of t.messages.entries()) {
      if (known('msg', m.id)) continue;
      await db.query(`INSERT INTO thread_messages (id, thread_id, project_id, parent_id, role, text, created_by, legacy_id, created_at, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [idOf('msg', m.id), thId, pid, m.parentId ? idOf('msg', m.parentId) : null, m.role, m.text, m.role === 'user' ? userId : null, m.id, ts(m.at), k]);
    }
    if (!b || bThOrder.get(t.id) !== ti || !same([b.title, b.headId, b.updatedAt], [t.title, t.headId, t.updatedAt])) {
      await db.query('UPDATE threads SET title=$2, head_message_id=$3, updated_at=$4, sort_order=$5, deleted_at=NULL WHERE id=$1', [thId, t.title, t.headId ? idOf('msg', t.headId) : null, ts(t.updatedAt), ti]);
    }
    if (!b || !same(b.refIds, t.refIds)) {
      await db.query('DELETE FROM thread_links WHERE thread_id = $1', [thId]);
      for (const [k, id] of (t.refIds || []).entries()) if (known('doc', id)) await db.query('INSERT INTO thread_links (thread_id, target_document_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [thId, idOf('doc', id), k]);
    }
    if (!b || !same(b.agentIds, t.agentIds)) {
      await db.query('DELETE FROM thread_agents WHERE thread_id = $1', [thId]);
      for (const [k, id] of (t.agentIds || []).entries()) if (known('agent', id)) await db.query('INSERT INTO thread_agents (thread_id, agent_id, sort_order) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [thId, idOf('agent', id), k]);
    }
  }
  const aTh = new Set(after.threads.map((t) => t.id));
  for (const t of before.threads) {
    if (aTh.has(t.id)) continue;
    if (trashedThreads.has(t.id)) await db.query('UPDATE threads SET deleted_at = now() WHERE id = $1', [idOf('thread', t.id)]);
    else await db.query('DELETE FROM threads WHERE id = $1', [idOf('thread', t.id)]);
  }

  // 프롬프트 층 · 자리 모델 — 바뀌었으면 통째로
  const madeOf = (x) => Object.fromEntries(Object.entries(x.agents || {}).filter(([k]) => k !== '__kind'));
  if (!same([before.prompts, madeOf(before)], [after.prompts, madeOf(after)])) {
    await db.query('DELETE FROM project_prompt_layers WHERE project_id = $1', [pid]);
    for (const [layer, src] of [['override', after.prompts || {}], ['generated', madeOf(after)]]) {
      for (const [code, v] of Object.entries(src)) {
        await db.query('INSERT INTO project_prompt_layers (project_id, code, layer, name, role, task, craft) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [pid, code, layer, v.name || '', v.role || '', v.task || '', v.craft || '']);
      }
    }
  }
  if (!same(before.slotModels, after.slotModels)) {
    await db.query('DELETE FROM project_slot_models WHERE project_id = $1', [pid]);
    for (const [code, m] of Object.entries(after.slotModels || {})) await db.query('INSERT INTO project_slot_models (project_id, code, model_policy) VALUES ($1,$2,$3)', [pid, code, JSON.stringify({ alias: m })]);
  }

  // 휴지통 — 새로 담긴 것 · 빠진 것(되살렸거나 영구 삭제)
  const bTr = new Set(before.trash.map((e) => e.id));
  const aTr = new Map(after.trash.map((e) => [e.id, e]));
  for (const e of after.trash) {
    if (bTr.has(e.id)) continue;
    await db.query(`INSERT INTO trash_entries (project_id, legacy_id, kind, from_label, title, at_ms, target_id, member_ids, payload)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [pid, e.id, e.kind, e.from || '', e.title || '', Number(e.at) || Date.now(),
      String((e.payload && e.payload.id) || ''), JSON.stringify(e.memberIds || []), JSON.stringify(e.payload || {})]);
  }
  for (const e of before.trash) {
    if (aTr.has(e.id)) continue;
    await db.query('DELETE FROM trash_entries WHERE project_id = $1 AND legacy_id = $2', [pid, e.id]);
    const target = e.payload && e.payload.id;
    const restored = e.kind === 'doc' ? aDoc.has(target) : e.kind === 'thread' ? aTh.has(target) : aCat.has(target);
    if (!restored && e.kind === 'doc' && known('doc', target)) await db.query('UPDATE documents SET purged_at = now() WHERE id = $1', [idOf('doc', target)]);
  }

  await db.query('UPDATE projects SET updated_at = now() WHERE id = $1', [pid]);
}

// ---------------------------------------------------------------- 저장소

/**
 * 개인판 state.mjs 와 같은 꼴의 저장소(비동기). 권한은 이 층 위(online/tenancy)가 먼저 본다 — 여기는 «이 프로젝트»만 다룬다.
 *   get(pid) · update(pid, fn, { userId }) · create(fields, { ownerUserId, organizationId }) · remove(pid) · listFor(userId)
 */
export function createProjectStore(pool) {
  return {
    async get(pid) {
      const r = await loadAggregate(pool, pid);
      return r ? r.project : null;
    },

    async update(pid, fn, { userId = null } = {}) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const loaded = await loadAggregate(c, pid, { lock: true });
        if (!loaded) { await c.query('ROLLBACK'); return { ok: false, error: '프로젝트를 찾을 수 없습니다' }; }
        const before = structuredClone(loaded.project);
        const r = fn(loaded.project);
        await saveAggregate(c, pid, before, loaded.project, loaded.maps, { userId });
        await c.query('COMMIT');
        return r === undefined ? { ok: true } : r;
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch { /* 이미 끊겼다 */ }
        throw e;
      } finally {
        c.release();
      }
    },

    // 빈 프로젝트를 세우고(덩어리는 개인판 createProject 와 같은 골격) 넣을 것이 있으면 update 로 넣는다
    async create(fields = {}, { ownerUserId, organizationId = null, classId = null } = {}) {
      const { rows } = await pool.query(
        `INSERT INTO projects (owner_user_id, organization_id, class_id, name, spec, standard, request, model_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ownerUserId, organizationId, classId, String(fields.name || '새 작품'), { outline: '', form: '', length: '', ...(fields.spec || {}) },
          String(fields.standard || ''), String(fields.request || ''), JSON.stringify({ alias: 'opus' })]);
      return rows[0].id;
    },

    async remove(pid) {
      const r = await pool.query('UPDATE projects SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL', [pid]);
      return r.rowCount > 0;
    },

    async listFor(userId) {
      const { rows } = await pool.query(
        'SELECT id, name, created_at, updated_at FROM projects WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC', [userId]);
      return rows.map((r) => ({ id: r.id, name: r.name, updatedAt: ms(r.updated_at), createdAt: ms(r.created_at) }));
    },
  };
}
