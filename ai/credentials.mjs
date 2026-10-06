// AI 자격증명(credential) — 누구의 키로 부르는가(USER / ORGANIZATION / PLATFORM)와, 키를 어떻게 지키는가.
// 설계: docs/SECURITY.md §5 · docs/AI_PROVIDER.md §6.
//
// · 키는 AES-256-GCM 으로 봉해 둔다. 마스터 키는 플랫폼 Secrets(CREDENTIALS_KEY_V1, 32바이트 base64)에만 있다.
//   행마다 key_version 을 두어 마스터 키를 바꿀 수 있다. AAD 에 소유자 · provider · id 를 묶어 행 바꿔치기를 막는다.
// · 복호화는 부르기 직전에만, 결과 문자열은 그 호출 안에서만 산다. 화면에는 { provider, status, keyHint, lastVerifiedAt } 만.
// · 저장소(store)는 바깥이 넣는다 — 개발·시험은 메모리, 온라인은 PostgreSQL(provider_credentials).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const OWNERS = ['user', 'organization', 'platform'];
export const PROVIDER_IDS = ['anthropic', 'openai', 'google'];

// ---------------------------------------------------------------- 마스터 키

// env 에서 마스터 키들을 읽는다 — CREDENTIALS_KEY_V1, _V2 … 가장 큰 번호가 새로 봉할 때 쓰는 키다.
export function keysFromEnv(env = process.env) {
  const keys = new Map();
  const problems = [];
  for (const [name, value] of Object.entries(env)) {
    const m = /^CREDENTIALS_KEY_V(\d+)$/.exec(name);
    if (!m) continue;
    const buf = Buffer.from(String(value || ''), 'base64');
    if (buf.length !== 32) { problems.push(name + ' must be 32 bytes in base64'); continue; }
    keys.set(Number(m[1]), buf);
  }
  const current = keys.size ? Math.max(...keys.keys()) : 0;
  return { keys, current, problems };
}

const aadOf = ({ ownerType, ownerId, provider, id }) => Buffer.from([ownerType, ownerId || '', provider, id].join('|'), 'utf8');

export function seal(plain, { keys, current }, meta) {
  const key = keys.get(current);
  if (!key) throw new Error('no credential master key');
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aadOf(meta));
  const ciphertext = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { keyVersion: current, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function open(sealed, { keys }, meta) {
  const key = keys.get(Number(sealed.keyVersion));
  if (!key) throw new Error('credential master key version missing');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.nonce, 'base64'));
  d.setAAD(aadOf(meta));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(sealed.ciphertext, 'base64')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- 누구의 키인가

// 프로젝트 → 비용 주체. 기관 프로젝트는 기관, 개인은 그 사람, 플랫폼이 AI 를 대 주는 요금제면 플랫폼(명세 부록 H-1).
export function ownerOf(project, { managedAi = false } = {}) {
  if (project && project.organizationId) return { ownerType: 'organization', ownerId: String(project.organizationId) };
  if (managedAi) return { ownerType: 'platform', ownerId: '' };
  return { ownerType: 'user', ownerId: String((project && project.ownerUserId) || '') };
}

