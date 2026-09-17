// 시험 — SE2_MOCK=1 node tools/test.mjs
// 순수 로직 + 실제 서버(같은 프로세스에서 띄운다) + 자동 집필 완주 + 화면-서버 배선 맞춤.

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.SE2_MOCK = '1';
const BOX = mkdtempSync(join(tmpdir(), 'se2-test-'));
process.env.SE2_DATA_DIR = BOX;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let pass = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  fails.push(name + (detail ? ' — ' + detail : ''));
  return false;
}
const eq = (name, a, b) => ok(name, a === b, JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));

const model = await import('./model.mjs');
const store = await import('./store.mjs');
const asm = await import('./assemble.mjs');
const agents = await import('./agents.mjs');
const prompts = await import('./prompts.mjs');
const auto = await import('./auto.mjs');

// ---------------------------------------------------------------- 순수 로직

{
  const p = store.blankProject('p_t', '시험작');

  // 문서와 '새로 추가된 문서'
  const d1 = model.docCreate(p, { title: '가' });
  eq('새 문서는 카테고리가 없다', d1.categoryId, null);
  let view = model.categoriesView(p);
  eq('빈 카테고리는 없고 새 문서 칸만 있다', view.length, 1);
  eq('그 칸의 이름', view[0].name, '새로 추가된 문서');
  const c1 = model.categoryCreate(p, '설정');
  model.docWrite(p, d1.id, { categoryId: c1.id });
  view = model.categoriesView(p);
  eq('문서를 옮기면 새 문서 칸이 사라진다', view.length, 1);
  eq('남는 것은 만든 카테고리', view[0].name, '설정');
  const d2 = model.docCreate(p, { title: '나' });
  view = model.categoriesView(p);
  eq('새 문서가 생기면 그 칸이 돌아온다', view.length, 2);
  eq('돌아온 칸이 맨 앞', view[0].id, model.INBOX);

  // 확정본
  model.docSetFinal(p, d1.id, true);
  ok('확정본 켜짐', model.findDoc(p, d1.id).isFinal);

  // 이력
  model.docWrite(p, d1.id, { body: '처음' });
  model.docWrite(p, d1.id, { body: '다음' });
  eq('판이 쌓인다', model.findDoc(p, d1.id).versions.length, 2);
  model.docRestoreVersion(p, d1.id, 1);
  eq('되돌리면 그 판의 본문', model.findDoc(p, d1.id).body, '처음');
  eq('되돌리기도 판을 쌓는다', model.findDoc(p, d1.id).versions.length, 3);
  model.docWrite(p, d1.id, { request: '요청만' });
  eq('요청사항만 바꾸면 판을 쌓지 않는다', model.findDoc(p, d1.id).versions.length, 3);

  // 카테고리 삭제 = 그릇만
  model.categoryDelete(p, c1.id);
  eq('그릇만 휴지통으로', p.trash.length, 1);
  eq('안의 문서는 남는다', p.docs.length, 2);
  eq('문서는 새 문서 칸으로', model.findDoc(p, d1.id).categoryId, null);
  model.trashRestore(p, p.trash[0].id);
  eq('복원하면 카테고리가 돌아온다', p.categories.length, 1);
  eq('식구도 돌아온다', model.findDoc(p, d1.id).categoryId, p.categories[0].id);

  // 문서 삭제와 복원
  model.docDelete(p, d2.id);
  eq('문서가 휴지통으로', p.docs.length, 1);
  eq('어느 기능에서 왔는지 적힌다', p.trash[0].from, '문서');
  model.trashRestore(p, p.trash[0].id);
  eq('문서 복원', p.docs.length, 2);

  // 모순 검사·합평회도 같은 레코드
  const chk = model.docCreate(p, { kind: 'check', title: '모순 검사' });
  eq('모순 검사는 문서다', model.findDoc(p, chk.id).kind, 'check');
  model.docDelete(p, chk.id);
  eq('휴지통에 기능 이름이 남는다', p.trash[0].from, '모순 검사');
  model.trashRestore(p, p.trash[0].id);

  // 카테고리가 사라진 뒤 복원하면 새 문서 칸으로
  const c2 = model.categoryCreate(p, '임시');
  const d3 = model.docCreate(p, { title: '다', categoryId: c2.id });
  model.docDelete(p, d3.id);
  p.categories.splice(p.categories.indexOf(c2), 1);
  model.trashRestore(p, p.trash[p.trash.length - 1].id);
  eq('없어진 카테고리면 새 문서 칸으로', model.findDoc(p, d3.id).categoryId, null);

  // 휴지통 영구 삭제
  model.docDelete(p, d3.id);
  const tid = p.trash[p.trash.length - 1].id;
  model.trashPurge(p, tid);
  ok('영구 삭제', !p.trash.some((e) => e.id === tid));
}

