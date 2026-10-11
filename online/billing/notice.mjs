// 구독 취소 · 환불의 «이유»와 운영자 알림 메일의 글(순수) — docs/OPEN_EDITION.md §4-8 · §4-12(그로블 쪽 해지 · 다시 알림). 보내기는 ../mail.mjs, 언제 보낼지는 ./service.mjs.
// 메일에는 아이디 · 결제 건 번호 · 금액 · 때만 싣는다(이메일 · 키는 싣지 않는다 — 그로블 판매 관리에서는 결제 건 번호로 찾는다).
// 지운 계정(§4-11)은 아이디도 싣지 않는다 — «지운 계정»과 결제 건 번호만. 제목 머리는 앱 이름(전자책 오토 · 스토리 엔진).

// 이유 — 화면은 이 목록을 서버(me.pass)에서 받아 그린다(한 곳에만 둔다)
export const CANCEL_REASONS = [
  { code: 'price', say: '가격이 부담돼요' },
  { code: 'rarely', say: '자주 쓰지 않아요' },
  { code: 'feature', say: '필요한 기능이 없어요' },
  { code: 'hard', say: '쓰기 어렵거나 불편해요' },
  { code: 'quality', say: 'AI 결과가 기대와 달라요' },
  { code: 'switch', say: '다른 서비스를 쓰기로 했어요' },
  { code: 'other', say: '기타' },
];
// 사람이 고르지 않는 이유 — 계정을 지우면 서버가 구독 취소를 저절로 접수한다(§4-11). 목록(화면)에는 없다.
export const SYSTEM_REASONS = [{ code: 'account_deleted', say: '계정을 지움' }];
export const reasonSay = (code) => ([...CANCEL_REASONS, ...SYSTEM_REASONS].find((r) => r.code === code) || { say: String(code || '') }).say;
export const DETAIL_MAX = 500;

// 이유 받기 — 고른 것은 목록 안에서만, 적은 말은 500자(제어 글자는 걷는다). «기타»는 적은 말이 있어야 한다.
export function readReason(b) {
  const reason = String((b && b.reason) || '');
  const detail = String((b && b.detail) || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, DETAIL_MAX);
  if (!CANCEL_REASONS.some((r) => r.code === reason)) return { ok: false, error: '이유를 하나 골라 주세요' };
  if (reason === 'other' && !detail) return { ok: false, error: '«기타»를 고르면 이유를 적어 주세요' };
  return { ok: true, reason, detail };
}

// 알림 메일을 보내지 못한 까닭(이름) → 운영자에게 보일 말. 키 · 주소는 싣지 않는다.
export const MAIL_SAY = {
  off: '메일이 꺼져 있습니다 — Replit Secrets 에 RESEND_API_KEY 를 넣고 다시 게시해 주세요',
  no_to: '받을 메일 주소가 없습니다 — [이용 규칙]의 «알림 메일»을 넣어 주세요',
  http_401: 'Resend 가 키를 받지 않았습니다 — Secrets 의 RESEND_API_KEY 를 확인해 주세요',
  http_403: 'Resend 가 거절했습니다 — 받는 주소가 Resend 에 가입한 이메일과 같은지 확인해 주세요(도메인을 확인하기 전에는 그 주소로만 보냅니다)',
  http_422: 'Resend 가 메일 꼴을 받지 않았습니다 — 보내는 주소(MAIL_FROM)를 확인해 주세요',
  http_429: '잠시 너무 많이 보냈습니다 — 조금 뒤에 다시',
  timeout: 'Resend 가 답하지 않았습니다 — 조금 뒤에 다시', network: 'Resend 에 닿지 않았습니다 — 조금 뒤에 다시',
};
export const mailSay = (reason) => MAIL_SAY[reason] || ('보내지 못했습니다(' + String(reason || 'error') + ')');

const kst = (d) => (d ? new Date(d).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16) : '');
const kday = (d) => (d ? new Date(d).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }) : '');
const won = (n) => (n == null ? '' : Number(n).toLocaleString('ko-KR') + '원');
const idOf = (u) => (u.deleted || !u.loginId ? '지운 계정' : u.loginId);   // 제목에는 아이디만
const who = (u) => (u.deleted || !u.loginId ? '지운 계정' : u.name && u.name !== u.loginId ? u.name + '(' + u.loginId + ')' : u.loginId);
const head = (app) => '[' + (app || '스토리 엔진') + '] ';
const why = (reason, detail) => '· 이유: ' + reasonSay(reason) + (detail ? ' — ' + detail : '');
const payLine = (p) => [p.merchantUid ? '결제 건 번호 ' + p.merchantUid : '', won(p.amount), p.paidAt ? kst(p.paidAt) + ' 결제' : ''].filter(Boolean).join(' · ');
const tail = (site) => ['', '운영 화면: ' + (site ? site + '/manage.html → ' : '') + '관리 → 운영 → [결제 기록]'];

