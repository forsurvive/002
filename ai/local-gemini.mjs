// LocalGeminiKeyProvider — 개인판의 «Gemini API 키» 길(docs/PERSONAL_USB.md §8-2, 2026-10-13 사용자 결정 «제미니 구독은 API키로»).
// 부르는 일은 온라인판과 같은 어댑터(ai/gemini.mjs — fetch · 키는 헤더에만)가 한다. 여기서는 세 가지만 잇는다:
//   키(data/auth.json — 화면 · 기록에 내려 주지 않는다) · 등급 → model id(카탈로그) · 개인판의 동시 고삐(tools/call.mjs withSeat).
// 모의 실행(SE2_MOCK=1)은 클로드 쪽과 같은 가짜 응답을 낸다(호출 0).

import { createGeminiProvider } from './gemini.mjs';
import { success, failure } from './provider.mjs';
import { runClaudeCall, withSeat, MOCK, CALL_TIMEOUT_MS } from '../tools/call.mjs';
import { localCatalog } from '../tools/catalog-local.mjs';
import * as auth from '../tools/auth.mjs';

const SAY = { auth: 'Gemini API 키가 없습니다 — 설정 › 무엇으로 에 키를 넣어 주십시오', model: '카탈로그(config/models.json)에 그 Gemini 모델이 없습니다' };

export function createLocalGeminiProvider({ gemini = createGeminiProvider(), catalog = localCatalog, read = auth.read, mock = MOCK } = {}) {
  return {
    id: 'local-gemini',
    async generate({ model, systemPrompt, userPrompt, signal = null, metadata = {} } = {}) {
      if (mock) {
        const r = await runClaudeCall({ systemPrompt, prompt: userPrompt, mockKey: (metadata && metadata.code) || '', signal, model });
        return r.ok ? success({ text: r.text, finishReason: r.finishReason || 'stop', authSource: 'mock', elapsedMs: r.elapsedMs || 0 })
          : failure(r.reason, r.error, { elapsedMs: r.elapsedMs || 0 });
      }
      const a = read();
      if (!a.geminiKey) return failure('auth', SAY.auth);
      const entry = catalog().resolve('google', a.geminiModel);
      if (!entry) return failure('model', SAY.model);
      const r = await withSeat(signal, () => gemini.generate({
        model: entry.modelId, systemPrompt, userPrompt, credential: { apiKey: a.geminiKey },
        maxOutputTokens: entry.maxOutputTokens, signal, timeoutMs: CALL_TIMEOUT_MS,
      }));
      if (!r) return failure('stopped', '중지됨');
      return { ...r, authSource: 'gemini-key' };
    },
  };
}

export const localGeminiProvider = createLocalGeminiProvider();
