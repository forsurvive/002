// 온라인 서버 시험 — online/test.mjs 가 이어 부른다. 실제 HTTP 로 두드린다. 여기서는 worker 를 띄우지 않는다(작업은 줄에 서기만 한다) — 돌리는 쪽은 test.worker.mjs.

import { request as httpRequest } from 'node:http';
import { createOnlineServer, onlinePlan } from './server.mjs';
import { createUser, resetThrottle } from './auth.mjs';

export async function run({ pool, ok, eq }) {
  resetThrottle();
  await createUser(pool, { loginId: 'web-a', password: 'long-enough-a', displayName: '가' });
  await createUser(pool, { loginId: 'web-b', password: 'long-enough-b', displayName: '나' });

  const srv = createOnlineServer({ pool, plan: onlinePlan({ SE2_PORT: '0' }), denyFrames: true });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;

  const jar = { a: '', b: '' };
  const req = async (path, { who = '', method = 'GET', body, headers = {} } = {}) => {
    const h = { ...headers };
    if (who && jar[who]) h.cookie = jar[who];
    if (body !== undefined && !h['content-type']) h['content-type'] = 'application/json';
    return fetch(base + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual' });
  };
  const op = async (who, name, b = {}) => {
    const r = await req('/api', { who, method: 'POST', body: { op: name, ...b } });
    return { status: r.status, ...(await r.json()) };
  };
  const stateOf = async (who, pid) => (await req('/api/state' + (pid ? '?pid=' + encodeURIComponent(pid) : ''), { who })).json();

  try {
    // ---------------- 들어오기 전
    eq('살아 있는가는 누구나', (await req('/healthz')).status, 200);
    const home = await req('/');
    ok('로그인 전 첫 화면은 로그인 화면(그 자리에서 200 — 게시 상태 검사)', home.status === 200 && (await home.text()).includes('login.js'));
    const lp = await req('/login');
    ok('로그인 화면', lp.status === 200 && (await lp.text()).includes('login.js'));
    const st0 = await req('/api/state');
    const st0j = await st0.json();
    ok('로그인 전 상태는 401 · login', st0.status === 401 && st0j.code === 'login');
    eq('로그인 전 문도 401', (await req('/api', { method: 'POST', body: { op: 'project.list' } })).status, 401);
    ok('보안 머리줄', home.headers.get('x-frame-options') === 'DENY' && home.headers.get('x-content-type-options') === 'nosniff'
      && /frame-ancestors 'none'/.test(home.headers.get('content-security-policy') || '') && !/script-src[^;]*unsafe/.test(home.headers.get('content-security-policy') || ''));
    {
      // 운영이 아니면(작업 공간 미리보기 iframe) 틀 막기를 켜지 않는다 — 나머지 머리줄은 같다
      const dev = createOnlineServer({ pool, plan: onlinePlan({}) });
      await new Promise((r) => dev.listen(0, '127.0.0.1', r));
      const hd = await fetch('http://127.0.0.1:' + dev.address().port + '/healthz');
      ok('스테이징은 iframe 을 막지 않는다', !hd.headers.get('x-frame-options') && !/frame-ancestors/.test(hd.headers.get('content-security-policy') || '') && hd.headers.get('x-content-type-options') === 'nosniff');
      await new Promise((r) => dev.close(r));
    }

    // 가입 문은 없다(결정: 운영자 발급 · 자유 가입은 결제가 정해질 때까지 닫힘 — docs/SECURITY.md §7-0)
    eq('**가입 문이 없다**', (await req('/api/auth/signup', { method: 'POST', body: { loginId: 'stranger', password: 'long-enough-x' } })).status, 401);
    ok('가입 시도로 계정이 생기지 않는다', (await pool.query("SELECT 1 FROM users WHERE login_id = 'stranger'")).rowCount === 0);

    // ---------------- 로그인
    const wrong = await req('/api/auth/login', { method: 'POST', body: { loginId: 'web-a', password: 'nope-nope-nope' } });
    ok('틀리면 401 · 쿠키 없음', wrong.status === 401 && !wrong.headers.get('set-cookie'));
    for (const who of ['a', 'b']) {
      const r = await req('/api/auth/login', { method: 'POST', body: { loginId: 'web-' + who, password: 'long-enough-' + who } });
      const ck = r.headers.get('set-cookie') || '';
      ok('로그인하면 HttpOnly 쿠키(' + who + ')', r.status === 200 && /HttpOnly/.test(ck) && /SameSite=Lax/.test(ck));
      jar[who] = ck.split(';')[0];
    }
    ok('루프백에서는 Secure 를 달지 않는다(로컬 http)', !/Secure/.test((await req('/api/auth/login', { method: 'POST', body: { loginId: 'web-a', password: 'long-enough-a' } })).headers.get('set-cookie')));
    eq('로그인한 사람이 /login 에 오면 첫 화면으로', (await req('/login', { who: 'a' })).headers.get('location'), '/');
    const me = await (await req('/api/me', { who: 'a' })).json();
    ok('나는 누구인가', me.ok && me.me.loginId === 'web-a' && me.me.displayName === '가');

    // ---------------- 같은 문 · 같은 응답 꼴
    const miss = await op('a', 'project.create', { name: '', spec: {} });
    ok('필수 항목 누락은 개인판과 같은 말', miss.ok === false && /필수 항목 누락 — 이름 · 형식 · 자료/.test(miss.error));
    const made = await op('a', 'project.create', { name: '온라인 작품', spec: { form: '장편' }, materials: [{ name: '설정 노트', text: '세계는 둥글다' }] });
    ok('프로젝트를 만든다', made.ok && /^[0-9a-f-]{36}$/.test(made.pid), JSON.stringify(made));
    const pid = made.pid;
    let s = await stateOf('a', pid);
    ok('상태 꼴이 개인판과 같다', s.ok && s.project.id === pid && Array.isArray(s.project.docs) && Array.isArray(s.project.categories) && Array.isArray(s.projects));
    const mat = s.project.docs.find((d) => d.title === '설정 노트');
    ok('자료는 «자료» 카테고리의 문서로', mat && s.project.categories.some((c) => c.name === '자료' && c.docIds.includes(mat.id)));
    ok('작법서 구획은 개인판처럼 서지 않는다(기본 작법서를 두지 않는다)', !s.project.docs.some((d) => d.src));
    ok('과금 갈래가 화면에 오지 않는다', s.project.auth && s.project.auth.modes.length === 0 && s.project.auth.hasKey === false);
    ok('목록에 내 작품', s.projects.some((p) => p.id === pid) && s.me.loginId === 'web-a');

    const dc = await op('a', 'doc.create', { pid, title: '플롯', body: '첫 판' });
    ok('문서 만들기', dc.ok && dc.id);
    await op('a', 'doc.write', { pid, id: dc.id, body: '둘째 판', refIds: [mat.id] });
    await op('a', 'doc.final', { pid, ids: [mat.id], on: true });
    s = await stateOf('a', pid);
    let d = s.project.docs.find((x) => x.id === dc.id);
    ok('고치면 판이 쌓이고 참조가 걸린다', d.body === '둘째 판' && d.versions.length === 1 && d.refIds[0] === mat.id);
    ok('확정본', s.project.docs.find((x) => x.id === mat.id).isFinal === true);
    await op('a', 'doc.restoreVersion', { pid, id: dc.id, index: 0 });
    d = (await stateOf('a', pid)).project.docs.find((x) => x.id === dc.id);
    ok('판 복원', d.body === '첫 판' && d.versions.length === 2);
    const th = await op('a', 'thread.create', { pid, title: '논의' });
    ok('스레드', th.ok && th.id);
    await op('a', 'doc.delete', { pid, ids: [dc.id] });
    s = await stateOf('a', pid);
    ok('휴지통으로', !s.project.docs.some((x) => x.id === dc.id) && s.project.trash.some((e) => e.kind === 'doc'));
    await op('a', 'trash.restore', { pid, ids: [s.project.trash.find((e) => e.kind === 'doc').id] });
    ok('되살리기', (await stateOf('a', pid)).project.docs.some((x) => x.id === dc.id));
    const dl = await req('/api/download?pid=' + pid + '&kind=doc&id=' + dc.id, { who: 'a' });
    ok('내려받기', dl.status === 200 && (await dl.text()).startsWith('# 플롯'));

    // ---------------- 상태 폴링을 가볍게 — 바뀐 것이 없으면 304
    {
      const s1 = await req('/api/state?pid=' + pid, { who: 'a' });
      const tag = s1.headers.get('etag');
      ok('상태에 지문(ETag)', !!tag && s1.status === 200 && /no-cache/.test(s1.headers.get('cache-control')));
      eq('**바뀐 것이 없으면 304**', (await req('/api/state?pid=' + pid, { who: 'a', headers: { 'if-none-match': tag } })).status, 304);
      await op('a', 'doc.write', { pid, id: dc.id, request: '지문 바꾸기' });
      const s2 = await req('/api/state?pid=' + pid, { who: 'a', headers: { 'if-none-match': tag } });
      ok('고치면 새 지문으로 200', s2.status === 200 && s2.headers.get('etag') !== tag && (await s2.json()).project.docs.find((x) => x.id === dc.id).request === '지문 바꾸기');
      const home1 = await req('/api/state', { who: 'a' });
      const ht = home1.headers.get('etag');
      eq('첫 화면도 304', (await req('/api/state', { who: 'a', headers: { 'if-none-match': ht } })).status, 304);
      await op('a', 'project.spec', { pid, name: '온라인 작품' });
      ok('작품을 고치면 첫 화면 지문도 바뀐다', (await req('/api/state', { who: 'a', headers: { 'if-none-match': ht } })).status === 200);
      const sb0 = await req('/api/state?pid=' + pid, { who: 'b', headers: { 'if-none-match': tag } });
      ok('**남의 프로젝트에는 지문도 304 도 없다**', sb0.status === 200 && !sb0.headers.get('etag') && (await sb0.json()).ok === false);
    }

    // ---------------- AI 작업은 줄에 선다(곧바로 jobId) — 도는 동안 기존 글은 그대로
    const ai = await op('a', 'doc.update', { pid, id: dc.id });
    ok('AI 작업은 등록만 하고 곧바로 jobId', ai.ok && /^[0-9a-f-]{36}$/.test(ai.jobId));
    eq('그 사이 본문은 그대로', (await stateOf('a', pid)).project.docs.find((x) => x.id === dc.id).body, '첫 판');
    const line = (await stateOf('a', pid)).project.jobs.find((j) => j.id === ai.jobId);
    ok('작업 줄은 개인판 꼴(대기 중 · 대상)', line && line.status === 'running' && line.step === '대기 중' && line.targetId === dc.id);
    ok('같은 문서에 또 맡기면 «이미 도는 중»', /이미 도는 중/.test((await op('a', 'doc.update', { pid, id: dc.id })).error));
    ok('만들 때 선 에이전트 준비가 줄에 있다 — 다시 누르면 «이미 도는 중»', (await stateOf('a', pid)).project.jobs.some((j) => j.kind === 'agents') && /이미 도는 중/.test((await op('a', 'project.prepare', { pid })).error || ''));
    ok('남은 작업은 목록에서 치울 수 있다', (await op('a', 'job.remove', { pid, id: ai.jobId })).ok && !(await stateOf('a', pid)).project.jobs.some((j) => j.id === ai.jobId));

    // ---------------- 격리 — 남의 프로젝트는 «없음»
    const sb = await stateOf('b', pid);
    ok('**남의 프로젝트 상태를 볼 수 없다**', sb.ok === false && !sb.project && !JSON.stringify(sb).includes('온라인 작품'));
    const wb = await op('b', 'doc.write', { pid, id: dc.id, body: '남이 쓴 글' });
    ok('**남의 프로젝트를 고칠 수 없다(404)**', wb.status === 404 && wb.ok === false);
    eq('본문은 그대로', (await stateOf('a', pid)).project.docs.find((x) => x.id === dc.id).body, '첫 판');
    eq('**남의 프로젝트를 지울 수 없다**', (await op('b', 'project.delete', { pid })).status, 404);
    eq('**남의 프로젝트를 내려받을 수 없다**', (await req('/api/download?pid=' + pid + '&kind=doc&id=' + dc.id, { who: 'b' })).status, 404);
    ok('남의 목록에 없다', !(await stateOf('b')).projects.some((p) => p.id === pid));
    eq('이상한 pid 도 같은 404', (await op('a', 'doc.write', { pid: "x' OR 1=1 --", id: dc.id })).status, 404);
    eq('pid 없이 고치는 문도 404', (await op('a', 'doc.write', { id: dc.id })).status, 404);
    eq('모르는 문은 404', (await op('a', 'admin.everything', {})).status, 404);
    eq('로그인해도 가입 길은 없다(404)', (await req('/api/auth/signup', { who: 'a', method: 'POST', body: { loginId: 'stranger2', password: 'long-enough-x' } })).status, 404);
    eq('가입 op 도 없다', (await op('a', 'auth.signup', { loginId: 'stranger3', password: 'long-enough-x' })).status, 404);

    // ---------------- 키는 화면으로 받지 않는다
    const kw = await op('a', 'auth.write', { mode: 'api', apiKey: 'sk-fake-test-value' });
    ok('**auth.write 거절**', kw.status === 403 && kw.ok === false);
    ok('키 흔적이 상태에 없다', !JSON.stringify(await stateOf('a', pid)).includes('sk-fake-test-value'));

    // ---------------- 문지기
    const foreign = await req('/api', { who: 'a', method: 'POST', body: { op: 'project.list' }, headers: { origin: 'https://evil.example' } });
    eq('남의 Origin 은 403', foreign.status, 403);
    const plain = await req('/api', { who: 'a', method: 'POST', body: JSON.stringify({ op: 'project.list' }), headers: { 'content-type': 'text/plain' } });
    eq('text/plain 은 415', plain.status, 415);
    // fetch 는 Host 를 바꿔 달지 못한다 — 맨 http 로 보낸다
    const odd = await new Promise((resolve) => {
      const rq = httpRequest({ host: '127.0.0.1', port: srv.address().port, path: '/api/state', headers: { host: 'evil.example', cookie: jar.a } }, (res) => { res.resume(); resolve(res.statusCode); });
      rq.on('error', () => resolve(0)); rq.end();
    });
    eq('낯선 Host 는 403(DNS 재바인딩)', odd, 403);
    const big = await req('/api', { who: 'a', method: 'POST', body: JSON.stringify({ op: 'project.list', pad: 'x'.repeat(5 * 1024 * 1024 + 10) }) });
    eq('너무 큰 요청은 413', big.status, 413);
    eq('웹 폴더 밖은 없다', (await req('/..%2f..%2fpackage.json', { who: 'a' })).status, 404);

    // ---------------- 감사 · 지우기 · 로그아웃
    const acts = (await pool.query("SELECT action FROM audit_logs WHERE action LIKE 'project.%'")).rows.map((r) => r.action);
    ok('프로젝트 만들기가 감사 로그에', acts.includes('project.create'));
    const p2 = (await op('a', 'project.create', { name: '지울 것', spec: { form: '단편' }, materials: [{ name: '자', text: '자료' }] })).pid;
    ok('지운다', (await op('a', 'project.delete', { pid: p2 })).ok);
    ok('지운 것은 목록에서 빠진다', !(await stateOf('a')).projects.some((p) => p.id === p2));
    eq('지운 것은 열리지 않는다', (await stateOf('a', p2)).ok, false);
    const out = await req('/api/auth/logout', { who: 'a', method: 'POST', body: {} });
    ok('로그아웃은 쿠키를 지운다', out.status === 200 && /Max-Age=0/.test(out.headers.get('set-cookie') || ''));
    eq('로그아웃한 쿠키로는 못 들어온다', (await req('/api/state', { who: 'a' })).status, 401);
  } finally {
    await new Promise((r) => srv.close(r));
  }
}
