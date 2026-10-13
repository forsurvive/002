'use strict';

// 무엇으로 돈이 나가는가 — 사람이 고른다.
//
// 세 갈래다.
//   auto : 아무것도 손대지 않는다(지금까지의 거동). 사용자 PC 의 환경이 정하는 대로 간다.
//   sub  : 구독으로만 돈다 — 물려받은 ANTHROPIC_API_KEY 를 지워 종량 과금으로 새는 것을 막는다.
//   api  : 여기 담아 둔 키로 돈다 — 구독 한도를 다 썼을 때 갈아타는 자리.
//   chatgpt : 클로드가 아니라 ChatGPT 구독으로 돈다 — 그 PC 에 로그인한 Codex CLI(tools/codex-cli.mjs, 2026-10-13 사용자 지시).
//             chatgptModel — 고른 모델(Codex 제 목록의 이름). 비면 Codex 의 기본.
//   gemini  : Gemini API 키로 돈다(2026-10-13 사용자 결정 «제미니 구독은 API키로» — Google 계정 로그인은 약관 문제로 쓰지 않는다).
//             geminiKey — 키(이 파일 밖으로 나가지 않는다) · geminiModel — 카탈로그(config/models.json)의 등급(high_reasoning · balanced · fast).
//   openai  : ChatGPT API 키로 돈다(2026-10-13 «챗 지피티 api 간편 등록도») — openaiKey · openaiModel(등급). 구독(chatgpt)과 달리 키 주인에게 종량으로 나간다.
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
// 이 파일은 폴더의 data\ 안에 있다 — **폴더를 옮기면 키도 함께 간다.** 남에게 줄 USB 라면 먼저 [키 지우기].

import { join } from 'node:path';
import { DATA_DIR, readJson, writeJson } from './store.mjs';

const FILE = () => join(DATA_DIR, 'auth.json');

export const MODES = ['auto', 'sub', 'api', 'chatgpt', 'gemini', 'openai'];
export const GEMINI_TIERS = ['high_reasoning', 'balanced', 'fast'];
const TIERS = GEMINI_TIERS;   // 카탈로그의 등급 — Gemini · ChatGPT API 키가 함께 쓴다
const SLUG = /^[A-Za-z0-9._-]{1,80}$/;

export function read() {
  const v = readJson(FILE(), null) || {};
  return {
    mode: MODES.includes(v.mode) ? v.mode : 'auto',
    apiKey: typeof v.apiKey === 'string' ? v.apiKey : '',
    chatgptModel: SLUG.test(String(v.chatgptModel || '')) ? String(v.chatgptModel) : '',
    geminiKey: typeof v.geminiKey === 'string' ? v.geminiKey : '',
    geminiModel: TIERS.includes(v.geminiModel) ? v.geminiModel : 'balanced',
    openaiKey: typeof v.openaiKey === 'string' ? v.openaiKey : '',
    openaiModel: TIERS.includes(v.openaiModel) ? v.openaiModel : 'balanced',
  };
}

export function write(next = {}) {
  const now = read();
  const mode = MODES.includes(next.mode) ? next.mode : now.mode;
  // 키는 «안 보내면 그대로», «빈 값을 보내면 지운다».
  const apiKey = next.apiKey === undefined ? now.apiKey : String(next.apiKey || '').trim();
  const geminiKey = next.geminiKey === undefined ? now.geminiKey : String(next.geminiKey || '').trim();
  // 모델은 아는 꼴만 받는다 — 모르는 것이 오면 지금 값을 지킨다(빈 값은 «기본으로»)
  const chatgptModel = next.chatgptModel === undefined ? now.chatgptModel
    : next.chatgptModel === '' ? '' : SLUG.test(String(next.chatgptModel)) ? String(next.chatgptModel) : now.chatgptModel;
  const geminiModel = TIERS.includes(next.geminiModel) ? next.geminiModel : now.geminiModel;
  const openaiKey = next.openaiKey === undefined ? now.openaiKey : String(next.openaiKey || '').trim();
  const openaiModel = TIERS.includes(next.openaiModel) ? next.openaiModel : now.openaiModel;
  writeJson(FILE(), { mode, apiKey, chatgptModel, geminiKey, geminiModel, openaiKey, openaiModel });
  return view();
}

// 화면에 내려 주는 꼴 — 키는 절대 돌려주지 않는다. 들어 있는지만 이른다.
export function view() {
  const a = read();
  return { mode: a.mode, hasKey: !!a.apiKey, modes: MODES, chatgptModel: a.chatgptModel, hasGeminiKey: !!a.geminiKey, geminiModel: a.geminiModel, hasOpenaiKey: !!a.openaiKey, openaiModel: a.openaiModel };
}

// 「API 로 갈아탄다」가 실제로 될 형편인가 — 키가 없으면 고를 수 없다.
export function canApi() {
  return !!read().apiKey;
}
