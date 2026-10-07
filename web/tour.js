'use strict';

// 튜토리얼 — 진짜 화면에 가짜 자료를 태운다.
//
// 새 화면을 그리지 않는다. 화면은 S.pid 와 S.project 한 줄만 보고 갈리므로(app.js 의 render),
// 그 둘에 가짜를 꽂고 render() 를 부르면 app()·workshop()·docPanel()·jobRow() 가 손대지 않은 채 그대로 돈다.
// 창 여닫기도 상태 한 칸이라 «문서 창이 열린다»·«모델이 갈려 묻는다» 를 값 꽂기만으로 재연한다 —
// 고객이 보는 것은 흉내가 아니라 진짜 창 코드다.
//
// 클로드를 한 번도 부르지 않고, 프로젝트 파일에 한 글자도 쓰지 않는다.
// 서버로 나가는 길 셋(api·pull·download)은 S.tour 가 서 있는 동안 모두 막힌다(app.js 의 문지기 세 줄).

// 걸음 하나 = { title, say, spot, act }
// spot 은 눈길을 모을 자리 — 글(선택자)이거나 그 자리를 찾아 주는 함수. 없으면 막을 덮지 않는다.
function tourSteps(t) {
  const d = t.d;                                   // tourGo 가 걸음마다 새로 지어 넘긴다
  const doc = (id) => d.docs.find((x) => x.id === id);
  const job = (o) => Object.assign({
    id: 'j', kind: 'update', title: '', targetId: '', status: 'running',
    step: '', stepAt: t.now, error: '', startedAt: t.now, endedAt: 0, docIds: [],
  }, o);
  // 창 안에서 그 이름표가 붙은 줄을 찾는다 — 반 이름을 새로 붙이지 않으려고 글자로 찾는다.
  const labRow = (text) => () => {
    const lab = [...document.querySelectorAll('#layer1 .lab')].find((n) => n.textContent === text);
    return lab ? lab.parentElement : null;
  };

  // 온라인판(계정으로 들어온 사람)과 개인판(내 PC)은 작품을 두는 자리가 다르다 — 첫 걸음의 말이 갈린다
  const online = !!S.me;
  return [
    {
      title: '작품 만들기',
      say: '가운데 [+]를 눌러 새 작품을 만듭니다. 이름 · 형식 · 자료만 넣으면 됩니다.\n'
        + '만든 작품은 이 목록에 쌓이고, 누르면 열립니다.' + (online ? ' 어느 컴퓨터에서든 로그인하면 이어 쓸 수 있습니다.' : ' 작품은 이 컴퓨터에 저장됩니다.')
        + '\n지금부터 예시 작품 「대리 상주」로 쓰는 법을 보여 드립니다.',
      spot: '.cards .card',
      act() {
        S.pid = null; S.project = null; S.open = null; S.pick = null; S.confirm = null; S.menu = false;
        S.projects = [{ id: d.id, name: d.name, updatedAt: t.now, createdAt: t.now }];
      },
    },
    {
      title: '넣은 자료는 바로 정리됩니다',
      say: '작품을 만들면 AI 가 넣은 자료부터 읽고 정리합니다.\n'
        + '진행 중인 일은 작업 줄에 보입니다. 기다리는 동안 다른 일을 해도 됩니다.',
      spot: '.side-jobs .job',
      act() {
        S.pid = d.id; S.project = d; S.tab = '작업실'; S.open = null;
        d.jobs = [job({ id: 'j_prep', kind: 'agents', title: '자료 분석', step: '자료 분석', stepAt: t.now - 74 * 1000, startedAt: t.now - 74 * 1000 })];
      },
    },
    {
      title: '자료 분석 확인하기',
      say: '정리한 결과는 «자료 분석» 문서로 남습니다. 이미 정해진 것과 아직 비어 있는 것이 나뉘어 있습니다.\n'
        + '비어 있는 것을 보고 무엇을 더 정할지 먼저 확인하세요.',
      spot: null,
      act() {
        d.jobs = [job({ id: 'j_prep', kind: 'agents', title: '자료 분석', status: 'done', endedAt: t.now, docIds: ['d_study'] })];
        S.open = { type: 'doc', id: 'd_study' };
      },
    },
    {
      title: '[단계] — 16단계로 차근차근',
      say: '[단계] 탭에서 작품 규격부터 완성까지 16단계를 차례로 진행할 수 있습니다.\n'
        + '단계마다 생성 → 읽고 고치기 → 승인. 꼭 순서대로 하지 않아도 되고, 결과는 작업실에 문서로 남습니다.',
      spot: () => document.querySelector('.main .sec'),
      act() {
        S.open = null;
        S.tab = '단계';
        tourStageDone(d, 'study');            // 방금 읽은 «자료 분석»을 승인했다
        tourStageDraft(d, 'world', 'd_world', TOUR_WORLD);
      },
    },
    {
      title: '단계 진행하기 — 생성하고 승인',
      say: '단계를 누르면 할 일과 추천 참조가 보입니다. [생성]으로 초안을 만들고, 읽고 고친 뒤 [승인하고 다음 단계로]를 누르세요.\n'
        + '«확정본으로도 켜기»를 고르면 그 문서가 이후 작업의 기준이 됩니다.'
        + (online ? '\n수업 작품이면 단계마다 강의 카드가 함께 보입니다.' : ''),
      spot: () => { const b = document.querySelector('#layer1 .btn-red'); return b ? b.parentElement : null; },
      act() {
        S.open = { type: 'stage', key: 'world', episode: 0, refIds: ['d_study'], final: false };
      },
    },
    {
      title: '확정본 — 바뀌면 안 되는 설정',
      say: '문서의 붉은 스위치를 켜면 확정본이 됩니다. AI 는 확정본을 가장 먼저 읽고, 그 내용을 바꾸지 않습니다.\n'
        + '세계의 규칙 · 인물 설정처럼 지켜야 할 문서에 켜 두세요.',
      spot: () => document.querySelector('.sec .row.final'),
      act() {
        S.open = null;
        S.tab = '작업실';
        doc('d_rule').isFinal = true;
        doc('d_char').isFinal = true;
        doc('d_treat').isFinal = true;
      },
    },
    {
      title: '참조 — AI 에게 읽힐 문서',
      say: '쓰기 전에 [참조]에 문서를 걸면 AI 가 그 문서를 통째로 읽고 씁니다.\n'
        + '[+]로 더하고 × 로 뺍니다.',
      spot: labRow('참조'),
      act() {
        S.open = { type: 'doc', id: 'd_ep1' };
        doc('d_ep1').refIds = ['d_treat', 'd_rule', 'd_char'];
      },
    },
    {
      title: '에이전트 — 함께 쓸 사람',
      say: '[에이전트]에 사람을 걸면 그 사람의 관점이 더해집니다. 에이전트는 [설정] 탭에서 만들고 고칩니다.\n'
        + '«자리»가 붙은 기본 역할은 늘 함께하며 뺄 수 없습니다.',
      spot: labRow('에이전트'),
      act() { doc('d_ep1').agentIds = ['g_muk']; },
    },
    {
      title: '생성 — 기다리지 않아도 됩니다',
      say: '[생성]을 누르면 작업 줄에 작업이 생깁니다. 창을 닫아도 계속 진행되고, 여러 작업을 한꺼번에 돌릴 수 있습니다.\n'
        + '[일시중지]로 멈추고 [이어 하기]로 다시 잇습니다.',
      spot: '.side-jobs .job',
      act() {
        S.open = null;
        d.jobs = [
          job({ id: 'j_ep1', title: '1화 — 대역', targetId: 'd_ep1', step: '1화 — 대역', stepAt: t.now - 8 * 60 * 1000, startedAt: t.now - 8 * 60 * 1000 }),
          job({ id: 'j_prep', kind: 'agents', title: '자료 분석', status: 'done', endedAt: t.now, docIds: ['d_study'] }),
        ];
      },
    },
    {
      title: '이력 — 이전 판으로 되돌리기',
      say: '새로 생성해도 이전 글은 [이력]에 남아 언제든 되돌릴 수 있습니다.\n'
        + '본문은 직접 고쳐도 됩니다.',
      spot: null,
      act() {
        d.jobs[0] = job({ id: 'j_ep1', title: '1화 — 대역', targetId: 'd_ep1', status: 'done', endedAt: t.now, docIds: ['d_ep1'] });
        const e = doc('d_ep1');
        e.body = TOUR_EP1;
        e.versions = [{ i: 0, at: t.now - 52 * 60 * 1000, title: '1화 — 대역', body: TOUR_EP1_OLD }];
        S.fold['hist:d_ep1'] = true;
        S.open = { type: 'doc', id: 'd_ep1' };
      },
    },
    {
      title: '모순 검사 — 어긋난 곳 찾기',
      say: '작업실 [+] → [모순 검사]로 만듭니다. 검사할 문서를 걸면 어긋나는 곳을 찾아, 부딪히는 문장을 원문 그대로 보여 줍니다.\n'
        + '확정본과 어긋나면 어느 쪽이 틀렸는지도 알려 줍니다. 고칠 쪽을 골라 고치세요.',
      spot: null,
      act() {
        const c = doc('d_check');
        c.targetIds = ['d_ep1', 'd_treat'];
        c.refIds = ['d_rule', 'd_char'];
        c.body = TOUR_CONTRA;
        S.open = { type: 'doc', id: 'd_check' };
      },
    },
    {
      title: '모델 고르기',
      say: '걸어 둔 사람들의 AI 모델이 서로 다르면 실행 전에 이번에 쓸 모델을 묻습니다.\n'
        + '고른 모델은 이번 한 번에만 쓰입니다.',
      spot: null,
      act() {
        const r = doc('d_review');
        r.targetIds = ['d_ep1'];
        r.agentIds = ['g_muk', 'g_first'];
        S.open = { type: 'doc', id: 'd_review' };
        S.confirm = {
          text: '쓰는 모델이 서로 다릅니다',
          acts: [{ label: 'opus', class: 'btn-line', run() {} }, { label: 'sonnet', class: 'btn-line', run() {} }],
        };
      },
    },
    {
      title: '합평 — 여러 사람의 평',
      say: '작업실 [+] → [합평회]로 만듭니다. 평할 문서와 여러 사람을 걸면 각자 평한 뒤 하나로 정리해 줍니다.\n'
        + '의견이 갈린 곳은 갈린 대로 보여 주니, 어느 쪽으로 할지 정하세요.',
      spot: null,
      act() {
        S.confirm = null;
        doc('d_review').body = TOUR_REVIEW;
        d.jobs.unshift(job({ id: 'j_rev', title: '합평 — 1화', targetId: 'd_review', status: 'done', endedAt: t.now, docIds: ['d_review'] }));
        S.open = { type: 'doc', id: 'd_review' };
      },
    },
    {
      title: '논의 — 막힐 때 상의하기',
      say: '작업실 [+] → [논의 스레드]에서 쓰기 전에 AI 와 대화하며 방향을 잡습니다. 지난 말을 고치면 새 갈래로 다시 이어 갈 수 있습니다.\n'
        + '정리가 되면 [문서로 정리]를 눌러 대화 결과를 문서로 만듭니다.',
      spot: null,
      act() { S.open = { type: 'thread', id: 'h_talk' }; },
    },
    {
      title: '내려받기',
      say: '문서는 [다운로드]로 .md 파일로 받습니다. 구획을 통째로 고르면 한 파일로 받습니다.\n'
        + '이제 [+]로 내 작품을 시작해 보세요.',
      spot: null,
      act() { S.open = null; S.tab = '작업실'; },
    },
  ];
}

