// Provider 라우터 — 온라인판의 Generator. 한 번의 부르기마다
//   ① provider · tier 고르기(chooseModel — 정책 · 단계 · 에이전트 · 프로젝트 · 기관)
//   ② 카탈로그로 실제 model id · 출력 상한 · 가격 찾기
//   ③ 비용 주체의 키 열기(credentials.resolve — 기관 프로젝트는 기관 키, 개인은 본인 키)
//   ④ 그 Provider 어댑터로 부르기 · 가격표로 비용 추정
// 를 하고, 무엇을 골랐는지(routing)를 결과에 붙인다 — 생성 기록(generation_runs)이 그대로 받는다.
// 키는 이 함수 안에서만 산다. routing 에는 credentialId 만 싣는다.

import { chooseModel } from './catalog.mjs';
import { failure, estimateCost } from './provider.mjs';
import { SAY } from './http.mjs';

/**
 * metadata 에 실을 것:
 *   project   { id, ownerUserId, organizationId }
 *   policy    { providers, tiers, allowPick, managedAi } — 기관 정책 · 라이선스가 정한 허용 범위
 *   model     { pick, agent, stage, project, org } — 각 { provider?, tier? }
 */
export function createProviderRouter({ catalog, credentials, providers }) {
  return {
    id: 'router',
    async generate(input = {}) {
      const meta = input.metadata || {};
      const pol = meta.policy || {};
      const choice = chooseModel({
        ...(meta.model || {}),
        allowPick: pol.allowPick !== false,
        ...(pol.providers ? { providers: pol.providers } : {}),
        ...(pol.tiers ? { tiers: pol.tiers } : {}),
      });
      const routing = { provider: choice.provider, tier: choice.tier, source: choice.source, modelId: '', credentialId: '', ownerType: '' };
      const entry = catalog.resolve(choice.provider, choice.tier);
      if (!entry) return { ...failure('model', SAY.model), routing };
      routing.modelId = entry.modelId;
      const adapter = providers[choice.provider];
      if (!adapter) return { ...failure('model', SAY.model), routing };
      const cred = await credentials.resolve(meta.project || {}, choice.provider, { managedAi: !!pol.managedAi });
      routing.ownerType = cred.ownerType || '';
      if (!cred.ok) return { ...failure('credential', 'AI 연결이 필요합니다'), routing };
      routing.credentialId = cred.credentialId;
      const r = await adapter.generate({
        ...input,
        model: entry.modelId,
        maxOutputTokens: input.maxOutputTokens || entry.maxOutputTokens || 0,
        credential: cred.credential,
      });
      const cost = r.ok && r.costUsd == null && entry.price ? estimateCost(r.usage, entry.price) : r.costUsd;
      return { ...r, costUsd: cost == null ? null : cost, costSource: r.costSource !== 'none' ? r.costSource : cost == null ? 'none' : 'estimated', routing };
    },
  };
}
