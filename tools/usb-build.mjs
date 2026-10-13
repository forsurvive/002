// USB 휴대판 만들기 — 앱 · 휴대용 Node(윈도우 x64) · Claude Code(윈도우 x64)를 한 폴더에 담는다(docs/PERSONAL_USB.md §4).
//   node tools/usb-build.mjs --out <USB 의 폴더>                # 처음 만들기 · 업데이트(같은 명령)
//   node tools/usb-build.mjs --out <USB 의 폴더> --node v22.23.3 --claude 2.1.296
//   node tools/usb-build.mjs --out <USB 의 폴더> --skip-download  # 앱 파일만 바꾼다(동봉물은 그대로)
//   node tools/usb-build.mjs --out <USB 의 폴더> --with-codex     # ChatGPT 구독 길(Codex CLI)도 담는다 — 한 번 담으면 업데이트 때 함께 바뀐다
// 받는 곳은 둘뿐이다 — Node 는 nodejs.org 의 배포 폴더(SHASUMS256.txt 의 sha256 과 맞춰 본다),
// Claude Code 는 앤트로픽이 npm 에 올린 윈도우 패키지 @anthropic-ai/claude-code-win32-x64(레지스트리가 적은 sha512 와 맞춰 본다).
// 맞지 않으면 쓰지 않고 멈춘다. data/ 는 읽지도 쓰지도 않는다 — 원고는 이 도구가 건드리지 않는다.
// 콘솔은 ASCII 만.

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeText } from './store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

export const DEFAULT_NODE = 'v22.23.3';            // 2026-09-23 의 Node 22 LTS(nodejs.org/dist/index.json)
export const CLAUDE_PKG = '@anthropic-ai/claude-code-win32-x64';
export const MANIFEST = '.usb-build.json';

// 담을 앱 파일 — **개인판이 실제로 쓰는 것만**(사용자 지시, 2026-10-13 «결제 관련한 부가적인 기능들은 삭제해서»).
// 폴더를 통째로 옮기지 않고 실행기 · 서버에서 출발해 import 를 따라간 모듈만 담는다 — 그래서 온라인판의 계정 · 유료 서비스 ·
// 운영 화면(web/account · manage · login · school · 약관 · 소개)과 온라인 어댑터(ai/router · anthropic …) · 온라인 문서는
// USB 에 실리지 않는다. 저장소에서는 지우지 않는다(온라인 앱들이 쓰고, 그 시험이 지킨다).
// 시험(tools/test.mjs — 저장소 전체를 본다)과 온라인판(online/ · migrations/)도 싣지 않는다.
const TOP_FILES = ['스토리 엔진 개인판.cmd', 'README.md', 'DESIGN.md', '기획서.md'];
const ENTRIES = ['tools/server.mjs', 'tools/launch.mjs', 'tools/usb-build.mjs'];
// 모듈이 읽는 자료(import 가 아니라 파일로 읽는다)와 휴대판 안내
const DATA = ['tools/prompts.data.json', 'tools/books', 'config/workflows', 'docs/PERSONAL_USB.md', 'docs/WORKFLOW.md'];

// 상대 경로 import(정적 · 동적) 만 따라간다. 서버가 «바깥에 열고 DB 가 있을 때만» 부르는 온라인판(new URL('../online/…'))은 따라가지 않는다 —
// 실행기가 늘 127.0.0.1 로 띄우므로 그 길이 열리지 않는다.
export function moduleClosure(root = ROOT, entries = ENTRIES) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const rel = stack.pop();
    if (seen.has(rel)) continue;
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) continue;
    seen.add(rel);
    const text = readFileSync(abs, 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const parts = (rel.split('/').slice(0, -1).join('/') + '/' + m[1]).split('/');
      const outp = [];
      for (const x of parts) { if (x === '..') outp.pop(); else if (x && x !== '.') outp.push(x); }
      stack.push(outp.join('/'));
    }
  }
  return [...seen].sort();
}

// 화면 — 개인판의 첫 화면(index.html)과 그것이 부르는 파일만(화면 스크립트는 import 없이 차례로 읽힌다)
export function webFiles(root = ROOT) {
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^":?#]+)"/g)].map((m) => m[1]).filter((f) => !f.startsWith('/') && existsSync(join(root, 'web', f)));
  return ['web/index.html', ...new Set(refs.map((f) => 'web/' + f))];
}

export function appFiles(root = ROOT) {
  const out = [];
  for (const f of TOP_FILES) if (existsSync(join(root, f))) out.push(f);
  const walk = (rel) => {
    const abs = join(root, ...rel.split('/'));
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) { for (const n of readdirSync(abs).sort()) walk(rel + '/' + n); return; }
    if (/\.tmp$/.test(rel)) return;
    out.push(rel);
  };
  for (const d of DATA) walk(d);
  out.push(...moduleClosure(root), ...(existsSync(join(root, 'web', 'index.html')) ? webFiles(root) : []));
  return [...new Set(out)];
}

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// SHASUMS256.txt 에서 한 파일의 해시를 찾는다(«<hex>  win-x64/node.exe»)
export function shaFromSums(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === name) return m[1];
  }
  return '';
}