// ---------------------------------------------------------------- 보기만 하는 스크롤
// 각본이 도는 동안 진짜 화면은 눌리지 않는다(pointer-events: none — 고칠 수 없게). 그래서 휠 · 손가락 끌기가
// 화면에 닿지 않아 창 아래가 잘린 채 남는다. 휠 · 끌기만 받아, 그 자리 밑에서 스크롤할 수 있는 칸을 대신 굴린다.
const TOUR_SCROLLERS = ['#d-body', '#d-out', '#layer2 .panel-body', '#layer1 .panel-body', '.main'];
function tourScrollAt(x, y, dy) {
  const inside = (n) => { const r = n.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  const can = (n) => (dy > 0 ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0);
  for (const sel of TOUR_SCROLLERS) {
    for (const n of document.querySelectorAll(sel)) if (inside(n) && can(n)) { n.scrollTop += dy; return true; }
  }
  const page = document.scrollingElement;
  if (page && can(page)) { page.scrollTop += dy; return true; }
  return false;
}
const tourOnCard = (e) => !!(e.target && e.target.closest && e.target.closest('#tour-card'));
window.addEventListener('wheel', (e) => {
  if (!S.tour || tourOnCard(e)) return;
  if (tourScrollAt(e.clientX, e.clientY, e.deltaY)) e.preventDefault();
}, { passive: false });
let tourTouchY = null;
window.addEventListener('touchstart', (e) => { tourTouchY = S.tour && !tourOnCard(e) && e.touches.length === 1 ? e.touches[0].clientY : null; }, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (tourTouchY == null || !S.tour) return;
  const y = e.touches[0].clientY;
  if (tourScrollAt(e.touches[0].clientX, y, tourTouchY - y)) e.preventDefault();
  tourTouchY = y;
}, { passive: false });

