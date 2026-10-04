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
import { isUuid } from './tenancy.mjs';
import { PROVIDER_IDS } from '../ai/credentials.mjs';

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

export function createEdu({ pool, credentials = null }) {
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

  const OPS = {
    // ---------------- 나
    async 'me.memberships'(user) {
      const orgs = (await pool.query(
        `SELECT o.id, o.name, o.slug, o.status, array_agg(m.role ORDER BY m.role) AS roles FROM organization_members m JOIN organizations o ON o.id = m.organization_id
          WHERE m.user_id = $1 AND m.status = 'active' GROUP BY o.id ORDER BY o.name`, [user.id])).rows;
      const classes = (await pool.query(
        `SELECT c.id, c.name, c.status, c.organization_id, m.role FROM class_members m JOIN classes c ON c.id = m.class_id
          WHERE m.user_id = $1 ORDER BY c.name`, [user.id])).rows;
      return ok({ platformAdmin: !!user.isPlatformAdmin, organizations: orgs, classes });
    },

    // ---------------- 기관 · 라이선스(플랫폼 관리자)
    async 'org.create'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      const name = String(b.name || '').trim(); const slug = String(b.slug || '').trim().toLowerCase();
      if (!name || !SLUG_RE.test(slug)) return no(422, '이름과 주소 이름(영문 소문자 · 숫자 · -)이 필요합니다', 'validation');
      try {
        const o = await one('INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug, status', [name, slug]);
        await log(user, o.id, 'org.create', 'organization', o.id, { slug }, ip);
        return ok({ organization: o });
      } catch (e) {
        if (e && e.code === '23505') return no(409, '이미 있는 주소 이름입니다', 'conflict');
        throw e;
      }
    },
    async 'org.list'(user) {
      const rows = user.isPlatformAdmin
        ? (await pool.query('SELECT id, name, slug, status, created_at FROM organizations ORDER BY name')).rows
        : (await pool.query(`SELECT DISTINCT o.id, o.name, o.slug, o.status, o.created_at FROM organizations o JOIN organization_members m ON m.organization_id = o.id
            WHERE m.user_id = $1 AND m.status = 'active' AND m.role = 'organization_admin' ORDER BY o.name`, [user.id])).rows;
      return ok({ organizations: rows });
    },
    async 'org.settings'(user, b, ip) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      // 고칠 수 있는 칸만(기관 관리자의 작품 열람 — 기본 꺼짐)
      const patch = {};
      if (typeof b.adminCanReadProjects === 'boolean') patch.admin_can_read_projects = b.adminCanReadProjects;
      const o = await one('UPDATE organizations SET settings = settings || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING settings', [b.orgId, JSON.stringify(patch)]);
      await log(user, b.orgId, 'org.settings', 'organization', b.orgId, patch, ip);
      return ok({ settings: o.settings });
    },
    async 'license.issue'(user, b, ip) {
      if (!user.isPlatformAdmin) return FORBIDDEN;
      if (!isUuid(b.orgId) || !(await one('SELECT 1 FROM organizations WHERE id = $1', [b.orgId]))) return NOT_FOUND;
      const days = Math.max(1, Math.min(3650, Number(b.days) || 30));
      const seats = b.seatLimit == null ? null : Math.max(1, Number(b.seatLimit) || 1);
      const l = await one(`INSERT INTO licenses (organization_id, plan, ends_at, seat_limit, created_by)
        VALUES ($1, $2, now() + make_interval(days => $3), $4, $5) RETURNING id, plan, status, starts_at, ends_at, seat_limit`,
      [b.orgId, String(b.plan || 'trial'), days, seats, user.id]);
      await log(user, b.orgId, 'license.issue', 'license', l.id, { plan: l.plan, days, seats }, ip);
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
    async 'license.read'(user, b) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      const rows = (await pool.query('SELECT id, plan, status, starts_at, ends_at, seat_limit FROM licenses WHERE organization_id = $1 ORDER BY created_at DESC', [b.orgId])).rows;
      const seatsUsed = (await one(`SELECT count(DISTINCT user_id)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'student' AND status = 'active'`, [b.orgId])).n;
      return ok({ licenses: rows, seatsUsed });
    },

    // ---------------- 수업(기관 관리자)
    async 'class.create'(user, b, ip) {
      if (!isUuid(b.orgId) || !(await isAdmin(user, b.orgId))) return NOT_FOUND;
      const name = String(b.name || '').trim();
      if (!name) return no(422, '수업 이름이 필요합니다', 'validation');
      const c = await one('INSERT INTO classes (organization_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name, status', [b.orgId, name, user.id]);
      await log(user, b.orgId, 'class.create', 'class', c.id, { name }, ip);
      return ok({ class: c });
    },
    async 'class.list'(user, b) {
      if (!isUuid(b.orgId)) return NOT_FOUND;
      if (await isAdmin(user, b.orgId)) {
        return ok({ classes: (await pool.query(`SELECT c.id, c.name, c.status, (SELECT count(*)::int FROM class_members m WHERE m.class_id = c.id AND m.role = 'student') AS students
          FROM classes c WHERE c.organization_id = $1 ORDER BY c.name`, [b.orgId])).rows });
      }
      return ok({ classes: (await pool.query(`SELECT c.id, c.name, c.status, m.role FROM classes c JOIN class_members m ON m.class_id = c.id
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
        `SELECT u.id AS user_id, u.display_name, u.login_id, p.id AS project_id, p.name AS project_name, p.updated_at,
                (SELECT j.status FROM jobs j WHERE j.project_id = p.id ORDER BY j.created_at DESC LIMIT 1) AS last_job,
                (SELECT count(*)::int FROM documents d WHERE d.project_id = p.id AND d.deleted_at IS NULL) AS docs
           FROM class_members m JOIN users u ON u.id = m.user_id
           LEFT JOIN projects p ON p.class_id = m.class_id AND p.owner_user_id = u.id AND p.deleted_at IS NULL
          WHERE m.class_id = $1 AND m.role = 'student' ORDER BY u.display_name, p.updated_at DESC`, [c.id])).rows;
      return ok({ class: { id: c.id, name: c.name }, students: rows.map((r) => ({
        userId: r.user_id, name: r.display_name || r.login_id, projectId: r.project_id, projectName: r.project_name,
        updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : 0, docs: r.docs || 0, lastJob: r.last_job || '',
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
    async 'invite.revoke'(user, b, ip) {
      const inv = isUuid(b.inviteId) ? await one('SELECT id, organization_id, class_id FROM invites WHERE id = $1', [b.inviteId]) : null;
      if (!inv || !((await isAdmin(user, inv.organization_id)) || (inv.class_id && await teaches(user.id, inv.class_id)))) return NOT_FOUND;
      await pool.query('UPDATE invites SET revoked_at = now() WHERE id = $1', [inv.id]);
      await log(user, inv.organization_id, 'invite.revoke', 'invite', inv.id, {}, ip);
      return ok();
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

  // 초대 받기 — 로그인하지 않은 사람도(새 계정을 만들며), 로그인한 사람도(기관 · 수업에 더해지며)
  async function acceptInvite(user, b, ip) {
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
    tries.delete(key);
    await auth.audit(pool, { actor: who.id, organizationId: inv.organization_id, action: 'invite.accept', targetType: 'invite', targetId: inv.id, details: { role: inv.role, newAccount: made }, ip });
    return { status: 200, body: { ok: true, role: inv.role, organizationId: inv.organization_id, classId: inv.class_id }, newUser: made ? who : null };
  }

  return {
    OPS,
    OP_NAMES: [...Object.keys(OPS), 'invite.accept'],
    async handle(user, body, ip = '') {
      const op = String((body && body.op) || '');
      if (op === 'invite.accept') return acceptInvite(user, body, ip);
      if (!user) return no(401, '로그인이 필요합니다', 'login');
      const fn = OPS[op];
      if (!fn) return no(404, '그런 문이 없습니다: ' + op);
      return fn(user, body, ip);
    },
  };
}