{
  // 논의 스레드 가지
  const p = store.blankProject('p_t2', '스레드');
  const t = model.threadCreate(p, { title: '논의' });
  const m1 = model.threadAddMessage(p, t.id, 'user', '첫 말');
  const a1 = model.threadAddMessage(p, t.id, 'assistant', '첫 답');
  const m2 = model.threadAddMessage(p, t.id, 'user', '둘째 말');
  eq('현재 가지의 길이', model.threadPath(model.findThread(p, t.id)).length, 3);
  const branched = model.threadEditMessage(p, t.id, m2.id, '고친 말');
  eq('고치면 같은 부모 아래 새 가지', branched.parentId, m2.parentId);
  eq('원래 흐름은 남는다', model.findThread(p, t.id).messages.length, 4);
  eq('머리는 새 가지', model.findThread(p, t.id).headId, branched.id);
  const path = model.threadPath(model.findThread(p, t.id));
  eq('새 가지의 끝', path[path.length - 1].text, '고친 말');
  model.threadSetHead(p, t.id, m2.id);
  eq('가지를 갈아타면 원래 흐름', model.threadPath(model.findThread(p, t.id)).pop().text, '둘째 말');
  eq('형제 수', model.threadSiblings(model.findThread(p, t.id), m2.id).length, 2);
  ok('스레드 내려받기에 두 말이 다 있다', model.threadToText(model.findThread(p, t.id)).includes('첫 답'));
  eq('첫 답 앞에 클로드 이름', model.threadToText(model.findThread(p, t.id)).includes('## 클로드'), true);
  void m1; void a1;
}

// ---------------------------------------------------------------- 프롬프트 조립

{
  const p = store.blankProject('p_t3', '조립');
  p.spec = { outline: '개요다', form: '연재소설', length: '' };
  p.standard = '기준';
  p.request = '요청';
  const d = model.docCreate(p, { title: '참조본', body: '참조 본문' });
  const f = model.docCreate(p, { title: '확정본', body: '확정 본문' });
  model.docSetFinal(p, f.id, true);

  const u = asm.buildUser({
    project: p,
    materials: [{ id: 'm1', name: '자료 하나', text: '자료 본문' }],
    refs: [{ id: d.id, name: d.title, text: d.body }],
    finals: [{ id: f.id, name: f.title, text: f.body }],
    task: '이번 일',
  });
  ok('구획 이름이 그대로', u.includes('■ 작품 규격') && u.includes('■ 자료') && u.includes('■ 참조 문서'));
  ok('확정본 구획 표시', u.includes('■ 확정본 — 최우선 사실'));
  ok('확정본이 참조 문서 뒤', u.indexOf('■ 확정본') > u.indexOf('■ 참조 문서'));
  ok('분량이 비면 상한을 알린다', u.includes('상한 24화'));
  ok('세어 말하지 않는다가 붙는다', u.trim().endsWith('세어 말하지 않는다.'));
  ok('빈 구획은 머리표째 빠진다', !u.includes('■ 대상') && !u.includes('■ 대화'));

  const long = 'ㅁ'.repeat(120000);
  const u2 = asm.buildUser({ project: p, materials: [{ id: 'm', name: '큰 자료', text: long }], task: '일' });
  ok('상한이 없어 자료가 통째로 실린다', u2.includes(long));

  eq('머리표 흉내를 막는다', asm.neutralize('■ 가짜\n보통 줄').split('\n')[0], ' ■ 가짜');
  eq('앞뒤 빈 줄 제거', asm.cleanResponse('\n\n본문\n\n'), '본문');
  eq('코드 울타리 벗기기', asm.cleanResponse('```md\n본문\n```'), '본문');
  eq('첫 줄 제목 제거', asm.cleanResponse('# 제목\n본문'), '본문');
  eq('본문 안 소제목은 살린다', asm.cleanResponse('본문\n## 소제목'), '본문\n## 소제목');

  const sys = asm.buildSystem({ prompt: { name: '이름', role: '역할', craft: '작법 본문' }, prev: '앞', next: '뒤' });
  ok('시스템 구획', sys.includes('■ 에이전트') && sys.includes('■ 앞뒤') && sys.includes('■ 작법') && sys.includes('■ 응답 형식'));
  ok('확정본 규칙과 금지 문구', sys.includes('최우선 사실') && sys.includes('세어서 말하지 말고'));
  const sys2 = asm.buildSystem({ prompt: { name: 'ㄱ', role: 'ㄴ', craft: 'ㄷ' }, withFinalRule: false, withNoCount: false });
  ok('제어 호출에는 금지 문구를 싣지 않는다', !sys2.includes('■ 쓰지 않는 말'));
}

// ---------------------------------------------------------------- 즉석 에이전트 읽기

{
  const k1 = agents.readKind('분류: 소설\n까닭은 이러하다');
  ok('소설 판정', k1.fiction && k1.kind === '소설');
  const k2 = agents.readKind('분류: 실무 안내서\n관점: 쓰는 이\n관점: 읽는 이');
  ok('비소설 판정', !k2.fiction && k2.kind === '실무 안내서');
  eq('관점 줄을 읽는다', k2.views.length, 2);
  eq('형식이 어긋나면 빈 판정', agents.readKind('아무 말').kind, '');

  const a = agents.readAgent('이름: 길잡이\n역할: 안내한다\n할 일: 이것을 쓴다\n작법:\n본문 첫 줄\n본문 둘째 줄', 'S02');
  eq('이름', a.name, '길잡이');
  eq('역할', a.role, '안내한다');
  eq('작법 본문', a.craft, '본문 첫 줄\n본문 둘째 줄');
  const b = agents.readAgent('형식이 깨진 응답', 'S02');
  eq('형식이 깨지면 전체가 작법', b.craft, '형식이 깨진 응답');
  eq('내장 이름으로 물러선다', b.name, prompts.BUILTIN.S02.name);
  eq('자리 수', agents.perspectivesOf({}).length, prompts.PERSPECTIVES.length);
}

