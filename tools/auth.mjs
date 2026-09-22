'use strict';

// 무엇으로 돈이 나가는가 — 사람이 고른다.
//
// 세 갈래다.
//   auto : 아무것도 손대지 않는다(지금까지의 거동). 사용자 PC 의 환경이 정하는 대로 간다.
//   sub  : 구독으로만 돈다 — 물려받은 ANTHROPIC_API_KEY 를 지워 종량 과금으로 새는 것을 막는다.
//   api  : 여기 담아 둔 키로 돈다 — 구독 한도를 다 썼을 때 갈아타는 자리.
//
// 왜 «auto» 를 기본으로 두는가: 구독 로그인 없이 API 키만 있는 PC 에서 키를 지우면 그 사람은 아무것도 못 한다.
// 사람이 고르기 전까지는 손대지 않는 것이 맞다.
//
// 왜 갈래를 «강제»하지 않는가: 앤트로픽 상업 약관이 못박았다 —
// 「The Claude Code binary must not be modified … customers may not remove, disable, or restrict
//  any authentication method built into it」. 그래서 «API 키만 쓰게» 좁히지 않는다.
// 사용자의 요구가 애초에 «물어본다»인 것이 다행이다.
//
// 키는 이 파일 밖으로 나가지 않는다. 화면에 내려 주는 것은 view() 이고 거기에 키가 없다.
// 브리지 모드에서 이 파일은 사용자 PC 에만 있다 — 판매자 서버가 남의 키를 쥐지 않는다.

import { join } from 'node:path';
import { DATA_DIR, readJson, writeJson } from './store.mjs';

const FILE = () => join(DATA_DIR, 'auth.json');

export const MODES = ['auto', 'sub', 'api'];

export function read() {
  const v = readJson(FILE(), null) || {};
  return {
    mode: MODES.includes(v.mode) ? v.mode : 'auto',
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
  };
}

export function write(next = {}) {
  const now = read();
  const mode = MODES.includes(next.mode) ? next.mode : now.mode;
  // 키는 «안 보내면 그대로», «빈 값을 보내면 지운다».
  const apiKey = next.apiKey === undefined ? now.apiKey : String(next.apiKey || '').trim();
  writeJson(FILE(), { mode, apiKey });
  return view();
}

// 화면에 내려 주는 꼴 — 키는 절대 돌려주지 않는다. 들어 있는지만 이른다.
export function view() {
  const a = read();
  return { mode: a.mode, hasKey: !!a.apiKey, modes: MODES };
}

// 「API 로 갈아탄다」가 실제로 될 형편인가 — 키가 없으면 고를 수 없다.
export function canApi() {
  return !!read().apiKey;
}
