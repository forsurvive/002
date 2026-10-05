// 교육기관판의 일 — 기관 · 라이선스 · 수업 · 초대 · 수업 현황 · 기관 키. 권한은 docs/SECURITY.md §4 의 표를 따른다.
// 화면의 편집기 문(tools/ops.mjs)과 섞지 않고 POST /api/edu { op, … } 로 따로 받는다(개인판 문 표는 그대로 — 관리자 문이 없다).
//
// 지키는 것
//   · 초대 코드 원문은 만들 때 한 번만 돌려주고 DB 에는 sha256 만. 사용 횟수는 한 문장(UPDATE … RETURNING)으로 올려 두 사람이 마지막 한 자리를 함께 얻지 못한다.
//   · 학생 자리(seat_limit)는 라이선스가 정한다. 학생 화면에는 비용 · 횟수 · 키를 내보내지 않는다(수업 현황에도 비용 칸 없음).
//   · 기관 키는 쓰기 전용 — 넣으면 끝 네 자리와 상태만 보인다.
//   · 모든 변경은 감사 로그.

import { randomBytes, createHash } from 'node:crypto';
import * as auth from './auth.mjs';
import { isUuid, createTenancy } from './tenancy.mjs';
import { PROVIDER_IDS } from '../ai/credentials.mjs';
import { TIERS } from '../ai/catalog.mjs';
import { importProject } from './import.mjs';
import { loadAggregate } from './store.mjs';

const ok = (extra = {}) => ({ status: 200, body: { ok: true, ...extra } });
const no = (status, error, code) => ({ status, body: { ok: false, error, ...(code ? { code } : {}) } });
const NOT_FOUND = no(404, '찾을 수 없습니다');
const FORBIDDEN = no(403, '권한이 없습니다', 'forbidden');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ROLES = ['organization_admin', 'instructor', 'student'];
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // 헷갈리는 글자(0 · O · 1 · I)는 뺀다