// ---------------------------------------------------------------- 서버 통합

const PORT = 8899;
const { boot, OP_NAMES, server } = await import('./server.mjs');
await boot(PORT);
const base = 'http://127.0.0.1:' + PORT;

const post = async (op, body = {}) => (await fetch(base + '/api', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...body }),
})).json();
const stateOf = async (pid) => (await fetch(base + '/api/state?pid=' + pid)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(pid, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const st = await stateOf(pid);
    if (!st.ok) return null;
    if (!(st.project.jobs || []).some((j) => j.status === 'running')) return st.project;
    if (Date.now() - t0 > ms) return st.project;
    await sleep(25);
  }
}

// 가짜 응답 — 단계마다 알아볼 수 있는 글을 낸다.
let KIND = '소설';
const MOCK_FN = ({ mockKey }) => {
  if (mockKey === 'F-KIND') return KIND === '소설' ? '분류: 소설' : ('분류: ' + KIND + '\n' + Array.from({ length: 8 }, (_, i) => '관점: 관점' + i).join('\n'));
  if (mockKey === 'F-AGENT') return '이름: 지은이\n역할: 그 일을 한다\n할 일: 문서를 쓴다\n작법:\n' + '작'.repeat(2100);
  if (mockKey === 'F-COUNT') return '3';
  return '(모의) ' + mockKey + ' 본문';
};
globalThis.__SE2_MOCK_FN = MOCK_FN;

