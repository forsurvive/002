'use strict';

// 화면 밝기 — 기본은 어두운 화면(style.css :root). «밝게» 를 고른 브라우저만 기억해 둔다.
try { if (localStorage.getItem('se-theme') === 'light') document.documentElement.dataset.theme = 'light'; } catch { /* 저장소를 못 쓰면 기본 */ }

// 온라인판의 세 화면이 이 한 파일을 쓴다(<body data-page>로 가른다).
//   school.html  «내 수업»  — 들어가 있는 수업 · 내 수업 작품(열기 · 개인 작품으로 복사) · 수업 현황 · 학생 초대 코드(강사) · 새 수업 코드 넣기
//   account.html «내 계정»  — 새 수업 코드 넣기 · 내 AI 키 · 내 비밀번호 바꾸기(누구나)
//   manage.html «관리»  — 운영자(플랫폼 관리자)와 기관 관리자만: 기관 · 이용 기간 · 수업 · 초대 · 사용자(비밀번호 재설정 · 내보내기) · 기관 키 · 사용량
// 자유 가입판(S.edition 'open')에는 기관 · 수업 · 초대가 없다 — 그 조각을 그리지 않는다(서버 문도 404, online/edition.mjs).
// 모든 판정은 서버(online/edu.mjs · tenancy)가 한다. 이 화면은 서버가 허락한 것을 보여 줄 뿐이다.
// 학생에게 비용 · 횟수 · 키를 보이지 않는다. 초대 코드는 만든 그 자리에서 한 번만 보인다.

const PAGE = ['manage', 'account'].includes(document.body.dataset.page) ? document.body.dataset.page : 'school';
const S = { me: null, loggedIn: false, orgs: {}, progress: {}, shown: {}, say: '', open: {}, usage: {}, members: {}, wf: {}, wfOpen: {}, invites: {} };

// 브라우저 자동 채움 막기 — 크롬은 autocomplete="off" 를 무시하고 저장된 로그인 아이디를 아무 칸에나 넣는다(2026-10-06 워크스페이스 칸에 아이디가 들어간 일).
// 읽기 전용 칸은 채우지 않으므로, 로그인용(username · current-password · new-password)이 아닌 칸은 누르기 전까지 읽기 전용으로 둔다.
const FILL_OK = ['username', 'current-password', 'new-password'];
function noAutofill(n, attrs) {
  const a = attrs || {};
  if (['hidden', 'checkbox', 'radio', 'file', 'range', 'color'].includes(a.type) || a.readonly || FILL_OK.includes(a.autocomplete)) return;
  n.setAttribute('autocomplete', 'off');
  n.readOnly = true; n.dataset.lock = '1';
  const open = () => { n.readOnly = false; delete n.dataset.lock; };
  n.addEventListener('pointerdown', open);
  n.addEventListener('focus', open);
}
function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const k in attrs || {}) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  if (tag === 'input') noAutofill(n, attrs);
  return n;
}
const $ = (id) => document.getElementById(id);
const val = (id) => ($(id) ? $(id).value.trim() : '');
const day = (t) => (t ? new Date(t).toLocaleDateString() : '');
// 수업 기간은 한국 날짜로 — 끝은 «그날 24시»로 저장되므로 하루 앞을 보인다
const ymd = (t, end) => (t ? new Date(new Date(t).getTime() - (end ? 86400000 : 0)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : '');
const period = (c) => (c.starts_at || c.ends_at ? (ymd(c.starts_at) || '') + ' ~ ' + (ymd(c.ends_at, true) || '') : '');

async function edu(op, body = {}) {
  const r = await fetch('/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...body }) }).catch(() => null);
  const out = r ? await r.json().catch(() => ({ ok: false, error: '응답 없음' })) : { ok: false, error: '연결되지 않습니다' };
  if (out.code === 'gate') location.reload();   // 출입 열쇠는 페이지를 다시 열 때 묻는다
  return out;
}
// 알림 — 잘 된 일은 파랑(good), 막힌 일 · 오류는 빨강(2026-10-05 사용자 지시)
const tell = (text, good = false) => { S.say = text || ''; S.sayGood = good; S.fresh = good; render(); };
const done = (text) => tell(text, true);

// ---------------------------------------------------------------- 불러오기

// 초대 링크를 들고 «내 계정»으로 왔으면(이미 로그인한 사람) 코드를 채워 둔다
{
  const q = new URLSearchParams(location.search);
  S.linkInvite = PAGE === 'account' ? q.get('invite') || '' : '';
  if (S.linkInvite) { history.replaceState(null, '', location.pathname); S.sayGood = true; S.fresh = true; S.say = '초대 링크로 왔습니다 — 아래 «새 수업 코드 넣기»의 [들어가기]를 누르면 지금 계정으로 참여합니다'; }
  // 결제를 마치고 돌아왔으면(그로블 «이동 페이지» = /account.html?paid=1) 웹훅이 닿을 때까지 잠깐 이용권을 다시 본다
  if (PAGE === 'account' && q.has('paid')) { history.replaceState(null, '', location.pathname); S.paidPoll = true; }
  // 구글에서 돌아왔으면(?google=…, 잇기 · 구글로 가입) 알린다 — 주소창에서는 지운다
  S.googleBack = PAGE === 'account' ? q.get('google') || '' : '';
  if (S.googleBack) history.replaceState(null, '', location.pathname);
}
// 구글에서 돌아온 까닭(서버의 ?google=…) → 알림. [잘 됐는가, 문구]
const GOOGLE_SAY = {
  linked: [true, '구글 계정을 이었습니다 — 다음부터 로그인 화면의 [Google 계정으로 계속하기]로 들어옵니다'],
  new: [true, '구글 계정으로 가입했습니다'],
  already: [true, '이미 이 계정에 이어진 구글 계정입니다'],
  taken: [false, '그 구글 계정은 다른 계정에 이어져 있습니다 — 그 계정으로 들어가려면 로그아웃한 뒤 [Google 계정으로 계속하기]'],
  one: [false, '이 계정에는 이미 다른 구글 계정이 이어져 있습니다'],
  cancel: [false, '구글 연결을 그만뒀습니다'],
  state: [false, '다시 시도해 주세요 — 시작한 이 브라우저에서 10분 안에 돌아와야 합니다'],
  expired: [false, '시간이 지났습니다 — 다시 시도해 주세요'],
  failed: [false, '구글과 확인을 마치지 못했습니다 — 잠시 뒤 다시 시도해 주세요'],
  busy: [false, '잠시 뒤에 다시 시도해 주세요'],
};

async function load() {
  const m = await edu('me.memberships');
  S.loggedIn = m.ok === true;
  S.me = m.ok ? m : null;
  S.edition = (m.ok && m.edition) || 'school';
  S.orgs = {};
  const gb = S.me && GOOGLE_SAY[S.googleBack];
  if (gb) { S.say = gb[1] + (S.googleBack === 'new' ? ' — 아이디 ' + S.me.loginId + ' · 비밀번호 없이 구글로 들어옵니다' : ''); S.sayGood = gb[0]; S.fresh = gb[0]; }
  S.googleBack = '';
  if (S.me && PAGE === 'account') S.myKeys = (await edu('me.key.list')).credentials || [];
  if (S.me && PAGE === 'account' && S.edition === 'open') await loadPass();
  if (S.me && S.me.platformAdmin && PAGE === 'account') { const v = await edu('me.sub.view'); S.sub = v.ok ? v : null; }
  if (S.me && PAGE === 'manage') {
    // 관리할 수 있는 기관 — 플랫폼 관리자는 전부, 기관 관리자는 제 기관(서버가 골라 준다)
    const list = S.edition === 'open' ? [] : (await edu('org.list')).organizations || [];
    for (const o of list) {
      const [lic, cls, keys] = await Promise.all([edu('license.read', { orgId: o.id }), edu('class.list', { orgId: o.id }), edu('org.key.list', { orgId: o.id })]);
      S.orgs[o.id] = { org: o, lic, classes: cls.classes || [], keys: keys.credentials || [] };
    }
  }
  render();
}

// ---------------------------------------------------------------- 이용권(자유 가입판) — 내 상태 · 기한 · [결제하기]만(금액 · 매출은 운영 화면에만)

async function loadPass() {
  const r = await edu('me.pass');
  S.pass = r.ok ? r.pass : null;
}
// 결제창(새 탭)에서 돌아오면 이용권을 다시 본다 — 웹훅이 먼저 닿아 있으면 곧바로 바뀐 상태가 보인다
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || PAGE !== 'account' || S.edition !== 'open' || !S.payWait) return;
  const was = !!(S.pass && S.pass.active);
  await loadPass();
  if (!was && S.pass && S.pass.active) { S.payWait = 0; done('이용권이 반영되었습니다'); } else render();
});
// ?paid=1 로 돌아왔을 때 — 3초마다 1분까지
async function pollPaid() {
  S.paidPoll = false;
  if (!S.pass || S.pass.active) return;
  S.say = '결제를 확인하는 중…'; S.sayGood = true; render();
  for (let i = 0; i < 20 && S.pass && !S.pass.active; i++) { await new Promise((r) => setTimeout(r, 3000)); await loadPass(); }
  if (S.pass && S.pass.active) done('이용권이 반영되었습니다');
  else tell('결제 소식이 아직 닿지 않았습니다 — 잠시 뒤 새로 고침해 주세요(오래 걸리면 운영자에게 문의)');
}

const kday = (t) => (t ? new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : '');
function passLine(v) {
  if (v.operator) return { good: true, text: '운영자 — 이용권 없이 씁니다' };
  if (v.free) return { good: true, text: '무료 이용(운영자가 준 계정)' };
  if (v.status === 'active') {
    if (v.provider === 'groble') return { good: true, text: '이용 중' + (v.nextBillingDate ? ' — 다음 결제일 ' + v.nextBillingDate : '') };
    return { good: true, text: (v.provider === 'trial' ? '무료 체험 — ' : '이용 중 — ') + kday(v.paidUntil) + '까지' };
  }
  if (v.status === 'cancel_pending') return { good: true, text: '해지 예정 — ' + kday(v.serviceEndsAt) + '까지 쓰고 그 뒤 끝납니다' };
  if (v.status === 'past_due') return { good: false, text: '결제가 실패했어요 — 카드를 확인해 주세요(그로블). ' + kday(v.paidUntil) + '까지는 그대로 씁니다' + (v.finalFailure ? ' · 마지막 재시도도 실패했습니다' : '') };
  if (v.status === 'ended') return { good: v.active, text: v.active ? '해지됨 — ' + kday(v.paidUntil) + '까지 씁니다' : '이용권이 끝났습니다' };
  return { good: false, text: '이용권이 없습니다' };
}
function passBox() {
  const v = S.pass;
  if (S.edition !== 'open' || !v) return null;
  if (S.paidPoll) setTimeout(pollPaid, 0);
  const line = passLine(v);
  // 이미 그로블 정기결제로 쓰는 중이면 [결제하기]를 세우지 않는다(두 번 결제하지 않게). 결제 실패는 카드를 고치면 그로블이 다시 시도한다.
  const canPay = !v.operator && !v.free && !(v.status === 'active' && v.provider === 'groble') && !(v.status === 'past_due' && !v.finalFailure);
  const pay = async (plan) => {
    // 새 탭은 누른 그 순간에 연다(기다린 뒤에 열면 팝업 막기에 걸린다) — 링크를 받으면 그 탭을 결제창으로
    const w = window.open('about:blank', '_blank');
    const r = await edu('me.pass.checkout', { planId: plan.id });
    if (!r.ok) { if (w) w.close(); return tell(r.error); }
    S.payWait = Date.now();
    if (w) { w.opener = null; w.location.href = r.url; } else location.href = r.url;
    done('결제창을 열었습니다 — 결제를 마치고 이 화면으로 돌아오면 이용권이 보입니다');
  };
  // 환불 · 구독 취소(§4-8) — 구독 시작 뒤 기간 안에는 [환불 요청], 지나면 [구독 취소]. 둘 다 이유를 먼저 묻고(서버가 다시 판정한다)
  // 운영자에게 메일이 간다. 환불은 받는 순간 이용권이 멈추고, 취소는 지금 결제 기간 끝까지 그대로 쓴다.
  const rf = v.refund; const cn = v.cancel || {};
  const ask = (kind) => () => { S.open.quit = kind; S.quitWhy = ''; S.quitDetail = ''; render(); };
  const refundLine = !rf ? null
    : rf.reason === 'ok' ? (S.open.quit === 'refund' ? quitForm('refund', v) : h('div', { class: 'line', style: 'margin-top:10px;align-items:center' },
      h('span', { class: 'when', text: '환불 가능 — ' + rf.until + '까지(구독 시작 ' + rf.startedOn + (rf.noUse ? ' · AI 작업을 하기 전까지' : '') + ')' }),
      h('button', { class: 'btn-text', text: '환불 요청', onclick: ask('refund') })))
    : rf.reason === 'requested' ? h('div', { class: 'notice', style: 'margin-top:10px', text: '환불 요청됨(' + kday(rf.request.createdAt) + ') — 운영자가 확인한 뒤 결제 취소와 정기결제 해지를 함께 처리합니다' })
    : rf.reason === 'refunded' ? h('div', { class: 'when', style: 'margin-top:10px', text: '환불됐습니다' + (rf.request && !rf.request.cancelled ? ' — 정기결제 해지를 처리하는 중입니다' : '') })
    : rf.reason === 'ai_used' ? h('div', { class: 'when', style: 'margin-top:10px', text: '구독 시작 뒤 AI 작업을 해서 환불 대상이 아닙니다(환불은 구독 시작 후 ' + rf.days + '일 안, AI 작업 전까지)' })
    : null;
  const cancelLine = cn.request ? h('div', { class: cn.request.charged ? 'notice' : 'when', style: 'margin-top:10px', text: cn.request.charged
      ? '구독 취소를 접수한 뒤 결제가 되었습니다 — 운영자가 확인해 처리합니다'
      : '구독 취소 접수됨(' + kday(cn.request.createdAt) + ') — ' + (cn.request.nextBilling ? cn.request.nextBilling + '까지 쓰고, ' : '') + '그 뒤로는 청구되지 않습니다' })
    : cn.can ? (S.open.quit === 'cancel' ? quitForm('cancel', v) : h('div', { class: 'line', style: 'margin-top:10px;align-items:center' },
      h('span', { class: 'when', style: 'flex:1', text: cn.nextBillingDate ? '다음 결제일 ' + cn.nextBillingDate : '' }),
      h('button', { class: 'btn-text', text: '구독 취소', onclick: ask('cancel') })))
    : null;
  return section('이용권',
    h('div', { class: 'notice' + (line.good ? ' good' : ''), text: line.text }),
    refundLine, cancelLine,
    canPay && v.plans.length ? h('div', { class: 'line', style: 'margin-top:10px' },
      v.plans.map((p) => h('button', { class: 'btn-red', text: (v.status === 'cancel_pending' ? '다시 결제하기 — ' : '결제하기 — ') + p.name, onclick: () => pay(p) }))) : null,
    canPay && !v.plans.length ? h('div', { class: 'when', style: 'margin-top:8px', text: '아직 결제를 열지 않았습니다 — 운영자에게 문의해 주세요' }) : null,
    v.operator ? null : h('div', { class: 'when', style: 'margin-top:8px', text: '새 AI 작업은 이용권이 있을 때만 됩니다. 편집 · 열람 · 내보내기는 늘 됩니다. 카드 바꾸기는 그로블에서 합니다.' }));
}

// 이유 묻는 칸 — [환불 요청] · [구독 취소]를 누르면 먼저 연다. 고른 것 · 적은 말은 S 에 두어 다시 그려도 남는다.
function quitForm(kind, v) {
  const refund = kind === 'refund';
  const go = async () => {
    if (!S.quitWhy) return tell('이유를 하나 골라 주세요');
    if (S.quitWhy === 'other' && !String(S.quitDetail || '').trim()) return tell('«기타»를 고르면 이유를 적어 주세요');
    if (refund && !confirm('환불을 요청할까요?\n\n이용권(새 AI 작업)이 바로 멈춥니다. 편집 · 열람 · 내보내기는 그대로입니다.\n운영자가 확인한 뒤 결제 취소와 정기결제 해지를 함께 처리합니다.')) return;
    if (!refund && !confirm('구독을 취소할까요?\n\n지금 결제 기간이 끝날 때까지는 그대로 쓰고, 그 뒤로는 청구되지 않습니다.')) return;
    const r = await edu(refund ? 'me.pass.refund' : 'me.pass.cancel', { reason: S.quitWhy, detail: S.quitDetail || '' });
    if (!r.ok) return tell(r.error);
    S.pass = r.pass; S.open.quit = ''; S.quitWhy = ''; S.quitDetail = '';
    const nb = r.pass.cancel && r.pass.cancel.request ? r.pass.cancel.request.nextBilling : '';
    done(refund ? '환불을 요청했습니다 — 운영자가 확인한 뒤 결제 취소와 정기결제 해지를 함께 처리합니다'
      : '구독 취소를 접수했습니다 — ' + (nb ? nb + '까지 쓰고, ' : '') + '그 뒤로는 청구되지 않습니다');
  };
  return h('div', { class: 'card-box', style: 'margin-top:10px' },
    h('div', { class: 'lab', text: refund ? '환불하시는 이유를 알려 주세요' : '구독을 취소하시는 이유를 알려 주세요' }),
    (v.reasons || []).map((x) => h('label', { style: 'display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer' },
      h('input', { type: 'radio', name: 'quit-why', value: x.code, checked: S.quitWhy === x.code ? 'checked' : null, onchange: () => { S.quitWhy = x.code; } }),
      h('span', { text: x.say }))),
    h('textarea', { id: 'quit-detail', rows: '3', maxlength: '500', placeholder: '더 적고 싶은 것(선택 — «기타»는 꼭)', style: 'width:100%;margin-top:6px', text: S.quitDetail || '',
      oninput: (e) => { S.quitDetail = e.target.value; } }),
    h('div', { class: 'line', style: 'margin-top:10px' },
      h('button', { class: 'btn-red', text: refund ? '환불 요청하기' : '구독 취소하기', onclick: go }),
      h('button', { class: 'btn-text', text: '닫기', onclick: () => { S.open.quit = ''; render(); } })));
}

// ---------------------------------------------------------------- 조각

const field = (label, id, type = 'text', extra = {}) => h('div', { style: 'flex:1;min-width:160px' },
  h('div', { class: 'lab', text: label }), h('input', { id, type, ...extra }));

const section = (title, ...body) => h('div', { class: 'sec' },
  h('div', { class: 'sec-head' }, h('div', { class: 'name', text: title })),
  h('div', { style: 'padding:14px 16px' }, ...body));

