// 온라인판의 «한 번의 부르기» — 개인판 engine.callOnce 와 같은 자리.
//   ① Core 의 계획(planCall)으로 시스템 프롬프트 · 본문 · 모델 별칭 · 실은 것의 목록을 짓고
//   ② 생성 기록(generation_runs)과 참조 스냅샷(generation_run_inputs — 그때의 문서 판 id · sha256)을 먼저 남기고
//   ③ Provider 라우터(ai/router.mjs — 카탈로그 · 비용 주체의 키 · 어댑터)로 부르고
//   ④ 결과(토큰 · 비용 · 어느 provider/model · 실패 갈래)를 그 기록에 적는다.
// 키는 라우터 안에서만 산다. 이 파일은 키를 보지 않는다.

import { createHash } from 'node:crypto';
import { planCall } from '../core/reference/plan.mjs';
import { cleanResponse } from '../core/prompt/assemble.mjs';
import { promptFor, slotModel } from '../tools/prompt-pick.mjs';
import { haveBrain } from '../tools/prompts.mjs';

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

// 개인판 모델 별칭 → 온라인 tier. 대응은 운영자가 정한다(docs/AI_PROVIDER.md §4) — 적히지 않은 별칭은 프로젝트/기관 기본을 따른다.
export const DEFAULT_ALIAS_TIERS = { opus: 'high_reasoning', sonnet: 'balanced' };

// 기관 작품은 지금 유효한 라이선스가 허락한 회사 · 등급 안에서만 고른다(비어 있으면 모두). 개인 작품은 제한 없음.
export const licensePolicy = (row) => ({
  ...(row.organization_id && row.allowed_providers && row.allowed_providers.length ? { providers: row.allowed_providers } : {}),
  ...(row.organization_id && row.allowed_model_tiers && row.allowed_model_tiers.length ? { tiers: row.allowed_model_tiers } : {}),
});

// 비용 주체의 기본 — 기관 작품은 기관의 회사 · 등급, 개인 작품은 그 사람의 회사
const orgLayer = (row) => {
  const provider = row.organization_id ? row.org_provider : row.user_provider;
  const tier = row.organization_id ? row.org_tier : '';
  return provider || tier ? { ...(provider ? { provider } : {}), ...(tier ? { tier } : {}) } : null;
};

/**
 * deps = { pool, store, generator, aliasTiers?, policyOf?(projectRow) }
 * 돌려주는 call(args, ctx) 는 Core(run.mjs)가 부르는 모양 그대로: { ok, text, error, reason, retryAfterMs, runId }
 */
