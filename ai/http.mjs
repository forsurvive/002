// Provider 어댑터가 함께 쓰는 HTTP 도구 — SSE 읽기 · 시간 상한과 취소. I/O 는 fetch 가 하고 여기는 모양만 다룬다.

// SSE 한 덩이씩 — «event: …» / «data: {…}» 줄을 모아 빈 줄에서 끊는다. data 가 JSON 이 아니면 건너뛴다.
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buf = '';
  const take = function* () {
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* 깨진 덩이는 건너뛴다 */ }
    }
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    yield* take();
  }
  buf += '\n\n';
  yield* take();
}

// 사람이 세운 것(signal)과 시간이 넘친 것(timeoutMs)을 한 AbortController 로 묶는다.
export function deadline(signal, timeoutMs) {
  const ctl = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => { state.timedOut = true; ctl.abort(); }, Math.max(1000, Number(timeoutMs) || 30 * 60 * 1000));
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctl.signal, state,
    done() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); },
  };
}

export const retryAfterOf = (res) => {
  const v = Number(res && res.headers && res.headers.get && res.headers.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? v * 1000 : 0;
};

// 연결 실패의 갈래 이름만(오류 이름 · 원인 코드) — 원문 문구에는 주소 · 헤더 값이 섞일 수 있어 싣지 않는다.
export const netDetail = (e) => [e && e.name, e && e.cause && e.cause.code].filter((x) => x && /^[A-Za-z0-9_]+$/.test(String(x))).join(' ') || 'network';

export const headerOf = (res, name) => (res && res.headers && res.headers.get && res.headers.get(name)) || '';

// «한 번에 못 받는다»는 거절에서 숫자만 꺼낸다 — 보낸 토큰 수와 받을 수 있는 수(원문 문구는 싣지 않는다).
//   Anthropic «prompt is too long: 1234567 tokens > 1000000 maximum» · OpenAI «maximum context length is 128000 tokens … resulted in 130000 tokens»
//   Gemini «input token count (1234567) exceeds the maximum number of tokens allowed (1048576)» — 큰 쪽이 보낸 수, 작은 쪽이 받을 수 있는 수.
// 나눠 읽기(core/generation/reading.mjs)가 이 비율로 «원문 그대로 남길 수 있는 만큼»을 셈한다. 숫자가 둘이 아니면 null.
export function fitOf(message) {
  const nums = (String(message || '').match(/\d[\d,]{3,}/g) || []).map((x) => Number(x.replace(/,/g, ''))).filter((n) => Number.isFinite(n) && n >= 1000);
  if (nums.length < 2) return null;
  const tokens = Math.max(...nums); const max = Math.min(...nums);
  return tokens > max ? { tokens, max } : null;
}

// 화면으로 올리는 문구는 갈래마다 고정 — provider 원문(원고 · 키가 섞일 수 있음)을 싣지 않는다.
export const SAY = {
  auth: 'AI 연결 정보를 확인해야 합니다', credit: 'AI 사용 잔액이 모자랍니다', rate: '잠시 밀렸습니다',
  overloaded: 'AI 쪽이 잠시 붐빕니다', model: '그 모델을 쓸 수 없습니다', invalid: '요청을 처리하지 못했습니다(입력이 너무 길 수 있습니다)',
  safety: 'AI 가 이 요청을 거절했습니다', timeout: '응답 없음', stopped: '중지됨', empty: '빈 응답', other: 'AI 호출에 실패했습니다',
};
