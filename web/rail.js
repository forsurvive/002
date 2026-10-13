// 작품의 자동 실행(레일) — 작품 화면 위쪽 바의 [자동 실행] 단추와 그 창. 개인판에서만 그린다.
// 전자책(DESIGN §5-1)은 반자동 · 완전 자동, 이야기(DESIGN §5-2 — 사용자 결정 2026-10-13)는 한 가지 진행으로 자료 분석부터 회차별 집필 계획 세부까지 쓴다(storyRailPanel).
// 단추를 누르면 반자동 · 완전 자동을 고른다. 반자동은 도장에서 기다리고, 완전 자동은 편집장이 판단한다. 언제든 [중지] · 걸음마다 [여기로 되돌리기].
// 서버의 문은 rail.* 와 position.set 뿐이다.
// app.js 의 h · api · S · render · textbox · area · typedVal · clearTyped · jobLine 을 쓴다 — 그리기 때에만 부르므로 이 파일이 먼저 실려도 된다.

const RAIL_MODE = { semi: '반자동', auto: '완전 자동' };
const RAIL_SAY = { running: '진행 중', waiting: '기다림', stopped: '중지됨', done: '완성', failed: '실패' };
const POINT_NAME = { design: '① 설계', toc: '② 목차', review: '③ 개정 계획', finish: '④ 완성', check: '모순 검사' };
const railStory = () => S.project.workflow.template !== 'ebook';

function railOn() {
  return !S.me && !!S.project && !!S.project.workflow;
}

// 위쪽 바의 단추 — 지금 상태를 이름으로 보인다(도는 중 · 승인 대기). 누르면 자동 실행 창
function railButton() {
  if (!railOn()) return null;
  const r = S.project.rail;
  const st = r && r.status;
  return h('button', {
    class: st === 'waiting' ? 'btn-red' : st === 'running' ? 'btn' : 'btn-line',
    text: st === 'running' ? '자동 실행 중' : st === 'waiting' ? (railStory() ? '자동 실행 멈춤' : '승인 대기') : '자동 실행',
    onclick: () => { S.open = { type: 'rail' }; render(); },
  });
}

// 시작 전에 고른 설정(상한 · 장마다 멈춤 · 판정 회차 · 통과 못 하면 · 덧붙일 기준) — 레일이 있으면 곧바로 서버에, 없으면 시작할 때 함께 보낸다
function railSettingsNow() {
  const r = S.project.rail;
  return { cap: 0, stopEachChapter: false, rounds: 2, onFail: 'pass', criteria: '', request: '', ...(r ? r.settings : S.railDraft || {}) };
}
async function railSet(patch) {
  if (S.project.rail) await api('rail.settings', { settings: patch });
  else { S.railDraft = { ...(S.railDraft || {}), ...patch }; render(); }
}
async function railStart(mode) {
  // 자동 실행 요청사항 — 시작 칸에 적은 것을 함께 보낸다(모든 걸음에 실린다)
  const request = typedVal('rail-request', railSettingsNow().request || '');
  const r = await api('rail.start', { mode, settings: { ...(S.project.rail ? {} : (S.railDraft || {})), request } });
  S.railSay = r.ok ? '' : r.error;
  if (r.ok) S.railDraft = null;
  render();
}
async function railDo(op, body = {}) {
  const r = await api(op, body);
  S.railSay = r.ok ? '' : r.error;
  render();
}

// 도장의 문서 — 그 걸음의 결과 문서(완성은 문서가 하나가 아니다)
function railDocOf(key, episode) {
  const st = (S.project.workflow.stages || []).find((x) => x.key === key);
  if (!st) return null;
  const id = episode ? ((st.episodes || []).find((e) => e.episode === episode) || {}).docId : st.docId;
  return id ? (S.project.docs || []).find((d) => d.id === id) || null : null;
}
// 문서를 열고 닫으면 자동 실행 창으로 돌아온다(오던 길 — DESIGN «오던 길을 함께 닫지 않는다»)
const railOpenDoc = (d) => h('button', { class: 'btn-line', text: '문서 열기', onclick: () => { S.open = { type: 'doc', id: d.id, back: { open: { type: 'rail' } } }; render(); } });

