// 프롬프트 조립 — 구획을 정해진 순서로 쌓는다.
// 구획 머리표는 '■ ', 항목 이름은 '▶ '. 내용이 없는 구획은 머리표째 뺀다.
// 입출력에 상한을 두지 않는다 — 자료도 참조도 본문도 있는 그대로 전부 싣는다(사용자 지시).

export const FINAL_RULE = `«확정본» 구획에 실린 글은 이 작품의 최우선 사실이다. 다른 구획의 어떤 글보다, 그리고 네 판단보다 앞선다.
확정본과 어긋나는 내용은 쓰지 않는다. 다른 구획의 글이 확정본과 어긋나면 확정본이 옳고 그쪽이 틀린 것이다.
확정본을 고치자고 제안하지 않는다. 확정본에 없는 것만 네가 새로 정한다.`;

export const NO_COUNT = `계량어 사용 금지. 숫자, 숫자 세기, 개수, 개수 세기, 계량어, 횟수, 장부, 명단, 명부, 박자(반 박자·한 박자 등), 걸음, 셈 등의 표현을 사용하는 것을 강력히 금지한다. 문체에든 문장에든 내용 설계에든 철저히 배제하라. 반드시 필요할 때만 사용한다.

이 규칙은 네가 써서 내놓는 글에 걸린다.
세어서 말하지 말고 보이는 대로 쓴다. «세 사람이 서 있었다»가 아니라 «사람들이 서 있었다». «두 번 두드렸다»가 아니라 «두드리고, 다시 두드렸다». «반 박자 늦게»가 아니라 «조금 늦게». «한 걸음 물러섰다»가 아니라 «물러섰다».
항목에 번호를 매겨 늘어놓지 않는다. 몇 가지인지 먼저 말하고 세어 나가는 서술도 쓰지 않는다.
없으면 글이 성립하지 않는 자리에서만 쓴다. 회차 번호, 날짜와 시각, 인물의 나이, 작품 규격에 적힌 분량, 고유명사에 박힌 수는 그대로 쓴다.
망설여지면 쓰지 않는 쪽을 고른다.`;

export const RESPONSE_RULE = `답은 문서 본문 하나다. 인사말, 머리말, «다음은 ...입니다» 같은 말, 끝맺는 말을 붙이지 않는다.
첫 줄에 제목을 쓰지 않는다 — 제목은 프로그램이 붙인다. 본문 안의 소제목은 써도 좋다.
길이를 아끼지 마라. 필요한 만큼 충분히 써라.`;

const s = (v) => (v == null ? '' : String(v));

// ---------------------------------------------------------------- 나눠 읽기(한 번에 실리지 않을 때)
// 자르지 않는다 — 한 번에 실리지 않는 글은 조각조각 읽어 «반영할 것»을 빠짐없이 뽑아 옮기고, 그것을 싣고 쓴다(2026-10-08 사용자 지시:
// «문서를 쪼개서 작업하든 어떻게 하든 참조된 문서와 수정/생성할 문서, 요청사항 모두 결과에 반드시 반영되어야 해»). 본체: core/generation/reading.mjs

