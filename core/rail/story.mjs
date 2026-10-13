// 이야기 작품의 자동 실행 — 다음에 무엇을 쓸지 정하는 순수 함수(DESIGN.md §5-2, 사용자 결정 2026-10-13). I/O 없음.
// 단계 템플릿을 쓰지 않는다. 걸음마다 «자동 실행» 카테고리에 보통 문서를 하나 세우고(참조 · 대상 · 에이전트 · 요청사항을 문서에 적는다)
// 지금의 문서 생성(update)으로 쓴다 — 그래서 레일이 쓴 문서는 사람이 문서 창에서 같은 꼴로 다시 생성할 수 있다.
// 어디까지 왔는지는 rail.story = { docs: { 걸음 열쇠: 문서 id }, done: [끝난 걸음 열쇠] } 와 문서 본문에서 그때그때 읽는다.
// 선정 · 주요 인물 · 회차 수 · 모순 여부는 문서의 마지막 줄을 읽는다 — 사람이 그 줄을 고치고 [이어 하기]를 누르면 고친 대로 간다.
//
// storyNext 가 돌려주는 것(하나):
//   { do: 'run', key, docKey, mode, title, kind, agents, refs, targets, request, once, extraRefs, final, label }
//       mode 'new'  — docKey 의 문서가 없으면 세우고(있으면 그 문서 — 지난번에 실패한 걸음) 생성한다
//       mode 'self' — docKey 의 문서를 다시 쓴다(새 판). once · extraRefs 는 이번 한 번만(문서에 남기지 않는다)
//   { do: 'wait' }  — 그 문서를 짓는 작업이 이미 돈다
//   { do: 'stuck', why } — 사람이 손봐야 한다
//   { do: 'done' }

import * as model from '../domain/model.mjs';

export const RAIL_CATEGORY = '자동 실행';
// 호출 상한(0 = 없음) · 기획안 수 · 모순 검사 주기(0 = 회차 수를 보고 정한다) · 모순이 남을 때 그 주기를 다시 쓰는 횟수
// · 자동 실행 요청사항(시작하기 전에 적는다 — 모든 걸음에 이번 요청사항으로 실린다, 사용자 지시 2026-10-13)
export const STORY_DEFAULTS = { cap: 0, plans: 8, cycle: 0, reruns: 2, request: '' };
export const REQUEST_MAX = 4000;
// 걸음의 이번 요청사항 앞에 자동 실행 요청사항을 얹는다(전자책 레일도 같은 꼴 — tools/rail.mjs)
export const withRailRequest = (request, once = '') => [String(request || '').trim() ? '자동 실행 요청사항(모든 걸음에 걸린다): ' + String(request).trim() : '', once]
  .filter((x) => String(x || '').trim()).join('\n\n');
export const PLAN_MIN = 3;
export const PLAN_MAX = 8;
const LEAD_MAX = 10;
const UNIT_MAX = 200;

// 기획안마다 미는 관점 — 무난하게 섞지 않고 한 방향을 끝까지 민 안들을 견주게 한다
export const PERSPECTIVES = [
  '자료 충실 — 자료가 가장 강하게 품은 이야기를 정공법으로 세운다',
  '장르 독자 — 이 형식 · 장르의 독자가 기대하는 재미와 약속을 앞세운다',
  '인물 내면 — 주인공의 결함과 변화를 가장 깊게 판다',
  '대립 — 반대 세력과 맞섬의 구도를 이야기의 축으로 세운다',
  '구조와 반전 — 시점 · 시간 · 정보를 내보이는 순서를 비틀어 놀라움을 만든다',
  '세계와 주제 — 세계의 결함과 이 이야기가 묻는 물음을 앞세운다',
  '관계 — 인물 사이의 관계가 바뀌어 가는 것(사랑 · 우정 · 가족 · 경쟁)을 축으로 한다',
  '높은 콘셉트 — 한 줄 로그라인만 듣고도 읽고 싶어지는 갈고리를 가장 세게 건다',
];

