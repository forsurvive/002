// 전자책 레일 — 다음에 무엇을 할지 정하는 순수 함수(DESIGN.md §5-1 · docs/EBOOK_EDITION.md §2 · §3). I/O 없음.
// 레일은 단계 «위에» 얹은 순서일 뿐이다 — 어디까지 왔는지는 단계 상태와 문서에서 그때그때 읽는다.
// 그래서 사람이 손으로 승인 · 다시 생성 · 승인 풀기를 해도 레일이 그것을 따르고, 다시 켜도 같은 답이 나온다.
//
// nextStep 이 돌려주는 것(하나):
//   { do: 'run', key, episode, why }          — 그 걸음(장)을 생성한다(why: 'write' | 'revise')
//   { do: 'point', key }                       — 도장(승인 지점)에 닿았다 — 반자동은 사람을, 완전 자동은 편집장을 부른다
//   { do: 'chapter', episode }                 — 반자동 «장마다 멈춤» — [다음 장으로]를 기다린다
//   { do: 'stuck', why }                       — 더 갈 수 없다(사람이 손봐야 한다)
//   { do: 'done' }                             — 완성까지 승인되었다

import * as model from '../domain/model.mjs';
import * as wf from '../workflow/stages.mjs';

// 도장 넷 — 걸음 열쇠(config/workflows/ebook.json)와 화면 이름
export const POINTS = { design: '① 설계', toc: '② 목차', review: '③ 개정 계획', finish: '④ 완성' };

// 완전 자동의 편집장이 지점마다 보는 기준(사람이 덧붙인 기준은 그 뒤에 실린다)
export const CRITERIA = {
  design: '분량 · 장 수 · 장별 분량이 자료(자료 분석)로 받쳐지는가 · 독자와 약속이 분명한가 · 헌장(지킬 것 · 쓰지 않을 것)이 구체적인가.',
  toc: '근거 없는 장이 남아 있지 않은가 · 설계의 약속이 장마다 빠짐없이 나뉘었는가 · 장 사이에 겹침이 없는가 · 흐름이 이어지는가 · 맨 끝에 «장 수: N» 줄이 있는가.',
  review: '개정 계획이 고칠 것만 고치는가(멀쩡한 장을 새로 쓰자고 하지 않는가) · 고칠 장이 «n장» 꼴로 적혔는가 · 남은 [확인 필요]를 어떻게 할지 정했는가.',
  finish: '남은 [확인 필요]가 독자에게 닿는 약속을 해치지 않는가 · 책의 설계가 약속한 것이 모두 실렸는가 · 장 사이의 어긋남이 남지 않았는가.',
};

const bodyOf = (d) => (d ? String(model.bodyOf(d) || '') : '');
const filled = (d) => !!bodyOf(d).trim();

