// 자격증명 저장소(PostgreSQL) · 온라인 부르기(계획 → 라우터 → 생성 기록) 시험 — online/test.mjs 가 이어 부른다.
// 가짜 Provider 를 쓴다(망 · 실제 키 없음). 가짜 키도 «키처럼 생긴 값»일 뿐 실제 비밀이 아니다.

import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../core/domain/model.mjs';
import { createCredentialService } from '../ai/credentials.mjs';
import { createCatalog } from '../ai/catalog.mjs';
import { createProviderRouter } from '../ai/router.mjs';
import { success, failure } from '../ai/provider.mjs';
import { pgCredentialStore } from './credentials.mjs';
import { createOnlineCall } from './call.mjs';
import { createProjectStore } from './store.mjs';
import { createUser } from './auth.mjs';

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');
const FAKE_KEY = 'fake-test-key-' + randomBytes(6).toString('hex');

export function fakeRouter(pool, { reply = () => success({ text: '지은 글', usage: { input_tokens: 120, output_tokens: 30 }, finishReason: 'end_turn' }), keys = { keys: new Map([[1, randomBytes(32)]]), current: 1 } } = {}) {
  const credentials = createCredentialService({ store: pgCredentialStore(pool), keys });
  const seen = [];
  const adapter = { id: 'anthropic', async generate(input) { seen.push(input); return reply(input); } };
  const catalog = createCatalog([
    { provider: 'anthropic', tier: 'high_reasoning', modelId: 'test-model-high', price: { inputPerMTok: 10, outputPerMTok: 50 } },
    { provider: 'anthropic', tier: 'balanced', modelId: 'test-model-mid' },
  ]);
  return { keys, credentials, seen, generator: createProviderRouter({ catalog, credentials, providers: { anthropic: adapter } }) };
}

