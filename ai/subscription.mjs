// SubscriptionProvider — 최상위 운영자의 Claude 구독(Claude Code 로그인)으로 부른다(2026-10-07 사용자 지시).
// 부르는 일은 개인판과 같은 tools/call.mjs 가 한다(stream-json · 동시 고삐 · 실패 분류). 여기서는 두 가지만 못박는다.
//   · 늘 구독으로 — 물려받은 ANTHROPIC_API_KEY 를 지운다(authMode 'sub'). 그 변수가 있으면 키가 이겨서 말없이 종량 과금된다.
//   · 오류 문구는 갈래마다 고정 문구로 — CLI 의 stderr 원문(경로 · 원고가 섞일 수 있다)을 화면 · 기록으로 올리지 않는다.
// 누가 이 길을 쓰는가는 여기서 정하지 않는다 — online/call.mjs 가 «운영자 본인의 개인 작품»일 때만 billing 을 단다.
// 인증은 서버 환경의 CLAUDE_CODE_OAUTH_TOKEN(사람이 `claude setup-token` 으로 받아 Secrets 에 넣는다). 코드 · DB 어디에도 두지 않는다.

import { existsSync } from 'node:fs';
import { runClaudeCall } from '../tools/call.mjs';
import { success, failure } from './provider.mjs';

const SAY = {
  'quota-session': 'Claude 구독 한도(5시간)를 다 썼습니다 — 풀린 뒤에 다시 해 보세요',
  'quota-week': 'Claude 구독 주간 한도를 다 썼습니다',
  rate: '잠시 밀렸습니다', auth: 'Claude 구독 로그인이 필요합니다(Secrets 의 CLAUDE_CODE_OAUTH_TOKEN)',
  credit: '구독 쪽에서 거절했습니다', model: '그 모델을 쓸 수 없습니다', timeout: '응답 없음', stopped: '중지됨', empty: '빈 응답',
  other: 'Claude 구독 호출에 실패했습니다',
};

// cli 가 없거나 토큰이 없으면 «쓸 수 없음» — 화면은 이 값으로 켜기 단추를 막는다.
export function subscriptionStatus({ cli = '', env = process.env } = {}) {
  const cliFound = !!cli && existsSync(cli);
  const tokenSet = !!String(env.CLAUDE_CODE_OAUTH_TOKEN || '').trim();
  return { available: cliFound && tokenSet, cliFound, tokenSet };
}

export function createSubscriptionProvider({ cli = '', run = runClaudeCall } = {}) {
  return {
    id: 'subscription',
    async generate({ model, systemPrompt = '', userPrompt = '', signal = null } = {}) {
      const r = await run({ systemPrompt, prompt: userPrompt, model, signal, authMode: 'sub', cli: cli || null });
      const common = { limit: r.limit || null, elapsedMs: r.elapsedMs || 0 };
      if (!r.ok) return failure(r.reason, SAY[r.reason] || SAY.other, common);
      const u = r.usage || {};
      // 구독은 호출마다 돈이 나가지 않는다 — CLI 가 주는 total_cost_usd 는 «API 였다면»의 값이라 비용으로 적지 않는다.
      return success({
        ...common, text: r.text, finishReason: 'stop', costUsd: null, costSource: 'subscription',
        usage: { inputTokens: u.input || 0, outputTokens: u.output || 0, cacheReadTokens: u.cacheRead || 0, cacheWriteTokens: u.cacheWrite || 0 },
      });
    },
    // 연결 확인 — 가장 작은 호출 하나
    async validate({ model } = {}) {
      const r = await this.generate({ model, userPrompt: '.', systemPrompt: 'Reply with a single period.' });
      return { ok: r.ok || r.reason === 'empty', reason: r.ok ? '' : r.reason, say: r.ok ? '' : r.error };
    },
  };
}