// 다시 알림(§4-12) — 처리되지 않은 요청을 다음 날부터 하루 한 번. day 는 요청한 날부터 센 날(요청한 날 = 1일째)
export function again(msg, day, app = '') {
  if (!(day > 1)) return msg;
  const h = head(app);
  return { subject: h + '다시 알림(' + day + '일째) — ' + (msg.subject.startsWith(h) ? msg.subject.slice(h.length) : msg.subject),
    text: '아직 처리되지 않아 다시 알립니다 — 요청 ' + day + '일째. 처리될 때까지 날마다 한 번 보냅니다.\n\n' + msg.text };
}

// 환불 요청 — 구독 시작 7일 안에 고객이 [환불 요청]을 눌렀다. 이용권은 요청과 함께 멈췄다.
export function refundMail({ user, at, start, until, inPolicy, payment, aiRuns, prevRefunds = 0, reason, detail, site = '', app = '', done = null }) {
  return {
    subject: head(app) + '환불 요청 — ' + idOf(user),
    text: [
      who(user) + ' 님이 환불을 요청했습니다.', '',
      ...(done ? ['· 남은 일: ' + leftOf(done), ''] : []),
      '· 요청: ' + kst(at),
      '· 구독 시작(첫 결제): ' + kday(start) + ' · 환불 기한 ' + until + '까지 → ' + (inPolicy ? '기한 안' : '기한 밖'),
      '· 환불할 결제: ' + payLine(payment),
      '· 구독 시작 뒤 AI 작업: ' + aiRuns + '회',
      '· 이전 환불: ' + (prevRefunds ? prevRefunds + '번' : '없음'),
      why(reason, detail),
      '· 이용권: 요청과 함께 멈췄습니다(새 AI 작업만 — 편집 · 열람 · 내보내기는 그대로)', '',
      '할 일(그로블 판매 관리):',
      '1. 위 결제 환불',
      '2. 이 정기결제 해지',
      '둘 다 그로블에서 처리되면 [결제 기록]의 이 요청에 «환불됨 · 해지됨»이 저절로 찍힙니다.',
      '환불하지 않기로 했으면 [결제 기록] → 이 요청의 [요청 되돌리기](멈춘 이용권이 되살아납니다).',
      ...tail(site),
    ].join('\n'),
  };
}

// 구독 취소 — 환불 기간이 지난 고객이 [구독 취소]를 눌렀다. 이용권은 다음 결제일까지 그대로.
export function cancelMail({ user, at, nextBilling, lastPayment = null, reason, detail, site = '', app = '' }) {
  return {
    subject: head(app) + '구독 취소 — ' + idOf(user),
    text: [
      who(user) + ' 님이 구독 취소를 눌렀습니다.', '',
      '· 요청: ' + kst(at),
      '· 다음 결제일: ' + (nextBilling || '모름') + ' — 이 날 전에 그로블에서 정기결제를 해지해 주세요(놓치면 다시 청구됩니다)',
      '· 이용: ' + (nextBilling ? nextBilling + '까지' : '지금 결제 기간 끝까지') + ' 그대로 씁니다',
      ...(lastPayment ? ['· 마지막 결제: ' + payLine(lastPayment)] : []),
      why(reason, detail), '',
      '할 일(그로블 판매 관리): 이 정기결제 해지',
      '그로블에서 해지되면 [결제 기록]의 이 요청에 «해지 확인»이 저절로 찍힙니다.',
      ...tail(site),
    ].join('\n'),
  };
}

// 환불 건의 남은 일 — ① 그로블 환불 ② 정기결제 해지 가운데 아직인 것
const leftOf = (d) => [d.refunded ? '' : '① 그로블에서 이 결제 환불', d.cancelled ? '' : '② 그로블에서 정기결제 해지'].filter(Boolean).join(' · ') || '없음';

// 그로블에서 먼저 환불됐다(이번 회차) — 정기결제 해지가 아직이면 할 일이 있다(다음 결제일에 다시 청구된다)
export function grobleRefundMail({ user, at, payment, verdict = '', cancelled = false, site = '', app = '' }) {
  return {
    subject: head(app) + (cancelled ? '그로블에서 환불됨 — ' : '확인 필요 — 그로블에서 환불됨 · 정기결제 해지가 아직 — ') + idOf(user),
    text: [
      who(user) + ' 님의 이번 회차 결제가 그로블에서 환불되었습니다.', '',
      '· 때: ' + kst(at),
      '· 환불된 결제: ' + payLine(payment),
      ...(verdict ? ['· 판정: ' + verdict] : []),
      '· 이용권: 환불과 함께 끝났습니다', '',
      cancelled ? '할 일 없음 — 정기결제도 해지되어 있습니다.' : '할 일(그로블 판매 관리): 이 정기결제 해지 — 끊지 않으면 다음 결제일에 다시 청구됩니다.',
      ...(cancelled ? [] : ['해지되면 [결제 기록]의 이 환불 건에 «해지됨»이 저절로 찍힙니다. 그 전까지 날마다 다시 알립니다.']),
      ...tail(site),
    ].join('\n'),
  };
}