export async function run({ pool, ok, eq }) {
  const u = (await createUser(pool, { loginId: 'caller', password: 'long-enough-1' })).user;
  const store = createProjectStore(pool);
  const pid = await store.create({ name: '부르기 시험' }, { ownerUserId: u.id });
  let d1, d2;
  await store.update(pid, (p) => {
    d1 = M.docCreate(p, { title: '세계관', body: '세계는 둥글다' }).id;
    M.docSetFinal(p, d1, true);
    d2 = M.docCreate(p, { title: '1화', body: '', refIds: [d1], request: '써 다오' }).id;
  });
  const { keys, credentials, seen, generator } = fakeRouter(pool);
  const call = createOnlineCall({ pool, store, generator });

  // ---------------- 키가 없으면 «연결 필요»
  const none = await call({ pid, code: 'F-UPDATE', refIds: [d1], targetIds: [], request: '써 다오', keepSeat: true }, { userId: u.id });
  ok('키가 없으면 credential 로 실패', none.ok === false && none.reason === 'credential' && seen.length === 0);
  const r0 = (await pool.query('SELECT status, error_code, credential_owner_type FROM generation_runs WHERE id = $1', [none.runId])).rows[0];
  ok('그 실패도 기록에 남는다', r0.status === 'failed' && r0.error_code === 'credential' && r0.credential_owner_type === 'user');

  // ---------------- 자격증명 — 봉해서 넣고, 화면 꼴에는 원문이 없다
  const set1 = await credentials.set({ ownerType: 'user', ownerId: u.id, provider: 'anthropic', apiKey: FAKE_KEY + '-old', createdBy: u.id });
  const set2 = await credentials.set({ ownerType: 'user', ownerId: u.id, provider: 'anthropic', apiKey: FAKE_KEY, createdBy: u.id });
  ok('키를 넣는다(돌려주는 것은 끝 네 자리뿐)', set2.ok && set2.credential.keyHint === '…' + FAKE_KEY.slice(-4) && !JSON.stringify(set2).includes(FAKE_KEY));
  const rows = (await pool.query("SELECT status FROM provider_credentials WHERE owner_id = $1 ORDER BY created_at", [u.id])).rows.map((r) => r.status);
  ok('새 키를 넣으면 앞 키는 revoked', rows.join() === 'revoked,active', rows.join());
  ok('**DB 에 키 원문이 없다**', !JSON.stringify((await pool.query('SELECT * FROM provider_credentials')).rows).includes(FAKE_KEY));
  ok('목록에도 원문이 없다', !JSON.stringify(await credentials.list('user', u.id)).includes(FAKE_KEY) && set1.credential.id !== set2.credential.id);

  // ---------------- 부르기 — 계획 · 라우팅 · 기록 · 참조 스냅샷
  const r = await call({ pid, code: 'F-UPDATE', refIds: [d1], targetIds: [], request: '써 다오', keepSeat: true, modelPick: 'opus' }, { userId: u.id, jobId: null });
  ok('부르면 글이 온다', r.ok && r.text === '지은 글', JSON.stringify(r));
  const got = seen[seen.length - 1];
  ok('어댑터는 열린 키를 받는다(라우터 안에서만)', got.credential && got.credential.apiKey === FAKE_KEY);
  ok('opus 별칭 → high_reasoning → 카탈로그의 model id', got.model === 'test-model-high');
  ok('시스템 프롬프트와 본문이 실린다', got.systemPrompt.length > 100 && got.userPrompt.includes('세계는 둥글다') && got.userPrompt.includes('써 다오'));
  const run = (await pool.query('SELECT * FROM generation_runs WHERE id = $1', [r.runId])).rows[0];
  ok('생성 기록: 성공 · provider · tier · model id · 비용 주체 · credential id', run.status === 'succeeded' && run.provider === 'anthropic'
    && run.model_tier === 'high_reasoning' && run.model_id === 'test-model-high' && run.credential_owner_type === 'user' && run.credential_id === set2.credential.id);
  ok('토큰과 추정 비용', run.input_tokens === 120 && run.output_tokens === 30 && Number(run.cost_usd) > 0 && run.cost_source === 'estimated');
  ok('요청사항과 모델 출처', run.request_text === '써 다오' && run.model_source !== '' && run.prompt_key === 'F-UPDATE' && run.prompt_layer === 'builtin');
  const inputs = (await pool.query('SELECT * FROM generation_run_inputs WHERE run_id = $1 ORDER BY sort_order', [r.runId])).rows;
  const cur = (await pool.query('SELECT d.current_version_id, v.body FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.legacy_id = $1', [d1])).rows[0];
  const fin = inputs.find((x) => x.role === 'final');
  ok('**참조 스냅샷: 확정본이 «그때의 판»으로 남는다**', fin && fin.document_version_id === cur.current_version_id && fin.content_sha256 === sha(cur.body) && fin.title === '세계관', JSON.stringify(inputs.map((x) => x.role)));
  {
    const h = (await pool.query('SELECT prompt_checksum, prompt_sha256 FROM generation_runs WHERE id = $1', [r.runId])).rows[0];
    ok('생성 기록에 보낸 프롬프트의 지문(시스템 · 전체 — 원문은 남기지 않는다)', /^[0-9a-f]{64}$/.test(h.prompt_checksum) && /^[0-9a-f]{64}$/.test(h.prompt_sha256) && h.prompt_checksum !== h.prompt_sha256
      && h.prompt_sha256 === sha(got.systemPrompt + '\n\n' + got.userPrompt), JSON.stringify(h));
  }
  ok('**기록 어디에도 키 원문이 없다**', !JSON.stringify((await pool.query('SELECT * FROM generation_runs')).rows).includes(FAKE_KEY)
    && !JSON.stringify((await pool.query('SELECT * FROM generation_run_inputs')).rows).includes(FAKE_KEY));

  // 판이 바뀌어도 스냅샷이 가리킨 판은 남는다
  await store.update(pid, (p) => { M.docWrite(p, d1, { body: '세계는 평평하다' }); });
  const still = (await pool.query('SELECT body FROM document_versions WHERE id = $1', [fin.document_version_id])).rows[0];
  eq('옛 판은 그대로 남아 «무엇을 보고 만들었나»를 답한다', still.body, '세계는 둥글다');

  // ---------------- 운영자 도구로 키 넣기 — 키는 표준 입력으로만, 콘솔에는 끝 네 자리만(ASCII)
  {
    await createUser(pool, { loginId: 'keyed', password: 'long-enough-1' });
    const admin = fileURLToPath(new URL('./admin.mjs', import.meta.url));
    const env = { ...process.env, DATABASE_URL: process.env.DATABASE_URL_TEST, CREDENTIALS_KEY_V1: randomBytes(32).toString('base64') };
    const r1 = spawnSync(process.execPath, [admin, 'set-key', 'keyed', 'openai'], { input: FAKE_KEY + '-admin\n', env, encoding: 'utf8' });
    ok('운영자가 키를 넣는다', r1.status === 0 && /stored \(sealed\): openai \.\.\.[a-z0-9]{4}/.test(r1.stdout) && !r1.stdout.includes(FAKE_KEY), r1.stdout + r1.stderr);
    ok('콘솔은 ASCII 만', /^[\x00-\x7f]*$/.test(r1.stdout));
    ok('키는 명령줄 인자로 받지 않는다(인자에 넣어도 키로 쓰지 않는다)', spawnSync(process.execPath, [admin, 'set-key', 'keyed', 'openai', FAKE_KEY], { input: '', env, encoding: 'utf8' }).status !== 0);
    const row = (await pool.query("SELECT c.status FROM provider_credentials c JOIN users u ON u.id::text = c.owner_id WHERE u.login_id = 'keyed' AND c.provider = 'openai' AND c.status = 'active'")).rows;
    eq('봉해서 하나 저장', row.length, 1);
    ok('**DB 에 원문이 없다**', !JSON.stringify((await pool.query('SELECT * FROM provider_credentials')).rows).includes(FAKE_KEY));
    ok('감사 로그(키 값 없이)', (await pool.query("SELECT details FROM audit_logs WHERE action = 'credential.set'")).rows.every((r) => !JSON.stringify(r).includes(FAKE_KEY)));
  }

  // ---------------- 실패 갈래가 그대로 올라온다
  const { generator: g2 } = fakeRouter(pool, { reply: () => failure('rate', '잠시 붐빕니다', { retryAfterMs: 20000 }), keys });
  const busy = await createOnlineCall({ pool, store, generator: g2 })({ pid, code: 'F-UPDATE', refIds: [d1], keepSeat: true }, { userId: u.id });
  ok('rate 와 retry-after 가 올라온다', busy.ok === false && busy.reason === 'rate' && busy.retryAfterMs === 20000);
  const { generator: g3 } = fakeRouter(pool, { reply: () => success({ text: '   ' }), keys });
  eq('빈 응답은 empty', (await createOnlineCall({ pool, store, generator: g3 })({ pid, code: 'F-UPDATE', refIds: [d1], keepSeat: true }, {})).reason, 'empty');

  // ---------------- 기관 작품 — 라이선스가 허락한 등급 안에서만, 기관 기본 등급이 그 다음
  {
    const org = (await pool.query(`INSERT INTO organizations (name, slug, settings) VALUES ('정책 기관', 'policy-org', '{"ai_tier":"balanced"}') RETURNING id`)).rows[0].id;
    const lic = (await pool.query(`INSERT INTO licenses (organization_id, ends_at, allowed_model_tiers) VALUES ($1, now() + interval '30 days', '{balanced}') RETURNING id`, [org])).rows[0].id;
    await credentials.set({ ownerType: 'organization', ownerId: org, provider: 'anthropic', apiKey: FAKE_KEY + '-org', createdBy: u.id });
    const opid = await store.create({ name: '수업 작품' }, { ownerUserId: u.id, organizationId: org });
    await store.update(opid, (p) => { M.docCreate(p, { title: '세계관', body: '바다' }); });
    const { generator: g4, seen: s4 } = fakeRouter(pool, { keys });
    const oc = createOnlineCall({ pool, store, generator: g4 });
    const r4 = await oc({ pid: opid, code: 'F-UPDATE', refIds: [], keepSeat: true, modelPick: 'opus' }, { userId: u.id });
    const run4 = (await pool.query('SELECT model_tier, model_id, credential_owner_type FROM generation_runs WHERE id = $1', [r4.runId])).rows[0];
    ok('**라이선스가 Balanced 만 허락하면 High Reasoning 을 골라도 Balanced 로 돈다**', r4.ok && run4.model_tier === 'balanced' && s4[0].model === 'test-model-mid' && run4.credential_owner_type === 'organization', JSON.stringify(run4));
    await pool.query(`UPDATE licenses SET allowed_model_tiers = NULL WHERE id = $1`, [lic]);
    const r5 = await oc({ pid: opid, code: 'F-UPDATE', refIds: [], keepSeat: true, modelPick: 'opus' }, { userId: u.id });
    eq('제한을 풀면 고른 등급대로', (await pool.query('SELECT model_tier FROM generation_runs WHERE id = $1', [r5.runId])).rows[0].model_tier, 'high_reasoning');
    await pool.query(`UPDATE licenses SET allowed_providers = '{openai}' WHERE id = $1`, [lic]);
    const r6 = await oc({ pid: opid, code: 'F-UPDATE', refIds: [], keepSeat: true }, { userId: u.id });
    ok('**허락되지 않은 회사로는 부르지 않는다**', r6.ok === false && s4.length === 2 && (await pool.query('SELECT provider FROM generation_runs WHERE id = $1', [r6.runId])).rows[0].provider === 'openai');
  }
}
