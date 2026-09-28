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

  return [
    {
      title: '작품 하나가 파일 하나',
      say: '이 프로그램은 작품 하나를 내 컴퓨터의 파일 하나로 둡니다. 계정도, 클라우드도, 따로 낼 돈도 없습니다.\n'
        + '지금부터 「대리 상주」라는 가상의 작품으로, 모형이 아니라 실제 화면을 그대로 보여 드립니다.',
      spot: '.cards .card',
      act() {
        S.pid = null; S.project = null; S.open = null; S.pick = null; S.confirm = null; S.menu = false;
        S.projects = [{ id: d.id, name: d.name, updatedAt: t.now, createdAt: t.now }];
      },
    },
    {
      title: '넣자마자 읽습니다',
      say: '작품을 만들며 넣은 자료는 쌓이기만 하지 않습니다. 만들자마자 한 번 읽고 정리한 문서를 남깁니다.\n'
        + '왼쪽 줄은 지금 무엇을 하고 있는지와 얼마나 되었는지만 말합니다 — 진행률 막대를 두지 않은 것은 없는 숫자를 지어내지 않으려는 선택입니다.',
      spot: '.side-jobs .job',
      act() {
        S.pid = d.id; S.project = d; S.tab = '작업실'; S.open = null;
        d.jobs = [job({ id: 'j_prep', kind: 'agents', title: '에이전트 준비', step: '자료 분석', stepAt: t.now - 74 * 1000, startedAt: t.now - 74 * 1000 })];
      },
    },
    {
      title: '무엇이 비었는지부터 말합니다',
      say: '자료를 읽고 «정해진 것»과 «비어 있는 것»을 갈라 둡니다.\n'
        + '쓰기 전에 무엇이 비었는지 아는 것이 가장 값진 일입니다 — 빈 자리를 그럴듯한 말로 메우지 않습니다.',
      spot: null,
      act() {
        d.jobs = [job({ id: 'j_prep', kind: 'agents', title: '에이전트 준비', status: 'done', endedAt: t.now, docIds: ['d_study'] })];
        S.open = { type: 'doc', id: 'd_study' };
      },
    },
    {
      title: '붉은 스위치 — 설정이 흔들리지 않는 까닭',
      say: '이 붉은 스위치가 이 프로그램의 심장입니다. 켜 둔 문서는 일할 때마다 맨 먼저 다시 읽고 «최우선 사실»로 싣습니다.\n'
        + '제 판단보다 앞세우게 하고, 고치자고 제안하지도 못하게 합니다. 작가가 못 박은 것은 흔들리지 않습니다.',
      spot: () => document.querySelector('.sec .row.final'),
      act() {
        S.open = null;
        doc('d_rule').isFinal = true;
        doc('d_char').isFinal = true;
        doc('d_treat').isFinal = true;
      },
    },
    {
      title: '참조 — 자르지 않고 통째로 싣습니다',
      say: '새 회차를 짓기 전에 무엇을 읽힐지 겁니다. 여기 건 문서는 통째로 실립니다 — 몰래 간추리거나 뒤를 잘라 넣지 않습니다.\n'
        + '무엇을 걸었는지 보면 이번에 무엇을 읽고 쓸지가 그대로 보입니다.',
      spot: labRow('참조'),
      act() {
        S.open = { type: 'doc', id: 'd_ep1' };
        doc('d_ep1').refIds = ['d_treat', 'd_rule', 'd_char'];
      },
    },
    {
      title: '사람을 걸어도 전문가는 물러나지 않습니다',
      say: '이 자리에는 그 일을 원래 아는 사람이 붙박여 있습니다. 작가가 지은 사람은 그 위에 더해집니다.\n'
        + '뗄 수 없는 «자리» 칩에는 × 가 없습니다 — 개성을 얹는다고 기본기가 빠지지 않습니다.',
      spot: labRow('에이전트'),
      act() { doc('d_ep1').agentIds = ['g_muk']; },
    },
    {
      title: '누르면 십 분을 넘기기도 합니다',
      say: '[생성]을 누르면 일이 작업으로 떨어집니다. 창을 닫아도 계속 돌고, 여러 작업이 한꺼번에 돌 수 있습니다.\n'
        + '급하지 않으면 [일시중지]로 세워 두었다가 [이어 하기]로 그 자리에서 잇습니다 — 돌던 한 건은 버리지 않습니다.',
      spot: '.side-jobs .job',
      act() {
        S.open = null;
        d.jobs = [
          job({ id: 'j_ep1', title: '1화 — 대역', targetId: 'd_ep1', step: '1화 — 대역', stepAt: t.now - 8 * 60 * 1000, startedAt: t.now - 8 * 60 * 1000 }),
          job({ id: 'j_prep', kind: 'agents', title: '에이전트 준비', status: 'done', endedAt: t.now, docIds: ['d_study'] }),
        ];
      },
    },
    {
      title: '쓴 글은 지워지지 않습니다',
      say: '일이 끝나면 본문이 채워지고, 그 전의 판은 «이력»에 남아 언제든 되돌립니다.\n'
        + '마음에 들지 않아도 잃는 것이 없습니다. 본문은 그 자리에서 손으로 고쳐도 됩니다.',
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
      title: '«어딘가 이상하다»가 아니라 «여기와 여기»',
      say: '회차가 쌓이면 앞뒤가 어긋납니다. 모순 검사는 양쪽 원문을 그대로 인용해 어느 줄과 어느 줄이 부딪히는지 내놓습니다.\n'
        + '확정본이 걸려 있으면 어느 쪽이 틀렸는지까지 못 박고, 없으면 고르는 일은 작가에게 남깁니다.',
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
      title: '비싼 두뇌가 몰래 돌지 않습니다',
      say: '걸어 둔 사람들이 서로 다른 모델을 쓰기로 되어 있으면 부르기 직전에 한 번만 묻습니다.\n'
        + '고른 값은 이번 한 번에만 쓰이고 사람에게도 작품에도 저장되지 않습니다. 묻지 않고 도는 일이 없습니다.',
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
      title: '여럿이 따로 말하고, 편들지 않는 자리가 모읍니다',
      say: '평하는 사람을 여럿 걸면 호출이 한 번이 아닙니다. 각자 따로 읽어 제 합평을 내고, 마지막에 아무도 걸지 않은 자리가 그것들을 하나로 모읍니다.\n'
        + '의견이 갈리면 평균 내지 않습니다 — 왜 갈렸는지와 정하는 일이 누구 몫인지를 남깁니다.',
      spot: null,
      act() {
        S.confirm = null;
        doc('d_review').body = TOUR_REVIEW;
        d.jobs.unshift(job({ id: 'j_rev', title: '합평 — 1화', targetId: 'd_review', status: 'done', endedAt: t.now, docIds: ['d_review'] }));
        S.open = { type: 'doc', id: 'd_review' };
      },
    },
    {
      title: '막히면 문서를 짓기 전에 묻습니다',
      say: '여기는 글을 짓는 자리가 아니라 함께 궁리하는 자리입니다. 지난 내 말을 고치면 그 자리에서 갈래가 갈라지고 원래 흐름은 그대로 남습니다.\n'
        + '논의가 익으면 [문서로 정리]로 지금 갈래만 결론서가 됩니다.',
      spot: null,
      act() { S.open = { type: 'thread', id: 'h_talk' }; },
    },
    {
      title: '언제든 꺼내 갑니다',
      say: '쓴 글은 .md 파일로 언제든 꺼냅니다. 구획을 통째로 고르면 한 파일로 받습니다.\n'
        + '여기까지가 「대리 상주」였습니다 — 이 자리에 설 것은 당신의 작품입니다.',
      spot: null,
      act() { S.open = null; S.tab = '작업실'; },
    },
  ];
}

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
  const ring = $('tour-ring');
  if (!ring) return;
  const st = S.tour.steps[S.tour.i];
  const n = typeof st.spot === 'function' ? st.spot() : (st.spot ? document.querySelector(st.spot) : null);
  if (!n) { ring.style.display = 'none'; return; }
  n.scrollIntoView({ block: 'center', inline: 'nearest' });
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
function tourLayer() {
  const t = S.tour;
  const st = t.steps[t.i];
  const last = t.i === t.steps.length - 1;
  return h('div', { class: 'tour' },
    st.spot ? h('div', { class: 'tour-ring', id: 'tour-ring', style: 'display:none' }) : null,
    h('div', { class: 'panel narrow tour-card' },
      h('div', { class: 'panel-head' },
        h('div', { class: 'name', text: st.title }),
        h('div', { class: 'when', text: (t.i + 1) + ' / ' + t.steps.length })),
      h('div', { class: 'panel-body' },
        h('div', { class: 'tour-say', text: st.say }),
        h('div', { class: 'line tour-foot' },
          h('button', { class: 'btn-line', text: '튜토리얼 나가기', onclick: tourExit }),
          t.i ? h('button', { class: 'btn-text', text: '이전', onclick: () => tourGo(t.i - 1) }) : null,
          h('button', { class: 'btn', text: last ? '튜토리얼 마치기' : '다음', onclick: () => tourGo(t.i + 1) })))));
}
