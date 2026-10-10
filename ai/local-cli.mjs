// LocalClaudeCliProvider — 개인판의 부르기(Claude Code CLI · 구독 사용량 또는 API 키)를 Provider 계약으로 감싼다.
// 부르는 일은 그대로 tools/call.mjs 가 한다(stream-json · 고삐 · 실패 분류 · 모의 응답). 여기서는 결과 모양만 맞춘다.
// 온라인 production 의 경로가 아니다(docs/AI_PROVIDER.md §9).

import { runClaudeCall } from '../tools/call.mjs';
import { success, failure } from './provider.mjs';

export const localCliProvider = {
  id: 'local-cli',
  async generate({ model, systemPrompt, userPrompt, signal = null, metadata = {} } = {}) {
    const r = await runClaudeCall({ systemPrompt, prompt: userPrompt, mockKey: (metadata && metadata.code) || '', signal, model });
    const common = { limit: r.limit || null, elapsedMs: r.elapsedMs || 0, authSource: r.authSource || '' };
    if (!r.ok) return failure(r.reason, r.error, { ...common, ...(r.fit ? { fit: r.fit } : {}) });
    const u = r.usage || {};
    return success({
      ...common, text: r.text, usage: u, finishReason: r.finishReason || 'stop',   // 길이 한도에 닿았으면 length(tools/call.mjs) — Core 가 이어 쓴다
      costUsd: r.usage ? Number(u.costUsd) || 0 : null, costSource: r.usage ? 'provider' : 'none',
    });
  },
};
