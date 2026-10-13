// 개인판의 «ChatGPT API 키» 길(2026-10-13 사용자 지시 «챗 지피티 api 간편 등록도»). 구독(Codex CLI — ai/local-codex.mjs)과는 다른 길이다 — 값이 키 주인에게 종량으로 나간다.
// 본체는 ai/local-key.mjs · 어댑터는 온라인판과 같은 ai/openai.mjs.

import { createOpenAIProvider } from './openai.mjs';
import { createLocalKeyProvider } from './local-key.mjs';

export function createLocalOpenAIProvider({ openai = createOpenAIProvider(), ...rest } = {}) {
  return createLocalKeyProvider({ id: 'openai-key', provider: 'openai', name: 'ChatGPT', keyField: 'openaiKey', tierField: 'openaiModel', adapter: openai, ...rest });
}

export const localOpenAIProvider = createLocalOpenAIProvider();
