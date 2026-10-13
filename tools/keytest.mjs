// 붙여 넣은 API 키가 맞는가 — 값이 들지 않는 목록 문(모델 목록)을 한 번 두드려 본다(docs/PERSONAL_USB.md §8-4).
// Claude: GET api.anthropic.com/v1/models (x-api-key) · Gemini: GET generativelanguage.googleapis.com/v1beta/models (x-goog-api-key) · ChatGPT: GET api.openai.com/v1/models (Bearer).
// 키는 헤더에만 싣는다(주소 · 기록에 남지 않게). 돌려주는 것은 갈래뿐 — 회사의 오류 원문은 화면에 올리지 않는다.

const ASK = {
  claude: (key) => ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }],
  gemini: (key) => ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key }],
  openai: (key) => ['https://api.openai.com/v1/models', { authorization: 'Bearer ' + key }],
};

// 키 앞머리로 회사를 알아본다 — Claude sk-ant- · Gemini AIza · ChatGPT sk-(sk-proj- 등 — Claude 를 먼저 본다)
export const keyCompany = (key) => (/^sk-ant-/.test(key) ? 'claude' : /^AIza/.test(key) ? 'gemini' : /^sk-/.test(key) ? 'openai' : '');
// 붙여 넣은 글에서 빈칸 · 보이지 않는 글자 · 감싼 따옴표를 걷는다
export const cleanKey = (t) => String(t || '').replace(/[\s​-‍⁠﻿]/g, '').replace(/^["'`]+|["'`]+$/g, '');

export async function testKey(which, key, { fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  if (!ASK[which] || !key) return { verified: false, reason: 'empty' };
  const [url, headers] = ASK[which](key);
  try {
    const r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) return { verified: true };
    if (r.status === 400 || r.status === 401 || r.status === 403) return { verified: false, reason: 'invalid' };
    if (r.status === 429) return { verified: true, reason: 'busy' };   // 키는 맞다 — 잠깐 밀렸을 뿐
    return { verified: false, reason: 'service' };
  } catch {
    return { verified: false, reason: 'network' };
  }
}