// 만든 그 자리에 보이는 것 — 초대는 «링크»가 주인공(누르면 가입 화면이 열린다, 코드는 링크 안에 들어 있다).
// 계정 · 비밀번호(mk-)는 링크로 보내지 않고 글로 보인다.
const codeBox = (key, note) => {
  const v = S.shown[key];
  if (!v) return null;
  if (key.startsWith('mk-')) {
    return h('div', { class: 'line', style: 'margin-top:10px' },
      h('div', { class: 'mark', style: 'font-size:15px;padding:6px 10px', text: v }), copyBtn(v), hideBtn(key), h('div', { class: 'when', text: note || '' }));
  }
  const code = typeof v === 'string' ? v : v.code;
  const who = typeof v === 'string' ? '' : (ROLE_SAY[v.role] || '') + '용 초대 링크' + (v.cls ? ' · ' + v.cls : '');
  return h('div', { style: 'margin-top:10px' },
    // 누구를 부르는 링크인지 먼저 — 잘못 보내지 않게(기관 관리자 링크를 학생에게 보내면 그 사람이 기관 관리자가 된다)
    who ? h('div', { class: 'lab', style: 'margin-bottom:4px;color:var(--ink);font-weight:700', text: who }) : null,
    h('div', { class: 'line' },
      h('div', { class: 'mark', style: 'font-size:13px;padding:6px 10px;word-break:break-all;white-space:normal', text: inviteUrl(code) }),
      linkBtns(inviteUrl(code), '스토리 엔진 ' + (who || '초대')), hideBtn(key)),
    h('div', { class: 'when', text: note || '받은 사람이 누르면 ' + ((typeof v === 'object' && ROLE_SAY[v.role]) || '') + ' 계정 만들기 화면이 열립니다(코드 ' + code + ') · 닫아도 «초대 링크 목록»에서 다시 볼 수 있고, 못 쓰게 하려면 거기서 [취소]' }));
};
// [닫기] — 화면에서 접기만 한다(링크 · 계정은 그대로). 링크를 못 쓰게 하려면 «초대 링크 목록»의 [취소].
const hideBtn = (key) => h('button', { class: 'btn-text', text: '닫기', onclick: () => { delete S.shown[key]; render(); } });
// 링크로 보내기 — 코드를 손으로 옮기지 않게. [링크 복사]는 어디서나, [보내기]는 휴대폰의 공유 창(카카오톡 · 문자 …)이 있을 때만.
const inviteUrl = (code) => location.origin + '/login?invite=' + encodeURIComponent(code);
const resetUrl = (code, loginId) => location.origin + '/login?reset=' + encodeURIComponent(code) + '&id=' + encodeURIComponent(loginId || '');
const linkBtns = (url, title) => [
  h('button', { class: 'btn-text', text: '링크 복사', onclick: async () => {
    try { await navigator.clipboard.writeText(url); done('링크를 복사했습니다 — 카카오톡 · 문자 · 메일에 붙여 넣어 보내세요'); } catch { tell('복사하지 못했습니다 — ' + url); }
  } }),
  navigator.share ? h('button', { class: 'btn-text', text: '보내기', onclick: () => navigator.share({ title, url }).catch(() => {}) }) : null,
];
// 복사 — 안 되는 브라우저(보안 연결이 아닌 곳 등)에서는 조용히 넘어간다(코드는 화면에 그대로 있다)
const copyBtn = (code) => h('button', { class: 'btn-text', text: '복사', onclick: async () => {
  try { await navigator.clipboard.writeText(code); done('복사했습니다'); } catch { tell('복사하지 못했습니다 — 화면의 코드를 적어 주세요'); }
} });

// 아직 쓸 수 있는 초대 코드 — 열고 닫는다. 코드도 함께 보인다(서버가 봉해 둔 것을 열어 준다 — 옛 코드는 빈칸). 새어 나갔으면 취소한다.
async function toggleInvites(key, orgId) {
  if (S.invites[key]) { delete S.invites[key]; render(); return; }
  const r = await edu('invite.list', { orgId });
  if (!r.ok) return tell(r.error);
  S.invites[key] = r.invites;
  render();
}
function inviteList(key, orgId, classId) {
  const list = S.invites[key];
  const btn = h('button', { class: 'btn-line', text: list ? '초대 링크 목록 닫기' : '초대 링크 목록', onclick: () => toggleInvites(key, orgId) });
  if (!list) return btn;
  const rows = list.filter((x) => !classId || x.classId === classId);
  const revoke = async (x) => {
    if (!confirm('이 초대 링크를 취소할까요? 이미 들어온 사람은 그대로이고, 앞으로 이 링크(코드)로는 들어올 수 없습니다.')) return;
    const r = await edu('invite.revoke', { inviteId: x.id });
    if (!r.ok) return tell(r.error);
    delete S.invites[key];
    await toggleInvites(key, orgId);
  };
  return h('div', { style: 'width:100%' }, btn,
    rows.length ? rows.map((x) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', style: 'font-weight:600', text: (ROLE_SAY[x.role] || x.role) + '용 초대 링크' + (x.className ? ' · ' + x.className : '') }),
      x.code ? linkBtns(inviteUrl(x.code), '스토리 엔진 초대') : h('span', { class: 'when', text: '(다시 보일 수 없는 옛 초대)' }),
      x.code ? h('span', { class: 'when', text: '코드 ' + x.code }) : null,
      h('span', { class: 'mark', text: x.used + ' / ' + x.max + '명' }),
      h('div', { class: 'when', text: '~ ' + day(x.expiresAt) + (x.madeBy ? ' · ' + x.madeBy : '') }),
      h('button', { class: 'btn-text red', text: '취소', onclick: () => revoke(x) })))
      : h('div', { class: 'when', style: 'margin-top:6px', text: '쓸 수 있는 초대 링크가 없습니다' }));
}

async function makeInvite(key, orgId, classId, role) {
  const r = await edu('invite.create', { orgId, classId, role });
  if (!r.ok) return tell(r.error);
  // 누구를 부르는 링크인지 함께 둔다(기관 관리자용 · 강사용 · 학생용 — 어느 수업)
  const cls = classId ? (((S.orgs[orgId] || {}).classes || []).find((c) => c.id === classId) || (S.me && (S.me.classes || []).find((c) => c.id === classId)) || {}).name || '' : '';
  S.shown[key] = { code: r.invite.code, role, cls };
  // 열려 있는 초대 코드 목록에도 새 코드가 서게 다시 받는다
  for (const k of ['o-' + orgId, 'c-' + classId]) if (S.invites[k]) { delete S.invites[k]; await toggleInvites(k, orgId); }
  render();
}

// ---------------------------------------------------------------- 들어오기(초대 코드)

function joinBox() {
  // 로그인한 사람이 새 수업 · 기관에 들어간다 — 지금 계정 그대로(새 계정을 만들지 않는다).
  // 로그인 전에는 서버가 첫 화면(/login)으로 보낸다 — 거기서 코드 · 계정 만들기 · «이미 계정이 있어요».
  const go = async () => {
    const code = val('j-code');
    if (!code) return tell('초대 코드를 넣어 주세요');
    const r = await edu('invite.accept', { code });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.fresh = true; S.say = '들어왔습니다 — «내 수업»에 보입니다';
    await load();
  };
  return section('새 수업 코드 넣기',
    h('div', { class: 'line', style: 'align-items:flex-end' },
      field('초대 코드(초대 링크를 받았으면 링크를 누르면 저절로 채워집니다)', 'j-code', 'text', { placeholder: 'ABCD-EFGH-JKLM', autocapitalize: 'characters', spellcheck: 'false', value: S.linkInvite || '' }),
      h('button', { class: 'btn-red', text: '들어가기', onclick: go })));
}

// ---------------------------------------------------------------- 내 수업

function progressBox(c) {
  const p = S.progress[c.id];
  if (!p) return null;
  const SAY = { queued: '대기', running: '진행 중', paused: '멈춤', waiting_for_user: '멈춤', done: '완료', failed: '실패', cancelled: '중지' };
  const STAGE_SAY = { draft: '초안', approved: '승인', skipped: '건너뜀' };
  return h('div', { style: 'margin-top:10px;width:100%' }, p.students.length
    ? p.students.map((s) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: s.name + (s.projectName ? ' — ' + s.projectName : ' — (아직 작품 없음)') }),
      s.projectId ? h('span', { class: 'mark', text: '문서 ' + s.docs }) : null,
      s.stage ? h('span', { class: 'mark', text: s.stage.title + ' · ' + (STAGE_SAY[s.stage.status] || s.stage.status) }) : null,
      s.lastJob ? h('span', { class: 'mark', text: SAY[s.lastJob] || s.lastJob }) : null,
      h('div', { class: 'when', text: s.updatedAt ? day(s.updatedAt) : '' }),
      s.projectId && p.canRead ? h('a', { class: 'btn-text', href: '/?pid=' + encodeURIComponent(s.projectId), text: '읽기' }) : null,
      h('button', { class: 'btn-text', text: '비밀번호 재설정 코드', onclick: () => giveResetCode(p.class.organizationId, { userId: s.userId, name: s.name, loginId: s.loginId }, () => reloadProgress(c)) }),
      resetLine(s.resetCode, s.loginId),
      s.stage && s.stage.teachingNote ? h('button', { class: 'btn-text', text: '강의 포인트', onclick: () => { S.open['tn-' + s.userId] = !S.open['tn-' + s.userId]; render(); } }) : null,
      S.open['tn-' + s.userId] && s.stage ? h('div', { class: 'when', style: 'width:100%;white-space:normal', text: s.stage.title + ' — ' + s.stage.teachingNote }) : null))
    : h('div', { class: 'when', text: '아직 학생이 없습니다' }));
}

async function reloadProgress(c) {
  const r = await edu('class.progress', { classId: c.id });
  if (r.ok) { S.progress[c.id] = r; render(); }
}
async function showProgress(c) {
  if (S.progress[c.id]) { delete S.progress[c.id]; render(); return; }   // 열려 있으면 닫는다
  const r = await edu('class.progress', { classId: c.id });
  if (!r.ok) return tell(r.error);
  S.progress[c.id] = r;
  render();
}

function myClasses() {
  const list = (S.me && S.me.classes) || [];
  if (!list.length) return null;
  return section('내 수업', list.map((c) => h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' },
    h('div', { class: 'line' },
      h('div', { class: 'name', style: 'font-weight:600;flex:1', text: c.name }),
      h('span', { class: 'mark', text: c.role === 'instructor' ? '강사' : '학생' }),
      c.status !== 'active' ? h('span', { class: 'mark', text: '닫힘' }) : null),
    h('div', { class: 'line', style: 'margin-top:8px' },
      c.role === 'instructor' ? [
        h('button', { class: 'btn-line', text: S.progress[c.id] ? '현황 닫기' : '수업 현황', onclick: () => showProgress(c) }),
        h('button', { class: 'btn-line', text: '학생 초대 링크', onclick: () => makeInvite('s-' + c.id, c.organization_id, c.id, 'student') }),
      ] : null),
    codeBox('s-' + c.id),
    c.role === 'instructor' ? h('div', { style: 'margin-top:8px' }, inviteList('c-' + c.id, c.organization_id, c.id)) : null,
    (c.works || []).map((w) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', style: 'flex:1', text: w.name }),
      h('a', { class: 'btn-text', href: '/?pid=' + encodeURIComponent(w.id), text: '열기' }),
      w.canCopy ? h('button', { class: 'btn-text', text: '개인 작품으로 복사', onclick: () => copyWork(w) }) : null)),
    progressBox(c))));
}

// 수업 작품 → 내 개인 작품(원본은 기관에 그대로). 복사본의 AI 는 내 키로 — 비용은 나에게.
async function copyWork(w) {
  if (!confirm('«' + w.name + '» 을 내 개인 작품으로 복사합니다.\n원본은 수업에 그대로 남고, 복사본에서 쓰는 AI 는 내 AI 키로 돕니다(비용은 본인).')) return;
  const r = await edu('project.copy_personal', { pid: w.id });
  if (!r.ok) return tell(r.error);
  done('복사했습니다 — 작업실의 «' + w.name + ' (개인)»');
}

// AI 회사 — 키를 넣을 때 고른다. 쓸 회사는 키가 있는 회사 가운데 사람(또는 기관 · 작품)이 고른다. 아무도 고르지 않았으면 키가 있는 첫 회사(서버 ai/router.mjs).
const AI_CO = { anthropic: 'Claude', openai: 'ChatGPT', google: 'Gemini' };
// Claude 만 — 워크스페이스에 묶이지 않은 키는 워크스페이스 ID 를 함께 보내야 한다(비우면 보내지 않는다)
const wsField = (k, id) => (provOf(k) === 'anthropic' ? field('워크스페이스 ID(필요할 때만)', id, 'text', { autocomplete: 'off', spellcheck: 'false', placeholder: 'wrkspc_…' }) : null);
const AI_KEY_LABEL = { anthropic: 'Claude(Anthropic) API 키', openai: 'ChatGPT(OpenAI) API 키', google: 'Gemini(Google) API 키' };
S.prov = {};
S.lim = {};
S.dates = {};
S.audit = {};
S.ops = null;
const provOf = (k) => S.prov[k] || 'anthropic';
const providerPick = (k) => h('div', { class: 'line', style: 'margin-top:10px' },
  Object.entries(AI_CO).map(([p, name]) => h('button', { class: provOf(k) === p ? 'btn' : 'btn-line', text: name, onclick: () => { S.prov[k] = p; render(); } })));
// 쓸 AI 회사 고르기 — 키가 없는 회사는 «키 없음»을 단다(골라도 키를 넣기 전에는 «연결 필요»로 멈춘다)
// 키를 넣은 회사만 고른다(서버도 막는다). 처음 넣은 키의 회사가 저절로 기본이 된다.
function aiChoice(label, current, keys, save, allowed) {
  const have = new Set((keys || []).filter((x) => x.status === 'active').map((x) => x.provider));
  const list = Object.entries(AI_CO).filter(([p]) => have.has(p) && (!allowed || allowed.includes(p)));
  return h('div', { style: 'margin-top:12px' },
    h('div', { class: 'lab', text: label }),
    list.length ? h('div', { class: 'line' }, list.map(([p, name]) => h('button', {
      class: (current || list[0][0]) === p ? 'btn' : 'btn-line', text: name, onclick: () => save(p),
    }))) : h('div', { class: 'when', text: '아직 AI 키가 없습니다 — 아래에서 키를 넣으면 그 회사가 기본이 됩니다' }));
}

// 등급 — 화면은 이름만(실제 모델은 회사 · 설정이 정한다). 기관 기본 등급은 새 수업 작품의 시작 등급이 된다.
const TIER_CO = { high_reasoning: 'High Reasoning', balanced: 'Balanced', fast: 'Fast' };
const START_TIERS = ['high_reasoning', 'balanced'];
const limitText = (l) => (l && (l.allowed_providers || l.allowed_model_tiers)
  ? 'AI ' + (l.allowed_providers ? l.allowed_providers.map((p) => AI_CO[p]).join(' · ') : '모두') + ' / 등급 ' + (l.allowed_model_tiers ? l.allowed_model_tiers.map((t) => TIER_CO[t]).join(' · ') : '모두')
  : '');

// 넣어 둔 키 — 회사 · 끝 네 자리 · 확인 상태, 그리고 [연결 확인] [지우기]
const KEY_ERR = { auth: '키가 맞지 않음', credit: '잔액 없음', rate: '요청 많음', model: '모델 표 없음', overloaded: '회사 서버 바쁨', timeout: '응답 늦음', workspace: '워크스페이스 ID 필요', invalid: '요청 거절', other: '서버에 닿지 못함' };
function keyRows(list, op, extra, reload) {
  const live = (list || []).filter((x) => x.status === 'active' || x.status === 'invalid');
  if (!live.length) return h('div', { class: 'when', text: '아직 없습니다' });
  const test = async (x) => {
    done('확인하는 중…');
    const r = await edu(op + '.test', { ...extra, provider: x.provider });
    tell(r.ok ? (AI_CO[x.provider] + ' — ' + r.say) : r.error, !!(r.ok && r.verified));
    await reload();
  };
  const revoke = async (x) => {
    if (!confirm(AI_CO[x.provider] + ' 키를 지울까요? 이 키로 돌던 AI 작업은 «연결 필요»로 멈춥니다.')) return;
    const r = await edu(op + '.revoke', { ...extra, provider: x.provider });
    if (!r.ok) return tell(r.error);
    done('지웠습니다');
    await reload();
  };
  return live.map((x) => h('div', { class: 'row', style: 'cursor:default' },
    h('div', { class: 'name', text: (AI_CO[x.provider] || x.provider) + ' ' + x.keyHint + (x.workspaceId ? ' · ' + x.workspaceId : '') }),
    h('span', { class: 'mark', text: x.status === 'invalid' ? '키가 맞지 않음' : x.lastErrorCode ? (KEY_ERR[x.lastErrorCode] || '연결 안 됨') : x.lastVerifiedAt ? '확인됨 ' + day(x.lastVerifiedAt) : '확인 전' }),
    h('button', { class: 'btn-text', text: '연결 확인', onclick: () => test(x) }),
    h('button', { class: 'btn-text red', text: '지우기', onclick: () => revoke(x) })));
}

