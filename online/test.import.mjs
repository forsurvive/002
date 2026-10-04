// 개인판 JSON 가져오기 시험 — online/test.mjs 가 이어 부른다.
// 개인판 Core 로 실제와 같은 작품을 지어(옛 자료 · 끊긴 참조 · 휴지통을 지나온 문서 · 가지 친 논의) 파일 꼴로 만든 뒤 옮긴다.

import * as M from '../core/domain/model.mjs';
import { blankProject } from '../tools/store.mjs';
import { importProject } from './import.mjs';
import { createProjectStore } from './store.mjs';
import { createUser } from './auth.mjs';

function personalProject() {
  const p = blankProject('p_legacy01', '개인판 작품');
  p.spec = { outline: '개요', form: '장편', length: '10만 자' };
  p.request = '지속 요청'; p.model = 'sonnet'; p.noCount = false;
  p.materials = [{ id: 'm_1', name: '옛 자료', text: '옛 판에서 넣은 자료', addedAt: 1700000000000 }];
  const c = M.categoryCreate(p, '세계관');
  const ag = M.agentCreate(p, { name: '편집자', role: '다듬는다', craft: '짧게', model: 'fable' });
  const d1 = M.docCreate(p, { title: '설정', body: '첫 판', categoryId: c.id });
  M.docWrite(p, d1.id, { body: '둘째 판' });
  M.docWrite(p, d1.id, { body: '셋째 판', agentIds: [ag.id] });
  M.docSetFinal(p, d1.id, true);
  const d2 = M.docCreate(p, { title: '플롯', body: '플롯 본문', refIds: [d1.id, 'd_gone'], targetIds: ['d_gone2'] });
  M.docWrite(p, d2.id, { body: '플롯 둘째' });
  M.docDelete(p, d2.id);                         // 휴지통을 지나며 판 본문이 마른다
  M.trashRestore(p, p.trash[0].id);
  const t = M.threadCreate(p, { title: '논의', refIds: [d1.id, 'd_gone'] });
  const m1 = M.threadAddMessage(p, t.id, 'user', '질문');
  M.threadAddMessage(p, t.id, 'assistant', '답');
  M.threadEditMessage(p, t.id, m1.id, '다른 질문');
  const d3 = M.docCreate(p, { title: '버린 글', body: '휴지통에 남은 글' });
  M.docDelete(p, d3.id);
  p.prompts = { writer: { craft: '고친 작법' } };
  p.slotModels = { writer: 'opus' };
  p.jobs = [{ id: 'j_1', kind: 'update', status: 'running', title: '돌던 작업' }];
  return JSON.parse(JSON.stringify(p));          // 파일에서 읽은 꼴
}

export async function run({ pool, ok, eq }) {
  const owner = (await createUser(pool, { loginId: 'importer', password: 'long-enough-1' })).user;
  const raw = personalProject();
  const r = await importProject(pool, raw, { ownerUserId: owner.id });
  ok('가져오기 — 다시 지어 견준 것이 모두 맞다', r.ok, JSON.stringify(r.report && r.report.checks));
  const c = r.report.counts;
  ok('수량 보고', c.docs === 3 && c.categories === 2 && c.agents === 1 && c.threads === 1 && c.messages === 3 && c.trash === 1, JSON.stringify(c));
  eq('끊긴 참조 셋을 걸러 냈다고 보고한다', r.report.droppedRefs, 3);
  ok('본문이 마른 판 기록을 센다', r.report.bodilessVersions >= 1, String(r.report.bodilessVersions));

  const p = await createProjectStore(pool).get(r.pid);
  const d1 = p.docs.find((d) => d.title === '설정');
  ok('본문 · 판 · 확정본 · 사람이 옮겨 왔다', d1.body === '셋째 판' && d1.versions.map((v) => v.body).join('|') === '첫 판|둘째 판' && d1.isFinal && d1.agentIds.length === 1);
  ok('옛 자료는 «자료» 카테고리의 문서로', p.docs.some((d) => d.material && d.title === '옛 자료' && p.categories.find((x) => x.id === d.categoryId).name === '자료'));
  ok('작업 기록은 싣지 않는다', p.jobs.length === 0);
  ok('설정 칸 그대로', p.model === 'sonnet' && p.noCount === false && p.prompts.writer.craft === '고친 작법' && p.slotModels.writer === 'opus' && p.spec.length === '10만 자');
  ok('휴지통의 글을 되살릴 수 있다', (await createProjectStore(pool).update(r.pid, (x) => { M.trashRestore(x, x.trash[0].id); })).ok !== false
    && (await createProjectStore(pool).get(r.pid)).docs.some((d) => d.body === '휴지통에 남은 글'));
  const row = (await pool.query('SELECT legacy_id, owner_user_id FROM projects WHERE id = $1', [r.pid])).rows[0];
  ok('원래 id 와 주인을 남긴다', row.legacy_id === 'p_legacy01' && row.owner_user_id === owner.id);
  ok('감사 로그', (await pool.query("SELECT 1 FROM audit_logs WHERE action = 'project.import' AND target_id = $1", [r.pid])).rowCount === 1);

  // 같은 파일을 또 가져오면 따로 선다(덮어쓰지 않는다)
  const again = await importProject(pool, raw, { ownerUserId: owner.id });
  ok('다시 가져오면 새 프로젝트', again.ok && again.pid !== r.pid);

  // 못 옮기는 꼴이면 아무것도 쓰지 않는다
  const before = (await pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n;
  const broken = personalProject();
  broken.docs.push({ ...broken.docs[0] });
  const bad = await importProject(pool, broken, { ownerUserId: owner.id });
  ok('같은 id 가 둘이면 멈춘다', bad.ok === false && /duplicate id/.test(bad.problems.join(' ')));
  eq('멈추면 프로젝트를 남기지 않는다', (await pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n, before);
  eq('프로젝트 파일이 아니면 멈춘다', (await importProject(pool, { hello: 1 }, { ownerUserId: owner.id })).ok, false);
  const odd = personalProject();
  odd.docs[0].title = 42; odd.docs[0].versions = 'nope'; odd.threads[0].messages[0].role = 'system';
  ok('타입이 어긋난 칸은 다듬어 옮긴다', (await importProject(pool, odd, { ownerUserId: owner.id })).ok);
}
