// GoogleGeminiProvider — Gemini API(generateContent)를 fetch 로 부른다(SDK 없음).
// 요청/응답 모양은 공식 문서(ai.google.dev/api/generate-content)를 따랐다:
//   POST /v1beta/models/{model}:streamGenerateContent?alt=sse — 덩이마다 GenerateContentResponse
//   { systemInstruction: { parts:[{text}] }, contents:[{ role:'user', parts:[{text}] }], generationConfig:{ maxOutputTokens, temperature? } }
//   candidates[].content.parts[].text(thought:true 는 생각 — 본문이 아니다) · finishReason · promptFeedback.blockReason · usageMetadata
// · model id 는 받은 그대로(카탈로그의 일). 키는 x-goog-api-key 헤더에만(주소에 싣지 않는다 — 로그에 남지 않게).

import { success, failure, usageOf } from './provider.mjs';
import { sseEvents, deadline, retryAfterOf, headerOf, SAY } from './http.mjs';

export const DEFAULT_MAX_OUTPUT = 32000;
const SAFETY_STOPS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE']);

export function reasonOf(status, apiStatus = '', message = '') {
  const s = String(apiStatus || '');
  if (/api key not valid|API_KEY_INVALID/i.test(message) || status === 401 || s === 'UNAUTHENTICATED') return 'auth';
  if (status === 403 || s === 'PERMISSION_DENIED') return 'auth';
  if (s === 'FAILED_PRECONDITION' || /billing/i.test(message)) return 'credit';
  if (status === 404 || s === 'NOT_FOUND') return 'model';
  if (status === 429 || s === 'RESOURCE_EXHAUSTED') return 'rate';
  if (status === 400 || s === 'INVALID_ARGUMENT') return 'invalid';
  if (status >= 500 || s === 'UNAVAILABLE' || s === 'INTERNAL' || s === 'DEADLINE_EXCEEDED') return 'overloaded';
  return 'other';
}

export function createGeminiProvider({ baseUrl = 'https://generativelanguage.googleapis.com', fetchImpl = globalThis.fetch } = {}) {
  return {
    id: 'google',

    async generate({ model, systemPrompt = '', userPrompt = '', credential = null, maxOutputTokens = 0, temperature, signal = null, timeoutMs, onProgress = null } = {}) {
      const started = Date.now();
      const done = (r) => ({ ...r, elapsedMs: Date.now() - started });
      if (!String(userPrompt || '').trim()) return done(failure('empty', SAY.empty));
      if (!credential || !credential.apiKey) return done(failure('auth', SAY.auth));
      if (signal && signal.aborted) return done(failure('stopped', SAY.stopped));
      const dl = deadline(signal, timeoutMs);
      const body = {
        ...(String(systemPrompt).trim() ? { systemInstruction: { parts: [{ text: String(systemPrompt) }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: String(userPrompt) }] }],
        generationConfig: {
          maxOutputTokens: Number(maxOutputTokens) || DEFAULT_MAX_OUTPUT,
          ...(temperature == null ? {} : { temperature: Number(temperature) }),
        },
      };
      try {
        const url = baseUrl.replace(/\/+$/, '') + '/v1beta/models/' + encodeURIComponent(String(model || '')) + ':streamGenerateContent?alt=sse';
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': credential.apiKey },
          body: JSON.stringify(body),
          signal: dl.signal,
        });
        if (!res.ok) {
          let err = {};
          try { const j = await res.json(); err = (Array.isArray(j) ? j[0] : j || {}).error || {}; } catch { /* JSON 이 아님 */ }
          const reason = reasonOf(res.status, err.status, err.message);
          return done(failure(reason, SAY[reason], { providerRequestId: headerOf(res, 'x-request-id'), retryAfterMs: retryAfterOf(res) }));
        }
        let text = ''; let finish = ''; let usage = {}; let responseId = ''; let blocked = '';
        for await (const chunk of sseEvents(res.body)) {
          if (chunk.error) {
            const reason = reasonOf(0, chunk.error.status, chunk.error.message);
            return done(failure(reason, SAY[reason], { providerRequestId: responseId }));
          }
          if (chunk.responseId) responseId = chunk.responseId;
          if (chunk.usageMetadata) usage = chunk.usageMetadata;
          if (chunk.promptFeedback && chunk.promptFeedback.blockReason) blocked = chunk.promptFeedback.blockReason;
          const cand = (chunk.candidates || [])[0];
          if (!cand) continue;
          for (const part of (cand.content && cand.content.parts) || []) if (part && !part.thought && typeof part.text === 'string') text += part.text;
          if (cand.finishReason) finish = cand.finishReason;
          if (onProgress) { try { onProgress({ chars: text.length }); } catch { /* 진행 표시가 부르기를 막지 않는다 */ } }
        }
        const meta = { providerRequestId: responseId, usage: usageOf(usage) };
        if (blocked || SAFETY_STOPS.has(finish)) return done(failure('safety', SAY.safety, meta));
        if (!text.trim()) return done(failure('empty', SAY.empty, meta));
        return done(success({ ...meta, text, finishReason: finish === 'MAX_TOKENS' ? 'length' : 'stop' }));
      } catch {
        if (dl.state.timedOut) return done(failure('timeout', SAY.timeout));
        if (signal && signal.aborted) return done(failure('stopped', SAY.stopped));
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

export const geminiProvider = createGeminiProvider();
