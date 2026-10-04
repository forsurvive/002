// 이름표와 모델 목록 — Core 와 저장소가 함께 쓴다. I/O 가 없다.
// (개인판의 tools/store.mjs 에서 옮겼다 — 순번이 한 벌이어야 하므로 이곳 하나에만 둔다.)

let seq = 0;
export function newId(prefix = 'i') {
  seq += 1;
  return prefix + '_' + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

// 고를 수 있는 모델 — «기본값»(빈 값)은 두지 않는다.
// 무엇이 돌지 모르는 칸이 있으면 사람마다 모델을 정해 둔 뜻이 흐려진다(사용자 지시, 2026-09-19).
export const MODELS = ['opus', 'sonnet', 'fable'];
