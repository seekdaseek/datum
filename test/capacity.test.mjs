import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { waitForCapacity, ensureProver, readMemAvailableMB, NoCapacityError, NEED_MB, RETRY_MS, GIVE_UP_MS } from '../service/capacity.mjs';

// A fake clock: sleep() records the wait and returns at once.
const clock = () => {
  const slept = [];
  return { slept, sleep: async (ms) => { slept.push(ms); } };
};
// A faked MemAvailable that returns the given readings in order, then repeats the last.
const readings = (...mb) => { let i = 0; return () => mb[Math.min(i++, mb.length - 1)]; };

describe('CAPACITY: the prover is never started into an OOM', () => {
  test('the bar is the prover peak plus the floor kept for other services', () => {
    assert.equal(NEED_MB, 950);
    assert.equal(RETRY_MS, 30_000);
    assert.equal(GIVE_UP_MS, 600_000);
  });

  test('enough memory: starts at once, no waiting', async () => {
    const c = clock();
    const r = await waitForCapacity({ readMB: readings(1800), sleep: c.sleep });
    assert.equal(r.availableMB, 1800);
    assert.deepEqual(c.slept, []);
  });

  test('visum’s sandbox is up (820 MB): the job waits, re-reads every 30 s, and starts when memory returns', async () => {
    const c = clock();
    const waits = [];
    const r = await waitForCapacity({ readMB: readings(820, 830, 949, 1600), sleep: c.sleep, onWait: (mb, ms) => waits.push([mb, ms]) });
    assert.equal(r.availableMB, 1600);
    assert.deepEqual(c.slept, [30_000, 30_000, 30_000]);
    assert.deepEqual(waits, [[820, 0], [830, 30_000], [949, 60_000]], '949 MB is still one short of the bar');
    assert.equal(r.waitedMs, 90_000);
  });

  test('no capacity for ten minutes: the job fails cleanly with the reason, and never starts the prover', async () => {
    const c = clock();
    await assert.rejects(
      waitForCapacity({ readMB: readings(700), sleep: c.sleep }),
      (e) => e instanceof NoCapacityError && /waiting for capacity: the host had 700 MB available for 10 minutes/.test(e.message),
    );
    assert.equal(c.slept.length, 20, 'twenty 30-second waits make ten minutes');
  });

  test('MemAvailable is read from /proc/meminfo in MB; a host without it is not gated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'datum-meminfo-'));
    const f = join(dir, 'meminfo');
    writeFileSync(f, 'MemTotal:        3900560 kB\nMemFree:          351232 kB\nMemAvailable:     839680 kB\n');
    assert.equal(readMemAvailableMB(f), 820);
    assert.equal(readMemAvailableMB(join(dir, 'missing')), null);
  });
});

describe('CAPACITY: ensureProver starts the proof server only when there is room', () => {
  test('already running: no capacity check, no start', async () => {
    let starts = 0;
    const r = await ensureProver({ healthy: async () => true, start: async () => { starts++; }, readMB: () => 100, sleep: async () => {} });
    assert.deepEqual(r, { started: false, availableMB: null });
    assert.equal(starts, 0);
  });

  test('stopped and room available: started once, then answers', async () => {
    let starts = 0;
    let up = false;
    const r = await ensureProver({ healthy: async () => up, start: async () => { starts++; up = true; }, readMB: () => 1600, sleep: async () => {} });
    assert.equal(r.started, true);
    assert.equal(starts, 1);
  });

  test('stopped and no room for ten minutes: the prover is NEVER started', async () => {
    let starts = 0;
    await assert.rejects(
      ensureProver({ healthy: async () => false, start: async () => { starts++; }, readMB: () => 820, sleep: async () => {} }),
      NoCapacityError,
    );
    assert.equal(starts, 0);
  });
});
