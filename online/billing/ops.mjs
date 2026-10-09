// 이용권의 문(POST /api/edu { op }) — 자유 가입판에만(online/edition.mjs isOpenOnlyOp). createEdu 가 문 표에 더한다.
//   me.pass           — 내 이용권(상태 · 기한 · [결제하기]에 걸 결제 옵션 이름). 금액은 싣지 않는다.
//   me.pass.checkout  — [결제하기] — 새 참조값을 붙인 결제창 링크

export function billingOps({ billing }) {
  const ok = (extra = {}) => ({ status: 200, body: { ok: true, ...extra } });
  const no = (status, error, code) => ({ status, body: { ok: false, error, ...(code ? { code } : {}) } });
  return {
    async 'me.pass'(user) { return ok({ pass: await billing.myPass(user) }); },
    async 'me.pass.checkout'(user, b) {
      const r = await billing.checkout(user, b.planId);
      if (r.ok) return ok({ url: r.url });
      return r.code === 'bad_link' ? no(422, '결제 링크가 맞지 않습니다 — 운영자에게 알려 주세요', 'bad_link') : no(404, '그 결제 옵션이 없습니다', 'missing');
    },
  };
}
