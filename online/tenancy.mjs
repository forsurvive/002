// 접근 판정 — 누가 어느 프로젝트를 읽고 · 고치고 · AI 로 돌릴 수 있는가. 규칙은 이 한 곳에만 둔다(docs/SECURITY.md §4 · §5).
// 클라이언트가 보낸 pid · classId 는 «요청»일 뿐이다 — 서버가 여기서 다시 판정한다. 화면에서 숨기는 것은 보안이 아니다.
//
//   개인 프로젝트 : 주인만(읽기 · 쓰기 · AI)
//   기관 프로젝트 : 주인(학생) — 읽기 · 쓰기, AI 는 기관이 살아 있고 유효한 라이선스가 있고 주인이 아직 기관 멤버일 때만
//                  강사 — 맡은 수업(class_members.role='instructor') 학생 프로젝트 읽기만
//                  기관 관리자 — 기관 설정 admin_can_read_projects 가 켜져 있을 때만 읽기(기본 꺼짐 — 결정 전 보수적 기본, §7)
//                  플랫폼 관리자 — 작품 열람 없음(운영 필요 최소 — 필요하면 감사 로그를 남기는 별도 길로)
// 모르는 것 · 지운 것 · 남의 것은 모두 «없음»으로 같게 답한다(존재 여부를 흘리지 않는다).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID.test(String(v || ''));

const NONE = Object.freeze({ read: false, write: false, ai: false, role: '' });

export function createTenancy(pool) {
  // 기관이 지금 AI 작업을 받을 수 있는가 — 기관이 살아 있고, 기간 안의 active 라이선스가 있다
  async function licenseOf(orgId) {
    const { rows } = await pool.query(
      `SELECT o.status AS org_status,
              (SELECT row_to_json(l) FROM licenses l
                WHERE l.organization_id = o.id AND l.status = 'active' AND l.starts_at <= now() AND (l.ends_at IS NULL OR l.ends_at > now())
                ORDER BY l.ends_at DESC NULLS FIRST LIMIT 1) AS license
         FROM organizations o WHERE o.id = $1`, [orgId]);
    const r = rows[0];
    if (!r) return { ok: false, reason: 'org_missing' };
    if (r.org_status !== 'active') return { ok: false, reason: 'org_suspended' };
    if (!r.license) return { ok: false, reason: 'license_inactive' };
    return { ok: true, license: r.license };
  }

  const isOrgRole = async (userId, orgId, roles) => (await pool.query(
    `SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 AND status = 'active' AND role = ANY($3) LIMIT 1`,
    [orgId, userId, roles])).rowCount > 0;

  return {
    licenseOf,
    isOrgRole,

    // 한 프로젝트에 대한 이 사람의 권한
    async access(user, pid) {
      if (!user || !isUuid(pid)) return NONE;
      const p = (await pool.query(
        `SELECT p.id, p.owner_user_id, p.organization_id, p.class_id, o.settings AS org_settings
           FROM projects p LEFT JOIN organizations o ON o.id = p.organization_id
          WHERE p.id = $1 AND p.deleted_at IS NULL`, [pid])).rows[0];
      if (!p) return NONE;
      if (p.owner_user_id === user.id) {
        if (!p.organization_id) return { read: true, write: true, ai: true, role: 'owner', project: p };
        // 기관 프로젝트의 주인 — 기관을 떠났으면 읽기만(작품은 지우지 않는다)
        const member = await isOrgRole(user.id, p.organization_id, ['student', 'instructor', 'organization_admin']);
        return { read: true, write: member, ai: member, role: 'owner', project: p };
      }
      if (!p.organization_id) return NONE;
      if (p.class_id) {
        const inst = (await pool.query(
          `SELECT 1 FROM class_members WHERE class_id = $1 AND user_id = $2 AND role = 'instructor'`, [p.class_id, user.id])).rowCount > 0;
        if (inst) return { read: true, write: false, ai: false, role: 'instructor', project: p };
      }
      const settings = p.org_settings || {};
      if (settings.admin_can_read_projects === true && await isOrgRole(user.id, p.organization_id, ['organization_admin'])) {
        return { read: true, write: false, ai: false, role: 'organization_admin', project: p };
      }
      return NONE;
    },

    // AI 작업을 지금 받아도 되는가 — 등록할 때와 worker 가 돌리기 직전에 두 번 본다(그 사이 라이선스가 끝날 수 있다)
    async aiAllowed(pid) {
      const p = (await pool.query('SELECT organization_id FROM projects WHERE id = $1 AND deleted_at IS NULL', [pid])).rows[0];
      if (!p) return { ok: false, reason: 'missing' };
      if (!p.organization_id) return { ok: true };
      return licenseOf(p.organization_id);
    },

    // 수업에 프로젝트를 만들 수 있는가 — 그 수업의 학생(또는 강사)이고, 수업이 열려 있고, 기관 라이선스가 유효하다
    async canCreateInClass(user, classId) {
      if (!user || !isUuid(classId)) return { ok: false, reason: 'missing' };
      const c = (await pool.query(
        `SELECT c.id, c.organization_id, c.status, c.starts_at > now() AS early, c.ends_at <= now() AS late
           FROM classes c JOIN class_members m ON m.class_id = c.id
          WHERE c.id = $1 AND m.user_id = $2`, [classId, user.id])).rows[0];
      if (!c) return { ok: false, reason: 'missing' };
      if (c.status !== 'active') return { ok: false, reason: 'class_closed' };
      // 수업 기간(정했으면) — 시작 전 · 끝난 뒤에는 새 작품을 만들지 않는다(이미 만든 작품은 그대로 이어 쓴다)
      if (c.early) return { ok: false, reason: 'class_not_started' };
      if (c.late) return { ok: false, reason: 'class_ended' };
      const lic = await licenseOf(c.organization_id);
      if (!lic.ok) return lic;
      return { ok: true, organizationId: c.organization_id, classId: c.id };
    },
  };
}

// 사람에게 보일 말 — 학생 화면에도 나가므로 금액 · 횟수 · 키 이야기를 하지 않는다
export const SAY = {
  license_inactive: '이용 기간이 아닙니다 — 선생님(기관)께 문의해 주세요',
  org_suspended: '기관 이용이 멈춰 있습니다 — 선생님(기관)께 문의해 주세요',
  org_missing: '기관을 찾을 수 없습니다',
  class_closed: '수업이 닫혀 있습니다',
  class_not_started: '아직 수업 기간이 아닙니다',
  class_ended: '수업 기간이 끝났습니다',
  missing: '찾을 수 없습니다',
  read_only: '읽기만 할 수 있습니다',
};
