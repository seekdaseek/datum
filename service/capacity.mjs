//
// service/capacity.mjs — never start the prover into an OOM.
//
// The proof server peaks at 454 MB on the VPS (measured, one worker, one
// thread). The host must keep at least 500 MB available for its live
// services. So before datum-prover is started for a job, MemAvailable must be
// at least 954 MB, rounded to NEED_MB = 950 as agreed. If it is not, the job
// waits in a visible "waiting for capacity" state and re-reads every 30 s for
// up to 10 minutes, then fails cleanly with that reason.
//
// Everything that touches the host is injected, so the test drives it with a
// faked MemAvailable and a fake clock.
//
import { readFileSync } from 'node:fs';

export const PROVER_PEAK_MB = 454;
export const FLOOR_MB = 500;
export const NEED_MB = 950;
export const RETRY_MS = 30_000;
export const GIVE_UP_MS = 10 * 60_000;

/** MemAvailable in MB from /proc/meminfo, or null where there is no such file (macOS). */
export const readMemAvailableMB = (path = '/proc/meminfo') => {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync(path, 'utf8'));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
};

export class NoCapacityError extends Error {}

/**
 * Resolve once MemAvailable >= needMB. Calls onWait(availableMB, waitedMs)
 * each time it has to wait. Rejects with NoCapacityError after giveUpMs.
 * A null reading (no /proc/meminfo) means the gate does not apply.
 */
export const waitForCapacity = async ({
  readMB = readMemAvailableMB,
  needMB = NEED_MB,
  retryMs = RETRY_MS,
  giveUpMs = GIVE_UP_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  onWait = () => {},
} = {}) => {
  let waited = 0;
  for (;;) {
    const mb = readMB();
    if (mb === null || mb >= needMB) return { availableMB: mb, waitedMs: waited };
    if (waited >= giveUpMs) {
      throw new NoCapacityError(
        `waiting for capacity: the host had ${mb} MB available for ${Math.round(waited / 60_000)} minutes, and the prover needs ${needMB} MB (its ${PROVER_PEAK_MB} MB peak plus the ${FLOOR_MB} MB kept for other services). Try again later.`,
      );
    }
    onWait(mb, waited);
    await sleep(retryMs);
    waited += retryMs;
  }
};

/**
 * Make sure the proof server answers, starting it only when there is room.
 *   healthy(): Promise<boolean>   is the proof server answering?
 *   start():   Promise<void>      start it (pm2 start datum-prover)
 * Returns { started, availableMB }. If it is not running and capacity never
 * comes, rejects with NoCapacityError and start() is never called.
 */
export const ensureProver = async ({ healthy, start, waitForUp = 60, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...gate }) => {
  if (await healthy()) return { started: false, availableMB: null };
  const { availableMB } = await waitForCapacity({ sleep, ...gate });
  await start();
  for (let i = 0; i < waitForUp; i++) {
    if (await healthy()) return { started: true, availableMB };
    await sleep(1000);
  }
  throw new Error('the proof server did not start');
};