{
  // 프로젝트 생성 검사
  let r = await post('project.create', { name: '', spec: { outline: 'ㄱ', form: 'ㄴ' }, materials: [{ name: 'ㄷ', text: 'ㄹ' }] });
  ok('이름이 없으면 거절', !r.ok);
  r = await post('project.create', { name: '작품', spec: { outline: 'ㄱ', form: 'ㄴ' }, materials: [] });
  ok('자료가 없으면 거절', !r.ok);

  r = await post('project.create', {
    name: '시험 작품', spec: { outline: '개요', form: '연재소설', length: '3화' },
    standard: '기준', request: '요청', materials: [{ name: '자료', text: '자료 본문' }],
  });
  ok('프로젝트 생성', r.ok && r.pid);
  const pid = r.pid;

  // 만든 직후 에이전트 판정이 돈다
  let p = await settle(pid);
  ok('생성 직후 에이전트 준비 작업이 돌았다', (p.jobs || []).some((j) => j.kind === 'agents'));
  eq('소설이면 판정만 남는다', p.agentKind, '소설');

  // 문서와 갱신
  r = await post('doc.create', { pid, title: '메모' });
  const docId = r.id;
  await post('doc.write', { pid, id: docId, request: '이렇게 써 줘' });
  r = await post('doc.update', { pid, id: docId });
  ok('갱신이 작업으로 뜬다', r.ok && r.jobId);
  p = await settle(pid);
  const doc = p.docs.find((d) => d.id === docId);
  ok('갱신 결과가 본문이 된다', doc.body.includes('F-UPDATE'));
  eq('갱신 작업이 끝났다', p.jobs.find((j) => j.id === r.jobId).status, 'done');

  // 확정본 토글과 일괄
  await post('doc.final', { pid, ids: [docId], on: true });
  p = (await stateOf(pid)).project;
  ok('확정본 지정', p.docs.find((d) => d.id === docId).isFinal);

  // 카테고리
  r = await post('cat.create', { pid, name: '설정' });
  const catId = r.id;
  await post('doc.write', { pid, id: docId, categoryId: catId });
  p = (await stateOf(pid)).project;
  eq('카테고리로 옮김', p.docs.find((d) => d.id === docId).categoryId, catId);

  // 논의 스레드
  r = await post('thread.create', { pid, title: '논의' });
  const tid = r.id;
  await post('thread.send', { pid, id: tid, text: '무엇을 할까' });
  p = await settle(pid);
  let th = p.threads.find((t) => t.id === tid);
  eq('말과 답이 쌓인다', th.messages.length, 2);
  ok('답은 클로드 몫', th.messages[1].role === 'assistant' && th.messages[1].text.includes('F-TALK'));

  await post('thread.edit', { pid, id: tid, messageId: th.messages[0].id, text: '다르게 물어본다' });
  p = await settle(pid);
  th = p.threads.find((t) => t.id === tid);
  eq('가지가 갈라진다', th.messages.length, 4);

  r = await post('thread.doc', { pid, id: tid, request: '정리해 줘' });
  p = await settle(pid);
  ok('정리 문서가 생긴다', p.docs.some((d) => d.body.includes('F-THREADDOC')));

  // 모순 검사(대상에 확정본이 있으면 그것이 기준이 된다)
  r = await post('doc.create', { pid, kind: 'check', title: '모순 검사' });
  const chkId = r.id;
  await post('doc.write', { pid, id: chkId, targetIds: [docId] });
  await post('doc.update', { pid, id: chkId });
  p = await settle(pid);
  ok('모순 검사 결과가 그 문서의 본문', p.docs.find((d) => d.id === chkId).body.includes('F-CONTRA'));

  // 합평회
  r = await post('doc.create', { pid, kind: 'review', title: '합평회' });
  await post('doc.write', { pid, id: r.id, targetIds: [docId] });
  await post('doc.update', { pid, id: r.id });
  p = await settle(pid);
  ok('합평회 결과', p.docs.find((d) => d.id === r.id).body.includes('F-REVIEW'));

  // 내려받기
  const dl = await fetch(base + '/api/download?pid=' + pid + '&kind=doc&id=' + docId);
  eq('내려받기 응답', dl.status, 200);
  ok('내려받기에 제목이 붙는다', (await dl.text()).startsWith('# '));
  const dlc = await fetch(base + '/api/download?pid=' + pid + '&kind=cat&id=' + catId);
  ok('카테고리 내려받기', (await dlc.text()).includes('설정'));

  // 휴지통
  await post('doc.delete', { pid, ids: [docId] });
  p = (await stateOf(pid)).project;
  eq('휴지통에 들어간다', p.trash.length, 1);
  await post('trash.restore', { pid, ids: [p.trash[0].id] });
  p = (await stateOf(pid)).project;
  ok('복원된다', p.docs.some((d) => d.id === docId));

  // 자동 집필 완주 (분량 3화 → 회차 수 확인 호출 없이 돈다)
  r = await post('auto.start', { pid, feedbackRounds: 1, skipProse: false });
  ok('자동 집필 시작', r.ok);
  const again = await post('auto.start', { pid });
  ok('둘은 못 돈다', !again.ok);
  p = await settle(pid, 60000);
  const autoJob = p.jobs.find((j) => j.kind === 'auto');
  eq('완주', autoJob.status, 'done');

  const titles = p.docs.map((d) => d.title);
  for (const t of ['자료 분석', '세계관', '서사 재료', '기획 선정', '세계관 재작성', '인물 풀', '대략 플롯', '주요 인물 선정', '인물 설계', '상세 플롯', '회차 계획', '모순 검사', '자동 집필 합본']) {
    ok('산출물 «' + t + '»', titles.includes(t));
  }
  eq('관점마다 기획 한 편', titles.filter((t) => t.startsWith('기획 — ')).length, 8);
  eq('회차 본문 셋', titles.filter((t) => /^\d+화$/.test(t)).length, 3);
  eq('회차 집필 계획 셋', titles.filter((t) => /^\d+화 집필 계획$/.test(t)).length, 3);
  eq('회차 집필 계획 세부 셋', titles.filter((t) => /^\d+화 집필 계획 세부$/.test(t)).length, 3);

  const finals = p.docs.filter((d) => d.isFinal);
  eq('자동이 켠 확정본은 회차 계획 재작성 하나', finals.filter((d) => d.title === '회차 계획 재작성').length, 1);
  const autoCat = p.categories.find((c) => c.name === '자동 실행');
  ok('자동 실행 카테고리', !!autoCat);
  ok('합본이 그 안에 있다', autoCat.docIds.includes(p.docs.find((d) => d.title === '자동 집필 합본').id));
  const bundle = p.docs.find((d) => d.title === '자동 집필 합본');
  ok('합본에 회차 본문이 담긴다', bundle.body.includes('# 1화'));
  ok('합본에 모순 검사가 담긴다', bundle.body.includes('# 모순 검사'));
  eq('회차 수가 기록된다', p.auto.episodes, 3);
}

{
  // 본문 집필 제외 + 회차 수 확인 호출 + 비소설 즉석 에이전트
  KIND = '실무 안내서';
  const r = await post('project.create', {
    name: '안내서', spec: { outline: '개요', form: '안내 문서', length: '' },
    materials: [{ name: '자료', text: '자료 본문' }],
  });
  const pid = r.pid;
  let p = await settle(pid, 60000);
  eq('비소설로 판정', p.agentKind, '실무 안내서');

  const raw = JSON.parse(readFileSync(join(BOX, 'projects', pid + '.json'), 'utf8'));
  eq('자리마다 프롬프트를 지었다', prompts.AGENT_SLOTS.filter((c) => raw.agents[c] && raw.agents[c].craft).length, prompts.AGENT_SLOTS.length);
  ok('지은 프롬프트는 2000자 이상', prompts.AGENT_SLOTS.every((c) => raw.agents[c].craft.length >= agents.CRAFT_MIN));
  ok('관점도 새로 지었다', (raw.agents.__views || [])[0] === '관점0');

  await post('auto.start', { pid, feedbackRounds: 2, skipProse: true });
  p = await settle(pid, 90000);
  eq('완주', p.jobs.find((j) => j.kind === 'auto').status, 'done');
  const titles = p.docs.map((d) => d.title);
  eq('본문 제외면 본문 문서가 없다', titles.filter((t) => /^\d+화$/.test(t)).length, 0);
  ok('집필 계획 세부는 그대로 쓴다', titles.some((t) => /^\d+화 집필 계획 세부$/.test(t)));
  eq('회차 수는 물어서 정한다', p.auto.episodes, 3);
  eq('피드백을 두 번 돌면 합평도 둘', titles.filter((t) => t === '상세 플롯 합평').length, 2);
  eq('재작성도 둘', titles.filter((t) => t === '회차 계획 재작성').length, 2);
  eq('그래도 확정본은 하나', p.docs.filter((d) => d.isFinal && d.title === '회차 계획 재작성').length, 1);
}