// ---------------------------------------------------------------- 내 AI 키(누구나 — 쓰기 전용). 내 개인 작품의 AI 는 이 키로.
// 키 넣기는 클릭 몇 번과 붙여 넣기로 끝난다(2026-10-09 사용자 지시 — docs/OPEN_EDITION.md §4-3):
//   ① [키 만들기 페이지 열기] — 그 회사의 키 화면을 새 탭으로 ② 만든 키를 복사해 [붙여 넣기](또는 칸에 붙여 넣기)
//   ③ 붙여 넣는 순간 회사를 알아보고(키 앞머리) · 저장하고 · 연결을 확인한다. 워크스페이스 ID 는 그 회사가 요구할 때만 칸을 연다.
const KEY_PAGE = {
  anthropic: { url: 'https://platform.claude.com/settings/keys', how: '로그인 → [Create key] → 나온 키 복사' },
  openai: { url: 'https://platform.openai.com/api-keys', how: '로그인 → [Create new secret key] → 나온 키 복사(잔액이 있어야 돕니다)' },
  google: { url: 'https://aistudio.google.com/apikey', how: 'Google 계정으로 로그인 → [API 키 만들기] → 복사' },
};
// 키 앞머리로 회사 알아보기 — Claude sk-ant- · Gemini AIza · ChatGPT sk-
const keyCompany = (key) => (/^sk-ant-/.test(key) ? 'anthropic' : /^AIza/.test(key) ? 'google' : /^sk-/.test(key) ? 'openai' : '');
const cleanPaste = (t) => String(t || '').replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '').replace(/^["'`]+|["'`]+$/g, '');

async function addMyKey(raw) {
  const k = 'mykey';
  const key = cleanPaste(raw);
  if (!key) return tell('키를 붙여 넣어 주세요');
  const guess = keyCompany(key);
  if (guess) S.prov[k] = guess;   // 고른 회사와 달라도 키가 말하는 회사로
  const p = provOf(k);
  const ws = S.keyStep && S.keyStep.ws && $('mk-ws') ? val('mk-ws') : '';
  S.keyStep = { say: AI_CO[p] + ' 키를 저장하고 연결을 확인하는 중…', good: true, ws: !!ws };
  render();
  const r = await edu('me.key.set', { provider: p, apiKey: key, workspaceId: ws });
  if (!r.ok) { S.keyStep = { say: r.error, ws: !!ws }; return render(); }
  if (S.me && r.aiProvider != null) S.me.aiProvider = r.aiProvider;
  const t = await edu('me.key.test', { provider: p });
  S.myKeys = (await edu('me.key.list')).credentials || [];
  if (t.ok && t.verified) {
    if ($('mk-key')) $('mk-key').value = '';
    S.keyStep = { good: true, done: true, say: AI_CO[p] + ' — 연결됩니다. 이제 이 키로 돕니다' + (r.prepRetried ? '(멈춰 있던 자료 분석 ' + r.prepRetried + '건을 다시 겁니다)' : '') };
  } else if (t.ok && t.reason === 'workspace') {
    S.keyStep = { ws: true, say: t.say };   // 키는 칸에 그대로 — 워크스페이스 ID 를 붙여 넣으면 함께 다시 저장한다
  } else {
    if ($('mk-key')) $('mk-key').value = '';
    S.keyStep = { say: AI_CO[p] + ' — ' + (t.ok ? t.say : t.error || '확인하지 못했습니다') + ' · 키를 다시 복사해 붙여 넣어 보세요' };
  }
  render();
}

function keyGuide() {
  const k = 'mykey';
  const have = new Set((S.myKeys || []).filter((x) => x.status === 'active').map((x) => x.provider));
  if (!S.prov[k]) S.prov[k] = Object.keys(AI_CO).find((p) => !have.has(p)) || 'anthropic';
  const p = provOf(k);
  const st = S.keyStep || {};
  // 키가 이미 있으면 접어 둔다 — 새 회사 키 · 바꿀 키가 있을 때만 연다
  if (have.size && !S.open.keyAdd && !st.say) return h('button', { class: 'btn-line', style: 'margin-top:12px', text: '+ 키 넣기 · 바꾸기', onclick: () => { S.open.keyAdd = true; render(); } });
  const pasteBtn = h('button', { class: 'btn-red', text: '붙여 넣기', onclick: async () => {
    let t = '';
    try { t = await navigator.clipboard.readText(); } catch { t = ''; }
    if (!cleanPaste(t)) return tell('복사한 키를 읽지 못했습니다 — 오른쪽 칸을 누르고 붙여 넣어(Ctrl+V · 휴대폰은 길게 눌러) 주세요');
    if ($('mk-key')) $('mk-key').value = cleanPaste(t);
    addMyKey(t);
  } });
  const onPaste = (e) => {
    const t = ((e.clipboardData || window.clipboardData) || { getData: () => '' }).getData('text');
    if (!cleanPaste(t)) return;
    e.preventDefault();
    e.target.value = cleanPaste(t);
    addMyKey(t);
  };
  return h('div', { class: 'card-box', style: 'margin-top:14px' },
    h('div', { class: 'lab', text: '키 넣기 — 회사를 고르고 ①②만 하면 ③은 저절로' }),
    h('div', { class: 'line' }, Object.entries(AI_CO).map(([id, name]) => h('button', { class: p === id ? 'btn' : 'btn-line', text: name + (have.has(id) ? ' ✓' : ''), onclick: () => { S.prov[k] = id; S.keyStep = null; render(); } }))),
    h('div', { class: 'line', style: 'margin-top:8px' },
      h('a', { class: 'btn-line', href: KEY_PAGE[p].url, target: '_blank', rel: 'noopener noreferrer', text: '① ' + AI_CO[p] + ' 키 만들기 페이지 열기 ↗' }),
      h('span', { class: 'when', text: KEY_PAGE[p].how })),
    h('div', { class: 'line', style: 'margin-top:8px;align-items:center' },
      h('span', { class: 'when', text: '②' }), pasteBtn,
      h('input', { id: 'mk-key', type: 'password', spellcheck: 'false', placeholder: '또는 여기에 붙여 넣기', style: 'flex:1;min-width:180px', onpaste: onPaste, onkeydown: (e) => { if (e.key === 'Enter') addMyKey(e.target.value); } }),
      h('button', { class: 'btn-text', text: '저장', onclick: () => addMyKey(val('mk-key')) })),
    st.ws ? h('div', { class: 'line', style: 'margin-top:8px;align-items:center' },
      h('span', { class: 'when', text: '워크스페이스 ID' }),
      h('input', { id: 'mk-ws', type: 'text', spellcheck: 'false', placeholder: 'wrkspc_… 를 붙여 넣기', style: 'flex:1;min-width:180px', onpaste: (e) => { setTimeout(() => addMyKey(val('mk-key')), 0); } }),
      h('button', { class: 'btn-text', text: '다시 저장', onclick: () => addMyKey(val('mk-key')) })) : null,
    h('div', { class: st.say ? 'notice' + (st.good ? ' good' : '') : 'when', style: 'margin-top:8px', text: st.say || '③ 붙여 넣으면 회사를 알아보고 저장 · 연결 확인까지 저절로 합니다' }),
    p === 'google' ? h('div', { class: 'when', style: 'margin-top:4px', text: 'Gemini 는 무료 키로 시작할 수 있습니다 — 무료 등급은 횟수 한도가 있고, 보낸 글이 Google 의 제품 개선에 쓰일 수 있습니다(유료 등급은 쓰지 않습니다).' }) : null,
    have.size ? h('button', { class: 'btn-text', style: 'align-self:flex-start;margin-top:4px', text: '접기', onclick: () => { S.open.keyAdd = false; S.keyStep = null; render(); } }) : null);
}

function myKeyBox() {
  const k = 'mykey';
  if (!S.open[k] && PAGE !== 'account') return h('button', { class: 'btn-text', text: '내 AI 키', onclick: async () => { S.myKeys = (await edu('me.key.list')).credentials || []; S.open[k] = true; render(); } });
  return section('내 AI 키',
    keyRows(S.myKeys, 'me.key', {}, load),
    aiChoice('개인 작품에 쓸 AI 회사(작품마다 설정 탭에서 바꿀 수 있습니다)', (S.me && S.me.aiProvider) || '', S.myKeys, async (p) => {
      const r = await edu('me.ai.set', { provider: p });
      if (!r.ok) return tell(r.error);
      S.me.aiProvider = r.provider; tell(AI_CO[p] + '를 씁니다');
    }),
    keyGuide(),
    h('div', { class: 'when', style: 'margin-top:8px', text: S.edition === 'open' ? '내 작품의 AI 는 이 키로 돌고, 비용은 키 주인(본인)에게 나갑니다. 키는 저장한 뒤 다시 보이지 않습니다. 만 14세 이상만 넣어 주세요.'
      : '내 개인 작품의 AI 는 이 키로 돌고 비용은 키 주인에게 나갑니다. 수업 작품은 기관 키로 돕니다. 만 14세 이상만 넣어 주세요.' }));
}

// ---------------------------------------------------------------- Claude 구독(최상위 운영자만). 켜면 내 개인 작품이 API 키 대신 구독 사용량으로 돈다.
function subBox() {
  const v = S.sub;
  if (!v) return null;
  const flip = async () => {
    const r = await edu('me.sub.set', { on: !v.on });
    if (!r.ok) return tell(r.error);
    v.on = r.on; done(r.on ? 'Claude 구독으로 돕니다 — 내 개인 작품만(기관 · 수업 작품은 그대로 기관 키)' : 'API 키로 돕니다');
  };
  const test = async () => {
    done('확인하는 중…');
    const r = await edu('me.sub.test');
    tell(r.ok ? r.say : r.error, !!(r.ok && r.verified));
  };
  const why = !v.cliFound ? 'Claude Code 실행기가 없습니다 — 업데이트 뒤 다시 실행하면 받아 옵니다'
    : !v.tokenSet ? 'Secrets 에 CLAUDE_CODE_OAUTH_TOKEN 이 없습니다' : '';
  return section('Claude 구독(운영자 전용)',
    h('div', { class: 'line' },
      h('div', { class: 'lab', style: 'margin:0', text: '내 개인 작품을 구독 사용량으로' }),
      h('button', { class: 'tg' + (v.on ? ' on' : ''), onclick: flip }),
      v.available ? h('button', { class: 'btn-text', text: '연결 확인', onclick: test }) : null),
    h('div', { class: 'when', style: 'margin-top:6px', text: why || (v.on ? '켜짐 — 내 개인 작품은 Claude 구독으로 돕니다. 기관 · 수업 작품은 그대로 기관 키입니다.' : '꺼짐 — 내 AI 키로 돕니다') }));
}

// ---------------------------------------------------------------- 사용량(비용을 내는 쪽만 — 서버가 학생 · 강사에게는 내주지 않는다)

async function showUsage(key, orgId) {
  const r = await edu('usage.summary', orgId ? { orgId } : {});
  if (!r.ok) return tell(r.error);
  S.usage[key] = r.usage;
  render();
}
const usageRows = (key) => (S.usage[key] ? h('div', { style: 'margin-top:8px' }, S.usage[key].length
  ? S.usage[key].map((u) => h('div', { class: 'row', style: 'cursor:default' },
    h('div', { class: 'name', text: u.month + ' · ' + u.model_id }),
    h('span', { class: 'mark', text: '호출 ' + u.calls + (u.failed ? ' (실패 ' + u.failed + ')' : '') }),
    // 운영자 구독으로 돈 몫은 돈이 따로 나가지 않는다 — 금액 대신 «구독»
    h('div', { class: 'when', text: '입력 ' + u.input_tokens.toLocaleString() + ' · 출력 ' + u.output_tokens.toLocaleString() + ' 토큰 · ' + (u.subscription ? '구독' + (u.cost_usd ? ' + 추정 $' + u.cost_usd.toFixed(2) : '') : '추정 $' + u.cost_usd.toFixed(2)) })))
  : h('div', { class: 'when', text: '아직 쓴 것이 없습니다' }),
h('div', { class: 'when', style: 'margin-top:6px', text: '금액은 모델 가격표로 낸 추정입니다 — 정확한 청구는 AI 회사의 청구서를 보세요' })) : null);

// ---------------------------------------------------------------- 감사 기록 · 운영 현황(열었다 닫는다)

const ACT = {
  'org.create': '기관 만듦', 'org.settings': '기관 설정', 'org.status': '기관 상태', 'license.issue': '이용 기간 엶', 'license.status': '이용 기간 상태',
  'license.limits': '쓸 수 있는 AI 바꿈', 'class.create': '수업 만듦', 'class.dates': '수업 기간', 'class.archive': '수업 닫음', 'class.reopen': '수업 다시 엶', 'class.assign': '강사 맡김', 'class.unassign': '강사 뺌', 'invite.create': '초대 코드',
  'invite.revoke': '초대 코드 거둠', 'invite.accept': '초대로 들어옴', 'credential.set': 'AI 키 넣음', 'credential.revoke': 'AI 키 지움', 'member.create': '계정 만듦',
  'member.remove': '사용자 뺌', 'member.reset_password': '비밀번호 재설정', 'workflow.save': '단계 고침', 'project.create': '작품 만듦', 'project.delete': '작품 지움',
  'project.copy_personal': '개인 작품으로 복사', 'project.import': '작품 가져옴', 'ai.choose': 'AI 회사 고름', 'auth.login': '로그인', 'auth.login_failed': '로그인 실패', 'auth.google_login': '구글로 로그인', 'auth.google_link': '구글 계정 연결', 'billing.cancel_request': '구독 취소', 'billing.mail_test': '시험 메일', 'billing.mail_resend': '알림 메일 다시 보냄',
  'auth.password_changed': '비밀번호 바꿈', 'user.status': '계정 상태', 'admin.password_reset': '비밀번호 재설정(도구)', 'admin.user_created': '계정 만듦(도구)', 'setup.first_admin': '첫 관리자 만듦',
  'auth.signup': '가입', 'user.reset_code': '비밀번호 재설정 코드', 'billing.extend': '이용 기간 연장', 'billing.end': '이용권 끝냄', 'billing.free': '무료 이용', 'billing.memo': '고객 메모',
  'billing.link': '결제 연결', 'billing.ignore': '결제 무시', 'billing.plan_create': '결제 옵션 넣음', 'billing.plan_update': '결제 옵션 고침', 'billing.rules': '이용 규칙',
  'billing.refund_request': '환불 요청', 'billing.refund_withdraw': '환불 요청 되돌림',
};
const when = (t) => (t ? new Date(t).toLocaleString() : '');
async function toggleAudit(key, orgId) {
  if (S.audit[key]) { delete S.audit[key]; return render(); }
  const r = await edu('audit.list', orgId ? { orgId } : {});
  if (!r.ok) return tell(r.error);
  S.audit[key] = r.entries; render();
}
const auditRows = (key) => (S.audit[key] ? h('div', { style: 'margin-top:8px' }, h('div', { class: 'lab', text: '감사 기록(최근 50)' }), S.audit[key].length
  ? S.audit[key].map((a) => h('div', { class: 'row', style: 'cursor:default' },
    h('div', { class: 'name', text: (ACT[a.action] || a.action) + (a.org_name ? ' · ' + a.org_name : '') }),
    h('span', { class: 'mark', text: a.actor || '-' }),
    h('div', { class: 'when', text: when(a.at) })))
  : h('div', { class: 'when', text: '아직 없습니다' })) : null);

async function toggleOps() {
  if (S.ops) { S.ops = null; return render(); }
  const r = await edu('ops.overview');
  if (!r.ok) return tell(r.error);
  S.ops = r; render();
}
const JOB_ST = { queued: '대기', running: '도는 중', paused: '멈춤', waiting_for_user: '답 기다림', done: '끝남', failed: '실패', cancelled: '취소' };
function opsBox() {
  const o = S.ops;
  if (!o) return null;
  return h('div', { style: 'margin-top:8px' },
    h('div', { class: 'lab', text: '작업(진행 중 + 지난 24시간)' }),
    h('div', { class: 'line' }, o.jobs.length ? o.jobs.map((j) => h('span', { class: 'mark', text: (JOB_ST[j.status] || j.status) + ' ' + j.n })) : h('span', { class: 'when', text: '없음' }),
      o.stuck ? h('span', { class: 'mark', style: 'color:var(--red)', text: '응답 없는 작업 ' + o.stuck }) : null),
    h('div', { class: 'lab', style: 'margin-top:12px', text: '최근 실패한 작업' }),
    o.failures.length ? o.failures.map((f) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: (f.error_message_safe || f.error_code || '실패') + ' · ' + f.kind }),
      h('span', { class: 'mark', text: (f.org_name || '개인') + ' · ' + (f.login_id || '-') }),
      h('div', { class: 'when', text: when(f.at) }))) : h('div', { class: 'when', text: '없음' }),
    h('div', { class: 'lab', style: 'margin-top:12px', text: 'AI 호출(지난 24시간)' }),
    o.calls.length ? h('div', { class: 'line' }, o.calls.map((c) => h('span', { class: 'mark', text: (c.provider || '-') + ' · ' + (c.status === 'succeeded' ? '성공' : c.error_code || c.status) + ' ' + c.n })))
      : h('div', { class: 'when', text: '없음' }),
    h('div', { class: 'lab', style: 'margin-top:12px', text: '사용량(최근 석 달 · 추정)' }),
    o.usage.length ? o.usage.map((u) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: u.month + ' · ' + u.who }),
      h('span', { class: 'mark', text: (u.payer === 'organization' ? '기관 키' : u.payer === 'user' ? '개인 키' : u.payer || '-') + ' · 호출 ' + u.calls }),
      h('div', { class: 'when', text: '$' + u.cost_usd.toFixed(2) }))) : h('div', { class: 'when', text: '없음' }));
}

// ---------------------------------------------------------------- 기관 관리

// ---------------------------------------------------------------- 기관 관리 — 상태 카드 하나 + 탭 넷(수업 · 사용자 · AI · 설정)
// 한 눈에: 맨 위 카드가 «지금 이 기관이 돌아가는가»(이용 기간 · AI 키 · 시작 등급)를 보이고, 빠진 것은 붉게 짚어 그 탭으로 데려간다.

const liveOf = (orgId) => ((S.orgs[orgId] && S.orgs[orgId].lic || {}).licenses || []).find((l) => l.status === 'active' && (!l.ends_at || new Date(l.ends_at) > new Date()));
const pausedLic = (orgId) => ((S.orgs[orgId] && S.orgs[orgId].lic || {}).licenses || []).find((l) => l.status === 'suspended' && (!l.ends_at || new Date(l.ends_at) > new Date()));
const keyedOf = (keys) => [...new Set((keys || []).filter((x) => x.status === 'active').map((x) => x.provider))];
const tabRow = (list, cur, pick) => h('div', { class: 'line', style: 'margin:4px 0 14px' },
  list.map(([k, name]) => h('button', { class: cur === k ? 'btn' : 'btn-line', text: name, onclick: () => pick(k) })));
const toggleRow = (label, on, flip, note) => h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' },
  h('div', { class: 'line' }, h('div', { class: 'name', style: 'flex:1', text: label }), flip ? h('button', { class: 'tg' + (on ? ' on' : ''), onclick: flip }) : h('span', { class: 'mark', text: on ? '켜짐' : '꺼짐' })),
  note ? h('div', { class: 'when', style: 'margin-top:2px', text: note }) : null);
S.orgTab = {};   // 기관마다 지금 탭(S.sub 는 운영자 구독 형편 — 이름이 겹쳐 보통 사람에게도 구독 상자가 섰다)

function orgView(id) {
  const o = S.orgs[id];
  // 처음 열 때 — AI 키가 없으면 [AI] 부터(그것 없이는 학생 작업이 돌지 않는다), 있으면 [수업]
  const tab = S.orgTab[id] || (keyedOf(o.keys).length ? '수업' : 'AI');
  const go = (t) => { S.orgTab[id] = t; S.say = ''; render(); };   // 다른 탭으로 가면 앞 탭의 알림은 걷는다
  return h('div', null,
    orgCard(id, go),
    tabRow([['수업', '수업'], ['사용자', '사용자'], ['AI', 'AI'], ['설정', '설정']], tab, go),
    tab === '수업' ? classesTab(id) : tab === '사용자' ? usersTab(id) : tab === 'AI' ? aiTab(id) : settingsTab(id));
}

