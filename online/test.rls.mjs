// DB 2차 격리(RLS, migrations/014) 시험 — 서버의 판정(tenancy)을 일부러 건너뛰고 저장소에 곧장 물어도 DB 가 남의 작품을 내주지 않는가.
// 역할을 만들 권한이 없는 DB 면 이 층은 없다(1차 판정만) — 그때는 «접는다»만 확인한다.
import * as M from '../core/domain/model.mjs';
import { createUser } from './auth.mjs';
import { createProjectStore } from './store.mjs';

export async function run({ pool, ok, eq }) {
  const store = createProjectStore(pool);
  const mk = async (id) => (await createUser(pool, { loginId: id, password: 'long-enough-1' })).user;
  const owner = await mk('rls-owner'); const other = await mk('rls-other'); const inst = await mk('rls-inst'); const adm = await mk('rls-adm');
  const boss = (await createUser(pool, { loginId: 'rls-boss', password: 'long-enough-1', isPlatformAdmin: true })).user;
  const org = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('격리 기관', 'rls-org') RETURNING id`)).rows[0].id;
  const cls = (await pool.query(`INSERT INTO classes (organization_id, name) VALUES ($1, '격리반') RETURNING id`, [org])).rows[0].id;
  await pool.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,'student'), ($1,$3,'instructor'), ($1,$4,'organization_admin')`, [org, owner.id, inst.id, adm.id]);
  await pool.query(`INSERT INTO class_members (class_id, organization_id, user_id, role) VALUES ($1,$2,$3,'student'), ($1,$2,$4,'instructor')`, [cls, org, owner.id, inst.id]);
  const pid = await store.create({ name: '비밀 원고' }, { ownerUserId: owner.id, organizationId: org, classId: cls });
  await store.update(pid, (p) => { M.docCreate(p, { title: '1화', body: '비밀 본문' }); });
  const personal = await store.create({ name: '개인 원고' }, { ownerUserId: owner.id });

  const on = await store.readerOn();
  if (!on) {
    ok('역할이 없는 DB 에서는 getAs 가 get 으로 접는다(1차 판정만)', !!(await store.getAs(pid, other.id)));
    return;
  }
  const docs = async (p, u) => { const x = await store.getAs(p, u); return x ? x.docs.map((d) => d.body).join('|') : null; };
  eq('**주인은 읽는다**', await docs(pid, owner.id), '비밀 본문');
  eq('**남은 서버 판정 없이 곧장 물어도 «없음» — DB 가 막는다**', await store.getAs(pid, other.id), null);
  eq('**운영자도 남의 작품 행을 받지 못한다**', await store.getAs(pid, boss.id), null);
  eq('**맡은 수업의 강사는 읽는다**', await docs(pid, inst.id), '비밀 본문');
  eq('**기관 관리자는 열람이 꺼져 있으면 못 읽는다**', await store.getAs(pid, adm.id), null);
  await pool.query(`UPDATE organizations SET settings = settings || '{"admin_can_read_projects": true}' WHERE id = $1`, [org]);
  eq('**열람을 켜면 기관 관리자도 읽는다**', await docs(pid, adm.id), '비밀 본문');
  eq('개인 작품은 강사 · 기관 관리자도 못 읽는다', (await store.getAs(personal, inst.id)) || (await store.getAs(personal, adm.id)), null);
  // 자식 표도 따로 막혀 있다 — 역할을 바꿔 문서 표를 통째로 물어도 남의 행은 없다
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE se_reader'); await c.query(`SELECT set_config('app.user_id', $1, true)`, [other.id]);
    const n = (await c.query('SELECT count(*)::int AS n FROM documents WHERE project_id = $1', [pid])).rows[0].n;
    const v = (await c.query('SELECT count(*)::int AS n FROM document_versions WHERE project_id = $1', [pid])).rows[0].n;
    let wrote = true; try { await c.query(`UPDATE documents SET title = 'x' WHERE project_id = $1`, [pid]); } catch { wrote = false; }
    await c.query('ROLLBACK');
    ok('**문서 · 판 표를 통째로 물어도 남의 행은 0, 그 역할로는 쓰지도 못한다**', n === 0 && v === 0 && !wrote, JSON.stringify({ n, v, wrote }));
  } finally { c.release(); }
  // 지운 작품은 주인도 이 길로는 못 읽는다(휴지통은 따로)
  await pool.query('UPDATE projects SET deleted_at = now() WHERE id = $1', [personal]);
  eq('지운 작품은 주인도 «없음»', await store.getAs(personal, owner.id), null);
}
