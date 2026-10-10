// 모델 카탈로그 — 화면의 «High Reasoning / Balanced / Fast» 를 실제 provider model id 로 바꾸는 자리.
// 실제 id · 가격 · 출력 상한(그 모델의 최대치 — 우리가 줄이지 않는다)은 **설정 데이터**(config/models.json 또는 이후 DB 의 model_catalog)에만 있다 — 코드에 박지 않는다.
// 모델이 바뀌면 운영자가 설정만 고친다(명세 부록 E · Z 시나리오 5). I/O 없음 — 읽어 온 표를 받는다.

export const PROVIDERS = { anthropic: 'Claude', openai: 'GPT', google: 'Gemini' };
export const TIERS = { high_reasoning: 'High Reasoning', balanced: 'Balanced', fast: 'Fast' };

const clean = (e) => ({
  provider: String(e.provider || ''),
  tier: String(e.tier || ''),
  modelId: String(e.modelId || '').trim(),
  displayName: String(e.displayName || ''),
  maxOutputTokens: Math.max(0, Number(e.maxOutputTokens) || 0),   // 그 모델의 최대치. 0 = 보내지 않는다(모델이 제 최대치까지)
  price: e.price && typeof e.price === 'object' ? { ...e.price } : null,
  active: e.active !== false,
});

/**
 * entries = [{ provider, tier, modelId, displayName?, maxOutputTokens?, price?{inputPerMTok,outputPerMTok,cacheReadPerMTok,cacheWritePerMTok}, active? }]
 * 틀린 줄은 버리지 않고 problems 에 적는다(운영자가 고치도록). 쓸 수 있는 것은 (provider, tier) 당 활성 하나.
 */
export function createCatalog(entries = []) {
  const problems = [];
  const table = new Map();
  (Array.isArray(entries) ? entries : []).forEach((raw, i) => {
    const e = clean(raw || {});
    const where = '#' + (i + 1) + ' ' + e.provider + '/' + e.tier;
    if (!(e.provider in PROVIDERS)) return problems.push(where + ': unknown provider');
    if (!(e.tier in TIERS)) return problems.push(where + ': unknown tier');
    if (!e.active) return;
    if (!e.modelId || /[<>]/.test(e.modelId)) return problems.push(where + ': modelId not set');
    const k = e.provider + '/' + e.tier;
    if (table.has(k)) return problems.push(where + ': duplicate active entry');
    table.set(k, e);
  });
  return {
    problems,
    resolve(provider, tier) { return table.get(String(provider) + '/' + String(tier)) || null; },
    // 화면에 내보내는 꼴 — model id · 가격은 싣지 않는다(학생은 보지 않는다). 허락된 것만.
    choices({ providers = null, tiers = null } = {}) {
      return [...table.values()]
        .filter((e) => (!providers || providers.includes(e.provider)) && (!tiers || tiers.includes(e.tier)))
        .map((e) => ({ provider: e.provider, tier: e.tier, label: PROVIDERS[e.provider] + ' · ' + TIERS[e.tier] }));
    },
    // 관리자 화면용 — id · 가격까지
    entries() { return [...table.values()].map((e) => ({ ...e })); },
  };
}

/**
 * 이번 호출의 provider · tier 를 고른다(docs/ARCHITECTURE_TARGET.md §4-2).
 * 차례: 이번에 고른 값(정책이 허락할 때만) → 걸린 에이전트 → 워크플로우 단계 기본 → 프로젝트 기본 → 기관 기본 → balanced.
 * 결과는 허락된 provider × tier 안으로 잘린다. 어디서 왔는지(source)를 함께 돌려준다 — 생성 기록에 남긴다.
 */
export function chooseModel({
  pick = null, agent = null, stage = null, project = null, org = null,
  allowPick = true, providers = Object.keys(PROVIDERS), tiers = Object.keys(TIERS),
} = {}) {
  const fits = (c) => c && (!c.provider || providers.includes(c.provider)) && (!c.tier || tiers.includes(c.tier));
  const layers = [['pick', allowPick ? pick : null], ['agent', agent], ['stage', stage], ['project', project], ['org', org]];
  let provider = ''; let tier = ''; let pSrc = ''; let tSrc = '';
  for (const [src, c] of layers) {
    if (!c || !fits(c)) continue;
    if (!provider && c.provider) { provider = c.provider; pSrc = src; }
    if (!tier && c.tier) { tier = c.tier; tSrc = src; }
  }
  if (!provider) { provider = providers[0] || ''; pSrc = 'default'; }
  if (!tier) { tier = tiers.includes('balanced') ? 'balanced' : tiers[0] || ''; tSrc = 'default'; }
  return { provider, tier, source: { provider: pSrc, tier: tSrc } };
}