// ---------------------------------------------------------------- 도는 틀

function startTour() {
  const now = Date.now();
  const t = {
    i: 0,
    now,
    d: tourProject(now),
    back: { pid: S.pid, tab: S.tab, project: S.project, projects: S.projects, open: S.open, pick: S.pick, confirm: S.confirm, menu: S.menu, fold: S.fold },
    // 서버 대신 답하는 문 — 기본은 «했다» 한 마디, 펼쳐 보기만 데모 본문을 돌려준다.
    api(op, body) {
      if (op !== 'peek') return { ok: true };
      const id = body && body.id;
      const one = (t.d.docs.find((x) => x.id === id) || t.d.crew.find((x) => x.id === id));
      if (!one) return { ok: false, error: '없습니다' };
      return { ok: true, one: { id, name: one.title || one.name, text: one.body || one.text || one.craft || '' } };
    },
  };
  t.steps = tourSteps(t);
  S.tour = t;
  S.fold = {};
  document.body.classList.add('tour-on');
  tourGo(0);
}

// 걸음마다 가짜 작품을 처음부터 다시 지어 첫 걸음부터 되짚는다.
// 걸음이 앞의 걸음에 얹혀 자라므로, 이렇게 해야 [이전]으로 돌아가도 그때의 화면이 그대로 선다.
function tourGo(n) {
  const t = S.tour;
  if (!t) return;
  if (n >= t.steps.length) return tourExit();
  t.d = tourProject(t.now);
  t.steps = tourSteps(t);
  S.fold = {};
  S.open = null; S.pick = null; S.confirm = null; S.menu = false;
  for (let k = 0; k <= n; k++) t.steps[k].act();
  t.i = n;
  render();
}

