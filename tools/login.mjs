// 화면에서 하는 구독 로그인 — Claude(Claude Code) · ChatGPT(Codex CLI)를 클릭과 붙여 넣기로(docs/PERSONAL_USB.md §8-4, 2026-10-13 사용자 지시).
// 로그인은 각 회사의 실행기가 제 화면 · 제 자리에서 한다 — 이 앱은 실행기를 띄우고, 실행기가 찍은 로그인 주소를 화면에 옮기고,
// (Claude 가 «코드를 붙여 넣으라»고 하면) 사람이 붙여 넣은 코드를 실행기에 그대로 건넬 뿐이다. 토큰 · 로그인 정보는 읽지도 두지도 않는다.
// 실측(2026-10-13, 리눅스 · 창 없이): `claude auth login --claudeai` 는 «If the browser didn't open, visit: <주소>» 뒤 «Paste code here if prompted >» 로 기다리고,
// `codex login` 은 «navigate to this URL ... <주소>» 를 찍고 http://localhost:1455 에서 돌아오기를 기다린다.
// 한 번에 하나만 돈다. 10분이면 끊는다. 주소는 그 회사의 로그인 자리(claude.com · claude.ai · anthropic.com · openai.com)일 때만 화면에 올린다.

import { spawn } from 'node:child_process';

export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const URL_OK = /^https:\/\/([a-z0-9-]+\.)*(claude\.com|claude\.ai|anthropic\.com|openai\.com)\//i;

// 실행기 출력에서 로그인 주소 하나를 찾는다(그 회사의 자리일 때만)
export function loginUrlOf(text) {
  for (const m of String(text || '').matchAll(/https:\/\/[^\s"'<>]+/g)) {
    const u = m[0].replace(/[).,]+$/, '');
    if (URL_OK.test(u) && /oauth|authorize|login/i.test(u)) return u;
  }
  return '';
}

/**
 * plans = { claude: { cli, args, env }, chatgpt: { cli, args, env } } — 띄울 것(cli 는 함수여도 된다 — 띄우는 순간에 읽는다)
 *   prepare: () => null | Promise — 띄우기 전에 할 일(실행기가 없으면 폴더로 받기). 할 일이 없으면 null. 실패는 Error(화면에 보일 말)로 던진다
 *   preparing: 그동안 화면에 보일 말 · missing: 실행기를 찾지 못했을 때의 말
 * check = { claude: async () => bool, chatgpt: async () => bool } — 로그인되어 있는가
 */
export function createLogin({ plans, check, spawnImpl = spawn, timeoutMs = LOGIN_TIMEOUT_MS }) {
  let cur = null;   // { who, p, out, url, needsCode, step, done, ok, error, at }
  const view = () => (cur ? { who: cur.who, running: !cur.done, url: cur.url, needsCode: cur.needsCode, step: cur.step, done: cur.done, ok: cur.ok, error: cur.error } : null);

  function start(who) {
    const plan = plans[who];
    if (!plan) return { ok: false, error: '모르는 로그인입니다' };
    if (cur && !cur.done) {
      if (cur.who === who) return { ok: true, login: view() };   // 이미 도는 중 — 같은 것을 다시 띄우지 않는다
      stop();
    }
    const me = { who, p: null, out: '', url: '', needsCode: false, step: '', done: false, ok: false, error: '', at: Date.now() };
    cur = me;
    const need = plan.prepare ? plan.prepare() : null;
    if (need && typeof need.then === 'function') {
      // 받는 동안은 «도는 중»이다 — 화면이 2초마다 묻고, 끝나면 그대로 실행기를 띄운다
      me.step = plan.preparing || '';
      need.then(() => { me.step = ''; if (cur === me && !me.done) launch(me, plan); },
        (e) => { Object.assign(me, { step: '', done: true, error: String((e && e.message) || e || '') || '실행기를 준비하지 못했습니다' }); });
      return { ok: true, login: view() };
    }
    const r = launch(me, plan);
    return r.ok ? { ok: true, login: view() } : r;
  }

  function launch(me, plan) {
    const fail = plan.missing || '실행기를 띄우지 못했습니다';
    try {
      me.p = spawnImpl(typeof plan.cli === 'function' ? plan.cli() : plan.cli, plan.args, { env: plan.env || process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      Object.assign(me, { done: true, error: fail });
      return { ok: false, error: me.error };
    }
    const read = (s) => {
      me.out = (me.out + s).slice(-8000);
      if (!me.url) me.url = loginUrlOf(me.out);
      if (/paste (the )?code/i.test(me.out)) me.needsCode = true;
    };
    if (me.p.stdout) { me.p.stdout.setEncoding('utf8'); me.p.stdout.on('data', read); }
    if (me.p.stderr) { me.p.stderr.setEncoding('utf8'); me.p.stderr.on('data', read); }
    if (me.p.stdin) me.p.stdin.on('error', () => {});
    const timer = setTimeout(() => { if (!me.done) { me.error = '10분 안에 끝나지 않아 멈췄습니다 — 다시 눌러 주세요'; try { me.p.kill(); } catch {} } }, timeoutMs);
    if (timer.unref) timer.unref();
    // 실행 파일이 없으면(ENOENT) 'error' 만 오고 'close' 는 오지 않을 수 있다 — 그 자리에서 끝낸다
    me.p.on('error', () => { clearTimeout(timer); Object.assign(me, { done: true, error: me.error || fail }); });
    me.p.on('close', async () => {
      clearTimeout(timer);
      if (me.done) return;   // 이미 'error' 로 끝났다
      let good = false;
      try { good = await check[me.who](); } catch { good = false; }
      Object.assign(me, { done: true, ok: good, error: good ? '' : me.error || '로그인이 끝나지 않았습니다 — 다시 눌러 주세요' });
    });
    return { ok: true };
  }

  // 사람이 브라우저에서 받은 코드를 실행기에 건넨다(Claude 의 «Paste code here»). 글자 · 숫자 · 몇 가지 기호만
  function code(text) {
    const c = String(text || '').trim();
    if (!cur || cur.done || !cur.p || !cur.p.stdin) return { ok: false, error: '돌고 있는 로그인이 없습니다' };
    if (!c || c.length > 2000 || !/^[A-Za-z0-9#._~+\/=-]+$/.test(c)) return { ok: false, error: '코드를 다시 복사해 붙여 넣어 주세요' };
    try { cur.p.stdin.write(c + '\n'); } catch { return { ok: false, error: '실행기에 건네지 못했습니다' }; }
    return { ok: true, login: view() };
  }

  function stop() {
    if (cur && !cur.done && cur.p) { try { cur.p.kill(); } catch {} }
  }

  return { start, code, stop, view };
}