// 조각 하나를 읽는 호출의 할 일 — 나중에 할 일(본래의 할 일)과 요청사항을 보며 이 조각에서 반영할 것을 뽑는다
export function readTask({ name, k, n, role = 'reference', again = false, later = '' }) {
  const what = role === 'final' ? '확정본(최우선 사실)' : role === 'material' ? '자료' : role === 'target' ? '대상 원고'
    : role === 'talk' ? '대화' : role === 'instruction' ? '지시 글' : role === 'extra' ? '보고' : '참조 문서';
  return [
    again
      ? `지금은 긴 ${what} «${s(name)}»에서 이미 뽑아 옮긴 것이 너무 길어 다시 모으는 중이다. «나눠 읽는 부분»은 그 뽑아 옮긴 것의 ${k}/${n} 부분이다.`
      : `지금은 한 번에 실리지 않는 긴 ${what} «${s(name)}»를 나눠 읽는 중이다. «나눠 읽는 부분»은 그 글의 ${k}/${n} 부분이다.`,
    '이 부분을 읽고, 아래 «나중에 할 일»과 요청사항(작품 요청사항 · 이번 요청사항)을 해내는 데 반영해야 할 것을 이 부분에서 하나도 빠뜨리지 말고 뽑아 옮겨라.',
    '이름 · 설정 · 규칙 · 사건 · 관계 · 순서 · 수치 · 고유한 표현은 원문 그대로 옮긴다. 줄이느라 뜻을 바꾸거나 다른 것과 섞지 않는다.',
    '반영할지 망설여지면 옮긴다. 이 부분에 없는 것을 지어내지 않고, 평가나 제안을 붙이지 않는다. 뽑아 옮긴 것만 내놓는다.',
    role === 'final' ? '이 글은 확정본이다 — 사실은 하나도 빠짐없이 원문 그대로 옮긴다.' : null,
    role === 'instruction' ? '이 글은 지켜야 할 지시다(요청사항 · 집필 기준 · 작품 요청사항 · 개요) — 지시 · 조건 · 금지 · 수치 · 이름은 하나도 빠뜨리지 말고 원문 그대로 옮기고, 함께 붙어 온 글(자료 · 예시)도 이번 일에 쓰일 것은 옮긴다.' : null,
    role === 'talk' ? '이 글은 작가와 나눈 대화다 — 작가가 정한 것 · 바꾸라고 한 것 · 물은 것과 그 답의 요지를 하나도 빠뜨리지 말고 옮긴다.' : null,
    '',
    '나중에 할 일:',
    s(later).trim() || '(이 작품의 다음 글을 쓴다)',
  ].filter((x) => x !== null).join('\n');
}

// 고칠 원고가 한 번에 실리지 않을 때 — 원고를 부분으로 나눠 부분마다 고치고 잇는다(보고서꼴은 부분마다 따로 본다)
export function partTask({ k, n, mode = 'rewrite', before = '', after = '' }) {
  const lines = mode === 'rewrite'
    ? [`«대상»은 한 번에 실리지 않는 긴 원고의 ${k}/${n} 부분이다. 이 부분만 이번 일과 요청사항에 맞게 쓰고, 이 부분에 해당하는 본문만 내놓는다.`,
      '다른 부분을 다시 쓰거나 줄여 옮기지 않는다. 이 부분에 있던 내용은 요청사항이 바꾸라고 한 것이 아니면 빠뜨리지 않는다. 앞뒤 부분과 이어지게 쓴다.']
    : [`«대상»은 한 번에 실리지 않는 긴 원고의 ${k}/${n} 부분이다. 이번 일은 이 부분에 대해서만 한다 — 다른 부분은 따로 본다.`];
  if (s(before).trim()) lines.push('앞 부분의 끝:\n' + neutralize(before));
  if (s(after).trim()) lines.push('뒤 부분의 처음:\n' + neutralize(after));
  return lines.join('\n');
}

// ---------------------------------------------------------------- 이어 쓰기(응답이 길이 한도에 닿아 끊겼을 때 — core/generation/continue.mjs)
// 끊긴 응답(«이미 쓴 부분»)을 통째로 보여 주고, 끊긴 자리 바로 다음부터 이어 쓰게 한다. 할 일 · 요청사항 · 참조는 처음 부른 것 그대로다.
export function continueTask({ n = 1, text = '' } = {}) {
  const tail = s(text).slice(-400);
  return [
    `앞선 응답이 길이 한도에 닿아 끊겼다(이어 쓰기 ${n}번째). «이미 쓴 부분»이 지금까지 쓴 응답이다.`,
    '끊긴 자리 바로 다음부터 이어 써라 — 이미 쓴 것을 되풀이하거나 처음부터 다시 쓰지 않는다. 문장이나 낱말 중간에서 끊겼으면 그 나머지부터 쓴다.',
    '위의 할 일과 요청사항은 그대로다. 이어지는 글만 내놓는다(머리말 · 맺음말 없이). 끊긴 자리가 문단의 끝이면 빈 줄로 시작한다.',
    '끊긴 자리(이미 쓴 부분의 마지막):',
    neutralize(tail),
  ].join('\n');
}