function tourExit() {
  const t = S.tour;
  if (!t) return;
  S.tour = null;
  document.body.classList.remove('tour-on');
  Object.assign(S, t.back);
  S.typed = {};
  S.peek = null;
  S.pickOpen = null;
  render();
  pull(true);
}

// 눈길을 모을 자리를 잡는다 — 접혀 있거나 스크롤 밖에 있으면 먼저 보이게 끌어온다.
// 다시 그리기가 모두 끝난 뒤에 불린다(app.js 의 render 끝).
function tourFocus() {
  // 말풍선 키를 재 둔다 — 창(panel)은 그 위까지만 서고, 화면 끝은 그만큼 더 내려 볼 수 있다(style.css --tour-h)
  const card = $('tour-card');
  if (card) document.body.style.setProperty('--tour-h', card.offsetHeight + 'px');
  const ring = $('tour-ring');
  if (!ring) return;
  const st = S.tour.steps[S.tour.i];
  const n = typeof st.spot === 'function' ? st.spot() : (st.spot ? document.querySelector(st.spot) : null);
  if (!n) { ring.style.display = 'none'; return; }
  // 같은 걸음에서 다시 그릴 때는 끌어오지 않는다 — 사람이 내려 본 자리를 되돌리지 않게
  if (S.tour.focused !== S.tour.i) { n.scrollIntoView({ block: 'center', inline: 'nearest' }); S.tour.focused = S.tour.i; }
  const r = n.getBoundingClientRect();
  if (!r.width || !r.height) { ring.style.display = 'none'; return; }
  const pad = 6;
  ring.style.display = '';
  ring.style.top = (r.top - pad) + 'px';
  ring.style.left = (r.left - pad) + 'px';
  ring.style.width = (r.width + pad * 2) + 'px';
  ring.style.height = (r.height + pad * 2) + 'px';
}

// 세 번째 겹 — 말풍선과 눈길 모으는 테. 진짜 화면 위에 얹힌다.
// 말풍선은 접을 수 있다 — 접으면 제목과 단추만 남아 아래 화면이 다 보인다.
function tourLayer() {
  const t = S.tour;
  const st = t.steps[t.i];
  const last = t.i === t.steps.length - 1;
  return h('div', { class: 'tour' },
    st.spot ? h('div', { class: 'tour-ring', id: 'tour-ring', style: 'display:none' }) : null,
    h('div', { class: 'panel narrow tour-card', id: 'tour-card' },
      h('div', { class: 'panel-head' },
        h('div', { class: 'name', text: st.title }),
        h('div', { class: 'when', text: (t.i + 1) + ' / ' + t.steps.length }),
        h('button', { class: 'btn-text', text: t.mini ? '펴기' : '접기', onclick: () => { t.mini = !t.mini; render(); } })),
      h('div', { class: 'panel-body' },
        t.mini ? null : h('div', { class: 'tour-say', text: st.say }),
        h('div', { class: 'line tour-foot' },
          h('button', { class: 'btn-line', text: '튜토리얼 나가기', onclick: tourExit }),
          t.i ? h('button', { class: 'btn-text', text: '이전', onclick: () => tourGo(t.i - 1) }) : null,
          h('button', { class: 'btn', text: last ? '튜토리얼 마치기' : '다음', onclick: () => tourGo(t.i + 1) })))));
}
