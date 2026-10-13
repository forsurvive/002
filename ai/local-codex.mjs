// LocalCodexCliProvider — 개인판의 ChatGPT 구독 길(Codex CLI)을 Provider 계약으로 감싼다(docs/PERSONAL_USB.md §8).
// 부르는 일은 tools/call.mjs 의 runCodexCall 이 한다. 여기서는 결과 모양만 local-cli 와 같게 맞춘다.
// 온라인 production 의 경로가 아니다 — 남의 구독으로 부르는 길은 두지 않는다(docs/OPEN_EDITION.md §1).

import { runCodexCall } from '../tools/call.mjs';
import { success, failure } from './provider.mjs';

export const localCodexProvider = {
  id: 'local-codex',
  async generate({ model, systemPrompt, userPrompt, signal = null, metadata = {} } = {}) {
    const r = await runCodexCall({ systemPrompt, prompt: userPrompt, mockKey: (metadata && metadata.code) || '', signal, model });
    const common = { limit: null, elapsedMs: r.elapsedMs || 0, authSource: r.authSource || 'chatgpt' };
    if (!r.ok) return failure(r.reason, r.error, common);
    const u = r.usage || {};
    return success({ ...common, text: r.text, usage: u, finishReason: r.finishReason || 'stop', costUsd: null, costSource: 'none' });
  },
};
