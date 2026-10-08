import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { verifyVenueSlot, normaliseUp, normaliseDown } from '../scripts/provenance.mjs';

// ---------------------------------------------------------------------------
// Offline replay of real Base mainnet RPC traffic, recorded by
// scripts/record-fixtures.mjs. The verifier runs its real code path against
// those recorded answers; a request the tape has never seen fails loudly
// rather than reaching the network.
// ---------------------------------------------------------------------------
const fx = JSON.parse(readFileSync(new URL('./fixtures/base-aero-usdc.json', import.meta.url)));
const revive = (o) =>
  Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1))
        : typeof v === 'string' && /^0x[0-9a-f]*$/i.test(v) && (k === 'pool' || k === 'syncTx') ? Uint8Array.from(v.slice(2).match(/../g).map((h) => parseInt(h, 16)))
        : v,
    ]),
  );
const honest = revive(fx.honestSlot);

/** A fetch that answers from the tape. `override(method, params, result)` may rewrite an answer. */
const replay = (override = (_m, _p, r) => r) => async (_url, init) => {
  const { method, params } = JSON.parse(init.body);
  const key = JSON.stringify([method, params]);
  if (!(key in fx.tape)) throw new Error(`fixture tape has no answer for ${key}`);
  const result = override(method, params, fx.tape[key]);
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
};

const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

describe('venue provenance: an honest slot', () => {
  test('passes every check against the source chain', async () => {
    const r = await verifyVenueSlot(honest, { fetchImpl: replay() });
    assert.deepEqual(failed(r), []);
    assert.equal(r.ok, true);
    assert.equal(r.checks.length, 12);
  });
});

describe('TAMPER: a published copy with one reserve changed', () => {
  test('one reserve changed reads MISMATCH, and only on that reserve', async () => {
    const tampered = { ...honest, reserveY: honest.reserveY + 1n };
    const r = await verifyVenueSlot(tampered, { fetchImpl: replay() });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['reserveY matches the log (normalised, rounded down)']);
  });

  test('the collateral reserve is checked too', async () => {
    const r = await verifyVenueSlot({ ...honest, reserveX: honest.reserveX - 1n }, { fetchImpl: replay() });
    assert.deepEqual(failed(r), ['reserveX matches the log (normalised, rounded up)']);
  });

  test('a cited log index that holds no Sync is rejected', async () => {
    const r = await verifyVenueSlot({ ...honest, logIndex: honest.logIndex + 100000n }, { fetchImpl: replay() });
    assert.deepEqual(failed(r), ['cited Sync log exists at (syncBlock, logIndex)']);
  });
});

describe('CHERRY-PICK: a real but older Sync, from when the pool looked different', () => {
  // Every number in this slot is genuine: a real Sync log, real reserves, the
  // real transaction. Only the moment is wrong — 85 later Syncs happened
  // before the reference block. This is the case binding txHash + logIndex
  // alone does not catch.
  const c = fx.cherry;
  const r0 = BigInt(c.reserve0);
  const r1 = BigInt(c.reserve1);
  const cherry = {
    ...honest,
    syncBlock: BigInt(c.syncBlock.slice(0, -1)),
    logIndex: BigInt(c.logIndex.slice(0, -1)),
    syncTx: Uint8Array.from(c.syncTx.slice(2).match(/../g).map((h) => parseInt(h, 16))),
    // AERO is token1, USDC token0 in this pool
    reserveX: normaliseUp(r1, 18),
    reserveY: normaliseDown(r0, 6),
  };

  test('the cited log itself checks out — the data is real', async () => {
    const r = await verifyVenueSlot(cherry, { fetchImpl: replay() });
    const byName = Object.fromEntries(r.checks.map((x) => [x.name, x.ok]));
    assert.equal(byName['cited Sync log exists at (syncBlock, logIndex)'], true);
    assert.equal(byName['cited log is inside syncTx'], true);
    assert.equal(byName['reserveX matches the log (normalised, rounded up)'], true);
    assert.equal(byName['reserveY matches the log (normalised, rounded down)'], true);
  });

  test('and is still rejected, by the no-newer-Sync window check alone', async () => {
    const r = await verifyVenueSlot(cherry, { fetchImpl: replay() });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['no newer Sync before refBlock (reserves are current, not cherry-picked)']);
    assert.match(r.checks.find((x) => !x.ok).detail, /later Sync\(s\)/);
  });
});

describe('the pool must be a real constant-product pool', () => {
  test('a pool not deployed by a known factory is rejected outright', async () => {
    // Anyone can deploy a contract that emits Sync with arbitrary numbers.
    const fake = replay((m, p, r) =>
      m === 'eth_call' && p[0].data === '0xc45a0155' ? '0x' + '00'.repeat(12) + 'de'.repeat(20) : r,
    );
    const r = await verifyVenueSlot(honest, { fetchImpl: fake });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['pool from a known constant-product factory']);
  });

  test('a stable-curve pool (not x*y=k) is rejected', async () => {
    const stable = replay((m, p, r) => (m === 'eth_call' && p[0].data === '0x22be3de1' ? '0x' + '0'.repeat(63) + '1' : r));
    const r = await verifyVenueSlot(honest, { fetchImpl: stable });
    assert.ok(failed(r).includes('factory vouches for the pool (volatile, not stable)'));
  });

  test('a fee that differs from the pool\'s fee at refBlock is rejected', async () => {
    const r = await verifyVenueSlot({ ...honest, feeBps: 1n }, { fetchImpl: replay() });
    assert.deepEqual(failed(r), ['fee matches the pool at refBlock']);
  });

  test('selling the stablecoin into the pool instead of the collateral is rejected', async () => {
    const r = await verifyVenueSlot({ ...honest, collateralIsToken0: !honest.collateralIsToken0, decX: honest.decY, decY: honest.decX }, { fetchImpl: replay() });
    assert.ok(failed(r).includes('quote side is an allowed USD stablecoin'));
  });

  test('a reference timestamp that is not refBlock\'s is rejected', async () => {
    const r = await verifyVenueSlot({ ...honest, refTime: honest.refTime + 3600n }, { fetchImpl: replay() });
    assert.deepEqual(failed(r), ["refTime is refBlock's timestamp"]);
  });
});

describe('normalisation rounds against the prover', () => {
  test('collateral rounds up and quote rounds down', () => {
    // 1.0000005 tokens at 18 decimals -> 1_000_001 micro when rounding up
    assert.equal(normaliseUp(1_000_000_500_000_000_000n, 18), 1_000_001n);
    assert.equal(normaliseDown(1_000_000_500_000_000_000n, 18), 1_000_000n);
  });
});
