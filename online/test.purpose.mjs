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
    eq('작업실 상태(me)에도', (await book.get('/api/state')).me.purpose, 'ebook');
    eq('내 계정(me.memberships)에도', (await book.post('/api/edu', { op: 'me.memberships' })).purpose, 'ebook');
    const novel = await start({ SE_EDITION: 'open' });
    const s2 = await novel.setup();
    ok('**용도를 적지 않은 앱은 지금 그대로 — novel · 스토리 엔진**', s2.purpose === 'novel' && s2.name === '스토리 엔진' && (await novel.get('/api/me')).me.purpose === 'novel');
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
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
}