// npm 의 integrity(«sha512-<base64>»)와 맞춰 본다
export function integrityOk(buf, integrity) {
  const m = String(integrity || '').match(/^sha512-(.+)$/);
  return !!m && createHash('sha512').update(buf).digest('base64') === m[1];
}

// tar(ustar) 의 파일을 차례로 꺼낸다 — npm 묶음은 package/ 밑에 있다. pax 머리(x · g)와 GNU 긴 이름(L)을 읽는다.
export function* untarEntries(tar) {
  let off = 0;
  let longName = '';
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    const name = longName || (prefix ? prefix + '/' : '') + str(0, 100);
    longName = '';
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x' || type === 'g') {
      const pm = body.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      if (pm && type === 'x') longName = pm[1];
      continue;
    }
    if (type === '0' || type === '\0') yield { name, body };
  }
}

export function untarOne(tar, want) {
  for (const e of untarEntries(tar)) if (e.name === want) return Buffer.from(e.body);
  return null;
}

async function get(url, as = 'buffer') {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return as === 'text' ? r.text() : as === 'json' ? r.json() : Buffer.from(await r.arrayBuffer());
}

// 큰 실행 파일 — 임시 이름으로 다 쓴 뒤 갈아끼운다(도중에 뽑혀도 반쪽 exe 가 남지 않게)
function putBinary(file, buf) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, buf);
  renameSync(tmp, file);
}

const same = (file, hex) => existsSync(file) && sha256(readFileSync(file)) === hex;

export async function fetchNode(out, ver, log) {
  const base = 'https://nodejs.org/dist/' + ver + '/';
  const want = shaFromSums(await get(base + 'SHASUMS256.txt', 'text'), 'win-x64/node.exe');
  if (!want) throw new Error('win-x64/node.exe not listed in SHASUMS256.txt for ' + ver);
  const file = join(out, 'tools', 'node', 'node.exe');
  if (same(file, want)) { log('  node.exe ' + ver + ' already in place (sha256 ok)'); return { version: ver, sha256: want }; }
  log('  Downloading ' + base + 'win-x64/node.exe');
  const buf = await get(base + 'win-x64/node.exe');
  if (sha256(buf) !== want) throw new Error('sha256 mismatch for node.exe - not written');
  putBinary(file, buf);
  log('  node.exe ' + ver + ' written (sha256 ' + want.slice(0, 16) + '...)');
  return { version: ver, sha256: want };
}

export async function fetchClaude(out, ver, log, prev = null) {
  const meta = await get('https://registry.npmjs.org/' + CLAUDE_PKG + '/' + encodeURIComponent(ver), 'json');
  const dist = meta && meta.dist;
  if (!dist || !dist.tarball || !dist.integrity) throw new Error('registry did not give a tarball for ' + CLAUDE_PKG + '@' + ver);
  const file = join(out, 'tools', 'claude', 'claude.exe');
  // 지난번에 담은 것과 같은 판이고 파일도 그대로면 다시 받지 않는다(묶음이 크다)
  if (prev && prev.version === meta.version && prev.integrity === dist.integrity && prev.sha256 && same(file, prev.sha256)) {
    log('  claude.exe ' + meta.version + ' already in place (sha256 ok)');
    return prev;
  }
  log('  Downloading ' + dist.tarball);
  const tgz = await get(dist.tarball);
  if (!integrityOk(tgz, dist.integrity)) throw new Error('sha512 mismatch for ' + CLAUDE_PKG + ' - not written');
  const exe = untarOne(gunzipSync(tgz), 'package/claude.exe');
  if (!exe) throw new Error('claude.exe not found in the package');
  const hex = sha256(exe);
  if (same(file, hex)) log('  claude.exe ' + meta.version + ' already in place');
  else { putBinary(file, exe); log('  claude.exe ' + meta.version + ' written'); }
  return { version: meta.version, integrity: dist.integrity, sha256: hex };
}