function railPanel(close) {
  if (railStory()) return storyRailPanel(close);
  const r = S.project.rail;
  const ro = !!S.project.readOnly;
  const job = (S.project.jobs || []).find((j) => j.rail && (j.status === 'running' || j.status === 'paused'));
  const live = r && (r.status === 'running' || r.status === 'waiting');
  // 고르기 — 아직 시작하지 않았거나 중지 · 완성 · 실패 뒤. 고른 자리부터 잇는다(쓴 것은 그대로)
  const choose = ro || live ? null : h('div', null,
    railRequestBox(),
    h('div', { class: 'lab', text: r ? '다시 이어 하기' : '어떻게 이어 쓸까요?' }),
    h('div', { class: 'line' },
      h('button', { class: 'btn', text: '반자동', onclick: () => railStart('semi') }),
      h('button', { class: 'btn', text: '완전 자동', onclick: () => railStart('auto') })),
    h('div', { class: 'when', text: '반자동 — ① 설계 · ② 목차 · ③ 개정 계획 · ④ 완성에서 멈추고 승인을 기다립니다. 완전 자동 — 그 자리에서 편집장이 판단 · 수정 요청 · 승인합니다.' }));

  let now = null;
  if (r && r.status === 'running') {
    now = h('div', { class: 'when', text: job ? jobLine(job)
      : (S.project.jobs || []).some((j) => j.kind === 'agents' && (j.status === 'running' || j.status === 'paused')) ? '자료 분석을 마치면 이어 씁니다' : '다음 걸음을 정하는 중' });
  } else if (r && r.status === 'waiting' && r.point === 'chapter') {
    const d = railDocOf('chapters', r.episode);
    now = h('div', null,
      h('div', { class: 'lab', text: r.episode + '장을 썼습니다 — 읽어 보고 다음 장으로' }),
      ro ? null : h('div', { class: 'line' }, d ? railOpenDoc(d) : null, h('button', { class: 'btn', text: '다음 장으로', onclick: () => railDo('rail.next') })));
  } else if (r && r.status === 'waiting' && r.point) {
    const d = railDocOf(r.point, 0);
    if (S.railFinal == null) S.railFinal = true;   // 도장 ① 은 확정본으로도(기본 켬 — 헌장이 이후 모든 호출의 최우선 사실)
    now = h('div', null,
      h('div', { class: 'lab', text: r.pointName + ' — 승인을 기다립니다' }),
      r.why ? h('div', { class: 'notice', text: r.why }) : null,
      ro ? null : [
        h('div', { class: 'line' },
          d ? railOpenDoc(d) : null,
          h('button', { class: 'btn-red', text: '승인', onclick: () => railDo('rail.approve', { final: r.point === 'design' && !!S.railFinal }) }),
          r.point === 'design' ? h('div', { class: 'line', style: 'gap:6px;cursor:pointer', onmousedown: () => { S.railFinal = !S.railFinal; render(); } },
            h('button', { class: 'ck' + (S.railFinal ? ' on' : '') }), h('span', { text: '확정본으로도' })) : null),
        r.point !== 'finish' ? h('div', { class: 'line' },
          textbox('rail-fix', '수정 요청 — 이번 한 번만 실려 새 판을 만듭니다', '', { style: 'flex:1;min-width:200px' }),
          h('button', { class: 'btn-line', text: '수정 요청', onclick: async () => { const t = typedVal('rail-fix', ''); await railDo('rail.revise', { text: t }); if (!S.railSay) clearTyped('rail-fix'); render(); } })) : null,
      ]);
  } else if (r && r.status === 'waiting') {
    now = h('div', null,
      h('div', { class: 'notice', text: r.why || '기다리는 중' }),
      ro ? null : h('button', { class: 'btn', text: '이어 하기', onclick: () => railDo('rail.resume') }));
  } else if (r && r.status === 'failed') {
    now = h('div', null,
      h('div', { class: 'notice', text: '실패 — ' + (r.why || '') }),
      ro ? null : h('button', { class: 'btn', text: '이어 하기', onclick: () => railDo('rail.resume') }));
  } else if (r && r.status === 'stopped') {
    now = h('div', { class: 'when', text: '중지됨 — 그 자리부터 완전 수동입니다. 쓴 것은 그대로입니다.' });
  } else if (r && r.status === 'done') {
    // 사람 검토 — 단계 탭을 걷었으므로(DESIGN §3 골격) 완성 단계의 사람 승인은 이 창에서 한다
    now = r.unreviewed ? h('div', null,
      h('div', { class: 'name', text: '완성 — 편집장이 승인했습니다. 읽어 보고 승인하면 사람 검토가 끝납니다.' }),
      ro ? null : h('button', { class: 'btn-red', text: '사람 승인', onclick: () => railDo('stage.approve', { key: 'finish' }) }))
      : h('div', { class: 'name', text: '완성' });
  }

  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' },
      h('div', { class: 'name', text: '자동 실행' }),
      r ? h('span', { class: 'mark', text: RAIL_MODE[r.mode] + ' · ' + (RAIL_SAY[r.status] || r.status) }) : null,
      r && r.unreviewed ? h('span', { class: 'mark', text: '사람 검토 전' }) : null,
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      now,
      // 언제든 중지 — 돌던 걸음도 그 자리에서 끊는다(그 걸음의 문서는 앞 판 그대로)
      live && !ro ? h('div', { class: 'line' },
        h('button', { class: 'btn-red', text: '중지', onclick: () => railDo('rail.stop') }),
        r ? h('span', { class: 'when', text: '호출 ' + (r.calls || 0) + (r.settings && r.settings.cap ? ' / ' + r.settings.cap : '') }) : null) : null,
      choose,
      S.railSay ? h('div', { class: 'notice', text: S.railSay }) : null,
      r && (r.notes || []).length ? h('div', null,
        h('div', { class: 'lab', text: '남은 소견(편집장이 통과시키지 못하고 넘어간 것)' }),
        r.notes.map((n) => h('div', { class: 'when', style: 'white-space:pre-wrap', text: '· ' + (POINT_NAME[n.point] || n.point) + ' — ' + n.text }))) : null,
      live ? railRequestLine() : null,
      railStepsBox(ro),
      railSettingsBox(ro),
      railSeatsBox(ro)));
}