// 이미 쓴 부분 — 통째, 또는(통째로 실리지 않을 때) 끝쪽만. 앞이 있다는 것을 밝힌다.
export const writtenOf = (text, tail = 0) => {
  const t = s(text);
  return tail > 0 && t.length > tail ? '(이미 쓴 부분이 길어 끝쪽 ' + tail.toLocaleString('en-US') + '자만 싣는다 — 그 앞도 이미 쓴 것이다)\n…' + t.slice(-tail) : t;
};

// 긴 원고를 부분마다 본 보고(모순 검사 · 합평)를 마지막에 견준다 — 부분 사이에 걸친 것을 놓치지 않게. 부분 보고는 그대로 남고 이것이 더해진다.
export const ACROSS_TASK = `«대상»은 한 번에 실리지 않는 긴 원고를 부분마다 본 보고들이다. 보고들을 서로 견주어 부분 사이에 걸친 어긋남 · 겹침 · 빠진 것만 찾아 적는다.
부분 보고에 이미 있는 것은 되풀이하지 않는다. 부분 사이에 걸친 것이 없으면 «부분 사이에 걸친 것 없음» 한 줄만 쓴다.`;

// 뽑아 옮긴 것을 원문 자리에 실을 때 붙이는 머리 — 읽는 쪽이 «원문 전체를 대신하는 것»임을 알게
export const digestNote = (chars) => `(원문 ${Number(chars).toLocaleString('en-US')}자가 한 번에 실리지 않아, 나눠 읽으며 이번 일에 반영할 것을 빠짐없이 뽑아 옮긴 것이다)\n`;

// 본문이 구획 머리표를 흉내 내지 못하게 막는다. 이 손질 말고는 한 글자도 고치지 않는다.
export function neutralize(body) {
  return s(body).split('\n').map((ln) => (ln.startsWith('■') || ln.startsWith('▶') ? ' ' + ln : ln)).join('\n');
}

function section(head, lines) {
  if (!lines.length) return '';
  return '■ ' + head + '\n' + lines.join('\n');
}

function itemsOf(list) {
  return list.map((it) => '▶ ' + s(it.name) + '\n' + neutralize(it.text));
}

// ---------------------------------------------------------------- 시스템 프롬프트

