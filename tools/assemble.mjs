// 프롬프트 조립 — 구획을 정해진 순서로 쌓는다.
// 구획 머리표는 '■ ', 항목 이름은 '▶ '. 내용이 없는 구획은 머리표째 뺀다.
// 입출력에 상한을 두지 않는다 — 자료도 참조도 본문도 있는 그대로 전부 싣는다(사용자 지시).

export const FINAL_RULE = `«확정본» 구획에 실린 글은 이 작품의 최우선 사실이다. 다른 구획의 어떤 글보다, 그리고 네 판단보다 앞선다.
확정본과 어긋나는 내용은 쓰지 않는다. 다른 구획의 글이 확정본과 어긋나면 확정본이 옳고 그쪽이 틀린 것이다.
확정본을 고치자고 제안하지 않는다. 확정본에 없는 것만 네가 새로 정한다.`;

export const NO_COUNT = `이 규칙은 네가 써서 내놓는 글에 걸린다.
숫자, 숫자 세기, 개수, 개수 세기, 계량어, 횟수, 장부, 명단, 명부, 박자(반 박자·한 박자 등), 걸음(한 걸음·첫 걸음·걸음마다 등) — 이런 표현을 쓰지 않는다. 문체에도, 문장에도, 내용 설계에도 철저히 배제한다.
세어서 말하지 말고 보이는 대로 쓴다. «세 사람이 서 있었다»가 아니라 «사람들이 서 있었다». «두 번 두드렸다»가 아니라 «두드리고, 다시 두드렸다». «반 박자 늦게»가 아니라 «조금 늦게». «한 걸음 물러섰다»가 아니라 «물러섰다».
항목에 번호를 매겨 늘어놓지 않는다. 몇 가지인지 먼저 말하고 세어 나가는 서술도 쓰지 않는다.
없으면 글이 성립하지 않는 자리에서만 쓴다. 회차 번호, 날짜와 시각, 인물의 나이, 작품 규격에 적힌 분량, 고유명사에 박힌 수는 그대로 쓴다.
망설여지면 쓰지 않는 쪽을 고른다.`;

export const RESPONSE_RULE = `답은 문서 본문 하나다. 인사말, 머리말, «다음은 ...입니다» 같은 말, 끝맺는 말을 붙이지 않는다.
첫 줄에 제목을 쓰지 않는다 — 제목은 프로그램이 붙인다. 본문 안의 소제목은 써도 좋다.
길이를 아끼지 마라. 필요한 만큼 충분히 써라.`;

const s = (v) => (v == null ? '' : String(v));

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
  return neutralize([
    '이름: ' + s(project.name),
    '개요: ' + (out || '정해지지 않음'),
    '형식: ' + s(sp.form),
    '분량: ' + (len || (capNote ? '정해지지 않음. 상한 24화.' : '정해지지 않음')),
  ].join('\n'));
}

/**
 * refs/targets/finals 는 [{ id, name, text }] 꼴. talk 는 [{ name, text }] 꼴(오래된 것부터).
 * 어느 구획도 자르지 않는다.
 */
export function buildUser({
  project, materials = [], refs = [], finals = [], targets = [], talk = [],
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
    s(request).trim() ? section('이번 요청사항', [neutralize(request)]) : '',
    section('이번에 할 일', [s(task) + (noCount ? '\n세어 말하지 않는다.' : '')]),
  ];
  return blocks.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- 응답 후처리 (셋뿐)

export function cleanResponse(text) {
  let t = s(text).replace(/\r\n/g, '\n').trim();
  const fence = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1].trim();
  const lines = t.split('\n');
  if (lines.length && /^#\s+/.test(lines[0])) { lines.shift(); t = lines.join('\n').trim(); }
  return t;
}