const bodyOf = (d) => (d ? String(model.bodyOf(d) || '') : '');
const clampInt = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const lastMatch = (text, re) => { let m = null; for (const x of String(text || '').matchAll(re)) m = x; return m; };
// 줄머리의 꾸밈(머리표 · 굵게 · 따옴표)과 이름 뒤의 꾸밈을 넘겨 «이름: 값» 줄을 읽는다
const lineRe = (label, value) => new RegExp('^[\\s>#*\\-·•«"\']*' + label + '[\\s*»"\']*[:：]\\s*[*«"\']*\\s*' + value, 'gm');

export function cleanStorySettings(s = {}, base = STORY_DEFAULTS) {
  const out = { ...STORY_DEFAULTS, ...base };
  if (s.cap !== undefined) out.cap = Math.max(0, Math.floor(Number(s.cap) || 0));
  if (s.plans !== undefined) out.plans = clampInt(s.plans, PLAN_MIN, PLAN_MAX, STORY_DEFAULTS.plans);
  if (s.cycle !== undefined) out.cycle = clampInt(s.cycle, 0, 50, 0);
  if (s.reruns !== undefined) out.reruns = clampInt(s.reruns, 0, 3, STORY_DEFAULTS.reruns);
  if (s.request !== undefined) out.request = String(s.request || '').slice(0, REQUEST_MAX);
  return out;
}

// ---------------------------------------------------------------- 문서의 마지막 줄 읽기

