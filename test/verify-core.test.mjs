import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { verifyAttestation, tamperedCopy } from '../scripts/verify-core.mjs';
import { normaliseUp, normaliseDown } from '../scripts/provenance.mjs';
import { deploy, attestOn, bookFor, pureCircuits, MICRO } from './harness.mjs';

// ---------------------------------------------------------------------------
// The whole verifier — the one the CLI and the page run — over a contract
// state produced by the real compiled circuit, with the Base side replayed
// from recorded mainnet RPC answers (test/fixtures/base-aero-usdc.json).
// ---------------------------------------------------------------------------
const fx = JSON.parse(readFileSync(new URL('./fixtures/base-aero-usdc.json', import.meta.url)));
const big = (s) => BigInt(s.slice(0, -1));
const bytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map((x) => parseInt(x, 16)));
const h = fx.honestSlot;
const honest = {
  chainId: big(h.chainId), pool: bytes(h.pool), collateralIsToken0: h.collateralIsToken0,
  decX: big(h.decX), decY: big(h.decY), feeBps: big(h.feeBps),
  syncBlock: big(h.syncBlock), syncTx: bytes(h.syncTx), logIndex: big(h.logIndex),
  refBlock: big(h.refBlock), refTime: big(h.refTime), reserveX: big(h.reserveX), reserveY: big(h.reserveY),
};
const replay = async (_url, init) => {
  const { method, params } = JSON.parse(init.body);
  const key = JSON.stringify([method, params]);
  if (!(key in fx.tape)) throw new Error(`fixture tape has no answer for ${key}`);
  return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: fx.tape[key] }) };
};
const failed = (r) => r.sections.flatMap((s) => s.checks.filter((c) => !c.ok).map((c) => c.name));

const Q = 1_000_000n * MICRO;
const DEBT = 500_000n * MICRO;
const RATIO = 1_200_000n;
const ledgerFor = async (venue, periods = 1) => {
  const dep = await deploy();
  let L;
  let prev;
  for (let p = 0; p < periods; p++) {
    const book = { ...bookFor([venue], [Q], DEBT, p + 1), prev };
    L = await attestOn(dep, { privateState: book, venues: [venue], ratio: RATIO });
    prev = { positions: book.positions, debt: book.debt, nonce: book.nonce };
  }
  return L;
};

describe('VERIFY FROM CHAIN: the published attestation, checked with public data only', () => {
  test('an honest attestation passes every check: digest, history, and the Sync re-fetched from Base', async () => {
    const L = await ledgerFor(honest, 2);
    const r = await verifyAttestation({ L, pureCircuits, fetchImpl: replay });
    assert.deepEqual(failed(r), []);
    assert.equal(r.ok, true);
    assert.equal(r.sections.length, 3);
    assert.equal(r.sections[1].checks.length, 3, 'two period links and the head');
    assert.equal(r.sections[2].checks.length, 12, 'twelve provenance checks on the one active slot');
  });
});

describe('TAMPER: a copy of the published venue array with one reserve changed', () => {
  test('reads MISMATCH twice — against the digest the proof bound, and against the Sync log on Base', async () => {
    const L = await ledgerFor(honest);
    const r = await verifyAttestation({ L, pureCircuits, venues: tamperedCopy(L.venues), fetchImpl: replay });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), [
      'venuesHash MISMATCH: this venue array is not the one the proof bound',
      'reserveY matches the log (normalised, rounded down)',
    ]);
  });

  test('changing the collateral reserve is caught the same way', async () => {
    const L = await ledgerFor(honest);
    const r = await verifyAttestation({ L, pureCircuits, venues: tamperedCopy(L.venues, { field: 'reserveX', delta: -1n }), fetchImpl: replay });
    assert.deepEqual(failed(r), [
      'venuesHash MISMATCH: this venue array is not the one the proof bound',
      'reserveX matches the log (normalised, rounded up)',
    ]);
  });
});

describe('CHERRY-PICK: an attestation proved on a real but stale Sync', () => {
  // The circuit cannot see Base, so it accepts a real, older Sync; the
  // verifier is what refuses it. This is why "Verify from chain" is part of
  // the product and not an optional extra.
  const c = fx.cherry;
  const cherry = {
    ...honest,
    syncBlock: big(c.syncBlock),
    logIndex: big(c.logIndex),
    syncTx: bytes(c.syncTx),
    reserveX: normaliseUp(BigInt(c.reserve1), 18),
    reserveY: normaliseDown(BigInt(c.reserve0), 6),
  };

  test('the proof lands, the digest matches, and the window check alone rejects it', async () => {
    const L = await ledgerFor(cherry);
    const r = await verifyAttestation({ L, pureCircuits, fetchImpl: replay });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ['no newer Sync before refBlock (reserves are current, not cherry-picked)']);
  });
});
