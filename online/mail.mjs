// 운영자에게 가는 알림 메일 — 환불 요청 · 구독 취소(docs/OPEN_EDITION.md §4-8). 보내는 길은 Resend(HTTPS API) 하나 — 의존성 없이 fetch.
//
// 지키는 것
//   · 키는 Secrets 의 RESEND_API_KEY 에만 — 코드 · Git · 화면 · 로그 · 오류 문구에 싣지 않는다. 실패는 까닭의 이름만 돌려준다.
//   · 받는 주소는 운영 화면 [이용 규칙]의 «알림 메일». Resend 의 시험 발신 주소(onboarding@resend.dev)는 Resend 계정의 이메일로만 보낸다 —
//     운영자 자신에게 보내는 이 쓰임에 맞다. 다른 주소로 보내려면 Resend 에 도메인을 확인하고 MAIL_FROM 을 그 주소로.

export const RESEND_URL = 'https://api.resend.com/emails';
export const DEFAULT_FROM = 'Story Engine <onboarding@resend.dev>';

export function mailConfig(env = process.env) {
  const key = String(env.RESEND_API_KEY || '').trim();
  if (!key) return null;
  return { key, from: String(env.MAIL_FROM || '').trim() || DEFAULT_FROM, url: RESEND_URL };
}

/**
 * 한 통 보내기. 돌려주는 값: { ok, id } 또는 { ok:false, reason: off | no_to | http_<상태> | shape | timeout | network }
 * (Resend 의 오류 본문은 돌려주지 않는다 — 주소 · 키가 섞일 수 있다)
 */
export async function sendMail(cfg, { to, subject, text }, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!cfg) return { ok: false, reason: 'off' };
  if (!to) return { ok: false, reason: 'no_to' };
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(cfg.url || RESEND_URL, {
      method: 'POST', signal: ac.signal,
      // User-Agent 가 없으면 Resend 앞단이 403 으로 막는다
      headers: { authorization: 'Bearer ' + cfg.key, 'content-type': 'application/json', 'user-agent': 'story-engine-online' },
      body: JSON.stringify({ from: cfg.from, to: [to], subject: String(subject || ''), text: String(text || '') }),
    });
    if (!r.ok) return { ok: false, reason: 'http_' + r.status };
    const j = await r.json().catch(() => null);
    return j && j.id ? { ok: true, id: String(j.id) } : { ok: false, reason: 'shape' };
  } catch (e) {
    return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(t);
  }
}

// 잠깐의 실패인가(한 번 더 보내 볼 만한가) — 닿지 않음 · 시간 초과 · 밀림 · 저쪽 오류
export const transient = (reason) => reason === 'network' || reason === 'timeout' || /^http_(429|5\d\d)$/.test(String(reason || ''));

// Secrets 로 보내는 기본 우편함 — on() 은 키가 있는가만, send() 는 그때의 Secrets 로
export const envMailer = { on: () => !!mailConfig(process.env), send: (m) => sendMail(mailConfig(process.env), m) };