// crew 는 작가가 지어 이 호출에 건 에이전트들 [{ name, role, craft }].
// 걸린 사람이 있으면 그들이 «누가 쓰는가»를 대신한다. 자리의 작법은 그대로 두고 그 밑에 각자의 작법을 잇는다.
export function buildSystem({ prompt, prev, next, crew = [], withFinalRule = true, withNoCount = true } = {}) {
  const p = prompt || {};
  const hands = (crew || []).filter((c) => c && (s(c.name).trim() || s(c.role).trim() || s(c.craft).trim()));
  const parts = [];
  const head = hands.length
    ? hands.map((c) => neutralize(s(c.name) + ' — ' + s(c.role))).join('\n')
    : s(p.name) + ' — ' + s(p.role);
  parts.push('■ 에이전트\n' + head + (hands.length > 1 ? '\n이 글은 위 사람들이 함께 쓴다.' : ''));
  if (prev || next) parts.push('■ 앞뒤\n앞: ' + (s(prev) || '없음') + ' / 뒤: ' + (s(next) || '없음'));
  const craft = [
    s(p.craft).trim(),
    ...hands.filter((c) => s(c.craft).trim()).map((c) => '▶ ' + neutralize(s(c.name) + '\n' + s(c.craft))),
  ].filter(Boolean).join('\n\n');
  if (craft) parts.push('■ 작법\n' + craft);
  if (withFinalRule) parts.push('■ 확정본 규칙\n' + FINAL_RULE);
  if (withNoCount) parts.push('■ 쓰지 않는 말\n' + NO_COUNT);
  parts.push('■ 응답 형식\n' + RESPONSE_RULE);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- 사용자 프롬프트

// 작품 규격은 네 줄로만 적는다. 사용자가 적은 값은 손대지 않는다.
export function specBlock(project, { capNote = true } = {}) {
  const sp = project.spec || {};
  const len = s(sp.length).trim();
  const out = s(sp.outline).trim();
  // 전자책(단계 템플릿 ebook)에는 회차가 없다 — 분량이 비면 «책의 설계»가 자료를 보고 정한다(소설의 «상한 24화»를 싣지 않는다)
  const book = !!(project.workflow && project.workflow.template === 'ebook');
  return neutralize([
    '이름: ' + s(project.name),
    '개요: ' + (out || '정해지지 않음'),
    '형식: ' + s(sp.form),
    '분량: ' + (len || (book ? '정해지지 않음. 책의 설계에서 자료를 보고 정한다.' : capNote ? '정해지지 않음. 상한 24화.' : '정해지지 않음')),
  ].join('\n'));
}

/**
 * refs/targets/finals 는 [{ id, name, text }] 꼴. talk 는 [{ name, text }] 꼴(오래된 것부터).
 * 어느 구획도 자르지 않는다.
 */
export function buildUser({
  project, materials = [], refs = [], finals = [], targets = [], talk = [], reading = [], written = '',
  request = '', task = '', noCount = true,
} = {}) {
  // 한 문서가 여러 자격을 가지면 한 구획에만 남긴다(부르는 쪽에서 이미 갈라 놓지만 한 번 더 막는다).
  const taken = new Set(targets.map((d) => d.id).filter(Boolean));
  const fin = finals.filter((d) => !d.id || !taken.has(d.id));
  for (const d of fin) if (d.id) taken.add(d.id);
  const rf = refs.filter((d) => !d.id || !taken.has(d.id));

  const blocks = [
    section('작품 규격', [specBlock(project)]),
    s(project.standard).trim() ? section('집필 기준', [neutralize(project.standard)]) : '',
    s(project.request).trim() ? section('작품 요청사항', [neutralize(project.request)]) : '',
    section('자료', itemsOf(materials)),
    section('참조 문서', itemsOf(rf)),
    section('확정본 — 최우선 사실', itemsOf(fin)),
    section('대상', itemsOf(targets)),
    section('대화', itemsOf(talk)),
    section('나눠 읽는 부분', itemsOf(reading)),
    // 이어 쓰기 — 끊긴 응답 통째(자르지 않는다)
    s(written) ? section('이미 쓴 부분(끊긴 응답)', [neutralize(written)]) : '',
    s(request).trim() ? section('이번 요청사항', [neutralize(request)]) : '',
    section('이번에 할 일', [s(task) + (noCount ? '\n세어 말하지 않는다.' : '')]),
  ];
  return blocks.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- 응답 후처리 (셋뿐)
// keepEnd — 길이 한도에 닿아 끊긴 응답은 끝을 다듬지 않는다(이어 쓸 때 끊긴 자리 · 문단 경계가 그대로 남게).

export function cleanResponse(text, { keepEnd = false } = {}) {
  let t = s(text).replace(/\r\n/g, '\n');
  t = keepEnd ? t.replace(/^\s+/, '') : t.trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  const lines = t.split('\n');
  if (lines.length && /^#\s+/.test(lines[0])) { lines.shift(); t = lines.join('\n'); t = keepEnd ? t.replace(/^\s+/, '') : t.trim(); }
  return t;
}

// 이어 쓴 조각 — 줄바꿈 꼴만 맞춘다(앞뒤를 다듬지 않는다 — 잇는 자리의 띄어쓰기 · 빈 줄이 그 조각에 있다)
export const cleanPart = (text) => s(text).replace(/\r\n/g, '\n');
