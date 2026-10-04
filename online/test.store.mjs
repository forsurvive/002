// 온라인 프로젝트 저장소 시험 — online/test.mjs 가 이어 부른다.
// 같은 Core 연산을 «메모리의 덩어리»에 걸고, 그 덩어리를 store.update 로 표에 쓴 뒤 다시 지어 견준다.
// 개인판 JSON 이 하는 일과 표가 하는 일이 같은 덩어리를 돌려주는지가 기준이다.

import * as M from '../core/domain/model.mjs';
import { blankProject } from '../tools/store.mjs';
import { createProjectStore, loadAggregate } from './store.mjs';
import { createUser } from './auth.mjs';

// 견줄 꼴 — 표가 따로 맡거나 표가 더 지키는 것은 뺀다.
//   · 프로젝트의 시각 · 작업(jobs 표) · 판의 본문(표는 판을 지우지 않으니, 휴지통을 지나온 판도 본문을 가진다 — 판은 제목·시각만 견준다)
function norm(p) {
  const sortKeys = (x) => Array.isArray(x) ? x.map(sortKeys)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])])) : x;
  const q = structuredClone(p);
  delete q.createdAt; delete q.updatedAt; delete q.jobs; delete q.id;
  for (const d of q.docs) {
    d.versions = d.versions.map((v) => ({ at: v.at, title: v.title }));
    if (d.orphanFrom == null) delete d.orphanFrom;   // 옛 그릇과의 연고가 «없음» — 빈 칸과 null 은 같은 뜻이다
  }
  return JSON.stringify(sortKeys(q));
}

// 어긋난 첫 자리 앞뒤만 보인다(덩어리 전체를 찍으면 읽을 수 없다)
function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return 'db: …' + a.slice(Math.max(0, i - 80), i + 80) + '… / mem: …' + b.slice(Math.max(0, i - 80), i + 80) + '…';
}