// 붙여 넣을 때 섞이는 것 — 공백 · 줄바꿈 · 보이지 않는 글자 · 둘러싼 따옴표 — 를 걷는다. 키에는 원래 없는 글자들이다.
export const cleanKey = (k) => String(k || '').replace(/[\s\u200B-\u200D\u2060\uFEFF]/g, '').replace(/^["'`]+|["'`]+$/g, '');

const hintOf = (k) => (String(k).length >= 8 ? '…' + String(k).slice(-4) : '…');

// 화면에 내보내는 꼴 — 원문은 절대 싣지 않는다
export const viewOf = (row) => ({
  id: row.id, provider: row.provider, ownerType: row.ownerType, status: row.status,
  keyHint: row.keyHint, lastVerifiedAt: row.lastVerifiedAt || 0, lastErrorCode: row.lastErrorCode || '',
});

// ---------------------------------------------------------------- 저장소(메모리 구현 — 개발 · 시험용, 온라인은 같은 모양의 PostgreSQL 구현)

export function memoryCredentialStore() {
  const rows = [];
  return {
    async insert(row) { rows.push({ ...row }); return { ...row }; },
    async update(id, patch) { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, patch); return r ? { ...r } : null; },
    async findActive(ownerType, ownerId, provider) { const r = rows.find((x) => x.status === 'active' && x.ownerType === ownerType && x.ownerId === ownerId && x.provider === provider); return r ? { ...r } : null; },
    async list(ownerType, ownerId) { return rows.filter((x) => x.ownerType === ownerType && x.ownerId === ownerId).map((x) => ({ ...x })); },
    _rows: rows,   // 시험이 «원문이 저장되지 않았다»를 확인하려고 들여다본다
  };
}

let seq = 0;
const newCredId = () => 'cred_' + Date.now().toString(36) + (++seq).toString(36) + randomBytes(3).toString('hex');

/**
 * 자격증명 서비스. store 는 위 모양, keys 는 keysFromEnv() 의 결과.
 *   set     — 새 키를 봉해 넣는다. 같은 주체 · provider 의 앞 키는 revoked. 돌려주는 것은 viewOf(원문 없음).
 *   resolve — 프로젝트의 비용 주체로 그 provider 의 활성 키를 찾아 연다 → { ok, credential:{ apiKey }, credentialId, ownerType, ownerId }
 *             없으면 { ok:false, reason:'credential_missing' } (작업은 «연결 필요»로 멈춘다).
 *   revoke  — 끊는다.
 */
export function createCredentialService({ store, keys }) {
  return {
    async set({ ownerType, ownerId = '', provider, apiKey, label = '', createdBy = '' }) {
      if (!OWNERS.includes(ownerType)) return { ok: false, error: 'owner' };
      if (!PROVIDER_IDS.includes(provider)) return { ok: false, error: 'provider' };
      const key = cleanKey(apiKey);
      if (key.length < 8) return { ok: false, error: 'key' };
      if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, error: 'key_chars' };   // 헤더에 실을 수 없는 글자 — 부르는 순간 끊긴다
      const old = await store.findActive(ownerType, String(ownerId), provider);
      const id = newCredId();
      const sealed = seal(key, keys, { ownerType, ownerId: String(ownerId), provider, id });
      const row = await store.insert({
        id, ownerType, ownerId: String(ownerId), provider, label, status: 'active', keyHint: hintOf(key),
        sealed, lastVerifiedAt: 0, lastErrorCode: '', createdBy, createdAt: Date.now(),
      });
      if (old) await store.update(old.id, { status: 'revoked', revokedAt: Date.now() });
      // 앞서 «키가 맞지 않음»으로 남은 행도 거둔다 — 새 키를 넣었는데 옛 줄이 남아 지워지지 않는 일이 없게
      for (const x of await store.list(ownerType, String(ownerId))) if (x.provider === provider && x.status === 'invalid' && x.id !== id) await store.update(x.id, { status: 'revoked', revokedAt: Date.now() });
      return { ok: true, credential: viewOf(row) };
    },

    async resolve(project, provider, { managedAi = false } = {}) {
      const { ownerType, ownerId } = ownerOf(project, { managedAi });
      const row = await store.findActive(ownerType, ownerId, provider);
      if (!row) return { ok: false, reason: 'credential_missing', ownerType, ownerId };
      try {
        const apiKey = cleanKey(open(row.sealed, keys, { ownerType, ownerId, provider, id: row.id }));   // 앞서 섞여 들어온 줄바꿈도 걷는다
        return { ok: true, credential: { apiKey }, credentialId: row.id, ownerType, ownerId };
      } catch {
        return { ok: false, reason: 'credential_unreadable', ownerType, ownerId };
      }
    },

    async markVerified(id, { ok, reason = '' }) {
      return store.update(id, ok ? { lastVerifiedAt: Date.now(), lastErrorCode: '' } : { status: reason === 'auth' ? 'invalid' : 'active', lastErrorCode: reason });
    },

    async revoke(id) { const r = await store.update(id, { status: 'revoked', revokedAt: Date.now() }); return r ? viewOf(r) : null; },

    async list(ownerType, ownerId) { return (await store.list(ownerType, String(ownerId))).map(viewOf); },
  };
}