{
  // 시작 검사와 중지
  const r = await post('project.create', {
    name: '멈춤 시험', spec: { outline: '개요', form: '소설', length: '2화' },
    materials: [{ name: '자료', text: '본문' }],
  });
  const pid = r.pid;
  await settle(pid);
  await post('material.delete', { pid, ids: [(await stateOf(pid)).project.materials[0].id] });
  const gate = await post('auto.start', { pid });
  ok('자료가 없으면 시작하지 않는다', !gate.ok && gate.error === '작품 규격과 자료 필요');

  await post('material.add', { pid, name: '자료', text: '본문' });
  const started = await post('auto.start', { pid });
  await post('job.stop', { pid, id: started.jobId });
  const p = await settle(pid);
  eq('중지됨', p.jobs.find((j) => j.id === started.jobId).status, 'stopped');

  const del = await post('project.delete', { pid });
  ok('프로젝트 삭제', del.ok);
  const gone = await stateOf(pid);
  ok('삭제되면 상태가 없다', !gone.ok);
}

{
  // 없는 문
  const r = await post('없는.문', {});
  ok('모르는 op 는 거절', !r.ok);
}


// ---------------------------------------------------------------- 검토에서 잡힌 것들

{
  // 순수 로직 — 카테고리 복원이 남의 문서를 가로채지 않는다
  const p = store.blankProject('p_t9', '복원');
  const 가 = model.categoryCreate(p, '가');
  const 나 = model.categoryCreate(p, '나');
  const d = model.docCreate(p, { title: 'X', categoryId: 가.id });
  model.categoryDelete(p, 가.id);            // X 는 새 문서 칸으로(연고: 가)
  model.docWrite(p, d.id, { categoryId: 나.id });  // 작가가 나로 옮긴다 → 연고가 끊긴다
  model.categoryDelete(p, 나.id);            // X 는 다시 새 문서 칸으로(연고: 나)
  const 가Trash = p.trash.find((e) => e.title === '가');
  model.trashRestore(p, 가Trash.id);
  eq('옛 그릇을 되살려도 남의 문서를 빨아들이지 않는다', model.findDoc(p, d.id).categoryId, null);
  const 나Trash = p.trash.find((e) => e.title === '나');
  model.trashRestore(p, 나Trash.id);
  eq('진짜 주인 그릇을 되살리면 돌아온다', model.findDoc(p, d.id).categoryId, 나.id);
}

{
  // 순수 로직 — 답은 «물은 그 말» 밑에 붙고, 보던 가지를 빼앗지 않는다
  const p = store.blankProject('p_t10', '가지');
  const t = model.threadCreate(p, { title: '논의' });
  const q1 = model.threadAddMessage(p, t.id, 'user', '첫 물음');
  const other = model.threadEditMessage(p, t.id, q1.id, '다른 물음');   // 머리가 다른 가지로 옮겨 간다
  model.threadAddMessage(p, t.id, 'assistant', '첫 답', q1.id, { moveHead: false });
  const th = model.findThread(p, t.id);
  const ans = th.messages.find((m) => m.text === '첫 답');
  eq('답의 부모는 물은 그 말', ans.parentId, q1.id);
  eq('보던 가지를 빼앗지 않는다', th.headId, other.id);
}

{
  // 분량 읽기 — «N화» 가 여럿이면 지어내지 않는다
  eq('«3화» 하나면 그대로', auto.specEpisodes({ spec: { length: '3화' } }), 3);
  eq('«총 12화» 하나면 그대로', auto.specEpisodes({ spec: { length: '총 12화' } }), 12);
  eq('«1화당 5천 자, 총 12화» 는 읽지 않는다', auto.specEpisodes({ spec: { length: '1화당 5천 자, 총 12화' } }), null);
  eq('«장편» 은 읽지 않는다', auto.specEpisodes({ spec: { length: '장편' } }), null);
  eq('빈 칸도 읽지 않는다', auto.specEpisodes({ spec: { length: '' } }), null);
}

{
  // 작품 규격도 머리표 흉내를 막는다
  const p = store.blankProject('p_t11', '규격');
  p.spec = { outline: '■ 가짜 구획\n둘째 줄', form: '소설', length: '' };
  const u = asm.buildUser({ project: p, task: '일' });
  ok('개요 속 머리표가 무력화된다', u.includes(' ■ 가짜 구획'));
}