// 자동 실행 요청사항(사용자 지시 2026-10-13) — 시작하기 전에 적는다. 모든 걸음의 이번 요청사항에 실린다(문서에는 남지 않는다). 도는 동안은 읽기만
function railRequestBox() {
  return h('div', null,
    h('div', { class: 'lab', text: '자동 실행 요청사항(모든 걸음에 실립니다)' }),
    area('rail-request', '예: 주인공은 끝까지 비밀을 말하지 않는다 · 잔혹한 묘사는 피한다', railSettingsNow().request || ''));
}
// 도는 동안 고치기 — 설정 칸에서(다음 걸음부터 실린다)
const railRequestEdit = (ro) => h('div', null,
  h('div', { class: 'lab', text: '자동 실행 요청사항(다음 걸음부터 실립니다)' }),
  area('rail-request-edit', '', railSettingsNow().request || ''),
  ro ? null : h('button', { class: 'btn-line', text: '저장', onclick: () => railSet({ request: typedVal('rail-request-edit', railSettingsNow().request || '') }) }));
function railRequestLine() {
  const t = String(railSettingsNow().request || '').trim();
  return t ? h('div', null, h('div', { class: 'lab', text: '자동 실행 요청사항' }), h('div', { class: 'when', style: 'white-space:pre-wrap', text: t })) : null;
}