// 사람이 받아 적기 쉬운 코드 — 12자(약 60비트), 넷씩 끊어 보인다
export function newInviteCode() {
  const b = randomBytes(12);
  let s = '';
  for (const x of b) s += ALPHABET[x % ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}
const codeHash = (code) => createHash('sha256').update(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')).digest();

// 초대 시도 고삐 — 같은 곳에서 거듭 틀리면 잠시 막는다(코드 맞히기 막기)
const tries = new Map();
const TRY_LIMIT = 10; const TRY_WINDOW = 15 * 60 * 1000;
export function resetInviteThrottle() { tries.clear(); }

// 수업 날짜는 한국 시각으로 센다(수업은 그날 0시에 열리고 끝 날 24시에 닫힌다)
const CLASS_TZ = 'Asia/Seoul';
const LIC_COLS = 'id, plan, status, starts_at, ends_at, seat_limit, allowed_providers, allowed_model_tiers';

export function createEdu({ pool, credentials = null, wfs = null, keyTester = null }) {
  const one = async (sql, args) => (await pool.query(sql, args)).rows[0] || null;
  const rolesIn = async (userId, orgId) => new Set((await pool.query(
    `SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active'`, [orgId, userId])).rows.map((r) => r.role));
  const isAdmin = async (user, orgId) => user.isPlatformAdmin || (await rolesIn(user.id, orgId)).has('organization_admin');
  const teaches = async (userId, classId) => !!(await one(`SELECT 1 FROM class_members WHERE class_id = $1 AND user_id = $2 AND role = 'instructor'`, [classId, userId]));
  const log = (user, orgId, action, targetType, targetId, details = {}, ip = '') => auth.audit(pool, { actor: user ? user.id : null, organizationId: orgId, action, targetType, targetId, details, ip });

  // 지금 유효한 라이선스(가장 늦게 끝나는 것)
  const liveLicense = (orgId) => one(
    `SELECT * FROM licenses WHERE organization_id = $1 AND status = 'active' AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
      ORDER BY ends_at DESC NULLS FIRST LIMIT 1`, [orgId]);

  // 라이선스가 허락하는 AI 회사 · 등급 — 빈 목록 · 없음은 «모두»(null)
  const limits = (b) => {
    const list = (v, known) => {
      if (v == null) return null;
      if (!Array.isArray(v)) return { bad: true };
      const xs = [...new Set(v.map(String))];
      return xs.some((x) => !known.includes(x)) ? { bad: true } : xs.length ? xs : null;
    };
    const providers = list(b.allowedProviders, PROVIDER_IDS);
    const tiers = list(b.allowedTiers, Object.keys(TIERS));
    if ((providers && providers.bad) || (tiers && tiers.bad)) return { error: '모르는 AI 회사 · 등급입니다' };
    return { providers, tiers };
  };

  // 수업 기간 — 'YYYY-MM-DD' 둘(비우면 기한 없음). 끝 날은 그날 하루를 다 쓴다(저장은 다음 날 0시).
  const classDates = (b) => {
    const d = (v) => { const s = String(v || '').trim(); return !s ? null : /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) ? s : undefined; };
    const start = d(b.startsAt); const end = d(b.endsAt);
    if (start === undefined || end === undefined) return { error: '날짜는 2026-03-02 꼴로 적어 주세요' };
    if (start && end && end < start) return { error: '끝나는 날이 시작하는 날보다 앞입니다' };
    return { start, end };
  };

  const tenancy = createTenancy(pool);
  const TIER_NAME = { high_reasoning: 'High Reasoning', balanced: 'Balanced', fast: 'Fast' };
  const ROLE_NAME = { material: '자료', final: '확정본', target: '대상', reference: '참조', extra: '덧붙임', talk: '논의', agent: '에이전트' };

  const OPS = {
    // ---------------- 만든 기록 — «이 글은 무엇을 보고 만들었나»(그때의 판 번호). 읽을 수 있는 사람만, 비용 · 모델 id · 키는 싣지 않는다.
    async 'run.list'(user, b) {
      if (!isUuid(b.pid) || !(await tenancy.access(user, b.pid)).read) return NOT_FOUND;
      const doc = await one('SELECT id FROM documents WHERE project_id = $1 AND legacy_id = $2', [b.pid, String(b.docId || '')]);
      if (!doc) return NOT_FOUND;
      const runs = (await pool.query(
        `SELECT r.id, r.started_at, r.status, r.model_tier, r.workflow_stage, r.request_once_text, r.finish_reason,
                v.seq AS result_seq
           FROM generation_runs r LEFT JOIN document_versions v ON v.id = r.result_version_id
          WHERE r.project_id = $1 AND (r.target_document_id = $2 OR v.document_id = $2)
          ORDER BY r.started_at DESC LIMIT 20`, [b.pid, doc.id])).rows;
      const ins = runs.length ? (await pool.query(
        `SELECT i.run_id, i.role, i.title, i.char_count, d.legacy_id AS doc_id, v.seq
           FROM generation_run_inputs i LEFT JOIN documents d ON d.id = i.document_id LEFT JOIN document_versions v ON v.id = i.document_version_id
          WHERE i.run_id = ANY($1) ORDER BY i.run_id, i.sort_order`, [runs.map((r) => r.id)])).rows : [];
      return ok({
        runs: runs.map((r) => ({
          at: r.started_at, status: r.status, tier: TIER_NAME[r.model_tier] || '', stage: r.workflow_stage || '', once: r.request_once_text || '',
          truncated: r.finish_reason === 'length', resultSeq: r.result_seq || null,
          inputs: ins.filter((i) => i.run_id === r.id).map((i) => ({ role: ROLE_NAME[i.role] || i.role, title: i.title, docId: i.doc_id || '', seq: i.seq || null, chars: i.char_count })),
        })),
      });
    },

    // ---------------- 나
    async 'me.memberships'(user) {
      const orgs = (await pool.query(
        `SELECT o.id, o.name, o.slug, o.status, array_agg(m.role ORDER BY m.role) AS roles FROM organization_members m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1 AND m.status = 'active' GROUP BY o.id ORDER BY o.name`, [user.id])).rows;
      const classes = (await pool.query(
        `SELECT c.id, c.name, c.status, c.organization_id, m.role FROM class_members m JOIN classes c ON c.id = m.class_id
          WHERE m.user_id = $1 ORDER BY c.name`, [user.id])).rows;
      // 내가 수업에서 만든 작품 — «개인 작품으로 복사» 단추가 기관 설정(allow_copy)을 따른다
      const works = (await pool.query(
        `SELECT p.id, p.name, p.class_id, coalesce((o.settings->>'allow_copy')::boolean, true) AS can_copy
           FROM projects p JOIN organizations o ON o.id = p.organization_id
          WHERE p.owner_user_id = $1 AND p.class_id IS NOT NULL AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`, [user.id])).rows;
      for (const c of classes) c.works = works.filter((w) => w.class_id === c.id).map((w) => ({ id: w.id, name: w.name, canCopy: w.can_copy }));
      const mine = await one('SELECT settings FROM users WHERE id = $1', [user.id]);
      return ok({ loginId: user.loginId, displayName: user.displayName, platformAdmin: !!user.isPlatformAdmin, organizations: orgs, classes, aiProvider: (mine && mine.settings && mine.settings.ai_provider) || '' });
    },

    // ---------------- 기관 · 라이선스(플랫폼 관리자)
    async 'org.create'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      // 영문 약칭(slug) — 기관을 안에서 가르는 짧은 이름(비밀번호가 아니다). 비워 두면 서버가 지어 붙인다.
      const name = String(b.name || '').trim();
      const slug = String(b.slug || '').trim().toLowerCase() || 'org-' + newInviteCode().replace(/-/g, '').slice(0, 6).toLowerCase();
      if (!name) return no(422, '기관 이름이 필요합니다', 'validation');
      if (!SLUG_RE.test(slug)) return no(422, '영문 약칭은 영문 소문자 · 숫자 · - 로 2~63자입니다(비워 두면 자동)', 'validation');
      try {
        const o = await one('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug, status', [name, slug]);
        await log(user, o.id, 'org.create', 'organization', o.id, { slug }, ip);
        return ok({ organization: o });
      } catch (e) {
        if (e && e.code === '23505') return no(409, '이미 있는 주소 이름입니다', 'conflict');
        throw e;
      }
    },
    // 기관 멈추기 · 다시 열기 — 멈추면 새 작품 · AI 작업이 서지 않는다(작품은 그대로 · 읽기는 된다). 운영자만.
    async 'org.status'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      if (!isUuid(b.orgId) || !['active', 'suspended'].includes(b.status)) return no(422, '상태가 맞지 않습니다', 'validation');
      const o = await one('UPDATE organizations SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, name, status', [b.orgId, b.status]);
      if (!o) return NOT_FOUND;
      await log(user, o.id, 'org.status', 'organization', o.id, { status: b.status }, ip);
      return ok({ organization: o });
    },

    // ---------------- 운영 현황(최상위 관리자) — 작업 · 실패 · 사용량. 원고 · 키는 싣지 않는다(실패 까닭은 사람 말로 가린 것만).
    async 'ops.overview'(user) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      const jobs = (await pool.query(
        `SELECT status, count(*)::int AS n FROM jobs WHERE status IN ('queued', 'running', 'paused', 'waiting_for_user') OR created_at > now() - interval '24 hours'
          GROUP BY status ORDER BY status`)).rows;
      const stuck = (await pool.query(`SELECT count(*)::int AS n FROM jobs WHERE status = 'running' AND lease_expires_at < now()`)).rows[0].n;
      const failures = (await pool.query(
        `SELECT j.id, j.kind, j.error_code, j.error_message_safe, coalesce(j.ended_at, j.created_at) AS at, o.name AS org_name, u.login_id
           FROM jobs j LEFT JOIN organizations o ON o.id = j.organization_id LEFT JOIN users u ON u.id = j.requested_by
          WHERE j.status = 'failed' ORDER BY coalesce(j.ended_at, j.created_at) DESC LIMIT 20`)).rows;
      const calls = (await pool.query(
        `SELECT provider, status, error_code, count(*)::int AS n FROM generation_runs WHERE started_at > now() - interval '24 hours'
          GROUP BY 1, 2, 3 ORDER BY n DESC`)).rows;
      const usage = (await pool.query(
        `SELECT to_char(date_trunc('month', r.started_at), 'YYYY-MM') AS month, coalesce(o.name, '개인') AS who, r.credential_owner_type AS payer,
                count(*)::int AS calls, round(coalesce(sum(r.cost_usd), 0)::numeric, 2)::text AS cost_usd
           FROM generation_runs r LEFT JOIN organizations o ON o.id = r.organization_id
          WHERE r.started_at > date_trunc('month', now()) - interval '2 months' AND r.provider <> ''
          GROUP BY 1, 2, 3 ORDER BY 1 DESC, 5 DESC`)).rows.map((r) => ({ ...r, cost_usd: Number(r.cost_usd) }));
      return ok({ jobs, stuck, failures, calls, usage, estimated: true });
    },

    // 감사 기록 — 최상위 관리자는 전체(또는 한 기관), 기관 관리자는 제 기관만. details 는 처음부터 가린 값만 남는다.
    async 'audit.list'(user, b) {
      const limit = Math.max(1, Math.min(200, Number(b.limit) || 50));
      const args = []; const where = [];
      if (b.orgId) {
        if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
        args.push(b.orgId); where.push('a.organization_id = $' + args.length);
      } else if (!user.isPlatformAdmin) return FORBIDDEN;
      if (b.action) { args.push(String(b.action)); where.push('a.action = $' + args.length); }
      args.push(limit);
      const rows = (await pool.query(
        `SELECT a.id, a.at, a.action, a.target_type, a.details, u.login_id AS actor, o.name AS org_name
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id LEFT JOIN organizations o ON o.id = a.organization_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.at DESC, a.id DESC LIMIT $${args.length}`, args)).rows;
      return ok({ entries: rows.map((r) => ({ ...r, id: Number(r.id) })) });
    },

    async 'org.list'(user) {
      const rows = user.isPlatformAdmin
        ? (await pool.query('SELECT id, name, slug, status, settings, created_at FROM organizations ORDER BY name')).rows
        : (await pool.query(`SELECT DISTINCT o.id, o.name, o.slug, o.status, o.settings, o.created_at FROM organizations o JOIN organization_members m ON m.organization_id = o.id
            WHERE m.user_id = $1 AND m.status = 'active' AND m.role = 'organization_admin' ORDER BY o.name`, [user.id])).rows;
      return ok({ organizations: rows });
    },
    async 'org.settings'(user, b, ip) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      // 고칠 수 있는 칸만(기관 관리자의 작품 열람 — 기본 꺼짐)
      const patch = {};
      // 학생 작품 열람은 최상위 관리자만 켜고 끈다(2026-10-05 사용자 결정 — 기관 관리자가 스스로 열지 못하게)
      if (typeof b.adminCanReadProjects === 'boolean') {
        if (!user.isPlatformAdmin) return no(403, '학생 작품 열람은 최상위 관리자만 정합니다', 'forbidden');
        patch.admin_can_read_projects = b.adminCanReadProjects;
      }
      // 학생에게 작업 중 강의 카드를 보이는가(기본 켬)
      if (typeof b.studentCards === 'boolean') patch.student_cards = b.studentCards;
      // 학생이 수업 작품을 개인 작품으로 복사해 갈 수 있는가(기본 허용)
      if (typeof b.allowCopy === 'boolean') patch.allow_copy = b.allowCopy;
      // 이 기관 작품에 쓸 AI 회사(''이면 고르지 않음 — 키를 넣은 회사 가운데 하나)
      if (typeof b.aiProvider === 'string') {
        if (b.aiProvider && !PROVIDER_IDS.includes(b.aiProvider)) return no(422, '모르는 AI 회사입니다', 'validation');
        patch.ai_provider = b.aiProvider;
      }
      // 이 기관 작품의 기본 등급(''이면 Balanced) — 작품 · 단계가 정하면 그쪽이 앞선다
      if (typeof b.aiTier === 'string') {
        if (b.aiTier && !(b.aiTier in TIERS)) return no(422, '모르는 등급입니다', 'validation');
        patch.ai_tier = b.aiTier;
      }
      const o = await one('UPDATE organizations SET settings = settings || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING settings', [b.orgId, JSON.stringify(patch)]);
      await log(user, b.orgId, 'org.settings', 'organization', b.orgId, patch, ip);
      return ok({ settings: o.settings });
    },
    async 'license.issue'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      if (!isUuid(b.orgId) || !(await one('SELECT 1 FROM organizations WHERE id = $1', [b.orgId]))) return NOT_FOUND;
      const days = Math.max(1, Math.min(3650, Number(b.days) || 30));
      const seats = b.seatLimit == null ? null : Math.max(1, Number(b.seatLimit) || 1);
      const lim = limits(b);
      if (lim.error) return no(422, lim.error, 'validation');
      const l = await one(`INSERT INTO licenses (organization_id, plan, ends_at, seat_limit, created_by, allowed_providers, allowed_model_tiers)
        VALUES ($1, $2, now() + make_interval(days => $3), $4, $5, $6, $7) RETURNING ${LIC_COLS}`,
      [b.orgId, String(b.plan || 'trial'), days, seats, user.id, lim.providers, lim.tiers]);
      await log(user, b.orgId, 'license.issue', 'license', l.id, { plan: l.plan, days, seats, providers: lim.providers, tiers: lim.tiers }, ip);
      return ok({ license: l });
    },
    async 'license.status'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      if (!isUuid(b.licenseId) || !['active', 'suspended', 'revoked'].includes(b.status)) return no(422, '상태가 맞지 않습니다', 'validation');
      const l = await one('UPDATE licenses SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, organization_id, status', [b.licenseId, b.status]);
      if (!l) return NOT_FOUND;
      await log(user, l.organization_id, 'license.status', 'license', l.id, { status: b.status }, ip);
      return ok({ license: l });
    },
    // 이용 기간 안에서 쓸 수 있는 AI 회사 · 등급을 고친다(비우면 모두) — 운영자만
    async 'license.limits'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      if (!isUuid(b.licenseId)) return NOT_FOUND;
      const lim = limits(b);
      if (lim.error) return no(422, lim.error, 'validation');
      const l = await one(`UPDATE licenses SET allowed_providers = $2, allowed_model_tiers = $3, updated_at = now() WHERE id = $1 RETURNING ${LIC_COLS}, organization_id`,
        [b.licenseId, lim.providers, lim.tiers]);
      if (!l) return NOT_FOUND;
      await log(user, l.organization_id, 'license.limits', 'license', l.id, { providers: lim.providers, tiers: lim.tiers }, ip);
      return ok({ license: l });
    },
    async 'license.read'(user, b) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      const rows = (await pool.query(`SELECT ${LIC_COLS} FROM licenses WHERE organization_id = $1 ORDER BY created_at DESC`, [b.orgId])).rows;
      const seatsUsed = (await one(`SELECT count(DISTINCT user_id)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'student' AND status = 'active'`, [b.orgId])).n;
      return ok({ licenses: rows, seatsUsed });
    },

    // ---------------- 수업(기관 관리자)
    async 'class.create'(user, b, ip) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      const name = String(b.name || '').trim();
      if (!name) return no(422, '수업 이름이 필요합니다', 'validation');
      // 이용 기간 안에서만 수업을 연다 — 기간이 없으면 학생이 들어와도 작품 · AI 가 멈춘다
      if (!(await liveLicense(b.orgId))) return no(403, '이용 기간이 없어 수업을 만들 수 없습니다 — 운영자에게 이용 기간을 요청해 주세요', 'license_inactive');
      const when = classDates(b);
      if (when.error) return no(422, when.error, 'validation');
      const c = await one(`INSERT INTO classes (organization_id, name, created_by, starts_at, ends_at) VALUES ($1, $2, $3, $4::date::timestamp AT TIME ZONE '${CLASS_TZ}', ($5::date + 1)::timestamp AT TIME ZONE '${CLASS_TZ}')
        RETURNING id, name, status, starts_at, ends_at`, [b.orgId, name, user.id, when.start, when.end]);
      await log(user, b.orgId, 'class.create', 'class', c.id, { name, startsAt: when.start, endsAt: when.end }, ip);
      return ok({ class: c });
    },
    // 수업 기간 고치기 — 비우면 기한 없음
    async 'class.dates'(user, b, ip) {
      const c = isUuid(b.classId) ? await one('SELECT id, organization_id FROM classes WHERE id = $1', [b.classId]) : null;
      if (!c || !(await isAdmin(user, c.organization_id))) return NOT_FOUND;
      const when = classDates(b);
      if (when.error) return no(422, when.error, 'validation');
      const r = await one(`UPDATE classes SET starts_at = $2::date::timestamp AT TIME ZONE '${CLASS_TZ}', ends_at = ($3::date + 1)::timestamp AT TIME ZONE '${CLASS_TZ}' WHERE id = $1 RETURNING id, name, status, starts_at, ends_at`, [c.id, when.start, when.end]);
      await log(user, c.organization_id, 'class.dates', 'class', c.id, { startsAt: when.start, endsAt: when.end }, ip);
      return ok({ class: r });
    },
    async 'class.list'(user, b) {
      if (!isUuid(b.orgId)) return NOT_FOUND;
      if (await isAdmin(user, b.orgId)) {
        return ok({ classes: (await pool.query(`SELECT c.id, c.name, c.status, c.starts_at, c.ends_at, (SELECT count(*)::int FROM class_members m WHERE m.class_id = c.id AND m.role = 'student') AS students
          FROM classes c WHERE c.organization_id = $1 ORDER BY c.name`, [b.orgId])).rows });
      }
      return ok({ classes: (await pool.query(`SELECT c.id, c.name, c.status, c.starts_at, c.ends_at, m.role FROM classes c JOIN class_members m ON m.class_id = c.id
        WHERE c.organization_id = $1 AND m.user_id = $2 ORDER BY c.name`, [b.orgId, user.id])).rows });
    },
    async 'class.archive'(user, b, ip) {
      const c = isUuid(b.classId) ? await one('SELECT id, organization_id FROM classes WHERE id = $1', [b.classId]) : null;
      if (!c || !(await isAdmin(user, c.organization_id))) return NOT_FOUND;
      await pool.query(`UPDATE classes SET status = $2 WHERE id = $1`, [c.id, b.reopen ? 'active' : 'archived']);
      await log(user, c.organization_id, b.reopen ? 'class.reopen' : 'class.archive', 'class', c.id, {}, ip);
      return ok();
    },
    // 수업 현황 — 강사(맡은 수업) · 기관 관리자. 학생마다 프로젝트 · 최근 작업 상태. 비용 · 횟수 칸은 없다.
    async 'class.progress'(user, b) {
      const c = isUuid(b.classId) ? await one('SELECT id, organization_id, name FROM classes WHERE id = $1', [b.classId]) : null;
      if (!c || !((await teaches(user.id, c.id)) || (await isAdmin(user, c.organization_id)))) return NOT_FOUND;
      const rows = (await pool.query(
        `SELECT u.id AS user_id, u.display_name, u.login_id, p.id AS project_id, p.name AS project_name, p.updated_at, p.stages,
                (SELECT j.status FROM jobs j WHERE j.project_id = p.id ORDER BY j.created_at DESC LIMIT 1) AS last_job,
                (SELECT count(*)::int FROM documents d WHERE d.project_id = p.id AND d.deleted_at IS NULL) AS docs
           FROM class_members m JOIN users u ON u.id = m.user_id
           LEFT JOIN projects p ON p.class_id = m.class_id AND p.owner_user_id = u.id AND p.deleted_at IS NULL
          WHERE m.class_id = $1 AND m.role = 'student' ORDER BY u.display_name, p.updated_at DESC`, [c.id])).rows;
      // 학생마다 «지금 단계» — 손댄 단계 가운데 가장 뒤의 것 · 그 상태 · 그 단계의 강사 메모(강사 화면의 «지금 강의 포인트»)
      const t = wfs ? await wfs.templateForOrg(c.organization_id) : null;
      const nowStage = (stages) => {
        if (!t || !stages) return null;
        let best = null;
        for (const [slot, st] of Object.entries(stages)) {
          const s = t.stages.find((x) => x.key === slot.split('#')[0]);
          if (!s || !st || !st.status) continue;
          if (!best || s.n > best.s.n || (s.n === best.s.n && slot > best.slot)) best = { s, slot, st };
        }
        return best ? { key: best.slot, title: best.s.title + (best.slot.includes('#') ? ' (' + best.slot.split('#')[1] + '화)' : ''), status: best.st.status, teachingNote: best.s.teachingNote || '' } : null;
      };
      return ok({ class: { id: c.id, name: c.name }, students: rows.map((r) => ({
        userId: r.user_id, name: r.display_name || r.login_id, projectId: r.project_id, projectName: r.project_name,
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0, docs: r.docs || 0, lastJob: r.last_job || '',
        stage: nowStage(r.stages),
      })) });
    },

    // ---------------- 초대
    async 'invite.create'(user, b, ip) {
      const role = String(b.role || 'student');
      if (!ROLES.includes(role) || !isUuid(b.orgId)) return no(422, '초대할 역할이 맞지 않습니다', 'validation');
      const admin = await isAdmin(user, b.orgId);
      let classId = null;
      if (b.classId) {
        const c = isUuid(b.classId) ? await one('SELECT id, organization_id FROM classes WHERE id = $1', [b.classId]) : null;
        if (!c || c.organization_id !== b.orgId) return NOT_FOUND;
        classId = c.id;
      }
      // 강사는 맡은 수업의 학생만 초대한다. 기관 관리자 초대는 기관 관리자 · 플랫폼 관리자만.
      const allowed = admin || (role === 'student' && classId && await teaches(user.id, classId));
      if (!allowed) return NOT_FOUND;
      if (role !== 'organization_admin' && role !== 'instructor' && !classId) return no(422, '학생 초대는 수업을 골라야 합니다', 'validation');
      const days = Math.max(1, Math.min(30, Number(b.days) || 7));
      const maxUses = Math.max(1, Math.min(500, Number(b.maxUses) || (role === 'student' ? 40 : 1)));
      const code = newInviteCode();
      const inv = await one(`INSERT INTO invites (organization_id, class_id, role, code_hash, expires_at, max_uses, created_by)
        VALUES ($1,$2,$3,$4, now() + make_interval(days => $5), $6, $7) RETURNING id, role, expires_at, max_uses`, [b.orgId, classId, role, codeHash(code), days, maxUses, user.id]);
      await log(user, b.orgId, 'invite.create', 'invite', inv.id, { role, classId, days, maxUses }, ip);
      return ok({ invite: { ...inv, code } });   // 원문은 이번 한 번뿐
    },
    // 아직 쓸 수 있는 초대 코드 — 코드 원문은 없다(만들 때 한 번만 보였다). 새어 나갔으면 여기서 취소한다.
    // 기관 관리자 · 최상위는 그 기관 것 모두, 강사는 제가 맡은 수업 것만.
    async 'invite.list'(user, b) {
      if (!isUuid(b.orgId)) return NOT_FOUND;
      const admin = await isAdmin(user, b.orgId);
      if (!admin && !(await one(`SELECT 1 FROM class_members WHERE organization_id = $1 AND user_id = $2 AND role = 'instructor' LIMIT 1`, [b.orgId, user.id]))) return NOT_FOUND;
      const rows = (await pool.query(
        `SELECT i.id, i.role, i.class_id, c.name AS class_name, i.used_count, i.max_uses, i.expires_at, i.created_at, u.login_id AS made_by
           FROM invites i LEFT JOIN classes c ON c.id = i.class_id LEFT JOIN users u ON u.id = i.created_by
          WHERE i.organization_id = $1 AND i.revoked_at IS NULL AND i.expires_at > now() AND i.used_count < i.max_uses
            AND ($2::boolean OR i.class_id IN (SELECT class_id FROM class_members WHERE user_id = $3 AND role = 'instructor'))
          ORDER BY i.created_at DESC`, [b.orgId, !!admin, user.id])).rows;
      return ok({ invites: rows.map((r) => ({ id: r.id, role: r.role, classId: r.class_id, className: r.class_name || '', used: r.used_count, max: r.max_uses,
        expiresAt: new Date(r.expires_at).getTime(), createdAt: new Date(r.created_at).getTime(), madeBy: r.made_by || '' })) });
    },
    async 'invite.revoke'(user, b, ip) {
      const inv = isUuid(b.inviteId) ? await one('SELECT id, organization_id, class_id FROM invites WHERE id = $1', [b.inviteId]) : null;
      if (!inv || !((await isAdmin(user, inv.organization_id)) || (inv.class_id && await teaches(user.id, inv.class_id)))) return NOT_FOUND;
      await pool.query('UPDATE invites SET revoked_at = now() WHERE id = $1', [inv.id]);
      await log(user, inv.organization_id, 'invite.revoke', 'invite', inv.id, {}, ip);
      return ok();
    },

    // ---------------- 사용량 — 비용을 내는 쪽만 본다(기관 키 → 기관 관리자 · 플랫폼 관리자, 개인 키 → 그 사람). 학생에게는 없다.
    // 금액은 카탈로그 가격으로 낸 «추정»이다(provider 청구서가 정본). 달 · 모델별로 묶는다.
    async 'usage.summary'(user, b) {
      let where; let args;
      if (b.orgId) {
        if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
        where = `r.organization_id = $1 AND r.credential_owner_type = 'organization'`; args = [b.orgId];
      } else {
        // 내 키로 돈 것(개인 프로젝트) — 기관 학생이라도 기관 키로 돈 것은 여기 들지 않는다
        where = `r.credential_owner_type = 'user' AND p.owner_user_id = $1 AND p.organization_id IS NULL`; args = [user.id];
      }
      const rows = (await pool.query(
        `SELECT to_char(date_trunc('month', r.started_at), 'YYYY-MM') AS month, r.provider, r.model_id, count(*)::int AS calls,
                sum(r.input_tokens)::bigint AS input_tokens, sum(r.output_tokens)::bigint AS output_tokens,
                sum(r.cache_read_tokens)::bigint AS cache_read_tokens, round(coalesce(sum(r.cost_usd), 0)::numeric, 4)::text AS cost_usd,
                sum(CASE WHEN r.status = 'succeeded' THEN 0 ELSE 1 END)::int AS failed
           FROM generation_runs r JOIN projects p ON p.id = r.project_id
          WHERE ${where} AND r.provider <> ''
          GROUP BY 1, 2, 3 ORDER BY 1 DESC, 2, 3`, args)).rows;
      return ok({ usage: rows.map((r) => ({ ...r, input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cache_read_tokens: Number(r.cache_read_tokens), cost_usd: Number(r.cost_usd) })), estimated: true });
    },

    // ---------------- 사람(기관 관리자) — 학생 · 강사는 저마다 제 계정이다(초대 코드는 들어오는 열쇠일 뿐 계정이 아니다)
    async 'org.members'(user, b) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      const rows = (await pool.query(
        `SELECT u.id, u.login_id, u.display_name, u.last_login_at, array_agg(DISTINCT m.role) AS roles,
                coalesce((SELECT array_agg(c.name ORDER BY c.name) FROM class_members cm JOIN classes c ON c.id = cm.class_id
                           WHERE cm.user_id = u.id AND cm.organization_id = $1), '{}') AS classes
           FROM organization_members m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND m.status = 'active'
          GROUP BY u.id ORDER BY u.display_name, u.login_id`, [b.orgId])).rows;
      return ok({ members: rows.map((r) => ({ userId: r.id, loginId: r.login_id, name: r.display_name, roles: r.roles, classes: r.classes,
        lastLoginAt: r.last_login_at ? new Date(r.last_login_at).getTime() : 0 })) });
    },
    // 비밀번호를 잊은 사람 — 임시 비밀번호를 한 번만 보여 주고, 그 사람의 세션은 모두 끊는다.
    // 기관 관리자는 제 기관의 학생 · 강사만(다른 기관 관리자 · 플랫폼 관리자 · 자기 자신은 안 된다 — 자기 것은 «비밀번호 바꾸기»로).
    async 'member.reset_password'(user, b, ip) {
      if (!isUuid(b.orgId) || !isUuid(b.userId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      if (b.userId === user.id) return no(422, '자기 비밀번호는 «비밀번호 바꾸기»에서 바꿉니다', 'validation');
      const roles = await rolesIn(b.userId, b.orgId);
      const target = await one('SELECT id, is_platform_admin FROM users WHERE id = $1', [b.userId]);
      if (!target || !roles.size) return NOT_FOUND;
      if (target.is_platform_admin || (roles.has('organization_admin') && !user.isPlatformAdmin)) return FORBIDDEN;
      const temp = newInviteCode().toLowerCase();   // 12자 · 사람이 받아 적기 쉬운 꼴
      await pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [b.userId, await auth.hashPassword(temp)]);
      await pool.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [b.userId]);
      await log(user, b.orgId, 'member.reset_password', 'user', b.userId, {}, ip);
      return ok({ tempPassword: temp });   // 이번 한 번만
    },
    // 계정 직접 만들기 — 초대 코드 없이 운영자 · 기관 관리자가 그 기관의 강사(또는 기관 관리자) 계정을 만든다.
    // 임시 비밀번호를 한 번만 보여 준다(본인이 «내 계정»에서 바꾼다). 기관 관리자 계정은 최상위 관리자만 만든다.
    // 학생은 초대 코드로(학생 자리 상한을 지키는 길이 하나여야 한다). 이미 있는 아이디면 만들지 않는다 — 있는 사람은 초대 코드로 더한다.
    async 'member.create'(user, b, ip) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      const role = String(b.role || 'instructor');
      if (!['instructor', 'organization_admin'].includes(role)) return no(422, '강사 · 기관 관리자 계정만 직접 만듭니다(학생은 초대 코드로)', 'validation');
      if (role === 'organization_admin' && !user.isPlatformAdmin) return no(403, '기관 관리자 계정은 최상위 관리자만 만듭니다', 'forbidden');
      let classId = null;
      if (b.classId) {
        const c = isUuid(b.classId) ? await one('SELECT id, organization_id FROM classes WHERE id = $1', [b.classId]) : null;
        if (!c || c.organization_id !== b.orgId) return NOT_FOUND;
        if (role === 'instructor') classId = c.id;
      }
      const temp = newInviteCode().toLowerCase();
      const r = await auth.createUser(pool, { loginId: b.loginId, password: temp, displayName: b.displayName || '' });
      if (!r.ok) return no(r.code === 'conflict' ? 409 : 422, r.code === 'conflict' ? '이미 있는 아이디입니다 — 그 사람은 초대 코드로 더해 주세요' : r.error, r.code);
      await pool.query('INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)', [b.orgId, r.user.id, role]);
      if (classId) await pool.query(`INSERT INTO class_members (class_id, organization_id, user_id, role) VALUES ($1,$2,$3,'instructor')`, [classId, b.orgId, r.user.id]);
      await log(user, b.orgId, 'member.create', 'user', r.user.id, { role, classId }, ip);
      return ok({ loginId: r.user.login_id, tempPassword: temp });   // 임시 비밀번호는 이번 한 번만
    },
    // 기관에서 내보내기 — 계정과 작품은 지우지 않는다(작품은 그 사람이 계속 읽는다). 기관 · 수업 멤버십만 거둔다.
    async 'member.remove'(user, b, ip) {
      if (!isUuid(b.orgId) || !isUuid(b.userId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      if (b.userId === user.id) return no(422, '자기 자신은 내보낼 수 없습니다', 'validation');
      const roles = await rolesIn(b.userId, b.orgId);
      if (!roles.size) return NOT_FOUND;
      if (roles.has('organization_admin') && !user.isPlatformAdmin) return FORBIDDEN;
      await pool.query(`UPDATE organization_members SET status = 'removed' WHERE organization_id = $1 AND user_id = $2`, [b.orgId, b.userId]);
      await pool.query('DELETE FROM class_members WHERE organization_id = $1 AND user_id = $2', [b.orgId, b.userId]);
      await log(user, b.orgId, 'member.remove', 'user', b.userId, { roles: [...roles] }, ip);
      return ok();
    },

    // ---------------- 단계 고쳐 쓰기(관리 화면) — 운영자는 전체 기본, 기관 관리자는 제 기관. 원문(설정 파일)은 남는다.
    async 'workflow.view'(user, b) {
      if (!wfs) return no(503, '단계 흐름을 쓸 수 없습니다', 'unavailable');
      if (b.orgId) { if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND; }
      else if (!user.isPlatformAdmin) return FORBIDDEN;
      return ok({ workflow: await wfs.editorView(b.orgId || null) });
    },
    async 'workflow.save'(user, b, ip) {
      if (!wfs) return no(503, '단계 흐름을 쓸 수 없습니다', 'unavailable');
      if (b.orgId) { if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND; }
      else if (!user.isPlatformAdmin) return FORBIDDEN;
      const r = await wfs.save({ scope: b.orgId ? 'organization' : 'platform', orgId: b.orgId || null, stageKey: String(b.stageKey || ''), data: b.data || {}, userId: user.id });
      if (!r.ok) return no(404, r.error);
      await log(user, b.orgId || null, b.orgId ? 'workflow.save_org' : 'workflow.save_platform', 'workflow_stage', String(b.stageKey), { fields: Object.keys(r.saved) }, ip);
      return ok({ saved: r.saved });
    },

    // ---------------- 내 AI 키(누구나 — 쓰기 전용). 내 개인 작품의 AI 는 이 키로, 비용은 나에게(USER).
    async 'me.key.set'(user, b, ip) {
      if (!credentials) return no(503, 'AI 키를 저장할 수 없습니다', 'unavailable');
      const provider = b.provider || 'anthropic';
      if (!PROVIDER_IDS.includes(provider)) return no(422, '모르는 AI 회사입니다', 'validation');
      const r = await credentials.set({ ownerType: 'user', ownerId: user.id, provider, apiKey: b.apiKey, createdBy: user.id });
      if (!r.ok) return no(422, '키를 저장하지 못했습니다', 'validation');
      await log(user, null, 'credential.set', 'user', user.id, { provider, ownerType: 'user', credentialId: r.credential.id }, ip);
      return ok({ credential: r.credential });
    },
    // 쓸 AI 회사 고르기 — 사람마다 기본(개인 작품에 쓴다). '' 는 «고르지 않음»(키를 넣은 회사 가운데 하나).
    async 'me.ai.set'(user, b, ip) {
      const p = String(b.provider || '');
      if (p && !PROVIDER_IDS.includes(p)) return no(422, '모르는 AI 회사입니다', 'validation');
      await pool.query(`UPDATE users SET settings = settings || jsonb_build_object('ai_provider', $2::text), updated_at = now() WHERE id = $1`, [user.id, p]);
      await log(user, null, 'ai.choose', 'user', user.id, { provider: p }, ip);
      return ok({ provider: p });
    },
    // 작품마다 회사 — 개인 작품의 주인만. 수업 작품은 기관이 정한다(학생은 고르지 않는다).
    async 'project.ai.set'(user, b, ip) {
      const p = String(b.provider || '');
      if (p && !PROVIDER_IDS.includes(p)) return no(422, '모르는 AI 회사입니다', 'validation');
      const row = isUuid(b.pid) ? await one('SELECT owner_user_id, organization_id FROM projects WHERE id = $1 AND deleted_at IS NULL', [b.pid]) : null;
      if (!row || row.owner_user_id !== user.id) return NOT_FOUND;
      if (row.organization_id) return no(403, '수업 작품의 AI 회사는 기관이 정합니다', 'forbidden');
      await pool.query(`UPDATE projects SET model_policy = model_policy || jsonb_build_object('provider', $2::text), updated_at = now() WHERE id = $1`, [b.pid, p]);
      await log(user, null, 'ai.choose', 'project', b.pid, { provider: p }, ip);
      return ok({ provider: p });
    },
    async 'me.key.list'(user) {
      return ok({ credentials: credentials ? await credentials.list('user', user.id) : [] });
    },
    // 연결 확인 — 그 회사에 아주 짧게 한 번 묻는다(비용은 거의 없다). 결과(확인한 때 · 실패 갈래)는 키 목록에 보인다.
    async 'me.key.test'(user, b) { return testKey({ ownerUserId: user.id }, b.provider); },
    async 'me.key.revoke'(user, b, ip) { return revokeKey(user, 'user', user.id, null, b.provider, ip); },
    async 'org.key.test'(user, b) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      return testKey({ organizationId: b.orgId }, b.provider);
    },
    async 'org.key.revoke'(user, b, ip) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      return revokeKey(user, 'organization', b.orgId, b.orgId, b.provider, ip);
    },

    // ---------------- 수업 작품 → 내 개인 작품으로 복사(원본은 기관에 그대로). 문서 · 판 이력 · 확정본 · 논의가 따라간다.
    // 복사본은 기관 · 수업에 묶이지 않는다 — AI 는 내 키로, 비용은 나에게. 기관이 막아 두었으면(allow_copy=false) 못 한다.
    async 'project.copy_personal'(user, b, ip) {
      const row = isUuid(b.pid) ? await one(`SELECT p.id, p.owner_user_id, p.organization_id, p.name, o.settings AS org_settings
        FROM projects p LEFT JOIN organizations o ON o.id = p.organization_id WHERE p.id = $1 AND p.deleted_at IS NULL`, [b.pid]) : null;
      if (!row || row.owner_user_id !== user.id) return NOT_FOUND;
      if (!row.organization_id) return no(422, '이미 개인 작품입니다', 'validation');
      if ((row.org_settings || {}).allow_copy === false) return no(403, '이 기관은 수업 작품을 개인 작품으로 복사하지 않게 정했습니다', 'copy_blocked');
      const loaded = await loadAggregate(pool, row.id);
      const src = structuredClone(loaded.project);
      src.name = src.name + ' (개인)';
      src.jobs = [];
      const r = await importProject(pool, src, { ownerUserId: user.id });
      if (!r.pid) return no(422, '복사하지 못했습니다', 'copy_failed');
      await log(user, row.organization_id, 'project.copy_personal', 'project', r.pid, { from: row.id, counts: r.report.counts }, ip);
      return ok({ pid: r.pid, counts: r.report.counts, verified: r.ok });
    },

    // ---------------- 기관 키(기관 관리자 — 쓰기 전용)
    async 'org.key.set'(user, b, ip) {
      if (!credentials) return no(503, 'AI 키를 저장할 수 없습니다', 'unavailable');
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      if (!PROVIDER_IDS.includes(b.provider)) return no(422, '모르는 AI 회사입니다', 'validation');
      const r = await credentials.set({ ownerType: 'organization', ownerId: b.orgId, provider: b.provider, apiKey: b.apiKey, createdBy: user.id });
      if (!r.ok) return no(422, '키를 저장하지 못했습니다', 'validation');
      await log(user, b.orgId, 'credential.set', 'organization', b.orgId, { provider: b.provider, ownerType: 'organization', credentialId: r.credential.id }, ip);
      return ok({ credential: r.credential });
    },
    async 'org.key.list'(user, b) {
      if (!credentials) return ok({ credentials: [] });
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      return ok({ credentials: await credentials.list('organization', b.orgId) });
    },
  };

  const KEY_SAY = { auth: '키가 맞지 않습니다', credit: '잔액(크레딧)이 없습니다', rate: '잠시 뒤에 다시 해 보세요(요청이 많습니다)', model: '이 회사의 모델 표가 없습니다', credential_missing: '넣어 둔 키가 없습니다', credential_unreadable: '키를 열 수 없습니다(마스터 키가 바뀌었나요?)', overloaded: '그 회사 서버가 바쁩니다 — 잠시 뒤에', timeout: '응답이 늦습니다 — 잠시 뒤에' };
  async function testKey(owner, provider) {
    if (!credentials || !keyTester) return no(503, '지금은 확인할 수 없습니다', 'unavailable');
    if (!PROVIDER_IDS.includes(provider)) return no(422, '모르는 AI 회사입니다', 'validation');
    const r = await keyTester(owner, provider);
    return ok({ verified: !!r.ok, reason: r.reason || '', say: r.ok ? '연결됩니다' : (KEY_SAY[r.reason] || '연결되지 않습니다') });
  }
  async function revokeKey(user, ownerType, ownerId, orgId, provider, ip) {
    if (!credentials) return no(503, '지금은 할 수 없습니다', 'unavailable');
    const live = (await credentials.list(ownerType, ownerId)).filter((c) => c.status === 'active' && c.provider === provider);
    if (!live.length) return NOT_FOUND;
    for (const c of live) await credentials.revoke(c.id);
    await log(user, orgId, 'credential.revoke', ownerType, ownerId, { provider, ownerType }, ip);
    return ok();
  }

  // 초대 코드 확인 — 맞고, 기관이 살아 있고, (학생이면) 이용 기간 · 자리가 남았는가. 틀리면 맞히기 횟수에 센다.
  async function findInvite(user, b, ip) {
    const key = String(ip || '');
    const t = tries.get(key);
    if (t && t.n >= TRY_LIMIT && t.until > Date.now()) return no(429, '잠시 뒤에 다시 시도해 주세요', 'rate_limited');
    const miss = () => {
      const f = tries.get(key);
      if (!f || f.until <= Date.now()) tries.set(key, { n: 1, until: Date.now() + TRY_WINDOW }); else f.n += 1;
      return no(404, '초대 코드가 맞지 않거나 끝났습니다', 'invite_invalid');
    };
    const inv = await one(`SELECT * FROM invites WHERE code_hash = $1 AND revoked_at IS NULL AND expires_at > now() AND used_count < max_uses`, [codeHash(b.code)]);
    if (!inv) return miss();
    const org = await one('SELECT id, status FROM organizations WHERE id = $1', [inv.organization_id]);
    if (!org || org.status !== 'active') return miss();
    // 학생 자리 — 유효한 라이선스의 seat_limit 안에서만
    if (inv.role === 'student') {
      const lic = await liveLicense(inv.organization_id);
      if (!lic) return no(403, '이용 기간이 아닙니다 — 선생님(기관)께 문의해 주세요', 'license_inactive');
      if (lic.seat_limit) {
        const used = (await one(`SELECT count(DISTINCT user_id)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'student' AND status = 'active'`, [inv.organization_id])).n;
        const already = user && (await rolesIn(user.id, inv.organization_id)).has('student');
        if (!already && used >= lic.seat_limit) return no(403, '수업 자리가 다 찼습니다 — 선생님(기관)께 문의해 주세요', 'seats_full');
      }
    }
    return { inv, miss };
  }

  // 아이디 쓸 수 있나 — 계정을 만들기 전에 미리 본다(만들 때도 DB 의 유일 조건이 다시 막는다).
  // 아무나 아이디 목록을 더듬지 못하게: 맞는 초대 코드를 쥔 사람(가입 중)이나 기관 · 최상위 관리자만 묻는다. 틀린 코드는 맞히기 횟수에 센다.
  async function loginAvailable(user, b, ip) {
    const admin = user && (user.isPlatformAdmin || (await one(`SELECT 1 FROM organization_members WHERE user_id = $1 AND role = 'organization_admin' AND status = 'active' LIMIT 1`, [user.id])));
    if (!admin) {
      const f = await findInvite(user, b, ip);
      if (!f.inv) return f;
    }
    const login = String(b.loginId || '').trim().toLowerCase();
    if (!auth.LOGIN_RE.test(login)) return ok({ available: false, reason: 'format', say: '아이디는 영문 소문자 · 숫자 · . _ - 로 3~64자' });
    const taken = !!(await one('SELECT 1 FROM users WHERE login_id = $1', [login]));
    return ok({ available: !taken, reason: taken ? 'taken' : '', say: taken ? '이미 사용 중인 아이디입니다' : '사용할 수 있는 아이디입니다' });
  }

  // 첫 화면에서 코드만 먼저 확인한다(쓰지 않는다) — 맞으면 계정 만들기 칸을 연다
  async function checkInvite(user, b, ip) {
    const f = await findInvite(user, b, ip);
    if (!f.inv) return f;
    const org = await one('SELECT name FROM organizations WHERE id = $1', [f.inv.organization_id]);
    const cls = f.inv.class_id ? await one('SELECT name FROM classes WHERE id = $1', [f.inv.class_id]) : null;
    return { status: 200, body: { ok: true, role: f.inv.role, organizationName: org ? org.name : '', className: cls ? cls.name : '' } };
  }

  // 초대 받기 — 로그인하지 않은 사람도(새 계정을 만들며), 로그인한 사람도(기관 · 수업에 더해지며)
  async function acceptInvite(user, b, ip) {
    const f = await findInvite(user, b, ip);
    if (!f.inv) return f;
    const { inv, miss } = f;
    let who = user;
    let made = false;
    if (!who) {
      const r = await auth.createUser(pool, { loginId: b.loginId, password: b.password, displayName: b.displayName || '' });
      if (!r.ok) return no(r.code === 'conflict' ? 409 : 422, r.error, r.code);
      who = { id: r.user.id, loginId: r.user.login_id };
      made = true;
    }
    // 한 자리 쓰기 — 동시에 마지막 자리를 둘이 얻지 못하게 한 문장으로
    const took = await one('UPDATE invites SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses AND revoked_at IS NULL AND expires_at > now() RETURNING id', [inv.id]);
    if (!took) {
      if (made) await pool.query('DELETE FROM users WHERE id = $1', [who.id]);   // 방금 만든 빈 계정은 거둔다
      return miss();
    }
    await pool.query(`INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1,$2,$3)
      ON CONFLICT (organization_id, user_id, role) DO UPDATE SET status = 'active'`, [inv.organization_id, who.id, inv.role]);
    if (inv.class_id && (inv.role === 'student' || inv.role === 'instructor')) {
      await pool.query(`INSERT INTO class_members (class_id, organization_id, user_id, role) VALUES ($1,$2,$3,$4)
        ON CONFLICT (class_id, user_id) DO NOTHING`, [inv.class_id, inv.organization_id, who.id, inv.role]);
    }
    tries.delete(String(ip || ''));
    await auth.audit(pool, { actor: who.id, organizationId: inv.organization_id, action: 'invite.accept', targetType: 'invite', targetId: inv.id, details: { role: inv.role, newAccount: made }, ip });
    return { status: 200, body: { ok: true, role: inv.role, organizationId: inv.organization_id, classId: inv.class_id }, newUser: made ? who : null };
  }

  return {
    OPS,
    OP_NAMES: [...Object.keys(OPS), 'invite.accept', 'invite.check', 'login.available'],
    async handle(user, body, ip = '') {
      const op = String((body && body.op) || '');
      if (op === 'invite.accept') return acceptInvite(user, body, ip);
      if (op === 'invite.check') return checkInvite(user, body, ip);
      if (op === 'login.available') return loginAvailable(user, body, ip);
      if (!user) return no(401, '로그인이 필요합니다', 'login');
      const fn = OPS[op];
      if (!fn) return no(404, '그런 문이 없습니다: ' + op);
      return fn(user, body, ip);
    },
  };
}