{
  // 고른 대상이 모두 확정본이면 «대상» 구획이 살아 있다
  const st2 = await import('./state.mjs');
  const eng = await import('./engine.mjs');
  const pj = st2.create({ name: '대상 시험', spec: { outline: 'ㄱ', form: 'ㄴ' }, materials: [{ name: 'ㄷ', text: 'ㄹ' }] });
  let a; let b;
  st2.update(pj.id, (p) => {
    a = model.docCreate(p, { title: '갑', body: '갑 본문' }).id;
    b = model.docCreate(p, { title: '을', body: '을 본문' }).id;
    model.docSetFinal(p, a, true);
    model.docSetFinal(p, b, true);
  });
  let seen = '';
  globalThis.__SE2_MOCK_FN = ({ prompt }) => { seen = prompt; return '모의'; };
  await eng.callOnce({ pid: pj.id, code: 'F-CONTRA', targetIds: [a, b], allFinals: true, finalFirst: true });
  ok('대상 구획이 사라지지 않는다', seen.includes('■ 대상'));
  ok('두 문서가 다 실린다', seen.includes('갑 본문') && seen.includes('을 본문'));
  // 하나만 확정본이면 그것이 기준으로 올라간다
  st2.update(pj.id, (p) => { model.docSetFinal(p, b, false); });
  await eng.callOnce({ pid: pj.id, code: 'F-CONTRA', targetIds: [a, b], allFinals: true, finalFirst: true });
  ok('확정본은 기준 자리로', seen.indexOf('갑 본문') < seen.indexOf('■ 대상'));
  ok('나머지는 대상 자리로', seen.indexOf('을 본문') > seen.indexOf('■ 대상'));
  globalThis.__SE2_MOCK_FN = MOCK_FN;
  st2.remove(pj.id);
}

{
  // 서버 — 남의 프로젝트를 지워도 내 작업은 돈다
  const r1 = await post('project.create', { name: '가', spec: { outline: 'ㄱ', form: 'ㄴ' }, materials: [{ name: 'ㄷ', text: 'ㄹ' }] });
  const r2 = await post('project.create', { name: '나', spec: { outline: 'ㄱ', form: 'ㄴ' }, materials: [{ name: 'ㄷ', text: 'ㄹ' }] });
  await settle(r1.pid); await settle(r2.pid);
  const d = await post('doc.create', { pid: r2.pid, title: '버틸 문서' });
  process.env.SE2_MOCK_DELAY_MS = '300';
  const job = await post('doc.update', { pid: r2.pid, id: d.id });
  await post('project.delete', { pid: r1.pid });
  const 나 = await settle(r2.pid);
  eq('남의 삭제에 휩쓸리지 않는다', 나.jobs.find((j) => j.id === job.jobId).status, 'done');
  process.env.SE2_MOCK_DELAY_MS = '3';

  // 끝난 작업에 중지를 눌러도 상태가 뒤집히지 않는다
  await post('job.stop', { pid: r2.pid, id: job.jobId });
  const again = (await stateOf(r2.pid)).project;
  eq('완료는 완료로 남는다', again.jobs.find((j) => j.id === job.jobId).status, 'done');
  await post('project.delete', { pid: r2.pid });
}

{
  // 서버 — 에이전트를 짓는 중에 자동 집필을 걸면 기다렸다 이어 간다(두 벌로 짓지 않는다)
  process.env.SE2_MOCK_DELAY_MS = '60';
  KIND = '실무 안내서';
  let agentCalls = 0;
  globalThis.__SE2_MOCK_FN = (args) => { if (args.mockKey === 'F-AGENT') agentCalls++; return MOCK_FN(args); };
  const r = await post('project.create', { name: '겹침', spec: { outline: 'ㄱ', form: 'ㄴ', length: '2화' }, materials: [{ name: 'ㄷ', text: 'ㄹ' }] });
  const started = await post('auto.start', { pid: r.pid });
  ok('준비 중에도 시작을 받는다', started.ok);
  const p = await settle(r.pid, 120000);
  globalThis.__SE2_MOCK_FN = MOCK_FN;
  process.env.SE2_MOCK_DELAY_MS = '3';
  eq('자동 집필이 완주한다', p.jobs.find((j) => j.kind === 'auto').status, 'done');
  eq('자리 수만큼만 지었다(두 벌이 아니다)', agentCalls, prompts.AGENT_SLOTS.length);
  await post('project.delete', { pid: r.pid });
  KIND = '소설';
}

{
  // 자동 집필이 남기는 것 — 합평은 합평회로, 모순 검사에는 대상이 적혀 있다
  const r = await post('project.create', {
    name: '자취 시험', spec: { outline: '개요', form: '소설', length: '2화' },
    materials: [{ name: '자료', text: '본문' }],
  });
  const pid = r.pid;
  await settle(pid);
  let seenSys = '';
  globalThis.__SE2_MOCK_FN = ({ mockKey, systemPrompt }) => {
    if (mockKey === 'F-REVIEW' && !seenSys) seenSys = systemPrompt;
    return MOCK_FN({ mockKey });
  };
  await post('auto.start', { pid, feedbackRounds: 1 });
  const p = await settle(pid, 90000);
  globalThis.__SE2_MOCK_FN = MOCK_FN;

  const 합평 = p.docs.filter((d) => d.title === '상세 플롯 합평');
  eq('합평은 합평회 레코드', 합평[0].kind, 'review');
  ok('합평에 대상이 적혀 있다', 합평[0].targetIds.length > 0);
  const 검사 = p.docs.find((d) => d.title === '모순 검사');
  ok('모순 검사에 회차 계획과 회차 산출물이 대상으로 적혀 있다', 검사.targetIds.length >= 3);
  const 계획 = p.docs.find((d) => d.title === '회차 계획 재작성');
  ok('그 대상에 회차 계획이 들어 있다', 검사.targetIds.includes(계획.id));
  ok('갱신이 빈 호출이 되지 않는다', 검사.targetIds.every((id) => p.docs.some((d) => d.id === id)));
  ok('합평 호출의 앞뒤가 실제 이웃이다', seenSys.includes('사건 엮는이') && seenSys.includes('플롯 고쳐 쓰는이'), seenSys.split('\n').find((l) => l.startsWith('앞:')) || '');
  await post('project.delete', { pid });
}