// 걸음 기록 · 되돌리기 — 자동 실행이 한 일만 거꾸로 푼다. 직접 만들거나 들여온 문서는 그대로다(사용자 지시 2026-10-13)
function railStepsBox(ro) {
  const r = S.project.rail;
  const steps = (r && r.steps) || [];
  if (!steps.length) return null;
  const open = !!S.railStepsOpen;
  return h('div', null,
    h('button', { class: 'btn-text', text: open ? '걸음 기록 접기' : '걸음 기록 · 되돌리기', onclick: () => { S.railStepsOpen = !open; render(); } }),
    open ? h('div', { style: 'display:flex;flex-direction:column;gap:4px;margin-top:8px' },
      h('div', { class: 'when', text: '되돌리면 그 걸음과 그 뒤에 자동 실행이 한 일만 풀립니다 — 새로 만든 문서는 휴지통으로, 고친 문서는 앞 판으로. 직접 만들거나 들여온 문서는 그대로입니다.' }),
      steps.slice().reverse().map((x) => h('div', { class: 'line', style: 'gap:8px' },
        h('span', { style: 'flex:1', text: x.label }),
        h('span', { class: 'when', text: when(x.at) }),
        ro ? null : h('button', { class: 'btn-text red', text: '여기로 되돌리기', onclick: () => {
          S.confirm = { text: '«' + x.label + '»부터 되돌리기', acts: [{ label: '되돌리기', class: 'btn-red', run: async () => { S.confirm = null; await railDo('rail.rollback', { step: x.id }); } }] };
          render();
        } })))) : null);
}

// 설정 — 접혀 있다. 상한 · 장마다 멈춤(반자동) · 판정 회차와 통과 못 하면(완전 자동) · 편집장에게 덧붙일 기준
function railSettingsBox(ro) {
  const open = !!S.railSettingsOpen;
  const s = railSettingsNow();
  return h('div', null,
    h('button', { class: 'btn-text', text: open ? '설정 접기' : '설정', onclick: () => { S.railSettingsOpen = !open; render(); } }),
    open ? h('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-top:8px' },
      h('div', null,
        h('div', { class: 'lab', text: '호출 상한(비우면 없음 — 자동 실행의 호출만 셉니다)' }),
        h('div', { class: 'line' },
          textbox('rail-cap', '예: 40', s.cap ? String(s.cap) : '', { style: 'width:120px', inputmode: 'numeric' }),
          ro ? null : h('button', { class: 'btn-line', text: '저장', onclick: () => railSet({ cap: Number(typedVal('rail-cap', s.cap || '')) || 0 }) }))),
      h('div', { class: 'line', style: 'gap:8px' },
        h('span', { text: '반자동 — 장 하나 쓸 때마다도 멈추기(기본은 승인 지점에서만 멈춤)' }),
        h('button', { class: 'tg' + (s.stopEachChapter ? ' on' : ''), onmousedown: () => { if (!ro) railSet({ stopEachChapter: !s.stopEachChapter }); } })),
      h('div', null,
        h('div', { class: 'lab', text: '완전 자동 — 도장마다 고쳐 오게 할 수 있는 횟수' }),
        h('div', { class: 'line' }, [0, 1, 2, 3].map((n) => h('button', { class: s.rounds === n ? 'btn' : 'btn-line', text: String(n), onclick: () => { if (!ro) railSet({ rounds: n }); } })))),
      h('div', null,
        h('div', { class: 'lab', text: '완전 자동 — 끝내 통과 못 하면' }),
        h('div', { class: 'line' },
          h('button', { class: s.onFail === 'pass' ? 'btn' : 'btn-line', text: '소견을 적고 넘어가기', onclick: () => { if (!ro) railSet({ onFail: 'pass' }); } }),
          h('button', { class: s.onFail === 'stop' ? 'btn' : 'btn-line', text: '멈추고 부르기', onclick: () => { if (!ro) railSet({ onFail: 'stop' }); } }))),
      S.project.rail ? railRequestEdit(ro) : null,
      h('div', null,
        h('div', { class: 'lab', text: '편집장에게 덧붙일 기준' }),
        area('rail-criteria', '예: 독자는 직장인 초보 — 전문 용어가 풀이 없이 나오면 되돌린다', s.criteria || ''),
        ro ? null : h('button', { class: 'btn-line', text: '저장', onclick: () => railSet({ criteria: typedVal('rail-criteria', s.criteria || '') }) }))) : null);
}

