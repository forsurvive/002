// 콘솔 가리기 — 로그에 키 · 비밀값이 새지 않게(ARCHITECTURE_TARGET §8 · CLAUDE.md 원칙 5).
// 코드가 처음부터 키를 찍지 않는 것이 첫 울타리이고, 이것은 실수로 섞여 든 것을 지우는 둘째 울타리다.

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***'],
  [/sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, 'sk-***'],
  [/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***'],
  [/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  [/((?:x-api-key|x-goog-api-key|api[_-]?key|authorization|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, '$1***'],
  [/(CREDENTIALS_KEY_V\d+\s*=\s*)\S+/g, '$1***'],
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1***@'],
];

export function redact(s) {
  let out = String(s);
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

// console.log · warn · error 를 한 번 감싼다(여러 번 불러도 한 겹)
export function guardConsole(c = console) {
  if (c.__redacted) return;
  for (const k of ['log', 'warn', 'error', 'info']) {
    const orig = c[k].bind(c);
    c[k] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? redact(a) : a instanceof Error ? redact(a.stack || a.message) : a)));
  }
  c.__redacted = true;
}