// 구매자가 그로블에서 결제 취소(환불)를 요청했다 — 승인 · 반려는 판매자가 그로블에서
export function buyerCancelMail({ user, at, payment, verdict = '', site = '', app = '' }) {
  return {
    subject: head(app) + '확인 필요 — 구매자가 그로블에서 취소(환불) 요청 — ' + idOf(user),
    text: [
      who(user) + ' 님이 그로블에서 결제 취소(환불)를 요청했습니다.', '',
      '· 때: ' + kst(at),
      '· 결제: ' + payLine(payment),
      ...(verdict ? ['· 판정: ' + verdict] : []), '',
      '할 일(그로블 판매 관리): 이 취소 요청 승인 또는 반려 — 승인하면 정기결제도 해지해 주세요.',
      '처리했으면 [결제 기록]의 이 줄을 [처리함]으로 닫아 주세요(환불되면 저절로 닫힙니다). 그 전까지 날마다 다시 알립니다.',
      ...tail(site),
    ].join('\n'),
  };
}

// 그로블 쪽에서 해지됐다(우리에게 낸 요청이 없던 해지 — 고객이 그로블에서 직접 했거나 판매 관리에서) — 알림만, 할 일 없음
export function grobleCancelMail({ user, at, endsAt = null, site = '', app = '' }) {
  return {
    subject: head(app) + '구독 해지(그로블에서) — ' + idOf(user),
    text: [
      who(user) + ' 님의 정기결제가 그로블에서 해지되었습니다(해지 예고).', '',
      '· 때: ' + kst(at),
      '· 이용: ' + (endsAt ? kday(endsAt) + '까지' : '지금 결제 기간 끝까지') + ' 쓰고 끝납니다 — 다음 결제는 청구되지 않습니다', '',
      '할 일 없음(알림만).',
      ...tail(site),
    ].join('\n'),
  };
}

// 해지 예고 없이 정기결제가 끝났다(결제 실패가 이어졌거나 그로블에서 바로 해지) — 알림만
export function endedMail({ user, at, site = '', app = '' }) {
  return {
    subject: head(app) + '구독 끝남 — ' + idOf(user),
    text: [
      who(user) + ' 님의 정기결제가 해지 완료되었습니다(해지 예고 없이 — 결제 실패가 이어졌거나 그로블에서 바로 해지).', '',
      '· 때: ' + kst(at),
      '· 이용권: 끝났습니다', '',
      '할 일 없음(알림만).',
      ...tail(site),
    ].join('\n'),
  };
}

// 계정을 지워 구독 취소를 저절로 접수했다(§4-11) — 아이디 · 이메일은 이미 지웠다. 그로블에서는 결제 건 번호로 찾는다.
export function deletedMail({ at, nextBilling, lastPayment = null, site = '', app = '' }) {
  return {
    subject: head(app) + '구독 취소(계정 삭제) — ' + (lastPayment && lastPayment.merchantUid ? '결제 건 번호 ' + lastPayment.merchantUid : '지운 계정'),
    text: [
      '고객이 계정을 지워 구독 취소를 저절로 접수했습니다(아이디 · 이메일 · 작품은 지웠습니다).', '',
      '· 요청: ' + kst(at),
      '· 다음 결제일: ' + (nextBilling || '모름') + ' — 이 날 전에 그로블에서 정기결제를 해지해 주세요(놓치면 다시 청구됩니다)',
      ...(lastPayment ? ['· 마지막 결제: ' + payLine(lastPayment) + ' — 그로블 판매 관리에서 이 결제 건 번호로 찾습니다'] : ['· 마지막 결제: 기록 없음 — [결제 기록]에서 «지운 계정»의 줄을 봐 주세요']),
      '· 이용권: 계정과 함께 끝났습니다', '',
      '할 일(그로블 판매 관리): 이 정기결제 해지',
      '그로블에서 해지되면 [결제 기록]의 이 요청에 «해지 확인»이 저절로 찍힙니다.',
      ...tail(site),
    ].join('\n'),
  };
}

// 취소를 접수한 정기결제에서 다시 결제됐다 — 그로블 해지가 늦었다
export function chargedMail({ user, requestedAt, at, payment, site = '', app = '' }) {
  return {
    subject: head(app) + '확인 필요 — 구독을 취소한 고객에게 다시 결제됨 — ' + idOf(user),
    text: [
      user.deleted ? '계정을 지운 고객(구독 취소 자동 접수 ' + kst(requestedAt) + ')에게 ' + kst(at) + '에 갱신 결제가 됐습니다.'
        : who(user) + ' 님은 ' + kst(requestedAt) + '에 구독 취소를 눌렀는데 ' + kst(at) + '에 갱신 결제가 됐습니다.', '',
      '· 결제: ' + payLine(payment), '',
      '할 일(그로블 판매 관리): 1. 이 결제 환불  2. 정기결제 해지',
      ...tail(site),
    ].join('\n'),
  };
}

export function testMail({ site = '', app = '' } = {}) {
  return {
    subject: head(app) + '알림 메일 시험',
    text: ['이 메일이 보이면 환불 요청 · 구독 취소 알림이 이 주소로 옵니다.', ...tail(site)].join('\n'),
  };
}
