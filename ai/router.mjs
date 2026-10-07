// Provider 라우터 — 온라인판의 Generator. 한 번의 부르기마다
//   ① provider · tier 고르기(chooseModel — 정책 · 단계 · 에이전트 · 프로젝트 · 기관)
//   ② 카탈로그로 실제 model id · 출력 상한 · 가격 찾기
//   ③ 비용 주체의 키 열기(credentials.resolve — 기관 프로젝트는 기관 키, 개인은 본인 키)
//   ④ 그 Provider 어댑터로 부르기 · 가격표로 비용 추정
// 를 하고, 무엇을 골랐는지(routing)를 결과에 붙인다 — 생성 기록(generation_runs)이 그대로 받는다.
// 키는 이 함수 안에서만 산다. routing 에는 credentialId 만 싣는다.

import { chooseModel, PROVIDERS } from './catalog.mjs';
import { failure, estimateCost } from './provider.mjs';
import { SAY } from './http.mjs';

/**
 * metadata 에 실을 것:
 *   project   { id, ownerUserId, organizationId }
 *   policy    { providers, tiers, allowPick, managedAi } — 기관 정책 · 라이선스가 정한 허용 범위
 *   model     { pick, agent, stage, project, org } — 각 { provider?, tier? }
 */
// 키마다 동시 부르기 고삐 — 한 기관 키에 수업 전체가 한꺼번에 몰려 429 가 줄줄이 나는 것을 막는다(명세: credential 별 속도 고삐).
// 넘치면 차례를 기다린다(작업을 세우면 기다리던 자리에서 곧바로 물러난다). 한 프로세스 안의 고삐다 — worker 를 여럿 띄우면 그 수만큼 곱해진다.
function createGates(limit) {
  const gates = new Map();   // credentialId → { n, wait: [] }
  return {
    async enter(id, signal) {
      if (signal && signal.aborted) return false;   // 들어오기 전에 이미 세워졌다
      if (!id || !(limit > 0)) return true;
      const g = gates.get(id) || { n: 0, wait: [] };
      gates.set(id, g);
      if (g.n < limit) { g.n += 1; return true; }
      return new Promise((resolve) => {
        const w = { resolve };
        g.wait.push(w);
        if (signal) signal.addEventListener('abort', () => { const i = g.wait.indexOf(w); if (i >= 0) { g.wait.splice(i, 1); resolve(false); } }, { once: true });
      });
    },
    leave(id) {
      const g = id && gates.get(id);
      if (!g) return;
      const w = g.wait.shift();
      if (w) { w.resolve(true); return; }   // 자리를 그대로 넘긴다
      g.n -= 1;
      if (!g.n) gates.delete(id);
    },
  };
}

export function createProviderRouter({ catalog, credentials, providers, perKey = 4 }) {
  const gates = createGates(perKey);
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
      // 회사를 아무도 정하지 않았으면(기본) — 비용을 내는 쪽(기관 · 본인)이 키를 넣어 둔 회사로 간다.
      // Claude → ChatGPT → Gemini 차례로, 그 tier 가 카탈로그에 있고 키가 열리는 첫 회사. 아무 키도 없으면 첫 회사로(«연결 필요»).
      // 운영자 구독 — 부르는 쪽(online/call.mjs)이 «운영자 본인의 개인 작품»에만 billing 을 단다. 회사는 Claude 로, 키는 열지 않는다.
      if (meta.billing === 'subscription') {
        const routing = { provider: 'anthropic', tier: choice.tier, source: { ...choice.source, provider: 'subscription' }, modelId: '', credentialId: '', ownerType: 'user', billing: 'subscription' };
        const entry = catalog.resolve('anthropic', choice.tier);
        if (!entry) return { ...failure('model', SAY.model), routing };
        routing.modelId = entry.modelId;
        if (!providers.subscription) return { ...failure('credential', 'Claude 구독 연결이 없습니다'), routing };
        const r = await providers.subscription.generate({ ...input, model: entry.modelId });
        return { ...r, routing };
      }
      let pre = null;
      if (choice.source.provider === 'default') {
        const order = (pol.providers || Object.keys(PROVIDERS)).filter((p) => providers[p]);
        for (const p of order) {
          if (!catalog.resolve(p, choice.tier)) continue;
          const c = await credentials.resolve(meta.project || {}, p, { managedAi: !!pol.managedAi });
          if (c.ok) { choice.provider = p; pre = c; break; }
        }
      }
      const routing = { provider: choice.provider, tier: choice.tier, source: choice.source, modelId: '', credentialId: '', ownerType: '' };
      const entry = catalog.resolve(choice.provider, choice.tier);
      if (!entry) return { ...failure('model', SAY.model), routing };
      routing.modelId = entry.modelId;
      const adapter = providers[choice.provider];
      if (!adapter) return { ...failure('model', SAY.model), routing };
      const cred = pre || await credentials.resolve(meta.project || {}, choice.provider, { managedAi: !!pol.managedAi });
      routing.ownerType = cred.ownerType || '';
      if (!cred.ok) return { ...failure('credential', 'AI 연결이 필요합니다'), routing };
      routing.credentialId = cred.credentialId;
      if (!(await gates.enter(cred.credentialId, input.signal))) return { ...failure('stopped', SAY.stopped), routing };
      let r;
      try {
        r = await adapter.generate({
          ...input,
          model: entry.modelId,
          maxOutputTokens: input.maxOutputTokens || entry.maxOutputTokens || 0,
          credential: cred.credential,
        });
      } finally { gates.leave(cred.credentialId); }
      const cost = r.ok && r.costUsd == null && entry.price ? estimateCost(r.usage, entry.price) : r.costUsd;
      return { ...r, costUsd: cost == null ? null : cost, costSource: r.costSource !== 'none' ? r.costSource : cost == null ? 'none' : 'estimated', routing };
    },
  };
}
