// LocalKeyProvider — 개인판의 «API 키» 길(Gemini · ChatGPT — docs/PERSONAL_USB.md §8). 부르는 일은 온라인판과 같은 어댑터
// (ai/gemini.mjs · ai/openai.mjs — fetch · 키는 헤더에만)가 한다. 여기서는 세 가지만 잇는다:
//   키(data/auth.json — 화면 · 기록에 내려 주지 않는다) · 등급 → model id(카탈로그) · 개인판의 동시 고삐(tools/call.mjs withSeat).
// 모의 실행(SE2_MOCK=1)은 클로드 쪽과 같은 가짜 응답을 낸다(호출 0).

import { success, failure } from './provider.mjs';
import { runClaudeCall, withSeat, MOCK, CALL_TIMEOUT_MS } from '../tools/call.mjs';
import { localCatalog } from '../tools/catalog-local.mjs';
import * as auth from '../tools/auth.mjs';

/**
 * provider : 카탈로그의 회사 이름(google · openai) · name : 화면 이름 · keyField / tierField : data/auth.json 의 칸
 * adapter  : 그 회사의 어댑터(generate({ model, systemPrompt, userPrompt, credential, maxOutputTokens, signal, timeoutMs }))
 */
export function createLocalKeyProvider({ id, provider, name, keyField, tierField, adapter, catalog = localCatalog, read = auth.read, mock = MOCK }) {
  const SAY = { auth: name + ' API 키가 없습니다 — 설정 › 무엇으로 에서 키를 넣어 주십시오', model: '카탈로그(config/models.json)에 그 ' + name + ' 모델이 없습니다' };
  return {
    id,
    async generate({ model, systemPrompt, userPrompt, signal = null, webSearch = false, images = [], metadata = {} } = {}) {
      if (mock) {
        const r = await runClaudeCall({ systemPrompt, prompt: userPrompt, mockKey: (metadata && metadata.code) || '', signal, model, webSearch, images });
        return r.ok ? success({ text: r.text, finishReason: r.finishReason || 'stop', authSource: 'mock', elapsedMs: r.elapsedMs || 0 })
          : failure(r.reason, r.error, { elapsedMs: r.elapsedMs || 0 });
      }
      const a = read();
      if (!a[keyField]) return failure('auth', SAY.auth);
      const entry = catalog().resolve(provider, a[tierField]);
      if (!entry) return failure('model', SAY.model);
      const r = await withSeat(signal, () => adapter.generate({
        model: entry.modelId, systemPrompt, userPrompt, credential: { apiKey: a[keyField] },
        maxOutputTokens: entry.maxOutputTokens, signal, timeoutMs: CALL_TIMEOUT_MS, webSearch: !!webSearch, images,
      }));
      if (!r) return failure('stopped', '중지됨');
      return { ...r, authSource: id };
    },
  };
}
