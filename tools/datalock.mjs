// 자료 상자 잠금 — 같은 data/ 를 두 곳에서 동시에 열지 않게(docs/PERSONAL_USB.md §3).
// USB 를 이 PC 에서 뽑아 저 PC 에 꽂는 사이, 또는 동기화 폴더 · 공유 폴더에 둔 상자를 두 PC 가 함께 열면
// 메모리가 정본인 두 서버가 서로의 저장을 통째로 덮어쓴다. 그래서 상자에 «지금 누가 열었는가»를 적어 둔다.
//   data/.lock = { host, pid, at } — 열어 둔 동안 1분마다 at 을 새로 적는다(숨 쉬기).
//   · 다른 PC 의 잠금이 3분 넘게 숨을 쉬지 않았으면 버려진 것으로 본다(USB 를 켠 채 뽑은 때).
//   · 같은 PC 의 잠금은 그 pid 가 살아 있고 숨도 쉬고 있을 때만 막는다.
// 파일 · 시각 · 이름을 바깥에서 받는 순수한 판정(judge)과, 그것을 실제 파일에 거는 자리(acquire)를 나눈다 — 시험이 판정을 그대로 돌린다.

import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { writeJson } from './store.mjs';

export const LOCK_NAME = '.lock';
export const STALE_MS = 3 * 60 * 1000;
export const BEAT_MS = 60 * 1000;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
};

// 잠금 하나를 읽고 «들어가도 되는가»를 말한다. 들어가면 안 될 때 who 에 그 잠금을 돌려준다.
export function judge(lock, me, now, isAlive = alive) {
  if (!lock || typeof lock !== 'object' || !lock.host) return { ok: true };
  const stale = !(now - Number(lock.at || 0) < STALE_MS);
  if (lock.host === me.host) {
    // 숨이 끊긴 잠금도 버려진 것이다 — 꺼진 창의 pid 를 다른 프로그램이 물려받아 «살아 있는» 것처럼 보일 수 있다
    if (lock.pid === me.pid || stale || !isAlive(lock.pid)) return { ok: true, took: lock.pid !== me.pid };
    return { ok: false, who: lock, same: true };
  }
  if (stale) return { ok: true, took: true, stale: true };
  return { ok: false, who: lock, same: false };
}

const readLock = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

export function acquire(dir, { host = hostname(), pid = process.pid, now = Date.now } = {}) {
  const file = join(dir, LOCK_NAME);
  const me = { host, pid };
  const r = judge(readLock(file), me, now());
  if (!r.ok) return r;
  const beat = () => { try { writeJson(file, { host, pid, at: now() }); } catch {} };
  beat();
  const timer = setInterval(beat, BEAT_MS);
  timer.unref();
  // 내 잠금일 때만 걷는다 — 그새 다른 PC 가 버려진 것으로 보고 가져갔으면 손대지 않는다
  const release = () => {
    clearInterval(timer);
    const cur = readLock(file);
    if (cur && cur.host === host && cur.pid === pid) { try { rmSync(file, { force: true }); } catch {} }
  };
  return { ok: true, took: r.took, stale: r.stale, release };
}
