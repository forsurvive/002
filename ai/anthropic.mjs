// AnthropicProvider — Claude Messages API 를 fetch 로 부른다(SDK 없음). 설계: docs/AI_PROVIDER.md §3.
//
// · 긴 출력은 스트리밍(SSE)으로 받는다 — 2~5분 넘는 호출이 중간 장비의 유휴 타임아웃에 끊기지 않게.
//   받은 글은 모았다가 끝에 한 번 돌려준다. 도중에 끊기면(시간 초과 · 연결 끊김 · 스트림 중간 오류 · 끝맺음 없이 닫힘 · 문맥 초과)
//   받은 글이 있으면 버리지 않고 «잘림»(finishReason 'length')으로 돌려준다 — Core 가 끊긴 자리부터 이어 쓴다(core/generation/continue.mjs).
//   사람이 세운 것만은 그대로 stopped.
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

// 회사 설명 문구를 화면에 실을 꼴로 — ASCII 만, 키처럼 생긴 토막은 가리고, 짧게.
export const plainMessage = (m) => String(m || '').replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***').replace(/[^\x20-\x7e]/g, '').slice(0, 200).trim();

export function createAnthropicProvider({ baseUrl = 'https://api.anthropic.com', fetchImpl = globalThis.fetch } = {}) {
  return {
    id: 'anthropic',

    async generate({ model, systemPrompt = '', userPrompt = '', credential = null, maxOutputTokens = 0, temperature, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = null, explain = false } = {}) {
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

      // 받은 것 — 도중에 끊겨도 돌려줄 수 있게 바깥에 둔다
      let text = '';
      let usage = {};
      let stop = '';
      let messageId = '';
      let requestId = '';
      const cut = (why) => done(success({ providerRequestId: requestId || messageId, usage: usageOf(usage), text, finishReason: 'length', cut: why }));
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
          headers: {
            'content-type': 'application/json', 'x-api-key': credential.apiKey, 'anthropic-version': ANTHROPIC_VERSION,
            // 워크스페이스에 묶이지 않은 키는 어느 워크스페이스로 부를지 함께 알려야 한다(없으면 400)
            ...(credential.workspaceId ? { 'anthropic-workspace-id': String(credential.workspaceId) } : {}),
          },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        requestId = (res.headers && res.headers.get && res.headers.get('request-id')) || '';
        if (!res.ok) {
          let err = {};
          try { err = ((await res.json()) || {}).error || {}; } catch { /* 본문이 JSON 이 아님 */ }
          const reason = reasonOf(res.status, err.type, err.message);
          // detail — 상태 번호와 오류 종류만(원문 문구는 싣지 않는다). 연결 시험에서 까닭을 가리는 데 쓴다.
          const head = ('HTTP ' + res.status + ' ' + String(err.type || '').replace(/[^A-Za-z_]/g, '')).trim();
          return done(failure(reason, SAY[reason], { providerRequestId: requestId, retryAfterMs: retryAfterOf(res), detail: explain && err.message ? head + ': ' + plainMessage(err.message) : head }));
        }

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
            if (text.trim() && reason !== 'safety') return cut('error');   // 받은 글이 있으면 잘림으로 — 끊긴 자리부터 잇는다
            return done(failure(reason, SAY[reason], { providerRequestId: requestId || messageId, usage: usageOf(usage) }));
          }
        }
        const meta = { providerRequestId: requestId || messageId, usage: usageOf(usage) };
        if (stop === 'refusal') return done(failure('safety', SAY.safety, meta));
        if (!text.trim()) return done(failure('empty', SAY.empty, meta));
        // 다 썼다(end_turn · stop_sequence)가 아니면 잘림 — 출력 상한(max_tokens) · 문맥 초과(model_context_window_exceeded) · 끝맺음 없이 닫힌 스트림
        const whole = stop === 'end_turn' || stop === 'stop_sequence';
        return done(success({ ...meta, text, finishReason: whole ? 'stop' : 'length', ...(whole || stop === 'max_tokens' ? {} : { cut: stop || 'closed' }) }));
      } catch (e) {
        if (signal && signal.aborted && !timedOut) return done(failure('stopped', SAY.stopped));
        if (text.trim()) return cut(timedOut ? 'timeout' : 'network');   // 받은 글은 버리지 않는다
        if (timedOut) return done(failure('timeout', SAY.timeout));
        return done(failure('other', SAY.other, { detail: netDetail(e) }));   // 연결 끊김 등 — 원문은 싣지 않는다
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    },

    // 연결 시험 — 가장 작은 호출 하나. 키는 돌려주지 않는다.
    async validateCredential(credential, { model } = {}) {
      // 연결 시험만 회사의 설명을 붙인다(explain) — 프롬프트가 «.» 뿐이라 원고가 섞일 일이 없다
      const r = await this.generate({ model, userPrompt: '.', credential, maxOutputTokens: 16, explain: true });
      const fine = r.ok || r.reason === 'empty';
      return { ok: fine, reason: fine ? '' : r.reason, error: fine ? '' : r.error, detail: fine ? '' : (r.detail || '') };
    },
  };
}

export const anthropicProvider = createAnthropicProvider();