// 자리(포지션) — 걸음마다 맡을 사람을 앉힌다. 앉힌 사람이 그 걸음의 자리를 대신한다(레일이든 손이든). 사람은 설정 › 에이전트에서 만든다
function railSeatsBox(ro) {
  const open = !!S.railSeatsOpen;
  const positions = S.project.workflow.positions || [];
  const crew = S.project.crew || [];
  const seated = S.project.positions || {};
  return h('div', null,
    h('button', { class: 'btn-text', text: open ? '자리 접기' : '자리 — 걸음마다 맡을 사람', onclick: () => { S.railSeatsOpen = !open; render(); } }),
    open ? h('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:8px' },
      crew.length ? null : h('div', { class: 'when', text: '설정 › 에이전트에서 사람을 만들면 여기 앉힐 수 있습니다' }),
      positions.map((x) => {
        const on = (seated[x.key] || [])[0] || '';
        return h('div', null,
          h('div', { class: 'lab', text: x.name + ' — ' + x.duty }),
          h('div', { class: 'line' },
            h('button', { class: on ? 'chip' : 'btn', text: '내장', onclick: () => { if (!ro) railDo('position.set', { position: x.key, agentIds: [] }); } }),
            crew.map((a) => h('button', { class: on === a.id ? 'btn' : 'chip', text: a.name, onclick: () => { if (!ro) railDo('position.set', { position: x.key, agentIds: on === a.id ? [] : [a.id] }); } }))));
      })) : null);
}

// ---------------------------------------------------------------- 이야기 작품의 자동 실행(DESIGN §5-2)
// 한 가지 진행 — [시작]하면 «자동 실행» 카테고리에 걸음마다 문서를 쌓는다. 승인 지점은 없다(기획서 선정도 에이전트가 «기획서 선정» 문서로 한다).
// 언제든 [중지] · [이어 하기] · 걸음마다 되돌리기. 끝나거나 멈추면 화면이 한 번 알린다(app.js railNotify).
const STORY_RAIL_DEFAULTS = { cap: 0, plans: 8, cycle: 0, reruns: 2, request: '' };
const PROGRESS_MARK = { done: '●', now: '◐', todo: '○' };

function storyRailPanel(close) {
  const p = S.project;
  const r = p.rail && p.rail.kind === 'story' ? p.rail : null;
  const ro = !!p.readOnly;
  const job = (p.jobs || []).find((j) => j.rail && (j.status === 'running' || j.status === 'paused'));
  const live = r && (r.status === 'running' || r.status === 'waiting');
  const miss = [];
  if (!String((p.spec || {}).form || '').trim()) miss.push('작품 규격(형식)');
  if (!(p.docs || []).some((d) => d.material)) miss.push('자료');
  const epDoc = r && r.status === 'done' ? (p.docs || []).find((d) => d.isFinal && d.title === '회차 계획') : null;

  let now = null;
  if (r && r.status === 'running') {
    now = h('div', { class: 'when', text: job ? jobLine(job)
      : (p.jobs || []).some((j) => j.kind === 'agents' && (j.status === 'running' || j.status === 'paused')) ? '에이전트 구성을 마치면 시작합니다' : '다음 걸음을 정하는 중' });
  } else if (r && (r.status === 'waiting' || r.status === 'failed')) {
    now = h('div', null,
      h('div', { class: 'notice', text: (r.status === 'failed' ? '실패 — ' : '') + (r.why || '멈춰 있습니다') }),
      ro ? null : h('button', { class: 'btn', text: '이어 하기', onclick: () => railDo('rail.resume') }));
  } else if (r && r.status === 'stopped') {
    now = h('div', { class: 'when', text: '중지됨 — 쓴 문서는 그대로입니다.' });
  } else if (r && r.status === 'done') {
    now = h('div', null, h('div', { class: 'name', text: '끝 — 회차별 집필 계획 세부까지 썼습니다' }), epDoc ? h('div', { class: 'line' }, railOpenDoc(epDoc)) : null);
  }

  // 시작 · 이어 하기 · 처음부터 — 작품 규격(형식)과 자료가 있어야 선다
  const again = () => {
    S.confirm = { text: '처음부터 다시 — 지금까지 쓴 문서는 그대로 남습니다', acts: [{ label: '처음부터', class: 'btn', run: async () => { S.confirm = null; await railStart('fresh'); } }] };
    render();
  };
  const begin = ro || live ? null : miss.length
    ? h('div', { class: 'notice', text: '시작하려면 ' + miss.join(' · ') + '이 필요합니다' })
    : h('div', null,
      railRequestBox(),
      h('div', { class: 'line' },
        !r ? h('button', { class: 'btn', text: '시작', onclick: () => railStart('auto') })
          : r.status === 'done' ? h('button', { class: 'btn', text: '처음부터 다시', onclick: again })
            : [h('button', { class: 'btn', text: '이어 하기', onclick: () => railStart('auto') }), h('button', { class: 'btn-line', text: '처음부터 다시', onclick: again })]),
      h('div', { class: 'when', text: '자료 분석부터 회차별 집필 계획 세부까지 «자동 실행» 카테고리에 문서로 쌓습니다.' }));

  return h('div', { class: 'panel narrow' },
    h('div', { class: 'panel-head' },
      h('div', { class: 'name', text: '자동 실행' }),
      r ? h('span', { class: 'mark', text: RAIL_SAY[r.status] || r.status }) : null,
      h('button', { class: 'x', text: '×', onclick: close })),
    h('div', { class: 'panel-body' },
      now,
      live && !ro ? h('div', { class: 'line' },
        h('button', { class: 'btn-red', text: '중지', onclick: () => railDo('rail.stop') }),
        h('span', { class: 'when', text: '호출 ' + (r.calls || 0) + (r.settings && r.settings.cap ? ' / ' + r.settings.cap : '') })) : null,
      begin,
      S.railSay ? h('div', { class: 'notice', text: S.railSay }) : null,
      live ? railRequestLine() : null,
      r && (r.progress || []).length ? h('div', { style: 'display:flex;flex-direction:column;gap:2px' },
        r.progress.map((x) => h('div', { class: x.state === 'todo' ? 'when' : '', text: PROGRESS_MARK[x.state] + '  ' + x.label }))) : null,
      r && (r.notes || []).length ? h('div', null,
        h('div', { class: 'lab', text: '남은 소견' }),
        r.notes.map((n) => h('div', { class: 'when', style: 'white-space:pre-wrap', text: '· ' + (POINT_NAME[n.point] || n.point) + ' — ' + n.text }))) : null,
      railStepsBox(ro),
      storySettingsBox(ro)));
}

