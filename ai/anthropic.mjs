// AnthropicProvider — Claude Messages API 를 fetch 로 부른다(SDK 없음). 설계: docs/AI_PROVIDER.md §3.
//
// · 긴 출력은 스트리밍(SSE)으로 받는다 — 2~5분 넘는 호출이 중간 장비의 유휴 타임아웃에 끊기지 않게.
//   받은 글은 모았다가 끝에 한 번 돌려준다(부분 결과로 문서를 쓰지 않는다).
// · 시스템 프롬프트(호출마다 같은 덩이)에 캐시 지점을 둔다.
// · model id 는 받은 그대로 쓴다 — 고르는 것은 카탈로그(설정)의 일이다. 여기에 박지 않는다.
// · 키는 헤더에만 실린다. 오류 문구 · 결과 · 로그에 싣지 않는다.
// 요청/응답 모양은 공식 문서(Messages API)를 따랐다 — 바뀌면 이 파일과 시험만 고친다.

import { success, failure, usageOf } from './provider.mjs';
import { sseEvents, retryAfterOf, netDetail, SAY } from './http.mjs';

export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_MAX_OUTPUT = 32000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// HTTP 상태 + 오류 종류 → 갈래
export function reasonOf(status, type = '', message = '') {
  if (status === 401 || status === 403 || type === 'authentication_error' || type === 'permission_error') return 'auth';
  if (status === 402 || type === 'billing_error' || /credit balance/i.test(message)) return 'credit';
  if (status === 404 || type === 'not_found_error') return 'model';
  if (status === 429 || type === 'rate_limit_error') return 'rate';
  if (status === 529 || status === 500 || status === 502 || status === 503 || type === 'overloaded_error' || type === 'api_error') return 'overloaded';
  if (status === 400 || status === 413 || type === 'invalid_request_error' || type === 'request_too_large') return 'invalid';
  return 'other';
}

export function createAnthropicProvider({ baseUrl = 'https://api.anthropic.com', fetchImpl = globalThis.fetch } = {}) {
  return {
    id: 'anthropic',

    async generate({ model, systemPrompt = '', userPrompt = '', credential = null, maxOutputTokens = 0, temperature, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = null } = {}) {
      const started = Date.now();
      const done = (r) => ({ ...r, elapsedMs: Date.now() - started });
      if (!String(userPrompt || '').trim()) return done(failure('empty', SAY.empty));
      if (!credential || !credential.apiKey) return done(failure('auth', SAY.auth));
      if (signal && signal.aborted) return done(failure('stopped', SAY.stopped));

      // 사람이 세운 것과 시간이 넘친 것을 가른다
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      const body = {
        model,
        max_tokens: Number(maxOutputTokens) || DEFAULT_MAX_OUTPUT,
        stream: true,
        ...(String(systemPrompt).trim() ? { system: [{ type: 'text', text: String(systemPrompt), cache_control: { type: 'ephemeral' } }] } : {}),
        messages: [{ role: 'user', content: String(userPrompt) }],
        ...(temperature == null ? {} : { temperature: Number(temperature) }),
      };

      try {
        const res = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': credential.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        const requestId = (res.headers && res.headers.get && res.headers.get('request-id')) || '';
        if (!res.ok) {
          let err = {};
          try { err = ((await res.json()) || {}).error || {}; } catch { /* 본문이 JSON 이 아님 */ }
          const reason = reasonOf(res.status, err.type, err.message);
          // detail — 상태 번호와 오류 종류만(원문 문구는 싣지 않는다). 연결 시험에서 까닭을 가리는 데 쓴다.
          return done(failure(reason, SAY[reason], { providerRequestId: requestId, retryAfterMs: retryAfterOf(res), detail: ('HTTP ' + res.status + ' ' + String(err.type || '').replace(/[^A-Za-z_]/g, '')).trim() }));
        }

        let text = '';
        let usage = {};
        let stop = '';
        let messageId = '';
        for await (const ev of sseEvents(res.body)) {
          if (ev.type === 'message_start' && ev.message) { messageId = ev.message.id || ''; usage = { ...(ev.message.usage || {}) }; }
          else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
            text += ev.delta.text || '';
            if (onProgress) { try { onProgress({ chars: text.length }); } catch { /* 진행 표시가 부르기를 막지 않는다 */ } }
          } else if (ev.type === 'message_delta') {
            if (ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
            if (ev.usage) usage = { ...usage, ...ev.usage };
          } else if (ev.type === 'error') {
            const e = ev.error || {};
            const reason = reasonOf(0, e.type, e.message);
            return done(failure(reason, SAY[reason], { providerRequestId: requestId || messageId, usage: usageOf(usage) }));
          }
        }
        const meta = { providerRequestId: requestId || messageId, usage: usageOf(usage) };
        if (stop === 'refusal') return done(failure('safety', SAY.safety, meta));
        if (!text.trim()) return done(failure('empty', SAY.empty, meta));
        return done(success({ ...meta, text, finishReason: stop === 'max_tokens' ? 'length' : 'stop' }));
      } catch (e) {
        if (timedOut) return done(failure('timeout', SAY.timeout));
        if (signal && signal.aborted) return done(failure('stopped', SAY.stopped));
        return done(failure('other', SAY.other, { detail: netDetail(e) }));   // 연결 끊김 등 — 원문은 싣지 않는다
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    },

    // 연결 시험 — 가장 작은 호출 하나. 키는 돌려주지 않는다.
    async validateCredential(credential, { model } = {}) {
      const r = await this.generate({ model, userPrompt: '.', credential, maxOutputTokens: 1 });
      const fine = r.ok || r.reason === 'empty';
      return { ok: fine, reason: fine ? '' : r.reason, error: fine ? '' : r.error, detail: fine ? '' : (r.detail || '') };
    },
  };
}

export const anthropicProvider = createAnthropicProvider();
