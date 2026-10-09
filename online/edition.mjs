// 판 스위치 — 코드는 하나, 판은 둘(docs/OPEN_EDITION.md §2 · §4-1). 환경 변수 SE_EDITION 하나로 고른다.
//   school(기본) — 교육기관판: 지금 그대로(기관 · 수업 · 초대 · 라이선스 · 기관 키).
//   open        — 자유 가입판: 누구나 가입 · 본인 키 · 월 이용료. 기관 · 수업에 딸린 문은 화면에서 숨기고 서버 문은 404.
// 모르는 값은 school 로 읽는다(닫힌 쪽이 기본 — 가입 문이 저절로 열리지 않게).

export const EDITIONS = ['school', 'open'];

export function editionOf(env = process.env) {
  return String(env.SE_EDITION || '').trim().toLowerCase() === 'open' ? 'open' : 'school';
}

// 자유 가입판이 쓰지 않는 교육기관 문(POST /api/edu) — 기관 · 이용 기간 · 수업 · 초대 · 기관 키 · 수업 현황 · 기관 사람 · 수업 작품 복사
export const SCHOOL_ONLY_OPS = new Set([
  'org.create', 'org.status', 'org.list', 'org.settings', 'org.members',
  'org.key.set', 'org.key.list', 'org.key.test', 'org.key.revoke',
  'license.issue', 'license.status', 'license.limits', 'license.read',
  'class.create', 'class.dates', 'class.list', 'class.archive', 'class.progress', 'class.instructors', 'class.assign',
  'invite.create', 'invite.list', 'invite.revoke', 'invite.accept', 'invite.check', 'login.available',
  'member.create', 'member.remove', 'member.reset_password',
  'project.copy_personal',
]);
// 두 판 모두에 있지만 기관을 가리키면(orgId) 자유 가입판에서는 없는 문 — 운영자 전체 · 내 것은 그대로
export const ORG_SCOPED_OPS = new Set(['audit.list', 'usage.summary', 'workflow.view', 'workflow.save']);

// 자유 가입판에만 있는 문 — 내 이용권(me.pass …) · 고객 · 결제 관리(billing.* — 운영자)
export const isOpenOnlyOp = (op) => /^(me\.pass(\.|$)|billing\.)/.test(String(op || ''));

// 이 판에 이 문이 있는가 — 없으면 서버가 «그런 문이 없습니다»(404)로 답한다(있는지도 흘리지 않는다)
export function eduOpAllowed(edition, op, body = {}) {
  if (edition === 'open') return !SCHOOL_ONLY_OPS.has(op) && !(ORG_SCOPED_OPS.has(op) && body && body.orgId);
  return !isOpenOnlyOp(op);
}