// 상태 카드 — 이용 기간 · AI · 시작 등급. 빠진 것은 붉게, 누르면 고칠 자리로.
function orgCard(id, go) {
  const { org, lic, keys } = S.orgs[id];
  const live = liveOf(id);
  const keyed = keyedOf(keys);
  const prov = (org.settings && org.settings.ai_provider) || '';
  const tier = (org.settings && org.settings.ai_tier) || 'balanced';
  const item = (label, text, bad, onclick) => h('div', { style: 'min-width:150px;flex:1;cursor:' + (onclick ? 'pointer' : 'default'), onclick },
    h('div', { class: 'lab', text: label }),
    h('div', { style: 'font-weight:600' + (bad ? ';color:var(--red)' : ''), text }));
  return h('div', { class: 'card-box', style: 'margin-bottom:14px' },
    h('div', { class: 'line', style: 'margin-bottom:8px' },
      h('div', { class: 'name', style: 'flex:1;font-size:18px;font-weight:700', text: org.name }),
      org.status !== 'active' ? h('span', { class: 'mark', style: 'color:var(--red)', text: '멈춤' }) : null),
    h('div', { class: 'line', style: 'align-items:flex-start' },
      item('이용 기간', live ? '~ ' + (live.ends_at ? day(live.ends_at) : '기한 없음') + ' · 학생 ' + (lic.seatsUsed || 0) + (live.seat_limit ? '/' + live.seat_limit : '') : '없음 — ' + (S.me.platformAdmin ? '아래에서 여세요' : '운영자에게 요청'), !live),
      item('AI', keyed.length ? (AI_CO[prov] || AI_CO[keyed[0]]) + ' 사용' : '키 없음 — 넣기', !keyed.length, () => go('AI')),
      item('새 수업 작품 시작 등급', TIER_CO[tier], false, () => go('AI'))),
    // 운영자가 쓸 수 있는 AI 를 줄여 두었으면 — 기관 관리자도 알 수 있게
    live && limitText(live) ? h('div', { class: 'when', style: 'margin-top:8px', text: '쓸 수 있는 AI(운영자가 정함): ' + limitText(live) }) : null,
    S.me.platformAdmin ? operatorRow(id) : null);
}

// 운영자만 — 이용 기간(기본값 90일 · 40자리 · 범위 모두) · 범위 · 멈추기
function operatorRow(id) {
  const { org } = S.orgs[id];
  const live = liveOf(id); const paused = pausedLic(id);
  const k = 'lic-' + id;
  if (!S.lim[id]) { const l = live || {}; S.lim[id] = { p: [...(l.allowed_providers || [])], t: [...(l.allowed_model_tiers || [])] }; }
  const lim = S.lim[id];
  const flip = (xs, x) => { const i = xs.indexOf(x); if (i < 0) xs.push(x); else xs.splice(i, 1); render(); };
  const issue = async () => {
    const days = Number(val('ld-' + id)) || 90;
    if (live && !confirm('이미 이용 기간이 있습니다. 오늘부터 ' + days + '일짜리 이용 기간을 새로 열까요?')) return;
    const r = await edu('license.issue', { orgId: id, days, seatLimit: Number(val('ls-' + id)) || null, allowedProviders: lim.p, allowedTiers: lim.t });
    if (!r.ok) return tell(r.error);
    S.open[k] = false;
    S.sayGood = true; S.fresh = true; S.say = org.name + ' — 이용 기간을 열었습니다(~ ' + day(r.license.ends_at) + ' · 학생 ' + (r.license.seat_limit || '제한 없음') + '자리)';
    await load();
  };
  const saveLimits = async () => {
    const r = await edu('license.limits', { licenseId: live.id, allowedProviders: lim.p, allowedTiers: lim.t });
    if (!r.ok) return tell(r.error);
    const names = (xs, map) => (xs.length ? xs.map((x) => map[x]).join(' · ') : '모두');
    S.open[k] = false; S.sayGood = true; S.fresh = true; S.say = org.name + '이(가) 쓸 수 있는 AI 를 바꿨습니다 — 회사: ' + names(lim.p, AI_CO) + ' / 등급: ' + names(lim.t, TIER_CO); await load();
  };
  const orgStatus = async () => {
    const to = org.status === 'active' ? 'suspended' : 'active';
    if (to === 'suspended' && !confirm(org.name + ' — 기관 이용을 멈출까요? 새 작품 · AI 작업이 서지 않습니다(작품은 그대로).')) return;
    const r = await edu('org.status', { orgId: id, status: to });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.fresh = true; S.say = org.name + (to === 'active' ? ' — 다시 열었습니다' : ' — 멈췄습니다'); await load();
  };
  const licStatus = async (l, to) => {
    if (to === 'suspended' && !confirm('이용 기간을 멈출까요? 새 작품 · AI 작업이 서지 않습니다.')) return;
    const r = await edu('license.status', { licenseId: l.id, status: to });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.fresh = true; S.say = org.name + ' 이용 기간 — ' + (to === 'active' ? '다시 열었습니다' : '멈췄습니다'); await load();
  };
  const chip = (xs, x, name) => h('button', { class: xs.includes(x) ? 'btn' : 'btn-line', text: name, onclick: () => flip(xs, x) });
  return h('div', { style: 'margin-top:12px;padding-top:10px;border-top:1px solid var(--line-soft)' },
    h('div', { class: 'line' },
      h('span', { class: 'when', text: '운영자' }),
      h('button', { class: 'btn-line', text: S.open[k] ? '닫기' : live ? '이용 기간 · 쓸 수 있는 AI' : '이용 기간 열기', onclick: () => { S.open[k] = !S.open[k]; render(); } }),
      live ? h('button', { class: 'btn-text red', text: '이용 기간 멈추기', onclick: () => licStatus(live, 'suspended') })
        : paused ? h('button', { class: 'btn-text', text: '이용 기간 다시 열기', onclick: () => licStatus(paused, 'active') }) : null,
      h('button', { class: 'btn-text' + (org.status === 'active' ? ' red' : ''), text: org.status === 'active' ? '기관 멈추기' : '기관 다시 열기', onclick: orgStatus })),
    S.open[k] ? h('div', { style: 'margin-top:10px' },
      h('div', { class: 'lab', text: '이 기관이 쓸 수 있는 AI 회사 · 등급 — 고른 것만 쓴다(아무것도 고르지 않으면 모두). 비싼 등급을 막거나 계약한 회사만 쓰게 할 때' }),
      h('div', { class: 'line' }, Object.entries(AI_CO).map(([p, n]) => chip(lim.p, p, n)), h('span', { class: 'when', text: '·' }), Object.entries(TIER_CO).map(([t, n]) => chip(lim.t, t, n))),
      live ? h('div', { class: 'line', style: 'margin-top:6px' }, h('button', { class: 'btn-line', text: '이대로 적용', onclick: saveLimits })) : null,
      h('div', { class: 'line', style: 'margin-top:10px;align-items:flex-end' },
        field('이용 일수', 'ld-' + id, 'text', { value: '90' }), field('학생 자리', 'ls-' + id, 'text', { value: '40' }),
        h('button', { class: 'btn-red', text: live ? '새 이용 기간 열기' : '이용 기간 열기', onclick: issue }))) : null);
}

// 맡은 강사 — 그 기관의 강사 가운데 골라 [넣기], 맡은 사람 옆 [빼기](그 수업에서만 빠진다). 링크 없이 관리자가 바로 정한다.
S.cinst = {};
async function loadClassInstructors(c) {
  const r = await edu('class.instructors', { classId: c.id });
  if (!r.ok) return tell(r.error);
  S.cinst[c.id] = r.instructors; render();
}
function classInstructors(c, orgId) {
  const list = S.cinst[c.id];
  if (!list) { S.cinst[c.id] = []; loadClassInstructors(c); return null; }
  const assign = async (x, on) => {
    if (!on && !confirm((x.name || x.loginId) + ' 강사를 «' + c.name + '» 수업에서 뺄까요? 기관 · 다른 수업에는 그대로 남습니다.')) return;
    const r = await edu('class.assign', { classId: c.id, userId: x.userId, on });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.fresh = true; S.say = (x.name || x.loginId) + ' — «' + c.name + '» ' + (on ? '수업을 맡겼습니다' : '수업에서 뺐습니다');
    await loadClassInstructors(c);
  };
  const mine = list.filter((x) => x.assigned); const rest = list.filter((x) => !x.assigned);
  return h('div', { style: 'width:100%;margin-top:8px' },
    h('div', { class: 'lab', text: '맡은 강사' }),
    mine.length ? h('div', { class: 'line' }, mine.map((x) => h('span', { class: 'chip' }, h('span', { text: x.name + ' · ' + x.loginId }), h('button', { text: '×', title: '이 수업에서 빼기', onclick: () => assign(x, false) }))))
      : h('div', { class: 'when', text: '아직 없습니다' }),
    rest.length ? h('div', { class: 'line', style: 'margin-top:6px' }, h('span', { class: 'when', text: '넣기:' }),
      rest.map((x) => h('button', { class: 'btn-line', text: '+ ' + x.name, onclick: () => assign(x, true) })))
      : list.length ? null : h('div', { class: 'when', text: '이 기관에 강사가 없습니다 — [사용자] 탭의 [+ 강사 초대 링크]로 먼저 부르세요' }));
}

// 수업 — 한 줄에 이름 · 기간 · 학생 수와 자주 쓰는 둘(학생 초대 코드 · 현황). 나머지는 [더보기].
function classesTab(id) {
  const { classes } = S.orgs[id];
  const nk = 'nc-open-' + id;
  const addClass = async () => {
    const r = await edu('class.create', { orgId: id, name: val('nc-' + id), startsAt: val('ncs-' + id), endsAt: val('nce-' + id) });
    if (!r.ok) return tell(r.error);
    S.open[nk] = false; S.sayGood = true; S.fresh = true; S.say = '«' + r.class.name + '» 수업을 만들었습니다 — [학생 초대 링크]를 보내 학생을 부르세요'; await load();
  };
  const saveDates = async (c) => {
    const r = await edu('class.dates', { classId: c.id, startsAt: val('cds-' + c.id), endsAt: val('cde-' + c.id) });
    if (!r.ok) return tell(r.error);
    S.dates[c.id] = false; S.sayGood = true; S.fresh = true; S.say = '수업 기간을 바꿨습니다'; await load();
  };
  const archive = async (c) => {
    const closing = c.status === 'active';
    if (closing && !confirm('«' + c.name + '» 수업을 닫을까요?\n닫으면 이 수업에 새 작품을 만들거나 초대 링크로 새로 들어올 수 없습니다.\n이미 든 학생과 작품은 그대로 남고, «다시 열기»로 되돌릴 수 있습니다.')) return;
    const r = await edu('class.archive', { classId: c.id, reopen: !closing });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.fresh = true; S.say = '«' + c.name + '» ' + (closing ? '수업을 닫았습니다' : '수업을 다시 열었습니다'); await load();
  };
  const sorted = [...classes].sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1));
  return h('div', null,
    S.open[nk] ? h('div', { class: 'card-box', style: 'margin-bottom:12px' },
      h('div', { class: 'line', style: 'align-items:flex-end' }, field('수업 이름', 'nc-' + id),
        field('시작하는 날(선택)', 'ncs-' + id, 'date'), field('끝나는 날(선택)', 'nce-' + id, 'date')),
      h('div', { class: 'line', style: 'margin-top:10px' }, h('button', { class: 'btn-red', text: '만들기', onclick: addClass }),
        h('button', { class: 'btn-text', text: '취소', onclick: () => { S.open[nk] = false; render(); } })))
      : h('button', { class: 'btn', style: 'margin-bottom:12px', text: '+ 새 수업', onclick: () => { S.open[nk] = true; render(); } }),
    sorted.length ? sorted.map((c) => {
      const more = S.open['more-' + c.id];
      return h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' + (c.status === 'active' ? '' : ';opacity:.6') },
        h('div', { class: 'line' },
          h('div', { class: 'name', style: 'flex:1;font-weight:600', text: c.name + (c.status === 'active' ? '' : ' (닫힘)') }),
          period(c) ? h('span', { class: 'when', text: period(c) }) : null,
          h('span', { class: 'mark', text: '학생 ' + (c.students || 0) }),
          c.status === 'active' ? h('button', { class: 'btn-text', text: '학생 초대 링크', onclick: () => makeInvite('s-' + c.id, id, c.id, 'student') }) : null,
          h('button', { class: 'btn-text', text: S.progress[c.id] ? '현황 닫기' : '현황', onclick: () => showProgress(c) }),
          h('button', { class: 'btn-text', text: more ? '접기' : '더보기', onclick: () => { S.open['more-' + c.id] = !more; if (!more) delete S.cinst[c.id]; render(); } })),
        more ? h('div', { class: 'line', style: 'margin-top:6px' },
          c.status === 'active' ? h('button', { class: 'btn-line', text: '강사 초대 링크', onclick: () => makeInvite('i-' + c.id, id, c.id, 'instructor') }) : null,
          h('button', { class: 'btn-line', text: S.dates[c.id] ? '기간 닫기' : '수업 기간', onclick: () => { S.dates[c.id] = !S.dates[c.id]; render(); } }),
          inviteList('c-' + c.id, id, c.id),
          classInstructors(c, id),
          h('button', { class: 'btn-text' + (c.status === 'active' ? ' red' : ''), text: c.status === 'active' ? '수업 닫기' : '다시 열기', onclick: () => archive(c) })) : null,
        S.dates[c.id] ? h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
          field('시작하는 날', 'cds-' + c.id, 'date', { value: ymd(c.starts_at) }), field('끝나는 날', 'cde-' + c.id, 'date', { value: ymd(c.ends_at, true) }),
          h('button', { class: 'btn-line', text: '저장', onclick: () => saveDates(c) })) : null,
        codeBox('s-' + c.id), codeBox('i-' + c.id), progressBox(c));
    }) : h('div', { class: 'when', text: '아직 수업이 없습니다 — [+ 새 수업]으로 만드세요' }));
}

// 사용자 — 목록은 열면 바로 보인다. 학생은 수업의 초대 코드로, 강사 · 기관 관리자는 여기서.
function usersTab(id) {
  if (!S.members[id] && !S.open['ml-' + id]) { S.open['ml-' + id] = true; showMembers(id).finally(() => { S.open['ml-' + id] = false; }); }
  return h('div', null,
    // 사람을 부르는 길은 초대 코드(본인이 비밀번호를 정한다). 운영자만 계정을 직접 만든다.
    h('div', { class: 'line', style: 'margin-bottom:10px' },
      h('button', { class: 'btn-line', text: '+ 강사 초대 링크', onclick: () => makeInvite('ti-' + id, id, null, 'instructor') }),
      h('button', { class: 'btn-line', text: '+ 기관 관리자 초대 링크', onclick: () => makeInvite('a-' + id, id, null, 'organization_admin') })),
    codeBox('ti-' + id), codeBox('a-' + id),
    makeMemberBox(id),
    codeBox('mk-' + id, '아이디 / 비밀번호 — 본인에게 전해 주세요(본인이 바꾸기 전까지 아래 목록에서도 다시 보입니다)'),
    S.members[id] ? membersBox(id, { fixed: true }) : h('div', { class: 'when', text: '불러오는 중…' }),
    h('div', { style: 'margin-top:14px' }, inviteList('o-' + id, id, null)));
}

// AI — ① 쓰는 회사(키가 있는 회사만) ② 키 ③ 시작 등급(기본 Balanced) ④ 사용량
function aiTab(id) {
  const { org, keys } = S.orgs[id];
  const live = liveOf(id);
  const keyed = keyedOf(keys).filter((p) => !(live && live.allowed_providers) || live.allowed_providers.includes(p));
  const prov = (org.settings && org.settings.ai_provider) || '';
  const tier = (org.settings && org.settings.ai_tier) || 'balanced';
  const kk = 'ok-' + id;
  const saveKey = async () => {
    const r = await edu('org.key.set', { orgId: id, provider: provOf(kk), apiKey: val(kk), workspaceId: $(kk + '-ws') ? val(kk + '-ws') : '' });
    if ($(kk)) $(kk).value = '';
    if (!r.ok) return tell(r.error);
    S.open['addkey-' + id] = false;
    S.sayGood = true; S.fresh = true; S.say = AI_CO[provOf(kk)] + ' 키를 저장했습니다(다시 보이지 않습니다) — [연결 확인]으로 확인해 보세요';
    await load();
  };
  const tiers = START_TIERS.filter((t) => !(live && live.allowed_model_tiers) || live.allowed_model_tiers.includes(t));
  return h('div', null,
    h('div', { class: 'lab', text: '이 기관 작품에 쓰는 AI' }),
    keyed.length ? h('div', { class: 'line' }, keyed.map((p) => h('button', {
      class: (prov || keyed[0]) === p ? 'btn' : 'btn-line', text: AI_CO[p],
      onclick: async () => { const r = await edu('org.settings', { orgId: id, aiProvider: p }); if (!r.ok) return tell(r.error); S.sayGood = true; S.fresh = true; S.say = AI_CO[p] + '를 씁니다'; await load(); },
    }))) : h('div', { class: 'notice', text: '아직 AI 키가 없습니다 — 아래에서 키를 넣으면 그 회사가 기본이 됩니다' }),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '키(학생 작업이 이 키로 돕니다 · 다시 보이지 않습니다)' }),
    keyRows(keys, 'org.key', { orgId: id }, load),
    S.open['addkey-' + id] ? h('div', { class: 'card-box', style: 'margin-top:8px' },
      providerPick(kk),
      h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
        field(AI_KEY_LABEL[provOf(kk)], kk, 'password', { autocomplete: 'off', spellcheck: 'false' }),
        wsField(kk, kk + '-ws'),
        h('button', { class: 'btn-red', text: '저장', onclick: saveKey }),
        h('button', { class: 'btn-text', text: '취소', onclick: () => { S.open['addkey-' + id] = false; render(); } })))
      : h('button', { class: 'btn-line', style: 'margin-top:8px', text: '+ 키 넣기', onclick: () => { S.open['addkey-' + id] = true; render(); } }),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '새 수업 작품의 시작 등급(학생이 작품마다 바꿀 수 있습니다)' }),
    h('div', { class: 'line' }, tiers.map((t) => h('button', {
      class: tier === t ? 'btn' : 'btn-line', text: TIER_CO[t] + (t === 'balanced' ? ' (기본)' : ''),
      onclick: async () => { const r = await edu('org.settings', { orgId: id, aiTier: t }); if (!r.ok) return tell(r.error); S.sayGood = true; S.fresh = true; S.say = TIER_CO[t] + '로 시작합니다'; await load(); },
    }))),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '사용량(이 기관 키)' }),
    S.usage['o-' + id] ? h('button', { class: 'btn-line', text: '사용량 닫기', onclick: () => { delete S.usage['o-' + id]; render(); } })
      : h('button', { class: 'btn-line', text: '사용량 보기', onclick: () => showUsage('o-' + id, id) }),
    usageRows('o-' + id));
}

