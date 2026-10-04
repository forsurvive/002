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

/**
 * deps = { pool, store, generator, aliasTiers?, policyOf?(projectRow) }
 * 돌려주는 call(args, ctx) 는 Core(run.mjs)가 부르는 모양 그대로: { ok, text, error, reason, retryAfterMs, runId }
 */
export function createOnlineCall({ pool, store, generator, aliasTiers = DEFAULT_ALIAS_TIERS, policyOf = () => ({}) }) {
  return async function call(args, ctx = {}) {
    if (!haveBrain()) return { ok: false, error: '내장 프롬프트를 읽지 못했습니다', reason: 'prompts' };
    const { pid, code } = args;
    const project = await store.get(pid);
    if (!project) return { ok: false, error: '프로젝트를 찾을 수 없습니다', reason: 'other' };
    const row = (await pool.query('SELECT owner_user_id, organization_id FROM projects WHERE id = $1', [pid])).rows[0];
    const plan = planCall(project, args, { pr: promptFor(project, code), slotModel: slotModel(project, code) });

    // 생성 기록 — 부르기 전에 남긴다(무엇을 보고 만들려 했나는 실패해도 남는다)
    const jobId = ctx.jobId || null;
    const target = (args.targetIds || [])[0] || '';
    const ids = async (table, legacy) => (legacy
      ? ((await pool.query(`SELECT id${table === 'documents' ? ', current_version_id' : ''} FROM ${table} WHERE project_id = $1 AND legacy_id = $2`, [pid, legacy])).rows[0] || null)
      : null);
    const tdoc = await ids('documents', target);
    const thread = ctx.threadId ? await ids('threads', ctx.threadId) : null;
    const run = (await pool.query(
      `INSERT INTO generation_runs (job_id, project_id, organization_id, requested_by, purpose, prompt_key, prompt_layer, target_document_id, thread_id, request_text, model_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [jobId, pid, row.organization_id, ctx.userId || null, String(code || ''), String(code || ''),
        project.prompts && project.prompts[code] ? 'override' : project.agents && project.agents[code] ? 'generated' : 'builtin',
        tdoc ? tdoc.id : null, thread ? thread.id : null, String(args.request || ''), String(plan.modelSource || '')])).rows[0].id;
    for (const [i, x] of plan.inputs.entries()) {
      const d = x.id ? await ids('documents', x.id) : null;
      await pool.query(
        `INSERT INTO generation_run_inputs (run_id, role, document_id, document_version_id, title, content_sha256, char_count, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [run, x.role === 'agent' ? 'agent' : x.role, d ? d.id : null, d ? d.current_version_id : null, String(x.name || ''), sha(x.text || ''), String(x.text || '').length, i]);
    }

    const tier = aliasTiers[plan.model] || '';
    const r = await generator.generate({
      systemPrompt: plan.systemPrompt, userPrompt: plan.userPrompt, signal: args.signal || ctx.signal || null,
      metadata: {
        project: { id: pid, ownerUserId: row.owner_user_id, organizationId: row.organization_id },
        policy: policyOf(row),
        model: { project: tier ? { tier } : null },
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
  };
}
