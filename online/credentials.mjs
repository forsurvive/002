// 자격증명 저장소 — ai/credentials.mjs 의 저장소 모양(insert · update · findActive · list)을 PostgreSQL(provider_credentials)로.
// 봉인 · 열기 · 누구의 키인가는 ai/credentials.mjs 가 맡는다. 여기는 행을 넣고 꺼낼 뿐 — 원문은 이 표 어디에도 없다.

const toRow = (r) => r && ({
  id: r.id, ownerType: r.owner_type, ownerId: r.owner_id, provider: r.provider, label: r.label, status: r.status,
  keyHint: r.key_hint, sealed: r.sealed, lastVerifiedAt: r.last_verified_at ? new Date(r.last_verified_at).getTime() : 0,
  lastErrorCode: r.last_error_code, createdBy: r.created_by, createdAt: new Date(r.created_at).getTime(),
});

const COLS = { status: 'status', label: 'label', lastVerifiedAt: 'last_verified_at', lastErrorCode: 'last_error_code', revokedAt: 'revoked_at' };
const asTime = (k, v) => (k === 'lastVerifiedAt' || k === 'revokedAt' ? (v ? new Date(v) : null) : v);

export function pgCredentialStore(pool) {
  return {
    async insert(row) {
      // 같은 주체 · provider 의 활성 키는 하나뿐(credentials_one_active) — 서비스가 앞 키를 revoked 로 돌리기 전에 넣으므로, 앞 것을 먼저 내린다
      await pool.query(`UPDATE provider_credentials SET status = 'revoked', revoked_at = now()
                         WHERE owner_type = $1 AND owner_id = $2 AND provider = $3 AND status = 'active'`, [row.ownerType, row.ownerId, row.provider]);
      const { rows } = await pool.query(
        `INSERT INTO provider_credentials (id, owner_type, owner_id, provider, label, status, key_hint, sealed, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [row.id, row.ownerType, row.ownerId, row.provider, row.label || '', row.status || 'active', row.keyHint || '', row.sealed, String(row.createdBy || '')]);
      return toRow(rows[0]);
    },
    async update(id, patch) {
      const sets = []; const vals = [id];
      for (const [k, v] of Object.entries(patch || {})) if (COLS[k]) { vals.push(asTime(k, v)); sets.push(COLS[k] + ' = $' + vals.length); }
      if (!sets.length) return toRow((await pool.query('SELECT * FROM provider_credentials WHERE id = $1', [id])).rows[0]);
      const { rows } = await pool.query(`UPDATE provider_credentials SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
      return toRow(rows[0]) || null;
    },
    async findActive(ownerType, ownerId, provider) {
      const { rows } = await pool.query(`SELECT * FROM provider_credentials WHERE owner_type = $1 AND owner_id = $2 AND provider = $3 AND status = 'active'`, [ownerType, String(ownerId), provider]);
      return toRow(rows[0]) || null;
    },
    async list(ownerType, ownerId) {
      const { rows } = await pool.query('SELECT * FROM provider_credentials WHERE owner_type = $1 AND owner_id = $2 ORDER BY created_at', [ownerType, String(ownerId)]);
      return rows.map(toRow);
    },
  };
}