// 설정 — 켜고 끄기(기본값이 적혀 있다) · 단계와 강의 카드 · 감사 기록
function settingsTab(id) {
  const { org } = S.orgs[id];
  const st = org.settings || {};
  const set = (patch) => async () => { const r = await edu('org.settings', { orgId: id, ...patch }); if (!r.ok) return tell(r.error); await load(); };
  const readable = !!st.admin_can_read_projects;
  return h('div', null,
    toggleRow('학생에게 작업 중 강의 카드 보이기', st.student_cards !== false, set({ studentCards: st.student_cards === false }), '기본: 켬'),
    toggleRow('학생이 수업 작품을 개인 작품으로 복사해 갈 수 있게', st.allow_copy !== false, set({ allowCopy: st.allow_copy === false }), '기본: 켬 — 복사본의 AI 는 학생 본인의 키로 돕니다'),
    toggleRow('기관 관리자가 학생 작품을 읽을 수 있게', readable, S.me.platformAdmin ? set({ adminCanReadProjects: !readable }) : null, '기본: 끔 — 최상위 관리자만 바꿉니다'),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '단계 · 강의 카드 고쳐 쓰기(이 기관만 — 원문은 남습니다)' }),
    wfEditor(id),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '감사 기록(누가 무엇을 바꿨나)' }),
    h('button', { class: 'btn-line', text: S.audit['o-' + id] ? '감사 기록 닫기' : '감사 기록 보기', onclick: () => toggleAudit('o-' + id, id) }),
    auditRows('o-' + id));
}

// ---------------------------------------------------------------- 사용자(기관 관리자) — 한 사람 한 계정

async function showMembers(orgId) {
  const r = await edu('org.members', { orgId });
  if (!r.ok) return tell(r.error);
  S.members[orgId] = r.members;
  render();
}
const ROLE_SAY = { organization_admin: '기관 관리자', instructor: '강사', student: '학생' };

// 아이디 칸 — 치는 동안 쓸 수 있는지 미리 본다(잠깐 멈추면 묻는다). 만들 때도 서버가 다시 막는다.
function wireIdCheck(id, extra = () => ({})) {
  const n = $(id);
  if (!n || n.dataset.wired) return;
  n.dataset.wired = '1';
  const say = h('div', { class: 'when', style: 'margin-top:4px;min-height:18px' });
  n.after(say);
  let t = 0;
  n.addEventListener('input', () => {
    clearTimeout(t);
    say.textContent = '';
    const v = n.value.trim();
    if (!v) return;
    t = setTimeout(async () => {
      const r = await fetch('/api/edu', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'login.available', loginId: v, ...extra() }) }).catch(() => null);
      const out = r ? await r.json().catch(() => ({})) : {};
      if (n.value.trim() !== v) return;   // 그 사이 더 쳤다
      say.textContent = out.ok ? out.say : '';
      say.className = out.ok && !out.available ? 'notice' : 'when';
    }, 400);
  });
}

// 계정 직접 만들기 — 최상위 관리자만(기관 관리자 · 강사 · 학생). 비밀번호는 운영자가 정한다(기술 지원용) — [자동으로]는 칸에 지어 넣어 보이게 한다.
// 기관 관리자 · 강사는 초대 코드로 사람을 부른다(이 상자는 보이지 않는다).
function makeMemberBox(orgId) {
  if (!S.me || !S.me.platformAdmin) return null;
  const k = 'mk-' + orgId;
  const o = S.orgs[orgId];
  const st = S.open[k];
  if (!st) return h('button', { class: 'btn-line', text: '+ 계정 직접 만들기', onclick: () => { S.open[k] = { role: 'instructor', classId: '' }; render(); } });
  const pick = (patch) => { Object.assign(st, patch); render(); };
  setTimeout(() => wireIdCheck(k + '-id'), 0);   // 그리기가 끝난 뒤
  const gen = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const r = crypto.getRandomValues(new Uint8Array(12)); $(k + '-pw').value = [...r].map((x, i) => (i && i % 4 === 0 ? '-' : '') + a[x % a.length]).join(''); $(k + '-pw').type = 'text'; };
  const go = async () => {
    const pw = val(k + '-pw');
    const r = await edu('member.create', { orgId, role: st.role, classId: st.classId || null, loginId: val(k + '-id'), displayName: val(k + '-name'), password: pw });
    if (!r.ok) return tell(r.error);
    S.shown[k] = r.loginId + ' / ' + (r.password || pw);
    S.open[k] = null;
    S.sayGood = true; S.fresh = true; S.say = '계정을 만들었습니다 — 아이디와 비밀번호를 본인에게 전해 주세요';
    await load(); await showMembers(orgId);   // 학생 자리 수(상태 카드)도 다시
  };
  const classes = o.classes.filter((c) => c.status === 'active');
  return h('div', { class: 'card-box', style: 'width:100%' },
    h('div', { class: 'line' }, [['organization_admin', '기관 관리자'], ['instructor', '강사'], ['student', '학생']].map(([r, n]) =>
      h('button', { class: st.role === r ? 'btn' : 'btn-line', text: n, onclick: () => pick({ role: r, classId: r === 'organization_admin' ? '' : st.classId }) }))),
    st.role !== 'organization_admin' && classes.length ? h('div', { style: 'margin-top:8px' },
      h('div', { class: 'lab', text: st.role === 'student' ? '들어갈 수업' : '맡길 수업(나중에 정해도 됩니다)' }),
      h('div', { class: 'line' },
        st.role === 'student' ? null : h('button', { class: st.classId === '' ? 'btn' : 'btn-line', text: '아직 없음', onclick: () => pick({ classId: '' }) }),
        classes.map((c) => h('button', { class: st.classId === c.id ? 'btn' : 'btn-line', text: c.name, onclick: () => pick({ classId: c.id }) })))) : null,
    st.role === 'student' && !classes.length ? h('div', { class: 'notice', text: '학생은 수업에 들어갑니다 — [수업] 탭에서 수업을 먼저 만드세요' }) : null,
    // 위쪽 맞춤 — 아이디 칸 아래에 «쓸 수 있는지» 한 줄이 붙어도 다른 칸이 밀리지 않게
    h('div', { class: 'line', style: 'align-items:flex-start;margin-top:8px' },
      field('아이디(영문 소문자 · 숫자, 3자 이상)', k + '-id', 'text', { autocapitalize: 'none', spellcheck: 'false' }),
      field('이름', k + '-name'),
      field('비밀번호(10자 이상)', k + '-pw', 'text', { autocomplete: 'off', spellcheck: 'false' }),
      h('button', { class: 'btn-text', style: 'margin-top:30px', text: '자동으로', onclick: gen })),
    h('div', { class: 'line', style: 'margin-top:10px' },
      h('button', { class: 'btn-red', text: '만들기', onclick: go }),
      h('button', { class: 'btn-text', text: '닫기', onclick: () => { S.open[k] = null; render(); } })),
    h('div', { class: 'when', style: 'margin-top:6px', text: '비밀번호는 운영자가 정해 본인에게 전합니다. 본인이 «내 계정»에서 바꾸면 운영자도 모르게 됩니다.' }));
}

// 비밀번호를 잊은 사람 — 재설정 코드를 준다(비밀번호는 아무도 모른다). 본인이 로그인 화면 «비밀번호를 잊었어요»에서 아이디 · 코드 · 새 비밀번호를 넣는다.
async function giveResetCode(orgId, m, after) {
  if (!confirm((m.name || m.loginId) + '(' + m.loginId + ')에게 비밀번호 재설정 코드를 줄까요?\n본인이 로그인 화면의 «비밀번호를 잊었어요»에서 이 코드로 새 비밀번호를 정합니다(7일 · 한 번).')) return;
  const r = await edu('member.reset_password', { orgId, userId: m.userId });
  if (!r.ok) return tell(r.error);
  done('재설정 코드를 만들었습니다 — 본인에게 전해 주세요');
  await after();
}
const resetLine = (code, loginId) => (code ? h('div', { class: 'line', style: 'margin-top:6px' },
  h('div', { class: 'mark', style: 'font-size:14px;padding:4px 8px', text: code }), copyBtn(code),
  linkBtns(resetUrl(code, loginId), '스토리 엔진 비밀번호 재설정'),
  h('div', { class: 'when', text: '재설정 코드(7일 · 한 번) — 링크는 그 사람에게만 1:1로 보내세요(단체방에 올리지 않습니다)' })) : null);

function membersBox(orgId, { fixed = false } = {}) {
  const list = S.members[orgId];
  if (!list) return h('button', { class: 'btn-line', text: '사용자 목록', onclick: () => showMembers(orgId) });
  const remove = async (m) => {
    if (!confirm(m.name + '(' + m.loginId + ')을(를) 기관에서 내보낼까요? 계정과 작품은 남고, 수업에서만 빠집니다.')) return;
    const r = await edu('member.remove', { orgId, userId: m.userId });
    if (!r.ok) return tell(r.error);
    await showMembers(orgId);
  };
  return h('div', null,
    fixed ? null : h('button', { class: 'btn-line', text: '사용자 목록 닫기', onclick: () => { delete S.members[orgId]; render(); } }),
    h('div', { class: 'when', style: 'margin-top:8px', text: '학생 · 강사는 저마다 제 아이디로 들어옵니다(초대 링크는 수업에 들어오는 열쇠일 뿐 계정이 아닙니다).' }),
    list.length ? null : h('div', { class: 'when', style: 'margin-top:8px', text: '아직 사용자가 없습니다 — 학생은 [수업] 탭의 «학생 초대 링크»로, 강사는 [+ 강사 초대 링크]로 부르세요' }),
    list.map((m) => h('div', { style: 'padding:6px 0;border-bottom:1px solid var(--line-soft)' },
      h('div', { class: 'line' },
        h('div', { class: 'name', style: 'flex:1', text: (m.name || m.loginId) + ' · ' + m.loginId }),
        m.roles.map((r) => h('span', { class: 'mark', text: ROLE_SAY[r] || r })),
        m.classes.length ? h('div', { class: 'when', text: m.classes.join(', ') }) : null,
        S.me && m.loginId === S.me.loginId ? null : [
          h('button', { class: 'btn-text', text: '비밀번호 재설정 코드', onclick: () => giveResetCode(orgId, m, () => showMembers(orgId)) }),
          h('button', { class: 'btn-text red', text: '내보내기', onclick: () => remove(m) }),
        ]),
      // 운영자가 만든 계정의 비밀번호(최상위 관리자에게만 — 본인이 바꾸면 사라진다)
      m.knownPassword ? h('div', { class: 'line', style: 'margin-top:6px' },
        h('div', { class: 'mark', style: 'font-size:14px;padding:4px 8px', text: m.loginId + ' / ' + m.knownPassword }), copyBtn(m.loginId + ' / ' + m.knownPassword),
        h('div', { class: 'when', text: '운영자가 정한 비밀번호 — 본인이 바꾸면 여기서 사라집니다' })) : null,
      resetLine(m.resetCode, m.loginId))),
    h('button', { class: 'btn-text', style: 'margin-top:8px', text: '다시 불러오기', onclick: () => showMembers(orgId) }));
}

// ---------------------------------------------------------------- 내 비밀번호

