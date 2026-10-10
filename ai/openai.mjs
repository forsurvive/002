// OpenAIProvider — OpenAI Responses API 를 fetch 로 부른다(SDK 없음). «ChatGPT 지원»은 이 Provider 를 뜻한다(명세 부록 C).
// 요청/응답 모양은 OpenAI 의 공식 OpenAPI 명세(openai/openai-openapi)를 따랐다:
//   POST /v1/responses { model, instructions, input, max_output_tokens, stream, store, temperature? }
//   스트림: response.output_text.delta(delta) · response.completed / response.incomplete(response) · response.failed(response.error) · error
// · store:false — 학생 원고를 OpenAI 쪽에 보관하지 않는다.
// · temperature 는 받았을 때만 싣는다(추론 모델은 받지 않는다).
// · model id 는 받은 그대로(카탈로그의 일). 키는 헤더에만.
// · 도중에 끊기면(시간 초과 · 연결 끊김 · 끝 이벤트 없이 닫힘) 받은 글이 있으면 «잘림»으로 돌려준다 — Core 가 이어 쓴다(anthropic.mjs 와 같다).

import { success, failure, usageOf } from './provider.mjs';
import { sseEvents, deadline, retryAfterOf, headerOf, SAY } from './http.mjs';

export const DEFAULT_MAX_OUTPUT = 32000;

export function reasonOf(status, code = '', message = '') {
  const c = String(code || '');
  if (c === 'insufficient_quota' || /billing|quota/i.test(c)) return 'credit';
  if (c === 'rate_limit_exceeded' || status === 429) return 'rate';
  if (status === 401 || status === 403 || c === 'invalid_api_key') return 'auth';
  if (status === 404 || c === 'model_not_found') return 'model';
  if (c === 'context_length_exceeded' || c === 'invalid_prompt' || status === 400 || status === 413 || status === 422) return 'invalid';
  if (c === 'server_error' || status >= 500) return 'overloaded';
  return /quota/i.test(message) ? 'credit' : 'other';
}

const textOf = (resp) => ((resp && resp.output) || [])
  .filter((o) => o && o.type === 'message')
  .flatMap((o) => o.content || [])
  .filter((c) => c && c.type === 'output_text')
  .map((c) => c.text || '').join('');

export function createOpenAIProvider({ baseUrl = 'https://api.openai.com', fetchImpl = globalThis.fetch } = {}) {
  return {
    id: 'openai',

    async generate({ model, systemPrompt = '', userPrompt = '', credential = null, maxOutputTokens = 0, temperature, signal = null, timeoutMs, onProgress = null } = {}) {
      const started = Date.now();
      const done = (r) => ({ ...r, elapsedMs: Date.now() - started });
      if (!String(userPrompt || '').trim()) return done(failure('empty', SAY.empty));
      if (!credential || !credential.apiKey) return done(failure('auth', SAY.auth));
      if (signal && signal.aborted) return done(failure('stopped', SAY.stopped));
      const dl = deadline(signal, timeoutMs);
      let text = '';
      let requestId = '';
      const cut = (why) => done(success({ providerRequestId: requestId, text, finishReason: 'length', cut: why }));
      const body = {
        model,
        ...(String(systemPrompt).trim() ? { instructions: String(systemPrompt) } : {}),
        input: String(userPrompt),
        max_output_tokens: Number(maxOutputTokens) || DEFAULT_MAX_OUTPUT,
        stream: true,
        store: false,
        ...(temperature == null ? {} : { temperature: Number(temperature) }),
      };
      try {
        const res = await fetchImpl(baseUrl.replace(/\/+$/, '') + '/v1/responses', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + credential.apiKey },
          body: JSON.stringify(body),
          signal: dl.signal,
        });
        requestId = headerOf(res, 'x-request-id');
        if (!res.ok) {
          let err = {};
          try { err = ((await res.json()) || {}).error || {}; } catch { /* JSON 이 아님 */ }
          const reason = reasonOf(res.status, err.code || err.type, err.message);
          return done(failure(reason, SAY[reason], { providerRequestId: requestId, retryAfterMs: retryAfterOf(res) }));
        }
        let final = null;
        for await (const ev of sseEvents(res.body)) {
          if (ev.type === 'response.output_text.delta') {
            text += ev.delta || '';
            if (onProgress) { try { onProgress({ chars: text.length }); } catch { /* 진행 표시가 부르기를 막지 않는다 */ } }
          } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response || {};
          else if (ev.type === 'response.failed') {
            const e = (ev.response && ev.response.error) || {};
            const reason = reasonOf(0, e.code, e.message);
            return done(failure(reason === 'other' ? 'overloaded' : reason, SAY[reason === 'other' ? 'overloaded' : reason], { providerRequestId: requestId || (ev.response && ev.response.id) || '' }));
          } else if (ev.type === 'error') {
            const reason = reasonOf(0, ev.code, ev.message);
            if (text.trim()) return cut('error');   // 받은 글이 있으면 잘림으로 — 끊긴 자리부터 잇는다
            return done(failure(reason, SAY[reason], { providerRequestId: requestId }));
          }
        }
        const resp = final || {};
        if (!text) text = textOf(resp);   // 델타를 못 받았으면 마지막 응답에서 꺼낸다
        const meta = { providerRequestId: requestId || resp.id || '', usage: usageOf(resp.usage || {}) };
        const why = resp.incomplete_details && resp.incomplete_details.reason;
        if (why === 'content_filter') return done(failure('safety', SAY.safety, meta));
        if (!text.trim()) return done(failure('empty', SAY.empty, meta));
        // 끝 이벤트(completed · incomplete) 없이 닫힌 스트림도 잘림이다
        return done(success({ ...meta, text, finishReason: why === 'max_output_tokens' || !final ? 'length' : 'stop', ...(final ? {} : { cut: 'closed' }) }));
      } catch {
        if (signal && signal.aborted && !dl.state.timedOut) return done(failure('stopped', SAY.stopped));
        if (text.trim()) return cut(dl.state.timedOut ? 'timeout' : 'network');   // 받은 글은 버리지 않는다
        if (dl.state.timedOut) return done(failure('timeout', SAY.timeout));
        return done(failure('other', SAY.other));
      } finally {
        dl.done();
      }
    },

    async validateCredential(credential, { model } = {}) {
      const r = await this.generate({ model, userPrompt: '.', credential, maxOutputTokens: 16 });
      const fine = r.ok || r.reason === 'empty';
      return { ok: fine, reason: fine ? '' : r.reason, error: fine ? '' : r.error, detail: fine ? '' : (r.detail || '') };
    },
  };
}

export const openaiProvider = createOpenAIProvider();
