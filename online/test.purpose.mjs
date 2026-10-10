// 용도 축 시험 — SE_PURPOSE=ebook(전자책 오토)과 novel(지금 그대로). docs/EBOOK_EDITION.md §8 · §13(E0). online/test.mjs 가 이어 부른다.

import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { purposeOf, purposeName, purposeTemplate } from './purpose.mjs';
import { baseTemplate, templateKeyOf, TEMPLATE_KEYS } from '../tools/workflow.mjs';
import { createWorkflowSource } from './workflow.mjs';

export async function run({ pool, ok, eq }) {
  // ---------------- 용도 읽기 — 모르는 값은 novel(지금 앱이 저절로 바뀌지 않게)
  eq('용도 — 적지 않으면 novel', purposeOf({}), 'novel');
  eq('용도 — ebook(대소문자 · 빈칸 무시)', purposeOf({ SE_PURPOSE: ' EBook ' }), 'ebook');
  eq('**용도 — 모르는 값은 novel**', purposeOf({ SE_PURPOSE: 'e-book' }), 'novel');
  ok('이름 — 전자책 오토 · 스토리 엔진(모르는 용도는 스토리 엔진)', purposeName('ebook') === '전자책 오토' && purposeName('novel') === '스토리 엔진' && purposeName('x') === '스토리 엔진');
  ok('새 작품의 단계 템플릿 — ebook · story_creation', purposeTemplate('ebook') === 'ebook' && purposeTemplate('novel') === 'story_creation');
  const pl = onlinePlan({ SE_PURPOSE: 'ebook' });
  ok('계획 — purpose 가 실린다 · 모르는 값이면 알림', pl.purpose === 'ebook' && onlinePlan({}).purpose === 'novel'
    && onlinePlan({ SE_PURPOSE: 'book' }).notes.some((n) => /SE_PURPOSE/.test(n)) && !pl.notes.some((n) => /SE_PURPOSE/.test(n)));

  // ---------------- 템플릿 고르기 — 작품마다 p.workflow.template, 없거나 모르면 이야기 만들기(지금까지의 모든 작품)
  ok('템플릿 열쇠 — 이야기 만들기 · 전자책', TEMPLATE_KEYS.includes('story_creation') && TEMPLATE_KEYS.includes('ebook'));
  ok('기본 템플릿은 이야기 만들기(16단계)', baseTemplate().key === 'story_creation' && baseTemplate().stages.length === 16 && baseTemplate('story_creation') === baseTemplate());
  eq('모르는 열쇠의 템플릿은 없다(단계 기능이 서지 않을 뿐)', baseTemplate('../../etc/passwd'), null);
  ok('**작품의 템플릿 — 적혀 있지 않거나 모르는 값이면 이야기 만들기**', templateKeyOf({}) === 'story_creation' && templateKeyOf(null) === 'story_creation'
    && templateKeyOf({ workflow: { template: 'nope' } }) === 'story_creation' && templateKeyOf({ workflow: { template: 'ebook' } }) === 'ebook');

  resetThrottle();
  await createUser(pool, { loginId: 'pu-root', password: 'long-enough-pu-root', isPlatformAdmin: true });
  await createUser(pool, { loginId: 'pu-writer', password: 'long-enough-pu-writer' });
  const servers = [];
  const start = async (env) => {
    const srv = createOnlineServer({ pool, plan: onlinePlan(env) });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const base = 'http://127.0.0.1:' + srv.address().port;
    const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'pu-writer', password: 'long-enough-pu-writer' }) });
    const cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    const get = async (path) => (await fetch(base + path, { headers: { cookie } })).json();
    const post = async (path, body) => (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) })).json();
    return { base, get, post, setup: async () => (await fetch(base + '/api/setup')).json() };
  };

  try {
    // ---------------- 화면이 용도를 안다 — 로그인 전(/api/setup) · 뒤(/api/me · /api/state · 내 계정)
    const book = await start({ SE_EDITION: 'open', SE_PURPOSE: 'ebook' });
    const s1 = await book.setup();
    ok('**전자책 오토 — 로그인 전 화면이 용도 · 이름을 받는다**', s1.purpose === 'ebook' && s1.name === '전자책 오토' && s1.edition === 'open', JSON.stringify(s1));
    eq('로그인 뒤 me 에 용도', (await book.get('/api/me')).me.purpose, 'ebook');
    ok('**화면 이름은 서버가 준다 — me · 내 계정(me.memberships)에 «전자책 오토»**', (await book.get('/api/me')).me.appName === '전자책 오토'
      && (await book.post('/api/edu', { op: 'me.memberships' })).appName === '전자책 오토');
    eq('작업실 상태(me)에도', (await book.get('/api/state')).me.purpose, 'ebook');
    eq('내 계정(me.memberships)에도', (await book.post('/api/edu', { op: 'me.memberships' })).purpose, 'ebook');
    const novel = await start({ SE_EDITION: 'open' });
    const s2 = await novel.setup();
    ok('**용도를 적지 않은 앱은 지금 그대로 — novel · 스토리 엔진**', s2.purpose === 'novel' && s2.name === '스토리 엔진' && (await novel.get('/api/me')).me.purpose === 'novel'
      && (await novel.get('/api/me')).me.appName === '스토리 엔진' && (await novel.post('/api/edu', { op: 'me.memberships' })).appName === '스토리 엔진');
    const school = await start({ SE_PURPOSE: 'ebook' });
    ok('용도는 판과 따로 돈다(교육기관판 + ebook)', (await school.setup()).purpose === 'ebook' && (await school.setup()).edition === 'school');

    // ---------------- 새 작품의 템플릿 — 전자책 오토에서 만든 책은 ebook, 지금 앱은 적지 않는다(지금까지와 같은 꼴)
    const mk = async (app, name) => (await app.post('/api', { op: 'project.create', name, spec: { form: '실용서' }, materials: [{ name: '자료', text: '글' }] })).pid;
    const tplOf = async (pid) => (await pool.query(`SELECT workflow->>'template' AS t FROM projects WHERE id = $1`, [pid])).rows[0].t;
    const bookPid = await mk(book, '첫 책');
    eq('**전자책 오토에서 만든 책은 전자책 템플릿을 쓴다**', await tplOf(bookPid), 'ebook');
    const novelPid = await mk(novel, '첫 소설');
    eq('**지금 앱에서 만든 작품에는 템플릿을 적지 않는다(지금까지와 같은 꼴)**', await tplOf(novelPid), null);
    const wfs = createWorkflowSource(pool);
    eq('적지 않은 작품은 이야기 만들기로 돈다', (await wfs.templateFor(novelPid)).key, 'story_creation');
    await pool.query(`UPDATE projects SET workflow = workflow || '{"template":"nope"}' WHERE id = $1`, [novelPid]);
    eq('모르는 값이 적혀 있어도 이야기 만들기', (await wfs.templateFor(novelPid)).key, 'story_creation');
    await pool.query(`UPDATE projects SET workflow = workflow - 'template' WHERE id = $1`, [novelPid]);
    ok('관리 화면이 고칠 템플릿은 앱의 용도가 정한다(이 앱은 이야기 만들기)', (await wfs.editorView()).key === 'story_creation');

    // ---------------- 작업실이 받는 단계 — 책은 전자책 8단계 · 말은 «장», 작품은 지금처럼 16단계 · «화»
    const stOf = async (app, pid) => (await app.get('/api/state?pid=' + pid)).project;
    const bs = await stOf(book, bookPid);
    ok('**책의 작업실은 전자책 단계(8단계 · 장)를 받는다**', bs.workflow && bs.workflow.stages.length === 8 && bs.workflow.episodeWord === '장' && bs.workflow.title === '전자책 만들기',
      JSON.stringify(bs.workflow && { n: bs.workflow.stages.length, w: bs.workflow.episodeWord }));
    ok('책의 첫 걸음(의뢰 · 자료)은 규격과 자료가 있으면 끝', bs.workflow.stages[0].key === 'brief' && bs.workflow.stages[0].status === 'approved');
    const ns = await stOf(novel, novelPid);
    ok('작품의 작업실은 지금처럼(16단계 · 화)', ns.workflow.stages.length === 16 && ns.workflow.episodeWord === '화');
    eq('**장을 고르지 않고 장 집필을 시작하면 «몇 장인지»를 묻는다**', (await book.post('/api', { op: 'stage.start', pid: bookPid, key: 'chapters' })).error, '몇 장인지 골라 주세요');
    eq('책의 템플릿을 고르면 전자책(관리 화면이 아닌 작품 쪽)', (await createWorkflowSource(pool, { defaultKey: 'ebook' }).templateFor(bookPid)).key, 'ebook');
    // 전자책 집필만 하는 앱(2026-10-10) — 책은 처음부터 «전자책»(소설/비소설 판정 호출 없이 전자책 에이전트를 짓는다)
    const kindOf = async (pid) => (await pool.query(`SELECT agent_kind FROM projects WHERE id = $1`, [pid])).rows[0].agent_kind;
    eq('**전자책 오토의 책은 글 종류가 처음부터 «전자책»**', await kindOf(bookPid), '전자책');
    ok('지금 앱의 작품은 지금처럼(글 종류는 준비 작업이 판정한다 — 비어 있다)', !(await kindOf(novelPid)));
    // 다른 앱(스토리 엔진)의 작품 파일을 전자책 오토로 들여오면 책으로 연다
    const bundle = await (await fetch(novel.base + '/api/download?pid=' + novelPid + '&kind=project&id=', { headers: { cookie: (await (async () => {
      const r = await fetch(novel.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: 'pu-writer', password: 'long-enough-pu-writer' }) });
      return (r.headers.get('set-cookie') || '').split(';')[0];
    })()) } })).json();
    const imp = await book.post('/api', { op: 'project.import', bundle });
    ok('**전자책 오토로 들여온 작품은 전자책 템플릿 · 전자책 글 종류로 열린다**', imp.ok && await tplOf(imp.pid) === 'ebook' && await kindOf(imp.pid) === '전자책', JSON.stringify(imp));
    const imp2 = await novel.post('/api', { op: 'project.import', bundle });
    eq('지금 앱으로 들여오면 지금처럼(템플릿을 적지 않는다)', await tplOf(imp2.pid), null);
    ok('전자책 오토의 관리 화면은 전자책 단계를 고친다', (await createWorkflowSource(pool, { defaultKey: 'ebook' }).editorView()).stages.length === 8);
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
}
