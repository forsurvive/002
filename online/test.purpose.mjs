// 용도 축 시험 — SE_PURPOSE=ebook(전자책 오토)과 novel(지금 그대로). docs/EBOOK_EDITION.md §8 · §13(E0). online/test.mjs 가 이어 부른다.

import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';
import { purposeOf, purposeName, purposeTemplate } from './purpose.mjs';

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
  } finally {
    for (const s of servers) await new Promise((r) => s.close(r));
  }
}