// «선정: 기획안 N» — 마지막으로 적은 것. 범위 밖이면 0
export function pickedPlan(text, count) {
  const m = lastMatch(text, lineRe('선정', '(?:기획안\\s*)?(\\d{1,2})'));
  const n = m ? Number(m[1]) : 0;
  return n >= 1 && n <= count ? n : 0;
}
// «주요 인물: 이름 · 이름 · …» — 가운뎃점 · 쉼표 · 빗금으로 가른다
export function leadNames(text) {
  const m = lastMatch(text, lineRe('주요\\s*인물', '([^\\n]+)'));
  if (!m) return [];
  const names = m[1].replace(/[*_«»"']/g, '').split(/\s*[·,，、/|]\s*/).map((x) => x.replace(/\(.*?\)/g, '').trim()).filter((x) => x && x.length <= 30);
  return [...new Set(names)].slice(0, LEAD_MAX);
}
// «회차 수: N» · «단위: 장»
export function unitCount(text) {
  const m = lastMatch(text, lineRe('(?:회차|단위|파트|장|막)\\s*수', '(\\d{1,3})'));
  return m ? Math.min(Number(m[1]), UNIT_MAX) : 0;
}
export function unitWord(text) {
  const m = lastMatch(text, lineRe('단위', '(화|장|막|부|편|파트|시퀀스)(?![가-힣])'));
  return m ? m[1] : '화';
}
// «모순: 있음 | 없음» — 못 읽으면 null(부르는 쪽은 «있음»으로 친다)
export function contraFound(text) {
  const m = lastMatch(text, lineRe('모순', '(있음|있다|없음|없다)'));
  return m ? /있/.test(m[1]) : null;
}
// «분량: …» — 자료 분석이 정한 분량(작품 규격에 분량이 비어 있을 때 레일이 옮겨 적는다)
export function lengthLine(text) {
  const m = lastMatch(text, lineRe('분량', '([^\\n]+)'));
  return m ? m[1].replace(/[*_«»]/g, '').trim().slice(0, 80) : '';
}

// 모순 검사 주기 — 정해 두지 않았으면 회차 수를 보고 정한다(짧으면 한 번에, 길수록 넓게)
export function cycleSize(total, set = 0) {
  if (set > 0) return Math.min(set, Math.max(1, total));
  return total <= 5 ? Math.max(1, total) : total <= 15 ? 3 : total <= 40 ? 5 : 8;
}
export function cycles(total, size) {
  const out = [];
  for (let a = 1; a <= total; a += size) out.push(Array.from({ length: Math.min(size, total - a + 1) }, (_, i) => a + i));
  return out;
}

// ---------------------------------------------------------------- 걸음마다의 요청사항(문서의 요청사항으로 남는다 — 사람이 다시 생성해도 같은 미션)

const ASK = {
  analysis: '넣은 자료 전부와 작품 규격 · 집필 기준 · 작품 요청사항을 끝까지 읽고, 이 작품의 자동 실행이 끝까지 기댈 분석 문서를 쓴다.\n'
    + '① 요청사항과 집필 기준이 실제로 무엇을 요구하고 무엇을 막는지, 글에서 지킬 수 있는 말로 풀어 적는다.\n'
    + '② 자료의 의도 — 이 자료를 넣은 사람이 이 이야기에서 무엇을 보고 싶어 하는지. 짐작은 짐작이라 밝힌다.\n'
    + '③ 자료에 있는 사실 · 인물 · 사건 · 장소 · 분위기를 자료 이름과 함께 정리한다.\n'
    + '④ 자료가 품은 이야기의 씨앗(문턱 · 결함 · 세계의 결함 · 대조의 짝 · 반대 세력 · 장면이 될 상황 · 승리의 조각) 후보.\n'
    + '⑤ 자료끼리 어긋나는 곳과 비어 있는 곳.\n'
    + '⑥ 형식과 분량 — 작품 규격의 분량이 정해져 있으면 그대로 옮기고, 정해지지 않았으면 형식 · 자료의 크기 · 요청사항을 보고 알맞은 분량을 정해 까닭과 함께 적는다.\n'
    + '맨 끝 줄에 «분량: …» 한 줄을 적는다(예: «분량: 12화, 화당 5,000자 안팎»).',
  world: '자료 분석을 바탕으로 이 이야기의 세계관을 정리하고 넓힌다. 자료에 있는 설정은 출처를 잃지 않게 정리하고, 비어 있는 곳은 이야기에 쓰일 만큼만 넓힌다(넓힌 것은 «넓힘»이라 표시한다).\n'
    + '일상 세계와 비일상 세계 · 그 사이의 문턱 · 세계의 결함 · 갈등과 대가를 낳는 규칙 · 장소 · 사회 · 역사를 쓰고, 설정마다 어느 사건에서 드러날 수 있는지 적는다.',
  material: '자료 분석과 세계관에서 이야기로 쓸 서사 재료(사건 · 갈등 · 비밀 · 관계 · 장면의 씨앗)를 골라 정리한다. 재료마다 출처(자료 · 세계관의 어디)와 도식의 어느 칸에 놓일 수 있는지 적고, 비슷한 재료는 묶는다.\n'
    + '쓰지 않을 재료는 까닭과 함께 따로 적는다. 뒤에서 여러 관점의 기획안이 이 재료를 서로 다르게 고르므로, 한 방향으로 미리 좁히지 않는다.',
  plan: (look) => '작품 기획안을 하나 쓴다. 이번 기획안의 관점은 «' + look + '». 이 관점에서 가장 좋은 이야기를 세운다 — 다른 관점의 기획안이 따로 쓰이니 무난하게 섞지 말고 이 관점을 끝까지 민다.\n'
    + '① 시놉시스 — 처음부터 결말까지(한 쪽 안팎) ② 로그라인과 한 문장 ③ 도식의 칸(결함 · 결함의 본질 · 욕망 · 본질적 목표 · 외적 목표 · 기폭제 · 토론 · 1차 플롯포인트 · 중간점 · 절망의 순간 · 승리의 조각 · 최종 과제 · 변화의 증명)\n'
    + '④ 잃게 될 것 · 세 겹의 결함(세계 · 주인공 · 반대자) · 콘셉트 질문 ⑤ 분위기와 독자.\n'
    + '끝에 이 기획안이 작품 요청사항 · 집필 기준 · 자료의 의도에 어떻게 맞는지와 약점을 솔직하게 적는다.',
  select: (n) => '참조한 기획안 ' + n + '개를 작품 요청사항 · 집필 기준, 그리고 자료 분석이 밝힌 자료의 의도에 비추어 견주고, 이 작품으로 쓸 기획안 하나를 고른다.\n'
    + '기획안마다 맞는 점과 어긋나는 점을 짧게 적고, 고른 까닭을 적는다. 고르지 않은 기획안에서 살릴 만한 요소가 있으면 «살릴 것»에 따로 적는다(고른 기획안을 해치지 않는 것만).\n'
    + '맨 끝 줄에 «선정: 기획안 N» 한 줄만 적는다(N 은 기획안의 번호).',
  worldRev: (n) => '선정된 «기획안 ' + n + '»과 «기획서 선정»의 «살릴 것»에 맞춰 이 세계관을 다시 쓴다. 기획안과 어긋나는 설정은 바로잡고, 세계의 결함과 문턱이 기획안의 도식과 맞물리게 하며, 이 이야기에 쓰이지 않는 설정은 덜어 낸다(덜어 낸 것은 끝에 목록으로 남긴다).',
  cast: '선정된 기획안에 맞춰 이 이야기에 나올 수 있는 인물을 넉넉히 짓는다(주요 인물이 될 후보는 기획안이 요구하는 수보다 많이).\n'
    + '인물마다 이름 · 주인공의 무엇을 표상하는지 · 원형의 가면 · 원하는 것과 두려워하는 것 · 개성 · 과거 · 세계관 · 내면의 악마 · 동기와 목표 · 말투 한 줄을 적는다. 같은 태도의 인물은 합칠 후보로 표시한다.',
  outline: '선정된 기획안의 도식을 따라 대략적인 플롯을 세운다 — 네 파트(설정 · 반응 · 공격 · 해결)마다 설정 · 위기 · 단서 · 도전의 칸과 결말(변화의 증명).\n'
    + '파트마다 주인공의 상태와 중심 사건, 기폭제와 그 짝이 되는 필수 장면, 승리의 조각을 심을 자리를 적는다. 인물은 인물 풀의 이름으로 부르되 주요 인물은 아직 확정하지 않는다.',
  leads: '인물 풀과 대략 플롯을 보고 이 이야기를 끌고 갈 주요 인물을 고른다(형식과 분량에 맞게 — 단편이면 둘 · 셋, 장편 · 연재면 더).\n'
    + '인물마다 고른 까닭과 플롯에서 맡는 일, 관계의 축(딜레마가 서는가)을 적고, 주인공과 반대자는 세 차원(결함 · 결함의 본질 · 본질적 목표)까지 적는다. 같은 일을 하는 인물은 합친다.\n'
    + '맨 끝 줄에 «주요 인물: 이름 · 이름 · …» 한 줄을 적는다(이름만, 가운뎃점으로 가른다).',
  char: (name) => '주요 인물 «' + name + '»의 설계 문서를 쓴다.\n'
    + '① 소개 — 나이 · 처지 · 겉모습 · 첫인상 ② 내면 — 결함과 결함의 본질 · 원하는 것과 두려워하는 것 · 비밀 · 내면의 악마\n'
    + '③ 캐릭터 아크 — 대략 플롯의 파트마다 처음 상태 → 계기 → 끝 상태, 변화를 증명하는 장면 ④ 관계 — 다른 주요 인물과의 관계와 그 변화\n'
    + '⑤ 보이스 — 생각하는 방식 · 즐겨 쓰는 말 · 쓰지 않는 말 · 말의 길이와 리듬 ⑥ 대화 스타일 — 편할 때 · 몰릴 때 · 숨길 때 말하는 꼴과 짧은 대사 예시 서너 줄.\n'
    + '다른 주요 인물과 말투가 겹치지 않게 한다.',
  plot: '대략 플롯을 시퀀스와 사건으로 편 상세 플롯을 쓴다. 사건마다 누가 무엇을 원하고 · 무엇이 막고 · 무엇을 택하고 · 결과가 기대와 어떻게 어긋나는지, 그 사건에서 움직이는 인물의 아크를 적는다.\n'
    + '사건은 «그래서 · 그런데»로 이어지게 하고, 다 쓴 뒤 앞으로 되짚어 승리의 조각과 마지막 한 수를 앞에 심는다. 인물 설계의 아크 · 보이스와 어긋나지 않게 한다.',
  plotReview: '상세 플롯을 합평한다. 작품 요청사항 · 집필 기준 · 선정된 기획안이 약속한 것을 지키는지 보고, 인과가 약한 곳 · 늘어지는 곳 · 우연에 기대는 곳 · 인물 아크와 사건이 어긋나는 곳 · 반대자가 약해지는 곳을 짚는다.\n'
    + '지적마다 상세 플롯의 어느 대목인지와 고칠 방향을 적고, 무거운 것부터 차례로 세운다.',
  plotRev: '«상세 플롯 합평»의 지적을 반영해 상세 플롯을 다시 쓴다. 받아들인 지적은 고치고, 받아들이지 않은 지적은 끝에 까닭과 함께 짧게 적는다. 지적이 닿지 않은 곳은 살린다.',
  episodes: '상세 플롯을 작품 규격의 형식과 분량에 맞춰 나눈다. 연재 소설이면 회차로, 단편 · 장편 · 희곡 · 시나리오처럼 다른 형식이면 그 형식에 맞는 단위(장 · 막 · 시퀀스 · 파트)로 나누고 단위마다 분량을 정한다.\n'
    + '단위마다 번호와 이름 · 놓인 파트와 칸 · 중심 사건 · 그 단위 안의 설정 · 위기 · 단서 · 끝의 훅 · 나오는 인물 · 분량을 적는다.\n'
    + '맨 끝에 «회차 수: N» 한 줄(N 은 나눈 단위의 수)과, 회차가 아닌 단위로 나눴으면 «단위: 장»처럼 그 이름 한 줄을 적는다 — 자동 실행이 이 줄을 읽어 단위마다 집필 계획을 세운다.',
  episodesReview: '회차 계획을 합평한다. 상세 플롯이 빠짐없이 · 겹침 없이 나뉘었는지, 단위마다 중심 사건이 하나로 서는지, 분량 배분이 형식과 작품 규격에 맞는지, 끝의 훅이 다음을 당기는지, 늘어지거나 몰린 곳이 없는지 짚는다.\n'
    + '지적마다 몇 번째 단위인지와 고칠 방향을 적는다.',
  episodesRev: '«회차 계획 합평»의 지적을 반영해 회차 계획을 다시 쓴다. 받아들이지 않은 지적은 끝에 까닭과 함께 짧게 적는다. 맨 끝의 «회차 수: N» 줄(과 «단위» 줄)을 지킨다.\n'
    + '이 판이 뒤의 모든 집필 계획이 따를 확정본이 된다.',
  scene: (u) => '회차 계획의 ' + u + '을 장면 단위로 나눈 집필 계획을 쓴다. 장면마다 장면 이름 · 장소와 시간 · 나오는 인물 · 장면 목표 · 시작 가치 → 끝 가치 · 일어나는 일(기대와 결과의 어긋남) · 심는 것과 거두는 것 · 분량을 적는다.\n'
    + '회차 계획이 ' + u + '에 약속한 중심 사건과 끝의 훅을 지키고, 앞의 집필 계획 세부에서 이어받는 것을 끊지 않는다. 다른 회차의 사건을 당겨 쓰지 않는다.',
  beat: (u) => '«' + u + ' 집필 계획»의 장면을 차례대로 문단으로 나눈다. 장면마다 머리줄을 두고, 그 아래 문단마다 번호를 달아 그 문단에서 일어나는 일 · 보이는 것 · 오가는 말의 요지를 1~3문장으로 진술한다 — 본문을 쓰지 않는다.\n'
    + '말이 중요한 문단은 인물 설계의 보이스와 대화 스타일에 맞는 대사의 요지를 적는다. 장면 계획의 시작 가치 → 끝 가치가 문단을 따라 실제로 바뀌게 한다.',
  check: (range) => '회차 계획(확정본)을 기준으로 ' + range + '의 집필 계획과 집필 계획 세부를 맞대어 읽고 모순과 차이를 찾는다 — 회차 계획과 다른 사건 · 빠진 사건 · 사건의 순서 · 인물의 상태와 관계 · 설정(세계관) · 시간과 장소 · 앞 회차와의 연결 · 같은 회차의 집필 계획과 세부 사이의 어긋남.\n'
    + '찾은 것마다 어느 문서의 어느 대목인지와 바로잡을 방향을 적는다. 맨 끝 줄에 «모순: 있음» 또는 «모순: 없음» 한 줄을 적는다.',
  redo: (range) => '«모순 검사 — ' + range + '»가 짚은 모순과 차이 가운데 이 문서에 걸린 것을 바로잡아 다시 쓴다. 회차 계획(확정본)을 따르고, 짚이지 않은 곳은 살린다.',
};

const seat = (...codes) => codes.map((c) => 'seat:' + c);

// ---------------------------------------------------------------- 다음 걸음

/**
 * p = 프로젝트, rail = p.rail(설정 · rail.story), busy(docId) = 그 문서를 짓는 작업이 도는가.
 * 순서(사용자 지시 2026-10-13): 자료 분석 → 세계관 → 서사 재료 → 기획안 여럿 → 기획서 선정 → 세계관 다시 → 인물 풀 → 대략 플롯 → 주요 인물 → 인물 설계(사람마다)
 *   → 상세 플롯 → 합평 → 다시 → 회차 계획 → 합평 → 다시(확정본) → 회차마다 [집필 계획 → 세부] — 주기마다 모순 검사, 모순이 있으면 그 주기를 다시 쓰고 다시 검사.
 */
export function storyNext(p, rail = {}, { busy = () => false } = {}) {
  const S = rail.story || {};
  const docs = S.docs || {};
  const done = new Set(S.done || []);
  const set = cleanStorySettings({}, rail.settings || {});
  const doc = (k) => (docs[k] ? model.findDoc(p, docs[k]) : null);
  const ids = (...ks) => [...new Set(ks.flat(Infinity).map((k) => (doc(k) || {}).id).filter(Boolean))];
  const mats = model.materialDocs(p).map((d) => d.id);

  const go = (step) => {
    const d = doc(step.docKey || step.key);
    if (step.mode === 'self' && !d) return { do: 'stuck', why: '«' + step.title + '» 문서가 없습니다 — 휴지통에서 되살리거나 그 걸음으로 되돌리고 이어 하세요' };
    if (d && busy(d.id)) return { do: 'wait' };
    return { do: 'run', docKey: step.key, mode: 'new', agents: [], refs: [], targets: [], request: '', once: '', extraRefs: [], final: false, kind: 'doc', ...step,
      label: step.label || step.title + (step.mode === 'self' ? ' 다시 씀' : ' 생성') };
  };
  const make = (key, title, agents, refs, request, more = {}) => (done.has(key) ? null : go({ key, title, agents, refs, request, ...more }));
  const redo = (key, docKey, title, once, extraRefs, more = {}) => (done.has(key) ? null : go({ key, docKey, title, mode: 'self', once, extraRefs, ...more }));

  // ① 자료 분석 · ② 세계관 · ③ 서사 재료
  let s = make('analysis', '자료 분석', seat('S02'), mats, ASK.analysis)
    || make('world', '세계관', seat('N-WORLD'), ids('analysis'), ASK.world)
    || make('material', '서사 재료', seat('N-PLAN'), ids('analysis', 'world'), ASK.material);
  if (s) return s;
  // ④ 기획안 여럿 — 관점마다 하나
  const K = set.plans;
  const planKeys = Array.from({ length: K }, (_, i) => 'plan#' + (i + 1));
  for (let i = 0; i < K; i++) {
    const look = PERSPECTIVES[i % PERSPECTIVES.length];
    s = make(planKeys[i], '기획안 ' + (i + 1) + ' — ' + look.split(' — ')[0], seat('N-PLAN'), ids('analysis', 'world', 'material'), ASK.plan(look));
    if (s) return s;
  }
  // ⑤ 기획서 선정 — 요청사항 · 기준 · 자료의 의도로 견준다(합평하는 눈과 도식 짓는 눈이 함께)
  s = make('select', '기획서 선정', seat('F-REVIEW', 'N-PLAN'), ids('analysis', planKeys), ASK.select(K));
  if (s) return s;
  const chosen = pickedPlan(bodyOf(doc('select')), K);
  if (!chosen || !doc('plan#' + chosen)) return { do: 'stuck', why: '«기획서 선정»의 맨 끝에서 «선정: 기획안 N»을 읽지 못했습니다 — 그 줄을 적고 이어 하세요' };
  const plan = 'plan#' + chosen;
  // ⑥ 세계관 다시(선정된 기획안에 맞춰 — 새 판) · ⑦ 인물 풀 · ⑧ 대략 플롯 · ⑨ 주요 인물
  s = redo('world_rev', 'world', '세계관', ASK.worldRev(chosen), ids(plan, 'select'), { label: '세계관 다시 씀(기획안 ' + chosen + '에 맞춰)' })
    || make('cast', '인물 풀', seat('N-CAST'), ids(plan, 'select', 'world', 'material', 'analysis'), ASK.cast)
    || make('outline', '대략 플롯', seat('N-GRID'), ids(plan, 'select', 'world', 'cast', 'material'), ASK.outline)
    || make('leads', '주요 인물', seat('N-CAST'), ids('cast', 'outline', plan), ASK.leads);
  if (s) return s;
  const names = leadNames(bodyOf(doc('leads')));
  if (!names.length) return { do: 'stuck', why: '«주요 인물»의 맨 끝에서 «주요 인물: 이름 · 이름»을 읽지 못했습니다 — 그 줄을 적고 이어 하세요' };
  // ⑩ 인물 설계 — 주요 인물마다
  const charKeys = names.map((_, i) => 'char#' + (i + 1));
  for (let i = 0; i < names.length; i++) {
    s = make(charKeys[i], '인물 설계 — ' + names[i], seat('N-CAST'), ids('leads', 'cast', 'outline', plan, 'world'), ASK.char(names[i]));
    if (s) return s;
  }
  // ⑪ 상세 플롯 → 합평(세 눈 — 합평 · 격자 · 인물) → 다시
  const PANEL_PLOT = seat('F-REVIEW', 'N-GRID', 'N-CAST');
  s = make('plot', '상세 플롯', seat('N-GRID'), ids('outline', plan, 'select', 'leads', charKeys, 'world'), ASK.plot)
    || make('plot_review', '상세 플롯 합평', PANEL_PLOT, ids(plan, 'outline', 'leads', charKeys), ASK.plotReview, { kind: 'review', targets: ids('plot') })
    || redo('plot_rev', 'plot', '상세 플롯', ASK.plotRev, ids('plot_review'), { label: '상세 플롯 다시 씀(합평 반영)' });
  if (s) return s;
  // ⑫ 회차 계획 → 합평 → 다시(확정본 — 유일한 확정본으로 켠다)
  const PANEL_EP = seat('F-REVIEW', 'N-SCENE', 'N-GRID');
  s = make('episodes', '회차 계획', seat('N-SCENE'), ids('plot', plan, 'leads', charKeys, 'world', 'analysis'), ASK.episodes)
    || make('episodes_review', '회차 계획 합평', PANEL_EP, ids('plot', plan, 'analysis'), ASK.episodesReview, { kind: 'review', targets: ids('episodes') })
    || redo('episodes_rev', 'episodes', '회차 계획', ASK.episodesRev, ids('episodes_review'), { label: '회차 계획 다시 씀(합평 반영 · 확정본)', final: true });
  if (s) return s;
  const epText = bodyOf(doc('episodes'));
  const total = unitCount(epText);
  if (!total) return { do: 'stuck', why: '«회차 계획»의 맨 끝에서 «회차 수: N»을 읽지 못했습니다 — 그 줄을 적고 이어 하세요' };
  const word = unitWord(epText);
  const U = (n) => n + word;
  // ⑬ 회차마다 집필 계획 → 세부. 주기마다 모순 검사 — 모순이 있으면 그 주기를 다시 쓰고(검사 문서를 모두 참조) 다시 검사한다
  const sceneOf = (n) => ({ title: U(n) + ' 집필 계획', agents: seat('N-SCENE'), refs: ids('episodes', 'plot', 'leads', charKeys, 'world', n > 1 ? 'beat#' + (n - 1) : []) });
  const beatOf = (n) => ({ title: U(n) + ' 집필 계획 세부', agents: seat('N-SCENE', 'N-WRITE'), refs: ids('scene#' + n, charKeys, 'world', 'episodes', n > 1 ? 'beat#' + (n - 1) : []) });
  const list = cycles(total, cycleSize(total, set.cycle));
  for (let c = 0; c < list.length; c++) {
    const eps = list[c];
    const range = eps.length > 1 ? U(eps[0]) + '~' + U(eps[eps.length - 1]) : U(eps[0]);
    for (const n of eps) {
      const a = sceneOf(n); const b = beatOf(n);
      s = make('scene#' + n, a.title, a.agents, a.refs, ASK.scene(U(n))) || make('beat#' + n, b.title, b.agents, b.refs, ASK.beat(U(n)));
      if (s) return s;
    }
    for (let r = 0; ; r++) {
      const checks = Array.from({ length: r }, (_, i) => 'check#' + (c + 1) + '~' + i);
      if (r > 0) {
        for (const n of eps) {
          s = redo('scene#' + n + '~' + r, 'scene#' + n, U(n) + ' 집필 계획', ASK.redo(range), ids(checks), { label: U(n) + ' 집필 계획 다시 씀(모순 검사 ' + r + ')' })
            || redo('beat#' + n + '~' + r, 'beat#' + n, U(n) + ' 집필 계획 세부', ASK.redo(range), ids(checks), { label: U(n) + ' 집필 계획 세부 다시 씀(모순 검사 ' + r + ')' });
          if (s) return s;
        }
      }
      const ck = 'check#' + (c + 1) + '~' + r;
      s = make(ck, '모순 검사 — ' + range + (r ? ' (재검사 ' + r + ')' : ''), [], ids('plot', charKeys, 'world', eps[0] > 1 ? 'beat#' + (eps[0] - 1) : []),
        ASK.check(range), { kind: 'check', targets: ids('episodes', eps.map((n) => ['scene#' + n, 'beat#' + n])), check: { cycle: c + 1, round: r, range } });
      if (s) return s;
      const found = contraFound(bodyOf(doc(ck))) !== false;
      if (!found || r >= set.reruns) break;
    }
  }
  return { do: 'done' };
}

// 화면의 진행 표 — 큰 걸음마다 끝남 · 지금 · 아직, 회차별 집필 계획은 «쓴 회차 / 회차 수»
export function storyProgress(p, rail = {}) {
  const S = rail.story || {};
  const done = new Set(S.done || []);
  const docs = S.docs || {};
  const set = cleanStorySettings({}, rail.settings || {});
  const has = (k) => done.has(k);
  const all = (pre) => [...done].filter((k) => k.startsWith(pre)).length;
  const rows = [
    ['자료 분석', has('analysis')], ['세계관', has('world')], ['서사 재료', has('material')],
    ['기획안 ' + set.plans + '개', all('plan#') >= set.plans], ['기획서 선정', has('select')], ['세계관 다시', has('world_rev')],
    ['인물 풀', has('cast')], ['대략 플롯', has('outline')], ['주요 인물', has('leads')], ['인물 설계', has('plot')],
    ['상세 플롯', has('plot')], ['상세 플롯 합평', has('plot_review')], ['상세 플롯 다시', has('plot_rev')],
    ['회차 계획', has('episodes')], ['회차 계획 합평', has('episodes_review')], ['회차 계획 다시(확정본)', has('episodes_rev')],
  ];
  const epDoc = docs.episodes ? model.findDoc(p, docs.episodes) : null;
  const total = has('episodes_rev') ? unitCount(bodyOf(epDoc)) : 0;
  const beats = [...done].filter((k) => /^beat#\d+$/.test(k)).length;
  rows.push(['회차별 집필 계획' + (total ? ' ' + beats + '/' + total : ''), rail.status === 'done']);
  const at = rows.findIndex((x) => !x[1]);
  return rows.map(([label, ok], i) => ({ label, state: ok ? 'done' : i === at ? 'now' : 'todo' }));
}
