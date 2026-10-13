// 개인판의 «Gemini API 키» 길(2026-10-13 사용자 결정 «제미니 구독은 API키로» — Google 계정 로그인은 약관 문제로 쓰지 않는다). 본체는 ai/local-key.mjs.

import { createGeminiProvider } from './gemini.mjs';
import { createLocalKeyProvider } from './local-key.mjs';

export function createLocalGeminiProvider({ gemini = createGeminiProvider(), ...rest } = {}) {
  return createLocalKeyProvider({ id: 'gemini-key', provider: 'google', name: 'Gemini', keyField: 'geminiKey', tierField: 'geminiModel', adapter: gemini, ...rest });
}

export const localGeminiProvider = createLocalGeminiProvider();