// ChatGPT 구독 길(docs/PERSONAL_USB.md §8)을 쓸 때만 — `--with-codex`. OpenAI 가 npm 에 올린 @openai/codex 의 윈도우 판
// (dist-tag win32-x64 → «<판>-win32-x64»)에서 vendor/x86_64-pc-windows-msvc/ 를 통째로 tools/codex/ 에 푼다(bin/codex.exe 와 곁 파일).
export const CODEX_PKG = '@openai/codex';
const CODEX_DIR = 'package/vendor/x86_64-pc-windows-msvc/';
export async function fetchCodex(out, ver, log, prev = null) {
  const spec = ver === 'latest' ? 'win32-x64' : /-win32-x64$/.test(ver) ? ver : ver + '-win32-x64';
  const meta = await get('https://registry.npmjs.org/' + CODEX_PKG + '/' + encodeURIComponent(spec), 'json');
  const dist = meta && meta.dist;
  if (!dist || !dist.tarball || !dist.integrity) throw new Error('registry did not give a tarball for ' + CODEX_PKG + '@' + spec);
  const exe = join(out, 'tools', 'codex', 'bin', 'codex.exe');
  if (prev && prev.version === meta.version && prev.integrity === dist.integrity && prev.sha256 && same(exe, prev.sha256)) {
    log('  codex.exe ' + meta.version + ' already in place (sha256 ok)');
    return prev;
  }
  log('  Downloading ' + dist.tarball);
  const tgz = await get(dist.tarball);
  if (!integrityOk(tgz, dist.integrity)) throw new Error('sha512 mismatch for ' + CODEX_PKG + ' - not written');
  let n = 0, hex = '';
  for (const e of untarEntries(gunzipSync(tgz))) {
    if (!e.name.startsWith(CODEX_DIR)) continue;
    const rel = e.name.slice(CODEX_DIR.length);
    if (!rel || rel.split('/').some((x) => x === '..' || x === '')) continue;   // 묶음 밖으로 나가는 이름은 받지 않는다
    putBinary(join(out, 'tools', 'codex', ...rel.split('/')), Buffer.from(e.body));
    if (rel === 'bin/codex.exe') hex = sha256(e.body);
    n++;
  }
  if (!hex) throw new Error('codex.exe not found in the package');
  log('  codex ' + meta.version + ' written (' + n + ' files)');
  return { version: meta.version, integrity: dist.integrity, sha256: hex };
}

// 앱 파일을 옮겨 적는다. 지난번에 적은 것 가운데 이번에 없는 것(지워진 코드)은 걷는다 — 지난 목록(MANIFEST)에 있던 것만.
export function copyApp(out, { root = ROOT, log = () => {} } = {}) {
  const files = appFiles(root);
  const prev = (() => { try { return JSON.parse(readFileSync(join(out, MANIFEST), 'utf8')).files || []; } catch { return []; } })();
  for (const f of files) {
    const from = join(root, ...f.split('/'));
    const to = join(out, ...f.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    const buf = readFileSync(from);
    if (existsSync(to) && readFileSync(to).equals(buf)) continue;
    putBinary(to, buf);
  }
  let removed = 0;
  for (const f of prev) {
    if (files.includes(f) || f.startsWith('data/')) continue;
    const to = join(out, ...f.split('/'));
    if (existsSync(to)) { rmSync(to, { force: true }); removed++; }
  }
  log('  App files: ' + files.length + ' in place' + (removed ? ', ' + removed + ' old file(s) removed' : ''));
  return files;
}

function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip-download') o.skip = true;
    else if (a === '--with-codex') o.codex = 'latest';
    else if (a.startsWith('--')) o[a.slice(2)] = argv[++i];
  }
  return o;
}

async function main() {
  const log = (s) => console.log(s);
  const o = args(process.argv.slice(2));
  if (!o.out) {
    log('Usage: node tools/usb-build.mjs --out <folder on the USB stick> [--node ' + DEFAULT_NODE + '] [--claude latest|<version>] [--with-codex] [--codex-version <version>] [--skip-download]');
    process.exit(2);
  }
  const out = resolve(o.out);
  const rel = relative(ROOT, out);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    log('  [STOP] --out must be outside this repository folder');
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  log('  Story Engine USB build -> ' + out.replace(/[^\x20-\x7e]/g, '?'));
  const files = copyApp(out, { log });
  const prev = (() => { try { return JSON.parse(readFileSync(join(out, MANIFEST), 'utf8')); } catch { return {}; } })();
  let node = prev.node || null, claude = prev.claude || null, codex = prev.codex || null;
  if (!o.skip) {
    try {
      node = await fetchNode(out, o.node || DEFAULT_NODE, log);
      claude = await fetchClaude(out, o.claude || 'latest', log, prev.claude);
      if (o.codex || o['codex-version'] || prev.codex) codex = await fetchCodex(out, o['codex-version'] || 'latest', log, prev.codex);
    } catch (e) {
      log('  [ERROR] ' + String((e && e.message) || e).replace(/[^\x20-\x7e]/g, '?'));
      log('  Nothing half-written was kept. Check the network and run the same command again.');
      process.exit(1);
    }
  }
  writeText(join(out, MANIFEST), JSON.stringify({ builtAt: new Date().toISOString(), node, claude, codex, files }, null, 1));
  log('');
  log('  Done. On any Windows PC: open the folder and double-click the .cmd file.');
  log('  Node   : ' + (node ? node.version : 'not bundled (PATH node will be used)'));
  log('  Claude : ' + (claude ? claude.version : 'not bundled (installed on first run)'));
  if (codex) log('  Codex  : ' + codex.version + ' (ChatGPT subscription)');
  log('  data\\ was not touched.');
}

if (process.argv[1] && process.argv[1].endsWith('usb-build.mjs')) await main();
