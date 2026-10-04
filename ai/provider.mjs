// AI Provider 계약 — Core 는 «이 계획을 이 모델로 실행해 달라»만 말하고, 실제 부르기는 Provider 가 맡는다.
// 설계: docs/AI_PROVIDER.md. 이 파일은 계약(결과 모양 · 실패 갈래 · usage 정규화)만 담는다 — I/O 없음.
//
// Provider = { id, generate(input) → GenerateResult, validateCredential?(credential) }
//   input  = { model, systemPrompt, userPrompt, credential?, maxOutputTokens?, temperature?, signal?, timeoutMs?, metadata? }
//   result = { ok, text, usage, costUsd, costSource, providerRequestId, finishReason, reason, error, retryAfterMs, limit, elapsedMs }
// **generate 는 절대 throw 하지 않는다** — 모든 실패는 { ok:false, reason } 로 돌아온다(지금 call.mjs 의 약속 그대로).
// credential 은 로그 · 오류 문구 · 결과 어디에도 싣지 않는다.

// 실패의 갈래 — 개인판의 이름(call.REASONS)을 그대로 두고 API Provider 에 필요한 것을 더한다.
export const REASONS = [
  'quota-session', 'quota-week',   // 구독 한도(CLI 전용) — 사람에게 묻는다
  'rate',                          // 잠깐 밀림 — 다시 부르면 된다
  'overloaded',                    // 공급자 과부하·일시 장애 — 다시 부르면 된다
  'auth', 'credit', 'model',       // 키 · 잔액 · 모델 — 다시 불러도 같다
  'invalid',                       // 요청 형식 · 입력 길이 초과
  'safety',                        // 안전 정책으로 거절
  'timeout', 'stopped', 'empty', 'other',
];

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// usage 를 한 꼴로 — 어느 Provider 의 칸 이름이 와도 같은 모양이 된다.
export function usageOf(u = {}) {
  const x = u || {};
  const inputTokens = n(x.inputTokens ?? x.input ?? x.input_tokens ?? x.promptTokenCount);
  const outputTokens = n(x.outputTokens ?? x.output ?? x.output_tokens ?? x.candidatesTokenCount);
  const cacheReadTokens = n(x.cacheReadTokens ?? x.cacheRead ?? x.cache_read_input_tokens ?? x.cachedContentTokenCount ?? (x.input_tokens_details && x.input_tokens_details.cached_tokens));
  const cacheWriteTokens = n(x.cacheWriteTokens ?? x.cacheWrite ?? x.cache_creation_input_tokens);
  const reasoningTokens = n(x.reasoningTokens ?? (x.output_tokens_details && x.output_tokens_details.reasoning_tokens) ?? x.thoughtsTokenCount);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens: inputTokens + outputTokens + cacheWriteTokens };
}

// 가격표(백만 토큰당 USD)로 비용을 추정한다. 가격은 카탈로그(설정)에서 온다 — 코드에 박지 않는다.
export function estimateCost(usage, price) {
  if (!price) return null;
  const u = usageOf(usage);
  const per = (tokens, rate) => (n(rate) * tokens) / 1e6;
  const freshInput = Math.max(0, u.inputTokens - (price.inputIncludesCache ? u.cacheReadTokens : 0));
  return per(freshInput, price.inputPerMTok) + per(u.outputTokens, price.outputPerMTok)
    + per(u.cacheReadTokens, price.cacheReadPerMTok) + per(u.cacheWriteTokens, price.cacheWritePerMTok);
}

const BASE = { ok: false, text: '', usage: usageOf(), costUsd: null, costSource: 'none', providerRequestId: '', finishReason: '', reason: '', error: '', retryAfterMs: 0, limit: null, elapsedMs: 0 };

export function success(fields = {}) {
  return { ...BASE, ...fields, ok: true, usage: usageOf(fields.usage), reason: '', error: '' };
}

export function failure(reason, error = '', fields = {}) {
  return { ...BASE, ...fields, ok: false, text: '', reason: REASONS.includes(reason) ? reason : 'other', error: String(error || ''), usage: usageOf(fields.usage) };
}

export function isProvider(p) {
  return !!p && typeof p.id === 'string' && typeof p.generate === 'function';
}
