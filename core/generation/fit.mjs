// 길이로 거절당한 부르기를 줄여서 다시 — 참조가 많은 문서 생성이 «입력이 너무 깁니다»로 실패하던 것(2026-10-07 사용자 보고).
// 처음에는 실을 것을 그대로 보낸다(맞으면 아무것도 줄이지 않는다). 거절(invalid)당하면 몫을 줄여 가며 다시 부른다:
// 40만 자 → 15만 자 → 6만 자. 줄인 문서에는 «여기까지만 실었다» 표가 붙는다(core/reference/plan.mjs 의 fitInputs).
// 길이 거절은 모델이 읽기 전에 돌아오므로 다시 부르는 값이 거의 들지 않는다.

export const FIT_BUDGETS = [400000, 150000, 60000];

export function fitting(call, budgets = FIT_BUDGETS) {
  const fit = async (args, ctx) => {
    let r = await call(args, ctx);
    for (const max of budgets) {
      if (r.ok || r.reason !== 'invalid' || (args && args.inputMax) || (ctx && ctx.signal && ctx.signal.aborted)) break;
      if (ctx && typeof ctx.step === 'function') ctx.step('길이를 줄여 다시 — ' + max.toLocaleString('en-US') + '자');
      r = await call({ ...args, inputMax: max }, ctx);
    }
    return r;
  };
  return Object.assign(fit, call);   // call.raw 같은 곁문은 그대로
}