// ---------------------------------------------------------------- 되짚기에서 잡힌 것들

{
  // 답을 기다리는 사이 한 마디 더 보내면 그 줄 끝에 이어 붙는다(가지를 쪼개지 않는다)
  const st2 = await import('./state.mjs');
  const eng = await import('./engine.mjs');
  const pj = st2.create({ name: '이어 붙이기', spec: { outline: 'ㄱ', form: 'ㄴ' }, materials: [{ name: 'ㄷ', text: 'ㄹ' }] });
  let tid = null;
  st2.update(pj.id, (p) => { tid = model.threadCreate(p, { title: '논의' }).id; });

  // «첫 물음»을 보내는 중에 «둘째 물음»이 먼저 얹힌 상황을 흉내 낸다
  let asked = null;
  st2.update(pj.id, (p) => { asked = model.threadAddMessage(p, tid, 'user', '첫 물음').id; });
  st2.update(pj.id, (p) => { model.threadAddMessage(p, tid, 'user', '둘째 물음'); });
  await eng.runTalk(pj.id, tid, null, null);
  let th = model.findThread(st2.get(pj.id), tid);
  const ans = th.messages[th.messages.length - 1];
  eq('답이 그 줄 끝에 붙는다', ans.parentId, th.messages[1].id);
  ok('현재 가지에 답이 보인다', model.threadPath(th).some((m) => m.id === ans.id));
  eq('가지가 갈라지지 않는다', model.threadSiblings(th, asked).length, 1);

  // 답을 기다리는 사이 작가가 다른 가지로 옮겨 가면, 답은 물은 자리 밑에 조용히 붙는다
  process.env.SE2_MOCK_DELAY_MS = '250';
  const flying = eng.runTalk(pj.id, tid, '셋째 물음', null);   // 아직 돌고 있다
  await sleep(40);
  let askedAgain = null;
  st2.update(pj.id, (p) => {
    const t2 = model.findThread(p, tid);
    askedAgain = t2.headId;                                     // 방금 얹힌 «셋째 물음»
    model.threadEditMessage(p, tid, asked, '다른 물음');          // 작가가 다른 가지로 옮겨 간다
  });
  const before = model.findThread(st2.get(pj.id), tid).headId;
  await flying;
  process.env.SE2_MOCK_DELAY_MS = '3';
  th = model.findThread(st2.get(pj.id), tid);
  eq('보던 가지를 빼앗지 않는다', th.headId, before);
  const late = th.messages.filter((m) => m.role === 'assistant').pop();
  eq('답은 물은 자리 밑에 있다', late.parentId, askedAgain);
  st2.remove(pj.id);
}

{
  // 앞뒤는 실제 파이프라인의 이웃이다
  eq('본문 뒤에 합평이 서지 않는다', prompts.NEIGHBORS.S18C[1], 'F-CONTRA');
  eq('상세 플롯 뒤는 합평', prompts.NEIGHBORS.S12[1], 'F-REVIEW');
  eq('합평 뒤는 재작성', prompts.NEIGHBORS['F-REVIEW'][1], 'S14');
  ok('모든 자리에 이웃이 적혀 있다', prompts.AGENT_SLOTS.every((c) => prompts.NEIGHBORS[c]));
}

{
  // 자료 이름은 첫 줄에서 딴다
  eq('첫 줄이 이름이 된다', model.firstLineName('  등대 자료\n둘째 줄'), '등대 자료');
  eq('빈 글이면 기본 이름', model.firstLineName('   '), '붙여 넣은 글');
}

{
  // 서버 — 이력이 옛 본문을 함께 보여 준다 · 같은 문서에 갱신을 두 번 걸지 않는다 · 스레드 이름 고치기
  const r = await post('project.create', { name: '되짚기', spec: { outline: 'ㄱ', form: 'ㄴ', length: '2화' }, materials: [{ name: 'ㄷ', text: 'ㄹ' }] });
  const pid = r.pid;
  await settle(pid);

  const d = await post('doc.create', { pid, title: '문서' });
  await post('doc.write', { pid, id: d.id, body: '처음 본문' });
  await post('doc.write', { pid, id: d.id, body: '나중 본문' });
  const p1 = (await stateOf(pid)).project.docs.find((x) => x.id === d.id);
  eq('판이 쌓인다', p1.versions.length, 2);
  eq('옛 본문을 볼 수 있다', p1.versions[1].body, '처음 본문');

  process.env.SE2_MOCK_DELAY_MS = '300';
  const first = await post('doc.update', { pid, id: d.id });
  const second = await post('doc.update', { pid, id: d.id });
  ok('갱신을 두 번 걸지 않는다', first.ok && !second.ok);
  await settle(pid);
  process.env.SE2_MOCK_DELAY_MS = '3';

  const t = await post('thread.create', { pid, title: '논의' });
  await post('thread.title', { pid, id: t.id, title: '주인공 고르기' });
  eq('스레드 이름을 고친다', (await stateOf(pid)).project.threads[0].title, '주인공 고르기');

  await post('material.add', { pid, text: '새 자료 첫 줄\n둘째 줄' });
  const mats = (await stateOf(pid)).project.materials;
  eq('붙여 넣은 자료의 이름', mats[mats.length - 1].name, '새 자료 첫 줄');
  ok('글자 수가 함께 온다', mats[mats.length - 1].chars > 0);
  await post('project.delete', { pid });
}