function passwordBox() {
  const k = 'pwbox';
  // 구글로 만든 계정 — 비밀번호가 없다. 세션만으로는 정하지 못한다(서버도 막는다) — 운영자의 재설정 코드로.
  if (S.me && S.me.noPassword) {
    return PAGE !== 'account' ? null : section('내 비밀번호',
      h('div', { class: 'when', text: '비밀번호 없음 — 구글 계정으로 들어옵니다. 비밀번호로도 들어가려면 운영자에게 재설정 코드를 받아 로그인 화면의 «비밀번호를 잊었어요»에 넣으세요(아이디 ' + S.me.loginId + ').' }));
  }
  if (!S.open[k] && PAGE !== 'account') return h('button', { class: 'btn-text', text: '내 비밀번호 바꾸기', onclick: () => { S.open[k] = true; render(); } });
  const go = async () => {
    if (val('pw-next') !== val('pw-next2')) return tell('새 비밀번호가 서로 다릅니다');
    const r = await fetch('/api/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: val('pw-cur'), next: val('pw-next') }) })
      .then((x) => x.json()).catch(() => ({ ok: false, error: '연결되지 않습니다' }));
    if (!r.ok) return tell(r.error);
    S.open[k] = false;
    done('비밀번호를 바꿨습니다');
  };
  return section('내 비밀번호 바꾸기',
    h('div', { class: 'line', style: 'align-items:flex-end' },
      field('지금 비밀번호', 'pw-cur', 'password', { autocomplete: 'current-password' }),
      field('새 비밀번호(10자 이상)', 'pw-next', 'password', { autocomplete: 'new-password' }),
      field('새 비밀번호 한 번 더', 'pw-next2', 'password', { autocomplete: 'new-password' }),
      h('button', { class: 'btn-red', text: '바꾸기', onclick: go })));
}

// ---------------------------------------------------------------- 구글 로그인(자유 가입판, docs/OPEN_EDITION.md §4-9)
// 켜졌을 때만. 이은 구글 계정(이메일)을 보이고, 안 이었으면 [구글 계정 연결] — 구글을 다녀와 이 화면으로 돌아온다.
function googleBox() {
  const g = S.me && S.me.google;
  if (S.edition !== 'open' || !g || (!g.on && !g.linked)) return null;
  return section('구글 로그인',
    g.linked ? h('div', { class: 'notice good', text: '이어짐 — ' + (g.email || '구글 계정') + (g.since ? ' · ' + kday(g.since) + '부터' : '') + (g.on ? '' : ' · 지금은 구글 로그인이 꺼져 있습니다') })
      : h('div', { class: 'line', style: 'align-items:center' },
        h('span', { class: 'when', style: 'flex:1', text: '구글 계정을 이으면 로그인 화면의 [Google 계정으로 계속하기]로도 들어옵니다' }),
        h('button', { class: 'btn-line', text: '구글 계정 연결', onclick: () => { location.href = '/api/auth/google/start?mode=link'; } })));
}

// ---------------------------------------------------------------- 단계 · 강의 카드 고쳐 쓰기
// 운영자는 «전체 기본»을, 기관 관리자는 «제 기관»을 고친다. 원문(설정 파일)은 남고, 비우면 원래대로 돌아간다.
// 고칠 수 있는 칸: 이름 · 할 일 · 추천 참조(앞 단계만) · 끌 수 있음 · 카드(무엇인가 · 볼 점 · 질문) · 강사 메모.

async function loadWf(scopeKey, orgId) {
  const r = await edu('workflow.view', orgId ? { orgId } : {});
  if (!r.ok) return tell(r.error);
  S.wf[scopeKey] = r.workflow;
  render();
}

function wfEditor(orgId) {
  const sk = orgId || 'platform';
  const w = S.wf[sk];
  if (!w) return h('button', { class: 'btn-line', text: '단계 목록 열기', onclick: () => loadWf(sk, orgId) });
  const layerOf = (st) => (orgId ? st.organization : st.platform) || {};
  const close = () => h('button', { class: 'btn-line', style: 'margin-top:8px', text: '단계 목록 닫기', onclick: () => { delete S.wf[sk]; render(); } });
  return h('div', null, close(), w.stages.map((st) => {
    const k = sk + ':' + st.key;
    const mine = layerOf(st);
    const eff = st.effective;
    const head = h('div', { class: 'line', style: 'padding:6px 0;border-bottom:1px solid var(--line-soft);cursor:pointer', onclick: () => { S.wfOpen[k] = !S.wfOpen[k]; render(); } },
      h('div', { class: 'name', style: 'flex:1', text: st.n + '  ' + eff.title }),
      Object.keys(mine).length ? h('span', { class: 'mark', text: orgId ? '이 기관이 고침' : '고침' }) : null,
      !orgId ? null : st.platform ? h('span', { class: 'mark', text: '운영자가 고침' }) : null,
      h('span', { class: 'when', text: S.wfOpen[k] ? '접기 ▴' : '열기 ▾' }));
    if (!S.wfOpen[k]) return head;
    const id = (f) => 'wf-' + sk + '-' + st.key + '-' + f;
    const before = w.stages.filter((x) => x.n < st.n);
    const generates = st.output !== 'input' && st.output !== 'final';
    const save = async (clear) => {
      const typed = {
        title: val(id('title')), task: $(id('task')) ? $(id('task')).value : undefined, teachingNote: $(id('note')).value,
        optional: $(id('opt')) ? $(id('opt')).checked : undefined,
        tier: generates ? (Object.keys(TIER_CO).find((t) => $(id('t-' + t)) && $(id('t-' + t)).checked) || undefined) : undefined,
        inputs: before.some((x) => $(id('in-' + x.key))) ? before.filter((x) => $(id('in-' + x.key)).checked).map((x) => x.key) : undefined,
        card: { what: $(id('what')).value, look: $(id('look')).value.split('\n').map((x) => x.trim()).filter(Boolean), ask: $(id('ask')).value },
      };
      // 아래 층(원문, 기관이면 원문 + 운영자)과 같은 칸은 보내지 않는다 — 안 고친 칸을 얼려 두지 않게
      const below = { ...st.original, ...(orgId ? st.platform || {} : {}) };
      const emptyCard = (c) => !c || (!c.what && !(c.look || []).length && !c.ask);
      const norm = (k, v) => k === 'card' ? (emptyCard(v) ? 'null' : JSON.stringify({ what: v.what || '', look: v.look || [], ask: v.ask || '' }))
        : k === 'inputs' ? JSON.stringify([...(v || [])].sort()) : k === 'optional' ? String(!!v) : JSON.stringify(v === '' || v == null ? null : v);
      const same = (k) => norm(k, typed[k]) === norm(k, below[k]);
      const data = {};
      if (!clear) for (const k of Object.keys(typed)) if (typed[k] !== undefined && !same(k)) data[k] = typed[k];
      const r = await edu('workflow.save', { ...(orgId ? { orgId } : {}), stageKey: st.key, data });
      if (!r.ok) return tell(r.error);
      S.sayGood = true; S.fresh = true; S.say = (clear ? '원래대로 되돌렸습니다' : '저장했습니다 — 다음 생성부터 쓰입니다') + ' (' + st.n + '  ' + (clear ? st.original.title : (data.title || st.effective.title)) + ')';
      S.wfOpen[k] = false;   // 저장하면 그 단계는 접는다
      await loadWf(sk, orgId);
    };
    const box = (f, label, value, big, hint) => h('div', { style: 'margin-top:10px' },
      h('div', { class: 'lab', text: label }),
      big ? h('textarea', { id: id(f), placeholder: hint || '' }) : h('input', { id: id(f), type: 'text', placeholder: hint || '' }));
    const form = h('div', { style: 'padding:6px 0 14px' },
      box('title', '단계 이름', '', false, st.original.title),
      generates ? box('task', '이 단계에서 하는 일(AI 에게 주는 «이번 단계에 할 일»)', '', true) : null,
      generates && before.length ? h('div', { style: 'margin-top:10px' }, h('div', { class: 'lab', text: '추천 참조(앞 단계 결과를 자동으로 체크해 보여 줌)' }),
        h('div', { class: 'line' }, before.map((x) => h('label', { class: 'line', style: 'gap:4px' },
          h('input', { id: id('in-' + x.key), type: 'checkbox' }), h('span', { text: x.effective.title }))))) : null,
      generates ? h('label', { class: 'line', style: 'gap:6px;margin-top:10px' }, h('input', { id: id('opt'), type: 'checkbox' }), h('span', { text: '학생 · 작가가 이 단계를 끌 수 있음' })) : null,
      generates ? h('div', { style: 'margin-top:10px' }, h('div', { class: 'lab', text: '기본 등급(학생 · 작가가 고르지 않았을 때 — 온라인판)' }),
        h('div', { class: 'line' }, Object.entries(TIER_CO).map(([t, name]) => h('label', { class: 'line', style: 'gap:4px' },
          h('input', { id: id('t-' + t), type: 'radio', name: id('tier') }), h('span', { text: name }))))) : null,
      box('what', '강의 카드 — 무엇인가', '', true),
      box('look', '강의 카드 — 볼 점(한 줄에 하나)', '', true),
      box('ask', '강의 카드 — 생각해 볼 질문', '', false),
      box('note', '강사 메모(강사 화면에만)', '', true),
      h('div', { class: 'line', style: 'margin-top:12px' },
        h('button', { class: 'btn-red', text: '저장', onclick: () => save(false) }),
        h('button', { class: 'btn-line', text: '닫기', onclick: () => { S.wfOpen[k] = false; render(); } }),
        Object.keys(mine).length ? h('button', { class: 'btn-text', text: '원래대로', onclick: () => save(true) }) : null,
        h('div', { class: 'when', text: '원문은 그대로 남습니다' })));
    // 칸에 지금 값(합친 결과)을 채워 둔다 — 그리기가 끝난 뒤
    setTimeout(() => {
      const set = (f, v) => { const n = $(id(f)); if (n && !n.dataset.filled) { n.value = v == null ? '' : v; n.dataset.filled = '1'; } };
      set('title', eff.title); set('task', eff.task); set('note', eff.teachingNote);
      set('what', eff.card && eff.card.what); set('look', eff.card ? (eff.card.look || []).join('\n') : ''); set('ask', eff.card && eff.card.ask);
      const opt = $(id('opt')); if (opt && !opt.dataset.filled) { opt.checked = !!eff.optional; opt.dataset.filled = '1'; }
      const tr = eff.tier && $(id('t-' + eff.tier)); if (tr && !tr.dataset.filled) { tr.checked = true; tr.dataset.filled = '1'; }
      for (const x of before) { const c = $(id('in-' + x.key)); if (c && !c.dataset.filled) { c.checked = (eff.inputs || []).includes(x.key); c.dataset.filled = '1'; } }
    }, 0);
    return h('div', null, head, form);
  }), close());
}

// ---------------------------------------------------------------- 고객 · 결제 관리(자유 가입판 — 최상위 운영자만, docs/OPEN_EDITION.md §4-6)
// 고객(이용권 상태 · 손 연장 · 끝내기 · 무료 이용 · 계정 정지 · 메모) · 결제 기록(확인 필요 · 웹훅 상태) · 결제 옵션(요금제) · 이용 규칙.
// 금액 · 매출은 이 화면에만. 결제 기록의 이름 · 전화 · 이메일은 서버가 가려서 보낸다. 카드 청구(정기결제)는 여기서 끊지 않는다 — 그로블 판매 관리에서.

S.bill = { cust: { q: '', status: '', list: null, total: 0, open: '', detail: null }, events: null, health: null, plans: null, rules: null };
const PASS_SAY = { active: '이용 중', past_due: '결제 실패', cancel_pending: '해지 예정', ended: '끝남', none: '없음', free: '무료 이용' };
const PROV_SAY = { groble: '정기결제', manual: '운영자 연장', trial: '무료 체험' };
const TYPE_SAY = {
  'subscription_payment.completed': '정기결제 결제', 'subscription_payment.failed': '갱신 실패', 'subscription.cancel_requested': '해지 예고', 'subscription.terminated': '해지 완료',
  'subscription_payment.refunded': '회차 환불', 'payment.completed': '단건 결제', 'payment.cancel_requested': '단건 취소 요청', 'payment.refunded': '단건 환불',
};
const RESULT_SAY = { applied: '반영', stale: '늦게 온 소식(기록만)', recorded: '기록만', unlinked: '연결 안 됨', amount_mismatch: '금액 · 상품 다름', unreadable: '읽지 못함', pending: '처리 중' };
const won = (n) => (n == null ? '' : Number(n).toLocaleString('ko-KR') + '원');
const REFUND_SAY = { open: '처리 중', done: '끝남', withdrawn: '되돌림' };

// 환불 건 한 줄 — 그때의 판정과 할 일 둘(① 그로블에서 이 결제 환불 ② 그로블에서 정기결제 해지)의 확인. 둘은 웹훅이 오면 저절로 «됨».
function refundRow(r, after) {
  const withdraw = async () => {
    const res = await edu('billing.refund.withdraw', { requestId: r.id, reason: val('rf-why-' + r.id) });
    if (!res.ok) return tell(res.error);
    S.bill.events = null; S.bill.cust.list = null;
    if (after) await after();
    done('환불 요청을 되돌렸습니다 — 멈췄던 이용권이 되살아났습니다');
  };
  return h('div', { style: 'padding:8px 0;border-bottom:1px solid var(--line-soft)' },
    h('div', { class: 'line' },
      h('div', { class: 'name', style: 'flex:1', text: (r.user.name || r.user.loginId) + ' · ' + r.user.loginId + (r.amount ? ' · ' + won(r.amount) : '') }),
      h('span', { class: 'mark', style: r.status === 'open' ? 'color:var(--red)' : '', text: REFUND_SAY[r.status] || r.status }),
      h('span', { class: 'mark', text: r.source === 'groble' ? '그로블에서 먼저' : '사용자 요청' }),
      h('div', { class: 'when', text: when(r.createdAt) })),
    h('div', { class: 'when', style: 'white-space:normal', text: '결제 ' + day(r.paidAt) + ' · 기한 ' + r.until + '까지 · 구독 시작 뒤 AI 작업 ' + r.aiRuns + '회 · ' + (r.inPolicy ? '규정 안' : '규정 밖') }),
    r.reasonSay ? h('div', { class: 'when', style: 'white-space:normal', text: '이유: ' + r.reasonSay + (r.detail ? ' — ' + r.detail : '') }) : null,
    r.source === 'user' ? mailMark('refund', r, after) : null,
    h('div', { class: 'line', style: 'margin-top:4px' }, [['① 그로블 환불', r.refundedAt], ['② 그로블 정기결제 해지', r.cancelledAt]].map(([n, at]) =>
      h('span', { class: 'mark', style: at ? '' : 'color:var(--red)', text: n + (at ? ' — 됨' : ' — 아직') }))),
    r.status === 'open' && r.refundedAt && !r.cancelledAt ? h('div', { class: 'notice', style: 'margin-top:6px', text: '환불은 됐는데 정기결제가 살아 있습니다 — 그로블에서 해지하지 않으면 다음 결제일에 다시 청구됩니다' }) : null,
    r.status === 'open' && !r.refundedAt ? h('div', { class: 'line', style: 'margin-top:6px;align-items:center' },
      h('input', { id: 'rf-why-' + r.id, type: 'text', placeholder: '되돌리는 까닭(감사 기록)', style: 'flex:1;min-width:120px' }),
      h('button', { class: 'btn-text', text: '요청 되돌리기', onclick: withdraw })) : null);
}

// 구독 취소 한 줄 — 이유 · 다음 결제일(이 날 전에 그로블에서 해지) · 그로블 해지 확인(웹훅이 오면 저절로) · 취소 뒤 다시 결제됐나 · 알림 메일
const CANCEL_SAY = { open: '그로블 해지 대기', done: '해지 확인', withdrawn: '되돌림' };
function cancelRow(x, after) {
  const late = x.status === 'open' && x.nextBilling && x.nextBilling <= kday(Date.now());
  return h('div', { style: 'padding:8px 0;border-bottom:1px solid var(--line-soft)' },
    h('div', { class: 'line' },
      h('div', { class: 'name', style: 'flex:1', text: (x.user.name || x.user.loginId) + ' · ' + x.user.loginId }),
      h('span', { class: 'mark', style: x.status === 'open' ? 'color:var(--red)' : '', text: CANCEL_SAY[x.status] || x.status }),
      h('div', { class: 'when', text: when(x.createdAt) })),
    h('div', { class: 'when', style: 'white-space:normal', text: '이유: ' + x.reasonSay + (x.detail ? ' — ' + x.detail : '') + ' · 다음 결제일 ' + (x.nextBilling || '모름') }),
    x.status === 'open' ? h('div', { class: late ? 'notice' : 'when', style: 'white-space:normal', text: late
      ? '다음 결제일이 지났는데 그로블 해지 확인이 없습니다 — 그로블에서 해지됐는지, 다시 청구되지 않았는지 확인해 주세요'
      : '그로블 판매 관리에서 이 정기결제를 해지하면 «해지 확인»이 저절로 찍힙니다' }) : null,
    x.chargedAt ? h('div', { class: 'notice', text: '취소를 접수한 뒤 ' + when(x.chargedAt) + ' 다시 결제됐습니다 — 그로블에서 이 결제 환불 · 정기결제 해지' }) : null,
    mailMark('cancel', x, after));
}
// 알림 메일 — 보냈으면 그때, 못 보냈으면 까닭과 [메일 다시 보내기]
function mailMark(kind, x, after) {
  const resend = async () => {
    const r = await edu('billing.mail.resend', { kind, id: x.id });
    if (!r.ok) return tell(r.error);
    S.bill.events = null;
    if (after) await after();
    done('알림 메일을 다시 보냈습니다');
  };
  if (x.mailedAt) return h('div', { class: 'when', text: '알림 메일 보냄 — ' + when(x.mailedAt) });
  if (!x.mailError) return null;
  return h('div', { class: 'line', style: 'margin-top:4px;align-items:center' },
    h('span', { class: 'notice', style: 'flex:1;white-space:normal', text: '알림 메일 못 보냄 — ' + (x.mailErrorSay || x.mailError) }),
    h('button', { class: 'btn-text', text: '메일 다시 보내기', onclick: resend }));
}

async function loadCustomers(more = false) {
  const f = S.bill.cust;
  f.loading = true;
  const r = await edu('billing.customers', { q: f.q, status: f.status, offset: more ? (f.list || []).length : 0 });
  f.loading = false;
  if (!r.ok) return tell(r.error);
  f.list = more ? [...(f.list || []), ...r.customers] : r.customers;
  f.total = r.total;
  render();
}
async function openCustomer(userId) {
  const f = S.bill.cust;
  if (f.open === userId && f.detail) { f.open = ''; f.detail = null; return render(); }
  const r = await edu('billing.customer', { userId });
  if (!r.ok) return tell(r.error);
  f.open = userId; f.detail = r.customer;
  render();
}
const passText = (c) => (c.free ? '무료 이용' : PASS_SAY[c.status] || c.status);

function customerDetail(d) {
  const u = d.user;
  const k = 'cd-' + u.userId;
  const reason = () => val(k + '-why');
  const reload = async (say) => { const r = await edu('billing.customer', { userId: u.userId }); if (r.ok) S.bill.cust.detail = r.customer; S.bill.cust.list = null; done(say); };
  const act = async (op, body, say, ask) => {
    if (ask && !confirm(ask)) return;
    const r = await edu(op, { userId: u.userId, reason: reason(), ...body });
    if (!r.ok) return tell(r.error);
    await reload(typeof say === 'function' ? say(r) : say);
  };
  const resetCode = async () => {
    const r = await edu('user.reset_code', { userId: u.userId });
    if (!r.ok) return tell(r.error);
    S.shown['mk-reset-' + u.userId] = r.loginId + ' / 재설정 코드 ' + r.resetCode;
    S.bill.cust.resetLink = resetUrl(r.resetCode, r.loginId);
    done('재설정 코드를 만들었습니다(' + r.days + '일 · 한 번) — 본인에게만 1:1로 보내세요');
  };
  const p = d.pass;
  return h('div', { class: 'card-box', style: 'margin:6px 0 12px' },
    h('div', { class: 'line' },
      h('div', { class: 'name', style: 'flex:1;font-weight:700', text: (u.name || u.loginId) + ' · ' + u.loginId }),
      u.operator ? h('span', { class: 'mark', text: '운영자' }) : null,
      u.accountStatus !== 'active' ? h('span', { class: 'mark', style: 'color:var(--red)', text: '정지됨' }) : null),
    h('div', { class: 'when', text: '가입 ' + day(u.createdAt) + (u.lastLoginAt ? ' · 마지막 로그인 ' + day(u.lastLoginAt) : '')
      + (u.google ? ' · 구글 로그인(' + u.google.email + ')' : '') + (u.noPassword ? ' · 비밀번호 없음(정하려면 재설정 코드)' : '') }),
    h('div', { class: 'lab', text: '이용권' }),
    h('div', { class: 'notice' + (p.active ? ' good' : ''), text: (p.operator ? '운영자 — 이용권 없이' : p.free ? '무료 이용' : PASS_SAY[p.status] || p.status)
      + (p.paidUntil && !p.free && !p.operator ? ' · 기한 ' + when(p.paidUntil) : '') + (p.nextBillingDate ? ' · 다음 결제일 ' + p.nextBillingDate : '') + (p.serviceEndsAt ? ' · ' + when(p.serviceEndsAt) + ' 해지' : '') }),
    d.subscriptions.length ? d.subscriptions.map((s) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: (PROV_SAY[s.provider] || s.provider) + (s.plan ? ' · ' + s.plan : '') + (s.ref ? ' · 참조 ' + s.ref : '') }),
      h('span', { class: 'mark', text: PASS_SAY[s.status] || s.status }),
      h('div', { class: 'when', text: (s.paidUntil ? '~ ' + when(s.paidUntil) : '') + (s.lastPaidAt ? ' · 마지막 결제 ' + day(s.lastPaidAt) + (s.lastAmount ? ' ' + won(s.lastAmount) : '') : '') }))) : h('div', { class: 'when', text: '이용권 기록이 없습니다' }),
    h('div', { class: 'lab', text: '결제 기록(이름 · 전화 · 이메일은 가림)' }),
    d.events.length ? d.events.map((e) => h('div', { class: 'row', style: 'cursor:default' },
      h('div', { class: 'name', text: (TYPE_SAY[e.type] || e.type || '?') + (e.amount ? ' · ' + won(e.amount) : '') + ' · ' + (RESULT_SAY[e.result] || e.result) }),
      h('div', { class: 'when', text: when(e.occurredAt || e.receivedAt) + (e.buyer.email ? ' · ' + e.buyer.email : '') }))) : h('div', { class: 'when', text: '받은 결제가 없습니다' }),
    d.refunds && d.refunds.length ? h('div', { class: 'lab', text: '환불' }) : null,
    ...(d.refunds || []).map((r) => refundRow(r, async () => { const x = await edu('billing.customer', { userId: u.userId }); if (x.ok) S.bill.cust.detail = x.customer; })),
    d.cancels && d.cancels.length ? h('div', { class: 'lab', text: '구독 취소' }) : null,
    ...(d.cancels || []).map((x) => cancelRow(x, async () => { const y = await edu('billing.customer', { userId: u.userId }); if (y.ok) S.bill.cust.detail = y.customer; })),
    h('div', { class: 'lab', text: '손으로 바꾸기 — 모두 감사 기록에 남습니다' }),
    field('왜(감사 기록에 남습니다)', k + '-why', 'text', { placeholder: '예: 웹훅이 끊긴 동안 메움' }),
    h('div', { class: 'line', style: 'margin-top:8px;align-items:center' },
      h('input', { id: k + '-days', type: 'text', value: '30', style: 'width:70px' }), h('span', { class: 'when', text: '일' }),
      h('button', { class: 'btn-line', text: '기간 연장', onclick: () => {
        const days = Number(val(k + '-days'));
        act('billing.extend', { days }, (r) => days + '일 연장했습니다 — ' + when(r.paidUntil) + '까지');
      } }),
      h('button', { class: 'btn-text red', text: '이용권 끝내기', onclick: () => act('billing.end', {}, '이용권을 끝냈습니다', (u.name || u.loginId) + ' — 이용권을 지금 끝낼까요? 새 AI 작업이 곧바로 막힙니다(작품은 그대로).\n그로블의 카드 청구는 끊기지 않습니다 — 끊으려면 그로블 판매 관리에서.') }),
      h('button', { class: 'btn-line', text: u.free ? '무료 이용 끄기' : '무료 이용 켜기', onclick: () => act('billing.free', { on: !u.free }, u.free ? '무료 이용을 껐습니다' : '무료 이용을 켰습니다 — 결제 없이 씁니다') }),
      u.operator ? null : h('button', { class: 'btn-text' + (u.accountStatus === 'active' ? ' red' : ''), text: u.accountStatus === 'active' ? '계정 정지' : '정지 풀기', onclick: async () => {
        const to = u.accountStatus === 'active' ? 'disabled' : 'active';
        if (to === 'disabled' && !confirm(u.loginId + ' — 계정을 멈출까요? 곧바로 로그아웃되고 다시 열 때까지 들어올 수 없습니다.')) return;
        const r = await edu('user.status', { loginId: u.loginId, status: to });
        if (!r.ok) return tell(r.error);
        await reload(to === 'disabled' ? '계정을 멈췄습니다' : '계정을 다시 열었습니다');
      } }),
      u.operator ? null : h('button', { class: 'btn-text', text: '비밀번호 재설정 코드', onclick: resetCode })),
    codeBox('mk-reset-' + u.userId, '본인에게만 1:1로 보내세요 · 7일 · 한 번'),
    S.shown['mk-reset-' + u.userId] && S.bill.cust.resetLink ? h('div', { class: 'line' }, linkBtns(S.bill.cust.resetLink, '스토리 엔진 비밀번호 재설정')) : null,
    h('div', { class: 'lab', text: '메모(운영자만 봅니다)' }),
    h('textarea', { id: k + '-memo', placeholder: '이 고객에 대한 메모' }),
    h('div', { class: 'line', style: 'margin-top:6px' }, h('button', { class: 'btn-line', text: '메모 저장', onclick: async () => {
      const r = await edu('billing.memo', { userId: u.userId, memo: $(k + '-memo').value });
      if (!r.ok) return tell(r.error);
      u.memo = $(k + '-memo').value; done('메모를 저장했습니다');
    } })),
    h('div', { class: 'when', text: '카드 청구(정기결제)는 여기서 끊기지 않습니다 — 해지 · 환불은 그로블 «판매 관리»에서 합니다.' }));
}

