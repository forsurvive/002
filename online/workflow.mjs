// 온라인판의 단계 템플릿 — 설정 파일(원문) 위에 운영자(전체) · 기관 관리자(그 기관)가 고쳐 쓴 것을 얹는다(core/workflow/stages.mjs applyOverrides).
// 원문은 파일에 그대로 남고, 고쳐 쓴 칸만 workflow_overrides 표에 있다(template_key 로 템플릿마다 따로). 되돌리기 = 그 행을 지운다.
// 작품마다 쓰는 템플릿은 projects.workflow->>'template'(없으면 이야기 만들기). defaultKey — 관리 화면이 고칠 템플릿(앱의 용도가 정한다).

import { baseTemplate, templateKeyOf, DEFAULT_TEMPLATE } from '../tools/workflow.mjs';
import { applyOverrides, cleanOverride, EDITABLE } from '../core/workflow/stages.mjs';

export function createWorkflowSource(pool, { defaultKey = DEFAULT_TEMPLATE } = {}) {
  const layer = async (key, scope, orgId) => {
    const { rows } = await pool.query(
      `SELECT stage_key, data FROM workflow_overrides WHERE template_key = $1 AND scope = $2 AND organization_id IS NOT DISTINCT FROM $3`,
      [key, scope, orgId || null]);
    return Object.fromEntries(rows.map((r) => [r.stage_key, r.data]));
  };

  async function templateForOrg(orgId, key = defaultKey) {
    const base = baseTemplate(key);
    if (!base) return null;
    const layers = [await layer(base.key, 'platform', null)];
    if (orgId) layers.push(await layer(base.key, 'organization', orgId));
    return applyOverrides(base, layers);
  }

  return {
    templateForOrg,
    // 프로젝트에 쓸 템플릿 — 그 작품의 템플릿(적혀 있지 않으면 이야기 만들기), 기관 프로젝트면 그 기관의 것까지
    async templateFor(pid) {
      const p = (await pool.query(`SELECT organization_id, workflow->>'template' AS template FROM projects WHERE id = $1`, [pid])).rows[0];
      return templateForOrg(p ? p.organization_id : null, templateKeyOf({ workflow: { template: p ? p.template : null } }));
    },
    // 관리 화면이 보는 꼴 — 원문 · 운영자 층 · 기관 층 · 합친 결과를 단계마다
    async editorView(orgId = null, key = defaultKey) {
      const base = baseTemplate(key);
      if (!base) return null;
      const plat = await layer(base.key, 'platform', null);
      const org = orgId ? await layer(base.key, 'organization', orgId) : {};
      const merged = applyOverrides(base, [plat, org]);
      return { key: base.key, title: base.title, editable: EDITABLE, stages: base.stages.map((s, i) => ({
        key: s.key, n: s.n, output: s.output, original: pick(s), platform: plat[s.key] || null, organization: org[s.key] || null, effective: pick(merged.stages[i]),
      })) };
    },
    // 고쳐 쓰기 — 고칠 수 있는 칸만 남기고 저장한다. data 가 비면(모두 되돌리기) 행을 지운다.
    async save({ scope, orgId = null, stageKey, data, userId, key = defaultKey }) {
      const base = baseTemplate(key);
      const clean = base ? cleanOverride(base, stageKey, data || {}) : null;
      if (!clean) return { ok: false, error: '없는 단계입니다' };
      const where = [base.key, scope, orgId || null, stageKey];
      await pool.query(`DELETE FROM workflow_overrides WHERE template_key = $1 AND scope = $2 AND organization_id IS NOT DISTINCT FROM $3 AND stage_key = $4`, where);
      if (Object.keys(clean).length) {
        await pool.query(`INSERT INTO workflow_overrides (template_key, scope, organization_id, stage_key, data, updated_by) VALUES ($1,$2,$3,$4,$5,$6)`,
          [...where, JSON.stringify(clean), userId || null]);
      }
      return { ok: true, saved: clean };
    },
  };
}

const pick = (s) => Object.fromEntries(EDITABLE.filter((k) => s[k] !== undefined).map((k) => [k, s[k]]));
