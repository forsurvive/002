// 계정 지우기 — 자유 가입판에서 본인이 «내 계정»에서(2026-10-11 사용자 지시). 설계: docs/OPEN_EDITION.md §4-11.
//
// 지우는 것(바로 · 되돌릴 수 없다): 작품 전부(문서 · 판 · 논의 · 에이전트 · 작업 · 생성 기록) · AI 키 · 세션 · 구글 연결 ·
//   이메일 · 이름 · 비밀번호 · 설정 · 무료 이용 표시와 운영 메모 · 쓰지 않은 결제 참조값 · 사용량 장부 · 그 사람이 한 일의 감사 기록.
// 남기는 것(법정 보존 — 결제 기록): 정기결제 줄 · 받은 결제 소식(구매자 정보는 걷는다) · 환불 · 구독 취소 요청.
//   이 줄들이 가리키도록 계정 줄은 «빈 껍데기»로 남는다 — 아이디 '_deleted-…'(가입 규칙으로는 만들 수 없는 꼴), 로그인 · 세션은 막힌다.
// 구독 — 다시 청구될 수 있는 그로블 정기결제마다 구독 취소를 저절로 접수하고(이유: 계정을 지움) 이용권은 지금 끝낸다.
//   그로블에 판매자 해지 API 가 없어 해지 자체는 운영자가 그로블 판매 관리에서 한다 — 운영자에게 메일이 가고, 해지 웹훅이 오면 «해지 확인».
// 하나의 트랜잭션 — 중간에 실패하면 아무것도 지우지 않는다. 도는 AI 작업은 작업 줄이 사라지니 worker 가 다음 숨에 손을 뗀다(쓰지 않는다).

import { randomBytes } from 'node:crypto';
import { NO_PASSWORD } from './auth.mjs';
import { cancelForDeletion } from './billing/service.mjs';

/**
 * 돌려주는 값: { ok, cancels: [취소 요청 id] } 또는 { ok:false, code: missing | operator }
 * 메일은 부른 쪽이 커밋 뒤에(billing.notify('cancel', id)) — 메일이 늦어도 DB 연결을 붙잡지 않게.
 */
export async function deleteAccount(pool, userId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = (await c.query('SELECT id, login_id, is_platform_admin, deleted_at FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!u || u.deleted_at) { await c.query('ROLLBACK'); return { ok: false, code: 'missing' }; }
    // 운영자 계정은 지우지 않는다 — 처음 설정 문이 다시 열리거나 운영 화면을 맡을 사람이 사라진다
    if (u.is_platform_admin) { await c.query('ROLLBACK'); return { ok: false, code: 'operator' }; }

    // 1. 구독 — 취소 접수 · 이용권 끝(결제 줄을 먼저 잠근다 — 같은 때 온 웹훅과 차례로)
    const cancels = await cancelForDeletion(c, userId);

    // 2. 작품 — 생성 기록의 입력(판을 RESTRICT 로 붙든다)부터 걷고 작품을 지운다(나머지는 작품에 딸려 함께 지워진다)
    const pids = (await c.query('SELECT id FROM projects WHERE owner_user_id = $1', [userId])).rows.map((r) => r.id);
    if (pids.length) {
      await c.query('UPDATE document_versions SET generation_run_id = NULL WHERE project_id = ANY($1) AND generation_run_id IS NOT NULL', [pids]);
      await c.query('UPDATE thread_messages SET generation_run_id = NULL WHERE project_id = ANY($1) AND generation_run_id IS NOT NULL', [pids]);
      await c.query('DELETE FROM generation_runs WHERE project_id = ANY($1)', [pids]);
      await c.query('DELETE FROM projects WHERE id = ANY($1)', [pids]);
    }

    // 3. 열쇠 · 들어오는 길 · 그 밖의 내 것
    await c.query(`DELETE FROM provider_credentials WHERE owner_type = 'user' AND owner_id = $1`, [String(userId)]);
    await c.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM user_identities WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM oauth_states WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM class_members WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM organization_members WHERE user_id = $1', [userId]);
    await c.query('DELETE FROM billing_customers WHERE user_id = $1', [userId]);
    // 결제 참조값 — 쓰인 것(정기결제가 걸린 것)은 남긴다: 해지 · 늦은 갱신 소식이 이 껍데기로 와서 운영자가 본다. 이메일 잇기와 쓰지 않은 것은 지운다.
    await c.query(`DELETE FROM billing_refs WHERE user_id = $1 AND (kind = 'email' OR used_at IS NULL)`, [userId]);
    await c.query('DELETE FROM usage_ledger WHERE owner_user_id = $1', [userId]);

    // 4. 결제 기록에서 구매자 정보를 걷는다(결제 건 번호 · 금액 · 때 · 상태만 남는다)
    await c.query(`UPDATE billing_events SET raw = raw #- '{data,object,buyer}' WHERE user_id = $1 AND raw #> '{data,object,buyer}' IS NOT NULL`, [userId]);

    // 5. 감사 기록 — 그 사람이 한 일은 지우고, 운영자가 그 사람에게 한 일(운영자의 접속 기록)에서는 아이디를 걷는다
    await c.query('DELETE FROM audit_logs WHERE actor_user_id = $1', [userId]);
    await c.query(`UPDATE audit_logs SET details = details - 'loginId' WHERE details->>'loginId' = $1`, [u.login_id]);
    await c.query(`UPDATE audit_logs SET target_id = '' WHERE target_type = 'user' AND target_id = $1`, [u.login_id]);   // 로그인 실패(시도한 아이디)

    // 6. 계정 줄 — 빈 껍데기로. 아이디는 풀어 준다(같은 아이디로 다시 가입할 수 있다).
    await c.query(`UPDATE users SET login_id = $2, email = NULL, display_name = '', password_hash = $3, status = 'disabled', is_platform_admin = false,
        settings = '{}'::jsonb, reset_code_hash = NULL, reset_code_sealed = NULL, reset_expires_at = NULL, known_password_sealed = NULL,
        last_login_at = NULL, deleted_at = now(), updated_at = now() WHERE id = $1`, [userId, '_deleted-' + randomBytes(8).toString('hex'), NO_PASSWORD]);
    // 지웠다는 기록 하나(아이디 · 이메일 없이) — «지워 달라는 요청을 처리했나»의 근거
    await c.query(`INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, details) VALUES ($1, 'auth.account_delete', 'user', $2, $3)`,
      [userId, String(userId), { projects: pids.length, cancels: cancels.length }]);
    await c.query('COMMIT');
    return { ok: true, cancels, projects: pids.length };
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* 끊겼다 */ }
    throw e;
  } finally {
    c.release();
  }
}
