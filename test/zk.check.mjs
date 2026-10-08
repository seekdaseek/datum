//
// test/zk.check.mjs — every simulator scenario, re-checked by the real ZK
// constraint checker in the proof server.
//
//   npm run test:zk        (needs a proof server on localhost:6300)
//
// Why this exists: the simulator executes the generated JavaScript, which
// skips the untaken side of a conditional. The ZK circuit evaluates both sides.
// On 2026-10-08 that difference let `(period - 1) as Uint<64>` inside
// `if (period > 0)` pass all 35 simulator tests and then fail on the proof
// server at period 0, where 0 - 1 wraps to r - 1 in the scalar field. This
// file sends each scenario's exact execution to the proof server's /check, so
// that class of bug fails here, before any chain is involved.
//
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { proofDataIntoSerializedPreimage } from '@midnight-ntwrk/compact-runtime';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { deploy, attestOn, bookFor, venue, poolOf, MICRO, UINT64_CAP, realisableProceeds, padZeros, nonceOf } from './harness.mjs';

const PROOF_SERVER = process.env.PROOF_SERVER ?? 'http://localhost:6300';
const zk = new NodeZkConfigProvider(resolve(import.meta.dirname, '../build/datum-full'));
const prover = httpClientProvingProvider(PROOF_SERVER, zk);

const zkCheck = async (pd) => {
  const pre = proofDataIntoSerializedPreimage(pd.input, pd.output, pd.publicTranscript, pd.privateTranscriptOutputs, 'attest');
  return prover.check(pre, 'attest');
};

const v = venue({ pool: poolOf(0x6c), reserveX: 27_799_024_916_317n, reserveY: 21_578_464_553_344n });
const R = 1_200_000n;
const Q = 10_000_000n * MICRO;

describe('the real ZK checker accepts what the simulator accepts', () => {
  test('period 0: genesis attestation, seven padding slots', async () => {
    const dep = await deploy();
    await attestOn(dep, { privateState: bookFor([v], [Q], 5_500_000n * MICRO), venues: [v], ratio: R });
    await zkCheck(dep.lastProofData);
  });

  test('period 1: the continuity branch is taken and the previous opening checked', async () => {
    const dep = await deploy();
    const b0 = bookFor([v], [Q], 5_500_000n * MICRO, 1);
    await attestOn(dep, { privateState: b0, venues: [v], ratio: R });
    await attestOn(dep, { privateState: { ...bookFor([v], [Q / 2n], 2_000_000n * MICRO, 2), prev: { positions: b0.positions, debt: b0.debt, nonce: b0.nonce } }, venues: [v], ratio: R });
    await zkCheck(dep.lastProofData);
  });

  test('period 2: a longer chain', async () => {
    const dep = await deploy();
    let prev;
    for (let k = 0; k < 3; k++) {
      const b = { ...bookFor([v], [Q - BigInt(k) * MICRO], 3_000_000n * MICRO, 10 + k), prev };
      await attestOn(dep, { privateState: b, venues: [v], ratio: R });
      prev = { positions: b.positions, debt: b.debt, nonce: b.nonce };
    }
    await zkCheck(dep.lastProofData);
  });

  test('several active slots on distinct pools', async () => {
    const dep = await deploy();
    const vs = [v, venue({ pool: poolOf(0x71) }), venue({ pool: poolOf(0x72), chainId: 1n })];
    await attestOn(dep, { privateState: bookFor(vs, [Q, 5n * MICRO, 7n * MICRO], 4_000_000n * MICRO), venues: vs, ratio: R });
    await zkCheck(dep.lastProofData);
  });

  test('maximum-width inputs', async () => {
    const MAX = UINT64_CAP - 1n;
    const big = venue({ reserveX: MAX, reserveY: MAX });
    const p = realisableProceeds(MAX, MAX, MAX, 30n);
    const dep = await deploy();
    await attestOn(dep, { privateState: { positions: padZeros([MAX]), proceeds: padZeros([p]), debt: 1n, nonce: nonceOf(1) }, venues: [big], ratio: R });
    await zkCheck(dep.lastProofData);
  });
});