{
  // 자동 집필을 두 번 돌리면 지난 확정본이 내려간다(옛 판이 새 판을 지배하지 않게)
  const r = await post('project.create', { name: '두 번', spec: { outline: 'ㄱ', form: 'ㄴ', length: '1화' }, materials: [{ name: 'ㄷ', text: 'ㄹ' }] });
  const pid = r.pid;
  await settle(pid);
  await post('auto.start', { pid, feedbackRounds: 1, skipProse: true });
  let p = await settle(pid, 90000);
  const firstFinal = p.docs.filter((x) => x.isFinal);
  eq('첫 실행의 확정본은 하나', firstFinal.length, 1);

  // 작가가 손으로 켠 확정본은 건드리지 않는다
  const mine = await post('doc.create', { pid, title: '내가 켠 확정본' });
  await post('doc.final', { pid, ids: [mine.id], on: true });

  await post('auto.start', { pid, feedbackRounds: 1, skipProse: true });
  p = await settle(pid, 90000);
  const finals = p.docs.filter((x) => x.isFinal);
  eq('지난 실행의 확정본은 내려간다', finals.filter((x) => x.title === '회차 계획 재작성').length, 1);
  ok('작가가 켠 확정본은 그대로', finals.some((x) => x.id === mine.id));
  eq('켜져 있는 확정본은 둘뿐', finals.length, 2);
  await post('project.delete', { pid });
}

// ---------------------------------------------------------------- 화면-서버 배선

{
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  const used = new Set();
  for (const m of app.matchAll(/api\(\s*'([^']+)'/g)) used.add(m[1]);
  ok('화면이 부르는 문이 하나라도 있다', used.size > 5, String(used.size));
  for (const op of used) ok('서버에 문이 있다: ' + op, OP_NAMES.includes(op));
  for (const m of app.matchAll(/\/api\/(state|download)/g)) ok('상태·내려받기 경로', !!m[1]);
  // 색은 :root 에 적힌 것만 쓴다 — 적·백·흑·파랑 네 갈래.
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  const root = css.slice(css.indexOf(':root'), css.indexOf('}', css.indexOf(':root')));
  const rootHex = (root.match(/#[0-9a-f]{3,8}/gi) || []).map((x) => x.toLowerCase());
  eq('팔레트 토큰', rootHex.sort().join(','), ['#111111', '#ffffff', '#1a48d0', '#7fa0ff', '#d4202a', '#ff8c92'].sort().join(','));
  const strays = (css.replace(root, '').match(/#[0-9a-f]{3,8}/gi) || []).map((x) => x.toLowerCase()).filter((x) => !rootHex.includes(x));
  ok('팔레트 밖의 색을 쓰지 않는다', strays.length === 0, strays.join(' '));
  const strayApp = (readFileSync(join(ROOT, 'web', 'app.js'), 'utf8').match(/#[0-9a-f]{3,8}/gi) || []);
  ok('화면 코드에 색을 박지 않는다', strayApp.length === 0, strayApp.join(' '));
}

// ---------------------------------------------------------------- 프롬프트 정본

{
  const need = ['S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S14', 'S15', 'S17', 'S18A', 'S18B', 'S18C',
    'F-UPDATE', 'F-TALK', 'F-THREADDOC', 'F-CONTRA', 'F-REVIEW', 'F-KIND', 'F-AGENT', 'F-COUNT'];
  for (const c of need) ok('내장 프롬프트 ' + c, !!prompts.BUILTIN[c]);
  const placeholder = prompts.BUILTIN.S02.craft.includes('임시');
  if (!placeholder) {
    for (const c of need) {
      if (c === 'F-COUNT') continue;
      ok('작법이 넉넉하다 ' + c, (prompts.BUILTIN[c].craft || '').length >= 2000, String((prompts.BUILTIN[c].craft || '').length));
    }
    // 제목 줄을 «쓰라»고 시키는 대목이 있으면 안 된다(제목은 프로그램이 붙인다).
    for (const c of need) ok('제목 줄을 시키지 않는다 ' + c, !/제목을\s*(쓴다|써라|적는다|적어라|붙여라|단다)/.test(prompts.BUILTIN[c].craft || ''));
  }
}

server.close();
rmSync(BOX, { recursive: true, force: true });

console.log('');
console.log('  통과 ' + pass + ' / 실패 ' + fails.length);
for (const f of fails) console.log('   ✗ ' + f);
console.log('');
process.exit(fails.length ? 1 : 0);