function customersTab() {
  const f = S.bill.cust;
  if (!f.list && !f.loading) loadCustomers();
  const search = () => { f.q = val('cu-q'); f.open = ''; f.detail = null; loadCustomers(); };
  // 메모 칸은 그리기가 끝난 뒤 한 번만 채운다(치던 글을 덮지 않게)
  if (f.detail) setTimeout(() => { const n = $('cd-' + f.detail.user.userId + '-memo'); if (n && !n.dataset.filled) { n.value = f.detail.user.memo || ''; n.dataset.filled = '1'; } }, 0);
  return h('div', null,
    h('div', { class: 'line', style: 'align-items:flex-end' },
      field('찾기(아이디 · 이름)', 'cu-q', 'text', { autocapitalize: 'none', spellcheck: 'false', onkeydown: (e) => { if (e.key === 'Enter') search(); } }),
      h('button', { class: 'btn-line', text: '찾기', onclick: search })),
    h('div', { class: 'line', style: 'margin:8px 0' }, [['', '전체'], ...Object.entries(PASS_SAY)].map(([k, n]) => h('button', {
      class: f.status === k ? 'btn' : 'btn-line', text: n, onclick: () => { f.status = k; f.open = ''; f.detail = null; loadCustomers(); },
    }))),
    !f.list ? h('div', { class: 'when', text: '불러오는 중…' }) : [
      h('div', { class: 'when', text: f.total + '명' }),
      f.list.map((c) => [
        h('div', { class: 'row', onclick: () => openCustomer(c.userId) },
          h('div', { class: 'name', text: (c.name || c.loginId) + ' · ' + c.loginId }),
          c.operator ? h('span', { class: 'mark', text: '운영자' }) : null,
          c.accountStatus !== 'active' ? h('span', { class: 'mark', style: 'color:var(--red)', text: '정지됨' }) : null,
          c.operator ? null : h('span', { class: 'mark', style: c.status === 'past_due' ? 'color:var(--red)' : '', text: passText(c) }),
          c.hasMemo ? h('span', { class: 'mark', text: '메모' }) : null,
          h('div', { class: 'when', text: '가입 ' + day(c.createdAt) + (c.until && c.status !== 'none' ? ' · 기한 ' + day(c.until) : '') + (c.nextBilling ? ' · 다음 결제 ' + c.nextBilling : '') + (c.lastPaidAt ? ' · 마지막 결제 ' + day(c.lastPaidAt) : '') })),
        f.open === c.userId && f.detail ? customerDetail(f.detail) : null,
      ]),
      f.list.length < f.total ? h('button', { class: 'btn-line', style: 'margin-top:8px', text: '더 보기', onclick: () => loadCustomers(true) }) : null,
    ]);
}

async function loadEvents() {
  const [ev, he] = await Promise.all([edu('billing.events'), edu('billing.health')]);
  if (!ev.ok) return tell(ev.error);
  S.bill.events = ev; S.bill.health = he.ok ? he.health : null;
  render();
}
function eventRow(e, actions) {
  return h('div', { style: 'padding:8px 0;border-bottom:1px solid var(--line-soft)' },
    h('div', { class: 'line' },
      h('div', { class: 'name', style: 'flex:1', text: (TYPE_SAY[e.type] || e.type || '?') + (e.amount ? ' · ' + won(e.amount) : '') }),
      h('span', { class: 'mark', style: e.review ? 'color:var(--red)' : '', text: RESULT_SAY[e.result] || e.result }),
      e.user ? h('span', { class: 'mark', text: e.user.loginId }) : null,
      h('div', { class: 'when', text: when(e.occurredAt || e.receivedAt) })),
    h('div', { class: 'when', style: 'white-space:normal', text: [e.note, e.buyer.name, e.buyer.email, e.buyer.phone, e.contentId ? '상품 ' + e.contentId : '', e.merchantUid ? '결제 건 ' + e.merchantUid : '', e.ref ? '참조 ' + e.ref : ''].filter(Boolean).join(' · ') }),
    actions || null);
}
function eventsTab() {
  if (!S.bill.events && !S.bill.loadingEvents) { S.bill.loadingEvents = true; loadEvents().finally(() => { S.bill.loadingEvents = false; }); }
  const E = S.bill.events; const H = S.bill.health;
  if (!E) return h('div', { class: 'when', text: '불러오는 중…' });
  const link = async (e) => {
    const loginId = val('lk-' + e.id);
    if (!loginId) return tell('연결할 계정의 아이디를 적어 주세요');
    if (!confirm('이 결제를 ' + loginId + ' 계정에 반영할까요? (금액 검사 없이 — 확인한 뒤에)')) return;
    const r = await edu('billing.link', { eventId: e.id, loginId, reason: val('lk-why-' + e.id) });
    if (!r.ok) return tell(r.error);
    S.bill.events = null; S.bill.cust.list = null;
    done(r.loginId + ' — ' + (RESULT_SAY[r.result] || r.result) + (r.note ? ' · ' + r.note : ''));
  };
  const ignore = async (e) => {
    const r = await edu('billing.ignore', { eventId: e.id, reason: val('lk-why-' + e.id) });
    if (!r.ok) return tell(r.error);
    S.bill.events = null; done('확인 필요에서 내렸습니다(기록은 그대로)');
  };
  const hookUrl = location.origin + '/api/billing/groble';
  const lastAgo = H && H.lastReceivedAt ? (Date.now() - new Date(H.lastReceivedAt).getTime()) / 86400000 : null;
  return h('div', null,
    H ? h('div', { class: 'card-box', style: 'margin-bottom:14px' },
      h('div', { class: 'lab', text: '웹훅 상태' }),
      h('div', { class: H.secret.current ? 'when' : 'notice', text: H.secret.current ? '시크릿 있음' + (H.secret.previous ? ' · 교체 중(옛 시크릿도 받음)' : '') : '시크릿 없음 — 웹훅을 받지 못합니다(Secrets 의 GROBLE_WEBHOOK_SECRET)' + (H.noSecret ? ' · 그사이 온 요청 ' + H.noSecret + '건(그로블이 다시 보냅니다)' : '') }),
      h('div', { class: 'line' }, h('div', { class: 'mark', style: 'font-size:13px;padding:4px 8px;word-break:break-all;white-space:normal', text: hookUrl }), copyBtn(hookUrl), h('span', { class: 'when', text: '← 그로블 «내 스토어 → 연동»에 넣는 주소' })),
      h('div', { class: 'when', text: '마지막으로 받은 때: ' + (H.lastReceivedAt ? when(H.lastReceivedAt) : '아직 없음') }),
      H.rejected ? h('div', { class: 'notice', text: '서명이 맞지 않은 요청 ' + H.rejected + '건(마지막 ' + when(H.rejectedAt) + ') — 그로블의 시크릿과 Secrets 의 값이 같은지 확인해 주세요' }) : null,
      H.overdue ? h('div', { class: 'notice', text: '다음 결제일이 지났는데 소식이 없는 정기결제 ' + H.overdue + '건 — 웹훅이 끊겼을 수 있습니다(그로블 «연동»에서 확인 · 다시 켜기, 그동안은 고객 탭의 [기간 연장]으로 메움)' }) : null,
      lastAgo != null && lastAgo > 3 && !H.overdue ? h('div', { class: 'when', text: '사흘 넘게 받은 웹훅이 없습니다 — 그로블은 20건 연속 실패 + 3일이면 엔드포인트를 끕니다' }) : null,
      H.refundsUncancelled ? h('div', { class: 'notice', text: '환불은 됐는데 그로블 정기결제가 살아 있는 건 ' + H.refundsUncancelled + '건 — 그로블에서 해지하지 않으면 다음 결제일에 다시 청구됩니다' }) : null,
      H.cancelsLate ? h('div', { class: 'notice', text: '다음 결제일이 지났는데 그로블 해지 확인이 없는 구독 취소 ' + H.cancelsLate + '건 — 다시 청구됐을 수 있습니다' }) : null,
      H.mail && !H.mail.on ? h('div', { class: 'notice', text: '알림 메일 꺼짐 — 환불 요청 · 구독 취소가 메일로 오지 않습니다(Secrets 의 RESEND_API_KEY)' })
        : H.mail && !H.mail.to ? h('div', { class: 'notice', text: '알림 메일 주소가 없습니다 — [이용 규칙]에서 넣어 주세요' }) : null,
      H.mail && H.mail.failed ? h('div', { class: 'notice', text: '알림 메일을 보내지 못한 요청 ' + H.mail.failed + '건 — 아래 줄의 [메일 다시 보내기]' }) : null,
      h('div', { class: 'when', text: '이번 달 반영된 결제 ' + E.month.count + '건 · ' + won(E.month.total) })) : null,
    h('div', { class: 'lab', text: '환불 — 처리 중 ' + (E.refunds || []).filter((r) => r.status === 'open').length + '건 · 할 일 둘(그로블에서 이 결제 환불 · 정기결제 해지)은 웹훅이 오면 저절로 «됨»' }),
    E.refunds && E.refunds.length ? E.refunds.map((r) => refundRow(r)) : h('div', { class: 'when', text: '없음' }),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '구독 취소 — 그로블 해지 대기 ' + (E.cancels || []).filter((x) => x.status === 'open').length + '건 · 그로블에서 해지하면 저절로 «해지 확인»' }),
    E.cancels && E.cancels.length ? E.cancels.map((x) => cancelRow(x)) : h('div', { class: 'when', text: '없음' }),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '확인 필요 ' + E.review.length + '건' }),
    E.review.length ? E.review.map((e) => eventRow(e, h('div', { class: 'line', style: 'margin-top:6px;align-items:center' },
      h('input', { id: 'lk-' + e.id, type: 'text', placeholder: '연결할 아이디', autocapitalize: 'none', spellcheck: 'false', style: 'width:150px', value: e.user ? e.user.loginId : '' }),
      h('button', { class: 'btn-line', text: '이 계정에 연결', onclick: () => link(e) }),
      h('input', { id: 'lk-why-' + e.id, type: 'text', placeholder: '왜(감사 기록)', style: 'flex:1;min-width:120px' }),
      h('button', { class: 'btn-text', text: '무시', onclick: () => ignore(e) })))) : h('div', { class: 'when', text: '없음' }),
    h('div', { class: 'lab', style: 'margin-top:16px', text: '받은 웹훅(최근 100)' }),
    E.recent.length ? E.recent.map((e) => eventRow(e)) : h('div', { class: 'when', text: '아직 없습니다' }),
    h('button', { class: 'btn-text', style: 'margin-top:8px', text: '다시 불러오기', onclick: () => { S.bill.events = null; render(); } }));
}

async function loadPlans() {
  const r = await edu('billing.plans');
  if (!r.ok) return tell(r.error);
  S.bill.plans = r.plans; render();
}
function plansTab() {
  if (!S.bill.plans && !S.bill.loadingPlans) { S.bill.loadingPlans = true; loadPlans().finally(() => { S.bill.loadingPlans = false; }); }
  const P = S.bill.plans;
  if (!P) return h('div', { class: 'when', text: '불러오는 중…' });
  const save = async (body, say) => { const r = await edu('billing.plan.save', body); if (!r.ok) return tell(r.error); S.bill.plans = r.plans; S.open.planEdit = ''; S.open.planNew = false; done(say); };
  const add = () => save({ name: val('pl-name'), checkoutUrl: val('pl-url'), price: Number(val('pl-price')), cycleMonths: Number(val('pl-months') || 1), productId: val('pl-product'), sortOrder: Number(val('pl-order') || 0) },
    '결제 옵션을 넣었습니다 — 사용자의 «내 계정 → 이용권»에 [결제하기]가 섭니다');
  // 그로블 쪽에 넣을 주소 셋 — 손으로 짓지 않게 이 사이트의 주소로 지어 [복사]로 건넨다(게시한 주소에서 열어야 그 주소가 나온다)
  const addr = (label, url, where) => h('div', { class: 'line', style: 'align-items:center' },
    h('span', { class: 'when', style: 'min-width:84px', text: label }),
    h('div', { class: 'mark', style: 'font-size:13px;padding:4px 8px;word-break:break-all;white-space:normal', text: url }), copyBtn(url),
    h('span', { class: 'when', text: where }));
  return h('div', null,
    h('div', { class: 'card-box', style: 'margin-bottom:14px' },
      h('div', { class: 'lab', text: '그로블에 넣을 주소 — [복사]해서 그로블 화면에 붙여 넣으세요' }),
      addr('진입 페이지', location.origin + '/login?signup', '← 그로블 상품 설정(결제창에 오기 전 페이지)'),
      addr('이동 페이지', location.origin + '/account.html?paid=1', '← 그로블 상품 설정(결제를 마친 뒤 돌아올 페이지)'),
      addr('웹훅 주소', location.origin + '/api/billing/groble', '← 그로블 «내 스토어 → 연동»'),
      h('div', { class: 'when', text: '이 주소들은 지금 연 사이트의 주소로 지어집니다 — 게시한 주소(….replit.app)에서 열었을 때 복사하세요.' })),
    P.length ? P.map((p) => h('div', { style: 'padding:10px 0;border-bottom:1px solid var(--line-soft)' + (p.enabled ? '' : ';opacity:.6') },
      h('div', { class: 'line' },
        h('div', { class: 'name', style: 'flex:1;font-weight:600', text: p.name }),
        h('span', { class: 'mark', text: won(p.price) + ' / ' + p.cycleMonths + '개월' }),
        h('span', { class: 'mark', text: p.productId ? '상품 ' + p.productId : '상품 번호 없음(금액만 견줌)' }),
        h('button', { class: 'tg' + (p.enabled ? ' on' : ''), title: p.enabled ? '켜짐' : '꺼짐', onclick: () => save({ id: p.id, enabled: !p.enabled }, p.enabled ? '껐습니다 — 새 결제는 받지 않고, 이 상품을 쓰던 사람의 갱신은 계속 받습니다' : '켰습니다') }),
        h('button', { class: 'btn-text', text: S.open.planEdit === p.id ? '닫기' : '고치기', onclick: () => { S.open.planEdit = S.open.planEdit === p.id ? '' : p.id; render(); } })),
      h('div', { class: 'when', style: 'word-break:break-all;white-space:normal', text: p.checkoutUrl + ' · 차례 ' + p.sortOrder }),
      S.open.planEdit === p.id ? h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
        field('이름', 'pe-name-' + p.id, 'text', { value: p.name }),
        field('그로블 결제창 링크', 'pe-url-' + p.id, 'text', { value: p.checkoutUrl, spellcheck: 'false' }),
        p.productId ? null : field('상품 번호(웹훅의 content.id — 한 번만)', 'pe-product-' + p.id, 'text', { spellcheck: 'false' }),
        field('차례', 'pe-order-' + p.id, 'text', { value: String(p.sortOrder) }),
        h('button', { class: 'btn-line', text: '저장', onclick: () => save({ id: p.id, name: val('pe-name-' + p.id), checkoutUrl: val('pe-url-' + p.id), sortOrder: Number(val('pe-order-' + p.id) || 0),
          ...($('pe-product-' + p.id) && val('pe-product-' + p.id) ? { productId: val('pe-product-' + p.id) } : {}) }, '고쳤습니다') })) : null))
      : h('div', { class: 'when', text: '아직 결제 옵션이 없습니다 — 그로블에서 정기결제 상품(결제창)을 만든 뒤 여기에 넣으세요' }),
    S.open.planNew ? h('div', { class: 'card-box', style: 'margin-top:12px' },
      h('div', { class: 'line', style: 'align-items:flex-end' }, field('이름(사용자에게 보임)', 'pl-name', 'text', { placeholder: '예: 월 이용권(5,000원)' }), field('그로블 결제창 링크', 'pl-url', 'text', { placeholder: 'https://…', spellcheck: 'false' })),
      h('div', { class: 'line', style: 'align-items:flex-end;margin-top:8px' }, field('가격(원)', 'pl-price', 'text', { value: '5000' }), field('주기(개월)', 'pl-months', 'text', { value: '1' }),
        field('상품 번호(선택 — 웹훅의 content.id)', 'pl-product', 'text', { spellcheck: 'false' }), field('차례', 'pl-order', 'text', { value: '0' })),
      h('div', { class: 'line', style: 'margin-top:10px' }, h('button', { class: 'btn-red', text: '넣기', onclick: add }), h('button', { class: 'btn-text', text: '취소', onclick: () => { S.open.planNew = false; render(); } })))
      : h('button', { class: 'btn', style: 'margin-top:12px', text: '+ 새 결제 옵션', onclick: () => { S.open.planNew = true; render(); } }),
    h('div', { class: 'when', style: 'margin-top:10px', text: '가격을 바꾸려면 그로블에서 새 상품을 만들고 새 줄을 넣은 뒤 옛 줄을 끕니다(그로블 정기결제는 판매된 옵션을 고칠 수 없다). 옛 상품을 쓰던 사람의 갱신은 계속 받습니다.' }));
}