// 설정 — 접혀 있다. 호출 상한 · 기획안 수 · 모순 검사 주기(자동 = 회차 수를 보고 정한다) · 모순이 남을 때 그 주기를 다시 쓰는 횟수
function storySettingsBox(ro) {
  const open = !!S.railSettingsOpen;
  const r = S.project.rail && S.project.rail.kind === 'story' ? S.project.rail : null;
  const s = { ...STORY_RAIL_DEFAULTS, ...(r ? r.settings : S.railDraft || {}) };
  const pick = (label, key, opts) => h('div', null,
    h('div', { class: 'lab', text: label }),
    h('div', { class: 'line' }, opts.map(([v, t]) => h('button', { class: s[key] === v ? 'btn' : 'btn-line', text: t, onclick: () => { if (!ro) railSet({ [key]: v }); } }))));
  return h('div', null,
    h('button', { class: 'btn-text', text: open ? '설정 접기' : '설정', onclick: () => { S.railSettingsOpen = !open; render(); } }),
    open ? h('div', { style: 'display:flex;flex-direction:column;gap:10px;margin-top:8px' },
      h('div', null,
        h('div', { class: 'lab', text: '호출 상한(비우면 없음 — 자동 실행의 호출만 셉니다)' }),
        h('div', { class: 'line' },
          textbox('rail-cap', '예: 120', s.cap ? String(s.cap) : '', { style: 'width:120px', inputmode: 'numeric' }),
          ro ? null : h('button', { class: 'btn-line', text: '저장', onclick: () => railSet({ cap: Number(typedVal('rail-cap', s.cap || '')) || 0 }) }))),
      r ? railRequestEdit(ro) : null,
      pick('기획안 수', 'plans', [3, 4, 5, 6, 7, 8].map((n) => [n, String(n)])),
      pick('모순 검사 주기', 'cycle', [[0, '자동'], [1, '1화'], [2, '2화'], [3, '3화'], [5, '5화'], [10, '10화']]),
      pick('모순이 남으면 그 주기를 다시 쓰는 횟수', 'reruns', [0, 1, 2, 3].map((n) => [n, String(n)]))) : null);
}