export async function run({ pool, ok, eq }) {
  const store = createProjectStore(pool);
  const owner = (await createUser(pool, { loginId: 'store01', password: 'long-enough-1' })).user;
  const other = (await createUser(pool, { loginId: 'store02', password: 'long-enough-1' })).user;

  const pid = await store.create({ name: '표 위의 작품' }, { ownerUserId: owner.id });
  ok('프로젝트를 세운다', /^[0-9a-f-]{36}$/.test(pid));
  const first = await store.get(pid);
  eq('빈 덩어리는 개인판 골격과 같다', norm(first), norm(blankProject(pid, '표 위의 작품')));

  // 메모리 덩어리에 연산을 걸고 → 표로 옮기고 → 다시 지어 견준다
  const local = structuredClone(first);
  const step = async (name, op) => {
    const r = op(local);
    await store.update(pid, (p) => { for (const k of Object.keys(p)) if (k !== 'id') delete p[k]; Object.assign(p, structuredClone(local), { id: pid }); }, { userId: owner.id });
    const back = await store.get(pid);
    const a = norm(back); const b = norm(local);
    ok('왕복: ' + name, a === b, firstDiff(a, b));
    return r;
  };

  await step('작품 칸', (p) => { p.name = '바뀐 이름'; p.spec.outline = '줄거리'; p.standard = '기준'; p.request = '지속 요청'; p.model = 'sonnet'; p.noCount = false; });
  const cat = await step('카테고리', (p) => M.categoryCreate(p, '세계관'));
  const d1 = await step('문서 만들기', (p) => M.docCreate(p, { title: '설정', body: '첫 본문', categoryId: cat.id, request: '문서 요청' }));
  const d2 = await step('참조하는 문서', (p) => M.docCreate(p, { title: '플롯', body: '플롯 본문', refIds: [d1.id], targetIds: [d1.id] }));
  await step('고치면 판이 쌓인다', (p) => { M.docWrite(p, d1.id, { body: '둘째 본문' }); M.docWrite(p, d1.id, { title: '설정 2', body: '셋째 본문' }); });
  eq('판 둘', local.docs.find((d) => d.id === d1.id).versions.length, 2);
  await step('판 복원', (p) => M.docRestoreVersion(p, d1.id, 0));
  await step('확정본', (p) => M.docSetFinal(p, d1.id, true));
  {
    const r = await pool.query('SELECT is_final, finalized_by FROM documents WHERE project_id = $1 AND legacy_id = $2', [pid, d1.id]);
    ok('확정한 사람이 남는다', r.rows[0].is_final && r.rows[0].finalized_by === owner.id);
    const n = (await pool.query('SELECT count(*)::int AS n FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.legacy_id = $1', [d1.id])).rows[0].n;
    eq('표에는 판이 모두 남는다(처음 + 고침 둘 + 복원)', n, 4);
  }
  await step('참조 · 요청 고치기', (p) => M.docWrite(p, d2.id, { refIds: [], request: '새 요청', categoryId: cat.id }));

  const ag = await step('에이전트', (p) => M.agentCreate(p, { name: '편집자', role: '다듬는다', craft: '짧게', model: 'fable' }));
  await step('문서에 사람을 건다', (p) => M.docWrite(p, d2.id, { agentIds: [ag.id] }));
  await step('에이전트 고치기', (p) => M.agentWrite(p, ag.id, { craft: '더 짧게' }));

  const th = await step('스레드', (p) => M.threadCreate(p, { title: '논의 하나', refIds: [d1.id], agentIds: [ag.id] }));
  let m1, m2;
  await step('말이 쌓인다', (p) => {
    m1 = M.threadAddMessage(p, th.id, 'user', '질문');
    m2 = M.threadAddMessage(p, th.id, 'assistant', '답');
    M.threadAddMessage(p, th.id, 'user', '되묻기');
  });
  await step('지난 말을 고치면 가지가 돋는다', (p) => M.threadEditMessage(p, th.id, m1.id, '다른 질문'));
  await step('가지를 옮긴다', (p) => M.threadSetHead(p, th.id, m2.id));
  eq('가지 둘', M.threadSiblings(local.threads[0], m1.id).length, 2);

  await step('프롬프트 · 자리 모델', (p) => {
    p.prompts = { writer: { craft: '고친 작법' } };
    p.agents = { __kind: 'novel', analyst: { code: 'analyst', name: '분석가', role: 'r', task: 't', craft: 'c' } };
    p.slotModels = { analyst: 'sonnet' };
  });

  // 휴지통 — 문서 · 카테고리(그릇만) · 스레드, 되살리기 · 영구 삭제
  await step('카테고리를 지우면 그릇만 간다', (p) => M.categoryDelete(p, cat.id));
  ok('문서는 남아 «새로 추가된 문서»로', local.docs.every((d) => !d.categoryId) && local.docs.some((d) => d.orphanFrom === cat.id));
  await step('카테고리 되살리기', (p) => M.trashRestore(p, p.trash[0].id));
  await step('문서를 휴지통으로', (p) => M.docDelete(p, d2.id));
  {
    const r = (await pool.query('SELECT deleted_at FROM documents WHERE legacy_id = $1', [d2.id])).rows[0];
    ok('휴지통의 문서는 행으로 남는다', r && r.deleted_at);
  }
  await step('문서 되살리기', (p) => M.trashRestore(p, p.trash.find((e) => e.kind === 'doc').id));
  {
    const n = (await pool.query('SELECT count(*)::int AS n FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.legacy_id = $1', [d2.id])).rows[0].n;
    eq('되살렸다고 판이 늘지 않는다', n, 1);
  }
  await step('스레드를 휴지통으로', (p) => M.threadDelete(p, th.id));
  await step('스레드 되살리기', (p) => M.trashRestore(p, p.trash.find((e) => e.kind === 'thread').id));
  await step('에이전트를 지우면 문서·스레드에서 떨어진다', (p) => M.agentDelete(p, ag.id));
  await step('다시 휴지통으로', (p) => M.docDelete(p, d2.id));
  await step('영구 삭제', (p) => M.trashPurge(p, p.trash.find((e) => e.kind === 'doc').id));
  {
    const r = (await pool.query('SELECT deleted_at, purged_at FROM documents WHERE legacy_id = $1', [d2.id])).rows[0];
    ok('영구 삭제도 행은 남고 purged_at 이 찍힌다(생성 기록이 가리킬 수 있다)', r && r.deleted_at && r.purged_at);
  }

  // 갓 만든 껍데기는 거둔다(행을 지운다)
  const fresh = await step('빈 문서', (p) => M.docCreate(p, { title: M.DOC_NAME.doc }));
  await step('빈 문서 거두기', (p) => M.docDiscard(p, fresh.id));
  eq('거둔 껍데기는 행도 없다', (await pool.query('SELECT count(*)::int AS n FROM documents WHERE legacy_id = $1', [fresh.id])).rows[0].n, 0);
  const freshT = await step('빈 스레드', (p) => M.threadCreate(p));
  await step('빈 스레드 거두기', (p) => M.threadDiscard(p, freshT.id));

  // 옛 판 자료 → 자료 카테고리의 문서
  await step('자료', (p) => { M.materialAdd(p, '자료 하나', '자료 본문'); });
  await step('옛 자료 옮기기', (p) => { p.materials = [{ id: 'm_old1', name: '옛 자료', text: '옛 글', addedAt: 1700000000000 }]; M.materialsToDocs(p); });

  // 판 상한 — 덩어리에는 최근 KEEP_VERSIONS 판만, 표에는 모두
  {
    const n0 = (await pool.query('SELECT count(*)::int AS n FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.legacy_id = $1', [d1.id])).rows[0].n;
    for (let i = 0; i < M.KEEP_VERSIONS + 3; i++) await step('판이 상한을 넘는다 ' + i, (p) => M.docWrite(p, d1.id, { body: '고침 ' + i }));
    const back = await store.get(pid);
    eq('덩어리에는 상한만큼', back.docs.find((d) => d.id === d1.id).versions.length, M.KEEP_VERSIONS);
    const n = (await pool.query('SELECT count(*)::int AS n FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE d.legacy_id = $1', [d1.id])).rows[0].n;
    eq('표에는 모두', n, n0 + M.KEEP_VERSIONS + 3);
  }

  // fn 이 throw 하면 아무것도 쓰지 않는다
  {
    const before = norm(await store.get(pid));
    let threw = false;
    try { await store.update(pid, (p) => { M.docWrite(p, d1.id, { body: '반쯤 쓴 글' }); throw new Error('boom'); }); } catch { threw = true; }
    ok('고치다 실패하면 그대로', threw && norm(await store.get(pid)) === before);
  }

  // 같은 프로젝트의 고침은 차례로(잠금) — 동시에 열 번 써도 하나도 잃지 않는다
  {
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.update(pid, (p) => { M.categoryCreate(p, '동시 ' + i); })));
    const back = await store.get(pid);
    eq('동시 고침을 잃지 않는다', back.categories.filter((c) => c.name.startsWith('동시 ')).length, 10);
  }

  // 반환값 · 없는 프로젝트
  eq('fn 의 반환값을 돌려준다', (await store.update(pid, () => ({ ok: true, n: 7 }))).n, 7);
  eq('없는 프로젝트는 고칠 수 없다', (await store.update('00000000-0000-0000-0000-000000000000', () => {})).ok, false);
  eq('없는 프로젝트는 null', await store.get('00000000-0000-0000-0000-000000000000'), null);

  // 목록 · 지우기 — 사람마다
  const pid2 = await store.create({ name: '남의 작품' }, { ownerUserId: other.id });
  ok('내 목록에는 내 것만', (await store.listFor(owner.id)).map((x) => x.id).join() === pid);
  ok('남의 목록에는 남의 것만', (await store.listFor(other.id)).map((x) => x.id).join() === pid2);
  ok('지운다', await store.remove(pid2));
  eq('지운 프로젝트는 열리지 않는다', await store.get(pid2), null);
  eq('목록에서도 빠진다', (await store.listFor(other.id)).length, 0);

  // 잠금 없이 짓는 길도 같은 덩어리
  eq('잠그고 지어도 같다', norm((await loadAggregate(pool, pid, { lock: false })).project), norm(await store.get(pid)));
}