export function createOnlineCall({ pool, store, generator, aliasTiers = DEFAULT_ALIAS_TIERS, policyOf = () => ({}) }) {
  const ids = async (pid, table, legacy) => (legacy
    ? ((await pool.query(`SELECT id${table === 'documents' ? ', current_version_id' : ''} FROM ${table} WHERE project_id = $1 AND legacy_id = $2`, [pid, legacy])).rows[0] || null)
    : null);

  // 공통 — 기록을 남기고 · 라우터로 부르고 · 결과를 적는다
  async function send(pid, project, { systemPrompt, userPrompt, alias, modelSource = '', code, inputs = [], request = '', requestOnce = '', stageKey = '', stageTier = '', target = '', signal = null }, ctx) {
    // 고른 AI 회사 — 작품이 정했으면 그것, 아니면 비용 주체의 기본(기관 작품은 기관, 개인 작품은 그 사람)
    const row = (await pool.query(
      `SELECT p.owner_user_id, p.organization_id, p.model_policy->>'provider' AS project_provider,
              coalesce(o.settings->>'ai_provider', '') AS org_provider, coalesce(o.settings->>'ai_tier', '') AS org_tier,
              coalesce(u.settings->>'ai_provider', '') AS user_provider,
              l.allowed_providers, l.allowed_model_tiers
         FROM projects p LEFT JOIN organizations o ON o.id = p.organization_id LEFT JOIN users u ON u.id = p.owner_user_id
         LEFT JOIN LATERAL (SELECT allowed_providers, allowed_model_tiers FROM licenses
                             WHERE organization_id = p.organization_id AND status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
                             ORDER BY ends_at DESC NULLS FIRST LIMIT 1) l ON true
        WHERE p.id = $1`, [pid])).rows[0];
    const tdoc = await ids(pid, 'documents', target);
    const thread = ctx.threadId ? await ids(pid, 'threads', ctx.threadId) : null;
    const run = (await pool.query(
      `INSERT INTO generation_runs (job_id, project_id, organization_id, requested_by, purpose, prompt_key, prompt_layer, target_document_id, thread_id, request_text, model_source, request_once_text, workflow_stage,
                                   prompt_checksum, prompt_sha256)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [ctx.jobId || null, pid, row.organization_id, ctx.userId || null, String(code || ''), String(code || ''),
        project.prompts && project.prompts[code] ? 'override' : project.agents && project.agents[code] ? 'generated' : 'builtin',
        tdoc ? tdoc.id : null, thread ? thread.id : null, String(request || ''), String(modelSource || ''), String(requestOnce || ''), String(stageKey || ''),
        sha(systemPrompt || ''), sha(String(systemPrompt || '') + '\n\n' + String(userPrompt || ''))])).rows[0].id;
    for (const [i, x] of inputs.entries()) {
      const d = x.id ? await ids(pid, 'documents', x.id) : null;
      await pool.query(
        `INSERT INTO generation_run_inputs (run_id, role, document_id, document_version_id, title, content_sha256, char_count, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [run, x.role, d ? d.id : null, d ? d.current_version_id : null, String(x.name || ''), sha(x.text || ''), String(x.text || '').length, i]);
    }

    const tier = aliasTiers[alias] || '';
    // 별칭이 어디서 왔는지에 따라 그 자리(층)에 둔다 — 이번에 고른 것 · 에이전트는 단계 기본보다 앞, 작품 기본은 뒤
    const layer = modelSource === 'pick' ? 'pick' : modelSource === 'agent' || modelSource === 'slot' ? 'agent' : 'project';
    const r = await generator.generate({
      systemPrompt, userPrompt, signal: signal || ctx.signal || null,
      metadata: {
        project: { id: pid, ownerUserId: row.owner_user_id, organizationId: row.organization_id },
        policy: { ...licensePolicy(row), ...(await policyOf(row)) },
        model: {
          ...(tier && layer !== 'project' ? { [layer]: { tier } } : {}),
          stage: stageTier ? { tier: stageTier } : null,
          project: (tier && layer === 'project') || row.project_provider
            ? { ...(tier && layer === 'project' ? { tier } : {}), ...(row.project_provider ? { provider: row.project_provider } : {}) } : null,
          org: orgLayer(row),
        },
      },
    });
    const text = r.ok ? cleanResponse(r.text) : '';
    const okNow = r.ok && !!text;
    const u = r.usage || {};
    const rt = r.routing || {};
    await pool.query(
      `UPDATE generation_runs SET status = $2, error_code = $3, finish_reason = $4, ended_at = now(), elapsed_ms = $5,
              input_tokens = $6, output_tokens = $7, cache_read_tokens = $8, cache_write_tokens = $9, reasoning_tokens = $10,
              cost_usd = $11, cost_source = $12, provider_request_id = $13, provider = $14, model_tier = $15, model_id = $16,
              credential_owner_type = $17, credential_id = $18
        WHERE id = $1`,
      [run, okNow ? 'succeeded' : r.reason === 'stopped' ? 'cancelled' : 'failed', okNow ? '' : r.reason || 'empty', String(r.finishReason || ''),
        Number(r.elapsedMs) || 0, u.inputTokens || 0, u.outputTokens || 0, u.cacheReadTokens || 0, u.cacheWriteTokens || 0, u.reasoningTokens || 0,
        r.costUsd == null ? null : r.costUsd, r.costSource || 'none', String(r.providerRequestId || ''), rt.provider || '', rt.tier || '', rt.modelId || '',
        rt.ownerType || '', rt.credentialId || null]);
    if (!r.ok) return { ok: false, error: r.error, reason: r.reason, retryAfterMs: r.retryAfterMs || 0, runId: run };
    if (!text) return { ok: false, error: '빈 응답', reason: 'empty', runId: run };
    return { ok: true, text, usage: r.usage, costUsd: r.costUsd, runId: run };
  }

  // 계획을 거치는 부르기 — Core(run.mjs)가 부르는 모양: call(args, ctx)
  async function call(args, ctx = {}) {
    if (!haveBrain()) return { ok: false, error: '내장 프롬프트를 읽지 못했습니다', reason: 'prompts' };
    const { pid, code } = args;
    const project = await store.get(pid);
    if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다', reason: 'other' };
    const plan = planCall(project, args, { pr: promptFor(project, code), slotModel: slotModel(project, code) });
    return send(pid, project, {
      systemPrompt: plan.systemPrompt, userPrompt: plan.userPrompt, alias: plan.model, modelSource: plan.modelSource, code,
      inputs: plan.inputs, request: args.request, requestOnce: args.requestOnce, stageKey: args.stageKey, stageTier: args.stageTier, target: (args.targetIds || [])[0] || '', signal: args.signal,
    }, ctx);
  }

  // 이미 지은 프롬프트로 곧장 — 에이전트 준비(F-KIND · F-AGENT)가 쓴다(core/generation/agents.mjs 의 raw)
  call.raw = async ({ systemPrompt, prompt, code, signal = null, model = '' }, ctx = {}) => {
    if (!haveBrain()) return { ok: false, error: '내장 프롬프트를 읽지 못했습니다', reason: 'prompts' };
    const project = await store.get(ctx.pid);
    if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다', reason: 'other' };
    return send(ctx.pid, project, { systemPrompt, userPrompt: prompt, alias: model, modelSource: 'control', code, signal }, ctx);
  };

  return call;
}