// 목차의 장 수 — 맨 끝의 «장 수: N»을 먼저, 없으면 «n장» 머리줄 가운데 가장 큰 수. 못 읽으면 0
export function chapterCount(text) {
  const t = String(text || '');
  let n = 0;
  for (const m of t.matchAll(/장\s*수\s*[*_»"']*\s*[:：]\s*[*_«"']*\s*(\d{1,3})/g)) n = Number(m[1]);
  if (n > 0) return Math.min(n, 200);
  for (const m of t.matchAll(/^[\s>#*\-|·•]*(?:제\s*)?(\d{1,3})\s*장(?![가-힣])/gm)) n = Math.max(n, Number(m[1]));
  return Math.min(n, 200);
}

// 전권 검토의 «개정 계획»에서 고칠 장 — 그 구획(없으면 문서 전체의 마지막 사분)에서 «n장»을 모은다. «고칠 것 없음»이면 빈 목록
export function revisionPlan(text) {
  const t = String(text || '');
  // 머리줄로 선 «개정 계획»을 먼저(본문 속 «개정 계획에 따라» 같은 말에 잘리지 않게), 없으면 마지막으로 나온 자리
  const head = t.search(/^[\s>#*\-]*(?:\d+[.)]\s*)?[«"']?개정\s*계획/m);
  const at = head >= 0 ? head : t.lastIndexOf('개정 계획');
  return at >= 0 ? t.slice(at) : '';
}
export function revisionChapters(text, total = 0) {
  const plan = revisionPlan(text);
  if (!plan.trim()) return [];
  const out = [];
  for (const m of plan.matchAll(/(?:제\s*)?(\d{1,3})\s*장/g)) {
    const n = Number(m[1]);
    if (n >= 1 && (!total || n <= total) && !out.includes(n)) out.push(n);
  }
  if (!out.length && /고칠\s*것\s*(이\s*)?없/.test(plan)) return [];
  return out.sort((a, b) => a - b);
}

// 편집장의 판단 — 첫 «판정:» 줄(승인 | 수정), «까닭», «수정 요청». 못 읽으면 decision ''
export function readJudgement(text) {
  const t = String(text || '');
  const m = t.match(/판정\s*[*»"']*\s*[:：]\s*[*«"']*\s*(승인|통과|수정|되돌림|반려)/);
  const decision = !m ? '' : /승인|통과/.test(m[1]) ? 'approve' : 'revise';
  const sec = (name) => {
    const i = t.search(new RegExp('^[\\s>#*\\-]*' + name + '\\s*[*»"\']*\\s*[:：]?', 'm'));
    if (i < 0) return '';
    const rest = t.slice(i).replace(new RegExp('^[\\s>#*\\-]*' + name + '\\s*[*»"\']*\\s*[:：]?'), '');
    const stop = rest.search(/^[\s>#*\-]*(판정|까닭|수정\s*요청)\s*[*»"']*\s*[:：]/m);
    return (stop >= 0 ? rest.slice(0, stop) : rest).trim();
  };
  return { decision, reasons: sec('까닭'), request: decision === 'revise' ? sec('수정\\s*요청') : '' };
}

// 개정 걸음에 실을 이번 요청사항 — 그 장 몫만 고친다(새로 쓰지 않는다)
export function reviseRequest(n, planText) {
  return '전권 검토의 «개정 계획» 가운데 ' + n + '장에 걸린 것만 고친다. 새로 쓰지 말고, 계획이 짚은 곳만 바로잡고 나머지는 그대로 둔다.\n\n' + String(planText || '').trim();
}

/**
 * 다음 걸음. rail = p.rail(설정 · 지난 기록), busy(docId) = 그 문서를 짓는 작업이 도는가.
 * 걸음의 순서는 docs/EBOOK_EDITION.md §2 그대로: 자료 분석 → 설계 ① → 목차 ② → 장들 → 전권 검토 ③ → 개정 → 서문 → 완성 ④
 */
export function nextStep(p, t, rail = {}, { busy = () => false } = {}) {
  const st = (key) => wf.stageOf(t, key);
  if (!st('design') || !st('toc') || !st('chapters') || !st('review') || !st('finish')) return { do: 'stuck', why: '전자책 단계가 아닙니다' };
  const rows = new Map(wf.view(p, t).map((r) => [r.key, r]));
  const doc = (key, ep = 0) => wf.docOf(p, t, key, ep);
  const passed = (key) => ['approved', 'skipped'].includes((rows.get(key) || {}).status);
  const write = (key, episode = 0) => {
    const d = doc(key, episode);
    if (d && busy(d.id)) return { do: 'wait' };
    return { do: 'run', key, episode, why: 'write' };
  };

  // ① 자료 분석 — 만들 때는 돌지 않으니 레일이 먼저 쓴다(사람이 단계에서 이미 썼으면 넘어간다)
  if (st('study') && !passed('study') && !filled(doc('study'))) return write('study');
  // ② 설계 · ③ 목차 — 쓰고, 도장
  for (const key of ['design', 'toc']) {
    if (!filled(doc(key))) return write(key);
    if (!passed(key)) return { do: 'point', key };
  }
  // ④ 장들 — 목차의 장 수만큼 1장부터
  const total = chapterCount(bodyOf(doc('toc')));
  if (!total) return { do: 'stuck', why: '목차에서 장 수를 읽지 못했습니다 — 목차 끝에 «장 수: N»을 적고 이어 하기를 누르세요' };
  const wrote = Array.isArray(rail.wrote) ? rail.wrote : [];
  const acked = Number(rail.acked) || 0;
  for (let n = 1; n <= total; n++) {
    if (!filled(doc('chapters', n))) return write('chapters', n);
    // 반자동 «장마다 멈춤» — 레일이 쓴 장만, 다음 장을 쓰기 전에 기다린다
    if (rail.mode === 'semi' && rail.settings && rail.settings.stopEachChapter && wrote.includes(n) && n > acked && n < total) return { do: 'chapter', episode: n };
  }
  // ⑤ 전권 검토 — 쓰고, 도장
  if (!filled(doc('review'))) return write('review');
  if (!passed('review')) return { do: 'point', key: 'review' };
  // ⑥ 개정 — 계획에 걸린 장만, 장마다 한 번(도장 ③ 을 다시 찍으면 새 계획으로 다시 센다)
  const reviewRow = rows.get('review') || {};
  const revise = rail.revise && rail.revise.at === (reviewRow.approvedAt || 0) ? rail.revise : { at: reviewRow.approvedAt || 0, done: [] };
  for (const n of revisionChapters(bodyOf(doc('review')), total)) {
    if (revise.done.includes(n)) continue;
    const d = doc('chapters', n);
    if (d && busy(d.id)) return { do: 'wait' };
    return { do: 'run', key: 'chapters', episode: n, why: 'revise', planAt: revise.at };
  }
  // ⑦ 서문 — 자료 분석이 «필요»라 했을 때만
  const pre = st('preface');
  if (pre && wf.whenState(p, t, pre) === true && !passed('preface') && !filled(doc('preface'))) return write('preface');
  // ⑧ 완성 — 도장
  if (!passed('finish')) return { do: 'point', key: 'finish' };
  return { do: 'done' };
}
