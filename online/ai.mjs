// 온라인판의 AI 배선 — 카탈로그(설정) · 자격증명(봉인 · PostgreSQL) · 세 Provider 어댑터를 라우터 하나로 묶는다.
// 실제 model id 는 config/models.json(운영자가 config/models.example.json 을 복사해 채운다)에만 있다.
// 마스터 키는 플랫폼 Secrets 의 CREDENTIALS_KEY_V1(32바이트 base64)에만 있다. 없으면 키를 열 수 없어 작업은 «AI 연결 필요»로 멈춘다.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatalog } from '../ai/catalog.mjs';
import { createCredentialService, keysFromEnv } from '../ai/credentials.mjs';
import { createProviderRouter } from '../ai/router.mjs';
import { anthropicProvider } from '../ai/anthropic.mjs';
import { openaiProvider } from '../ai/openai.mjs';
import { geminiProvider } from '../ai/gemini.mjs';
import { pgCredentialStore } from './credentials.mjs';
import { createSubscriptionProvider, subscriptionStatus } from '../ai/subscription.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const MODELS_FILE = join(ROOT, 'config', 'models.json');

export function loadCatalog(file = MODELS_FILE) {
  if (!existsSync(file)) return { catalog: createCatalog([]), aliasTiers: null, problems: ['config/models.json is missing - copy config/models.example.json and fill in model ids'] };
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const catalog = createCatalog(j.models || []);
    return { catalog, aliasTiers: j.aliases && typeof j.aliases === 'object' ? j.aliases : null, problems: catalog.problems };
  } catch {
    return { catalog: createCatalog([]), aliasTiers: null, problems: ['config/models.json is not valid JSON'] };
  }
}

// 운영자 구독용 실행기 — npm 이 받아 둔 Claude Code(선택 의존성). SE_CLAUDE_CLI 로 다른 자리를 가리킬 수 있다.
export const CLAUDE_CLI = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'claude.cmd' : 'claude');

export function buildAi(pool, env = process.env, { providers: given, file, log } = {}) {
  const cli = String(env.SE_CLAUDE_CLI || '') || CLAUDE_CLI;
  const subscription = (given && given.subscription) || createSubscriptionProvider({ cli });
  const providers = { anthropic: anthropicProvider, openai: openaiProvider, google: geminiProvider, ...(given || {}), subscription };
  const { catalog, aliasTiers, problems } = loadCatalog(file);
  const keys = keysFromEnv(env);
  if (!keys.current) problems.push('CREDENTIALS_KEY_V1 is not set - stored AI keys cannot be opened');
  problems.push(...keys.problems);
  const credentials = createCredentialService({ store: pgCredentialStore(pool), keys });
  // 운영자 구독의 형편 · 연결 확인(가장 싼 Claude 등급으로 한 번) — 화면은 운영자에게만 내준다(online/edu.mjs)
  const sub = {
    status: () => (given && given.subscriptionStatus ? given.subscriptionStatus() : subscriptionStatus({ cli, env })),
    async test() {
      const entry = catalog.resolve('anthropic', 'fast') || catalog.resolve('anthropic', 'balanced');
      if (!entry) return { ok: false, reason: 'model', say: '모델 표에 Claude 가 없습니다' };
      const r = await subscription.validate({ model: entry.modelId });
      if (!r.ok) log && log('subscription test: ' + (r.reason || 'other'));
      return r;
    },
  };
  return { generator: createProviderRouter({ catalog, credentials, providers, perKey: Number(env.SE_KEY_CONCURRENCY) || 4 }), credentials, catalog, aliasTiers, problems, keyTester: createKeyTester({ catalog, credentials, providers, log }), subscription: sub };
}

// 키 연결 시험 — 그 회사의 가장 싼 등급(fast, 없으면 balanced)으로 아주 짧게 한 번 부른다. 결과는 키 행에 적는다(markVerified).
// owner = { ownerUserId } | { organizationId } — credentials.resolve 가 비용 주체를 가리는 꼴 그대로. 키 원문은 이 함수 밖으로 나가지 않는다.
export function createKeyTester({ catalog, credentials, providers, log = () => {} }) {
  return async (owner, provider) => {
    const adapter = providers[provider];
    const entry = catalog.resolve(provider, 'fast') || catalog.resolve(provider, 'balanced');
    if (!adapter || !adapter.validateCredential || !entry) return { ok: false, reason: 'model' };
    const cred = await credentials.resolve(owner, provider);
    if (!cred.ok) return { ok: false, reason: cred.reason };
    const r = await adapter.validateCredential(cred.credential, { model: entry.modelId });
    // 워크스페이스에 묶이지 않은 Anthropic 키 — 갈래를 따로 두어 화면이 할 일을 말하게 한다
    if (!r.ok && /not scoped to a workspace/i.test(r.detail || '')) r.reason = 'workspace';
    await credentials.markVerified(cred.credentialId, { ok: r.ok, reason: r.reason || '' });
    // 운영 로그에는 회사 · 갈래 · 상태 번호만(키 · 원문 없음) — «왜 안 붙나»를 Console 에서 가릴 수 있게
    if (!r.ok) log('key test ' + provider + ' ' + entry.modelId + ': ' + (r.reason || 'other') + (r.detail ? ' (' + r.detail + ')' : ''));
    return { ok: !!r.ok, reason: r.reason || '', detail: r.detail || '' };
  };
}