async function loadRules() {
  const r = await edu('billing.rules');
  if (!r.ok) return tell(r.error);
  S.bill.rules = r.rules; render();
}
function rulesTab() {
  if (!S.bill.rules && !S.bill.loadingRules) { S.bill.loadingRules = true; loadRules().finally(() => { S.bill.loadingRules = false; }); }
  const R = S.bill.rules;
  if (!R) return h('div', { class: 'when', text: '불러오는 중…' });
  const save = async () => {
    const r = await edu('billing.rules.save', { trialDays: Number(val('ru-trial')), graceDays: Number(val('ru-grace')), refundDays: Number(val('ru-refund')) });
    if (!r.ok) return tell(r.error);
    S.bill.rules = r.rules; done('이용 규칙을 저장했습니다 — 무료 체험은 이제부터 가입하는 사람에게, 여유는 다음 결제부터');
  };
  const flipNoUse = async () => {
    const r = await edu('billing.rules.save', { refundNoUse: !R.refundNoUse });
    if (!r.ok) return tell(r.error);
    S.bill.rules = r.rules; done(r.rules.refundNoUse ? '환불은 AI 작업을 하기 전까지만 받습니다' : '환불 기간 안이면 AI 작업을 했어도 받습니다');
  };
  const saveMail = async () => {
    const r = await edu('billing.rules.save', { notifyEmail: val('ru-mail') });
    if (!r.ok) return tell(r.error);
    S.bill.rules = r.rules; done(r.rules.notifyEmail ? '알림 메일 주소를 저장했습니다 — [시험 메일 보내기]로 확인해 보세요' : '알림 메일 주소를 지웠습니다');
  };
  const testMail = async () => {
    const r = await edu('billing.mail.test');
    if (!r.ok) return tell(r.error);
    done('시험 메일을 보냈습니다 — 받은편지함(없으면 스팸함)을 확인해 주세요');
  };
  return h('div', null,
    h('div', { class: 'line', style: 'align-items:flex-end' },
      field('가입 직후 무료 체험(일, 기본 0)', 'ru-trial', 'text', { value: String(R.trialDays) }),
      field('결제 실패 · 해지 뒤 여유(일, 기본 10)', 'ru-grace', 'text', { value: String(R.graceDays) }),
      field('환불 기간(구독 시작 후 일, 기본 7 · 0 이면 받지 않음)', 'ru-refund', 'text', { value: String(R.refundDays) }),
      h('button', { class: 'btn-red', text: '저장', onclick: save })),
    toggleRow('환불은 구독 시작 뒤 AI 작업을 하기 전까지만', !!R.refundNoUse, flipNoUse, '기본: 끔 — AI 작업 수는 알림 메일에 실립니다. 그로블 상품 설명 · 약관의 환불 규정과 같게 둡니다'),
    h('div', { class: 'card-box', style: 'margin-top:16px' },
      h('div', { class: 'lab', text: '알림 메일 — 환불 요청 · 구독 취소가 오면 이 주소로' }),
      h('div', { class: R.mailOn ? 'when' : 'notice', text: R.mailOn ? '보내는 길 켜짐(Secrets 의 RESEND_API_KEY)' : '보내는 길 꺼짐 — Replit Secrets 에 RESEND_API_KEY 를 넣고 다시 게시하면 켜집니다' }),
      h('div', { class: 'line', style: 'align-items:flex-end' },
        field('받을 메일 주소', 'ru-mail', 'text', { value: R.notifyEmail || '', spellcheck: 'false', inputmode: 'email', autocapitalize: 'none' }),
        h('button', { class: 'btn-line', text: '저장', onclick: saveMail }),
        h('button', { class: 'btn-text', text: '시험 메일 보내기', onclick: testMail })),
      h('div', { class: 'when', text: 'Resend 에 가입한 이메일과 같은 주소로만 갑니다(도메인을 확인하기 전).' })),
    h('div', { class: 'when', style: 'margin-top:8px', text: '여유 — 다음 결제일 뒤 이만큼 더 씁니다(그로블의 갱신 재시도 3일 + 유예 7일). 갱신 소식이 끝내 오지 않아도 저절로 끝납니다.' }),
    toggleRow('이용권이 끝났을 때 막는 것: 새 AI 작업만', true, null, '편집 · 열람 · 내보내기는 늘 됩니다 — 바꿀 수 없습니다(원칙: AI 실패 · 결제가 작품을 막지 않는다)'),
    googleCard());
}
// 구글 로그인(§4-9) — 켜졌는가(Secrets 의 두 값) · 구글 클라우드 «승인된 리디렉션 URI»에 넣을 돌아오는 주소
function googleCard() {
  const on = !!(S.me && S.me.google && S.me.google.on);
  const cb = location.origin + '/api/auth/google/callback';
  return h('div', { class: 'card-box', style: 'margin-top:16px' },
    h('div', { class: 'lab', text: '구글 로그인' }),
    h('div', { class: 'when', text: on ? '켜짐 — 로그인 화면에 [Google 계정으로 계속하기]가 섭니다' : '꺼짐 — Secrets 에 GOOGLE_CLIENT_ID · GOOGLE_CLIENT_SECRET 을 넣고 다시 게시하면 켜집니다' }),
    h('div', { class: 'line', style: 'align-items:center' },
      h('div', { class: 'mark', style: 'font-size:13px;padding:4px 8px;word-break:break-all;white-space:normal', text: cb }), copyBtn(cb),
      h('span', { class: 'when', text: '← 구글 클라우드 «승인된 리디렉션 URI»(게시한 주소에서 열었을 때 복사)' })));
}

// ---------------------------------------------------------------- 운영(플랫폼 관리자)

// ---------------------------------------------------------------- 운영(최상위 관리자) — 현황 · 감사 기록 · 단계(전체) · 계정
S.opsTab = '현황';
function opsView() {
  const t = S.opsTab;
  if (t === '현황' && !S.ops && !S.open.opsLoading) { S.open.opsLoading = true; edu('ops.overview').then((r) => { S.open.opsLoading = false; if (r.ok) { S.ops = r; render(); } }); }
  if (t === '감사 기록' && !S.audit.all && !S.open.auditLoading) { S.open.auditLoading = true; edu('audit.list', {}).then((r) => { S.open.auditLoading = false; if (r.ok) { S.audit.all = r.entries; render(); } }); }
  const userStatus = async (status) => {
    const loginId = val('us-id');
    if (!loginId) return tell('아이디를 적어 주세요');
    if (status === 'disabled' && !confirm(loginId + ' — 계정을 멈출까요? 곧바로 로그아웃되고 다시 열 때까지 들어올 수 없습니다.')) return;
    const r = await edu('user.status', { loginId, status });
    if (!r.ok) return tell(r.error);
    S.sayGood = true; S.fresh = true; S.say = r.loginId + (status === 'disabled' ? ' — 멈췄습니다' : ' — 다시 열었습니다'); $('us-id').value = ''; render();
  };
  const orgList = Object.values(S.orgs);
  // 자유 가입판은 현황 다음에 고객 · 결제 탭 넷을 더한다(§4-6)
  const tabs = [['현황', '현황'], ['감사 기록', '감사 기록'], ['단계', '단계 · 강의 카드(전체)'], ['계정', '계정 멈추기']];
  if (S.edition === 'open') tabs.splice(1, 0, ['고객', '고객'], ['결제 기록', '결제 기록'], ['결제 옵션', '결제 옵션'], ['이용 규칙', '이용 규칙']);
  return h('div', null,
    tabRow(tabs, t, (k) => { S.opsTab = k; S.say = ''; if (k === '현황') S.ops = null; if (k === '결제 기록') S.bill.events = null; if (k === '고객') S.bill.cust.list = null; render(); }),
    t === '현황' ? h('div', null,
      S.edition === 'open' ? null : h('div', { class: 'lab', text: '기관' }),
      S.edition === 'open' ? null : orgList.length ? orgList.map(({ org }) => {
        const live = liveOf(org.id); const keyed = keyedOf(S.orgs[org.id].keys);
        return h('div', { class: 'row', onclick: () => { S.sel = org.id; render(); } },
          h('div', { class: 'name', text: org.name }),
          org.status !== 'active' ? h('span', { class: 'mark', style: 'color:var(--red)', text: '멈춤' }) : null,
          h('span', { class: 'mark', style: live ? '' : 'color:var(--red)', text: live ? '~ ' + (live.ends_at ? day(live.ends_at) : '기한 없음') : '이용 기간 없음' }),
          h('span', { class: 'mark', style: keyed.length ? '' : 'color:var(--red)', text: keyed.length ? keyed.map((p) => AI_CO[p]).join(' · ') : 'AI 키 없음' }),
          h('div', { class: 'when', text: '수업 ' + S.orgs[org.id].classes.filter((c) => c.status === 'active').length }));
      }) : h('div', { class: 'when', text: '아직 기관이 없습니다 — 위의 [+ 새 기관]으로 만드세요' }),
      S.ops ? opsBox() : h('div', { class: 'when', style: 'margin-top:10px', text: '불러오는 중…' })) : null,
    t === '감사 기록' ? (S.audit.all ? auditRows('all') : h('div', { class: 'when', text: '불러오는 중…' })) : null,
    t === '고객' ? customersTab() : null,
    t === '결제 기록' ? eventsTab() : null,
    t === '결제 옵션' ? plansTab() : null,
    t === '이용 규칙' ? rulesTab() : null,
    t === '단계' ? h('div', null, h('div', { class: 'when', style: 'margin-bottom:8px', text: '모든 기관 · 개인에게 쓰이는 기본입니다(기관은 그 위에 다시 고쳐 쓸 수 있습니다). 원문은 남습니다.' }), wfEditor(null)) : null,
    t === '계정' ? h('div', null,
      h('div', { class: 'when', style: 'margin-bottom:8px', text: '멈추면 곧바로 로그아웃되고 다시 열 때까지 들어올 수 없습니다. 작품은 그대로입니다.' }),
      h('div', { class: 'line', style: 'align-items:flex-end' }, field('아이디', 'us-id', 'text', { autocapitalize: 'none', spellcheck: 'false' }),
        h('button', { class: 'btn-red', text: '멈추기', onclick: () => userStatus('disabled') }),
        h('button', { class: 'btn-line', text: '다시 열기', onclick: () => userStatus('active') }))) : null);
}

// 새 기관 — 이용 기간을 바로 연다(기본값 90일 · 학생 40자리 — 끄면 기관만)
// 새 기관 — 이용 기간을 바로 열고(기본 90일 · 학생 40자리), 기관 관리자 계정도 함께 만든다(선택 — 비우면 기관만).
// 기관 자체는 로그인 계정이 아니다 — 로그인은 사람(기관 관리자)의 아이디 · 비밀번호로 한다.
function newOrgView() {
  if (S.open.withLic == null) S.open.withLic = true;
  setTimeout(() => wireIdCheck('no-aid'), 0);   // 아이디를 쓸 수 있는지 치는 동안 본다
  const gen = () => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; const r = crypto.getRandomValues(new Uint8Array(12)); $('no-apw').value = [...r].map((x, i) => (i && i % 4 === 0 ? '-' : '') + a[x % a.length]).join(''); };
  const go = async () => {
    const aid = val('no-aid'); const apw = val('no-apw');
    // 기관을 만들기 전에 막을 수 있는 것은 먼저 막는다(기관만 만들어지고 계정이 실패하는 일을 줄인다)
    if (!aid && (val('no-aname') || apw)) return tell('기관 관리자 아이디를 넣어 주세요(계정 없이 기관만 만들려면 세 칸을 모두 비웁니다)');
    if (aid && apw && apw.length < 10) return tell('기관 관리자 비밀번호는 10자 이상 — 비우면 자동으로 지어 드립니다');
    if (aid) {
      const chk = await edu('login.available', { loginId: aid });
      if (chk.ok && !chk.available) return tell('기관 관리자 아이디 — ' + chk.say);
    }
    const r = await edu('org.create', { name: val('no-name'), slug: val('no-slug') });
    if (!r.ok) return tell(r.error);
    const id = r.organization.id;
    const l = S.open.withLic ? await edu('license.issue', { orgId: id, days: Number(val('no-days')) || 90, seatLimit: Number(val('no-seats')) || null }) : null;
    const m = aid ? await edu('member.create', { orgId: id, role: 'organization_admin', loginId: aid, displayName: val('no-aname'), password: apw }) : null;
    S.sel = id;
    const bad = [l && !l.ok ? '이용 기간을 열지 못했습니다 — ' + l.error : '', m && !m.ok ? '기관 관리자 계정을 만들지 못했습니다 — ' + m.error : ''].filter(Boolean);
    if (m && m.ok) S.shown['mk-' + id] = m.loginId + ' / ' + (m.password || apw);   // [사용자] 탭에 그대로 보인다(지금만)
    S.orgTab[id] = m && m.ok ? '사용자' : 'AI';
    S.sayGood = !bad.length;
    S.say = bad.length ? '«' + r.organization.name + '» 기관은 만들었지만 — ' + bad.join(' · ')
      : '«' + r.organization.name + '» 기관을 만들었습니다' + (l ? ' · 이용 기간을 열었습니다' : '') + (m ? ' · 기관 관리자 계정을 만들었습니다(아래 아이디 / 비밀번호를 전해 주세요)' : '') + ' — 다음으로 [AI] 탭에서 키를 넣으세요';
    await load();
  };
  return h('div', { class: 'card-box' },
    h('div', { class: 'lab', text: '기관' }),
    h('div', { class: 'line', style: 'align-items:flex-end' }, field('기관 이름', 'no-name'),
      field('영문 약칭(선택 — 비워 두면 자동)', 'no-slug', 'text', { placeholder: '예: sea-school', autocapitalize: 'none', spellcheck: 'false' })),
    h('div', { class: 'line', style: 'margin-top:12px;gap:6px;cursor:pointer', onmousedown: () => { S.open.withLic = !S.open.withLic; render(); } },
      h('button', { class: 'ck' + (S.open.withLic ? ' on' : '') }), h('span', { text: '이용 기간도 바로 열기' })),
    S.open.withLic ? h('div', { class: 'line', style: 'margin-top:8px;align-items:flex-end' },
      field('이용 일수', 'no-days', 'text', { value: '90' }), field('학생 자리', 'no-seats', 'text', { value: '40' })) : null,
    h('div', { class: 'lab', style: 'margin-top:18px', text: '기관 관리자 계정(선택 — 이 기관을 관리할 사람이 로그인하는 계정. 비우면 기관만 만들고, 나중에 [사용자] 탭에서 만들거나 초대합니다)' }),
    // 위쪽 맞춤 — 아이디 칸 아래에 «쓸 수 있는지» 한 줄이 붙어도 다른 칸이 밀리지 않게
    h('div', { class: 'line', style: 'align-items:flex-start' },
      field('아이디(영문 소문자 · 숫자, 3자 이상)', 'no-aid', 'text', { autocapitalize: 'none', spellcheck: 'false' }),
      field('이름', 'no-aname'),
      field('비밀번호(10자 이상 — 비우면 자동)', 'no-apw', 'text', { autocomplete: 'off', spellcheck: 'false' }),
      h('button', { class: 'btn-text', style: 'margin-top:30px', text: '자동으로', onclick: gen })),
    h('div', { class: 'line', style: 'margin-top:14px' }, h('button', { class: 'btn-red', text: '기관 만들기', onclick: go })));
}

// 관리 화면 — 맨 위 줄에서 고른다(운영 · 기관마다 · 새 기관). 기관이 하나뿐인 기관 관리자는 줄 없이 곧바로.
function manageView() {
  const ids = Object.keys(S.orgs);
  const admin = !!S.me.platformAdmin;
  if (!S.sel || (S.sel !== 'ops' && S.sel !== 'new' && !S.orgs[S.sel])) S.sel = admin ? 'ops' : ids[0];
  const pills = [...(admin ? [['ops', '운영']] : []), ...ids.map((id) => [id, S.orgs[id].org.name]), ...(admin && S.edition !== 'open' ? [['new', '+ 새 기관']] : [])];
  return h('div', null,
    pills.length > 1 ? h('div', { class: 'line', style: 'margin-bottom:16px;flex-wrap:wrap' },
      pills.map(([k, name]) => h('button', { class: S.sel === k ? 'nav-btn on' : 'nav-btn', style: S.sel === k ? 'background:var(--blue);color:var(--on-color)' : '', text: name, onclick: () => { S.sel = k; S.say = ''; render(); } }))) : null,
    S.sel === 'ops' ? opsView() : S.sel === 'new' ? newOrgView() : orgView(S.sel));
}

// 화면 밝기 — 기본은 어둡게, 고르면 이 브라우저가 기억한다
function themeBox() {
  const light = document.documentElement.dataset.theme === 'light';
  const flip = () => {
    if (light) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = 'light';
    try { localStorage.setItem('se-theme', light ? 'dark' : 'light'); } catch { /* 이번 창에서만 */ }
    render();
  };
  return section('화면',
    h('div', { class: 'line' }, h('div', { class: 'lab', style: 'margin:0', text: '밝은 화면' }), h('button', { class: 'tg' + (light ? ' on' : ''), onclick: flip })));
}

// ---------------------------------------------------------------- 그리기

// 지금 들어와 있는 아이디와 신분 — 위쪽 제목 아래(여럿이면 모두)
function whoLine() {
  if (!S.me || !S.me.loginId) return null;
  const held = new Set([...(S.me.organizations || []).flatMap((o) => o.roles || []), ...(S.me.classes || []).map((c) => c.role)]);
  const names = [S.me.platformAdmin ? '최상위 관리자' : null, ...['organization_admin', 'instructor', 'student'].filter((r) => held.has(r)).map((r) => ROLE_SAY[r])].filter(Boolean);
  return h('div', { class: 'who' }, h('span', { class: 'who-id', text: S.me.loginId }), h('span', { text: names.length ? names.join(' · ') : '개인' }));
}

// 다시 그려도 치던 글은 남긴다 — 칸을 새로 지으면 친 것이 사라졌다(2026-10-07 검수: 기관 이름을 치고 «이용 기간도 바로 열기»를 누르니 이름이 지워짐).
// 일이 막 끝났을 때(S.fresh — 성공 알림)만 비운 채로 둔다: 만든 뒤에 칸이 비어야 다음 것을 넣는다. 실패했을 때는 친 것을 그대로 두어 고쳐 넣게 한다.
function render() {
  const keep = {};
  const was = document.activeElement && document.activeElement.id;
  let caret = null;
  if (!S.fresh) for (const el of document.querySelectorAll('#root input[id], #root textarea[id]')) {
    if (el.type === 'hidden' || el.type === 'checkbox' || el.value === el.defaultValue) continue;
    keep[el.id] = el.value;
    if (el.id === was) { try { caret = el.selectionStart; } catch { /* 고르기가 없는 칸 */ } }
  }
  S.fresh = false;
  paint();
  for (const [id, v] of Object.entries(keep)) {
    const el = $(id);
    if (!el || !('value' in el)) continue;
    el.value = v;
    if (el.dataset.lock) { el.readOnly = false; delete el.dataset.lock; }
  }
  if (was && $(was) && keep[was] != null) { $(was).focus(); try { if (caret != null) $(was).setSelectionRange(caret, caret); } catch { /* 고르기가 없는 칸 */ } }
}

function paint() {
  const head = (title) => h('div', { class: 'line', style: 'margin-bottom:22px;align-items:flex-start' },
    h('div', { style: 'flex:1' }, h('div', { class: 'top-name', style: 'font-size:28px', text: title }), whoLine()),
    S.loggedIn ? h('a', { class: 'btn-line', href: '/', text: '작업실로' }) : h('a', { class: 'btn-line', href: '/login', text: '로그인' }));
  const notice = S.say ? h('div', { class: 'notice' + (S.sayGood ? ' good' : ''), style: 'margin-bottom:14px', text: S.say }) : null;
  if (PAGE === 'manage') {
    // 관리 화면 — 운영자 · 기관 관리자만. 서버도 문마다 다시 본다(이 갈림은 안내일 뿐이다).
    const can = S.me && (S.me.platformAdmin || Object.keys(S.orgs).length);
    $('root').replaceChildren(h('div', { class: 'body' }, head('관리'), notice,
      !S.loggedIn ? h('div', { class: 'when', text: '로그인이 필요합니다' })
        : !can ? h('div', { class: 'when', text: '관리 권한이 없습니다 — 운영자나 기관 관리자만 들어옵니다' })
          : manageView()));
    return;
  }
  if (PAGE === 'account') {
    $('root').replaceChildren(h('div', { class: 'body' }, head('내 계정'), notice,
      S.loggedIn ? [S.edition === 'open' ? passBox() : joinBox(), myKeyBox(), subBox(), googleBox(), passwordBox(), themeBox()] : h('div', { class: 'when', text: '로그인이 필요합니다' })));
    return;
  }
  $('root').replaceChildren(h('div', { class: 'body' }, head('내 수업'), notice,
    S.loggedIn ? (myClasses() || h('div', { class: 'when', style: 'margin-bottom:14px', text: '들어가 있는 수업이 없습니다' })) : h('div', { class: 'when', text: '로그인이 필요합니다' }),
    S.loggedIn ? joinBox() : null));
}

load();
