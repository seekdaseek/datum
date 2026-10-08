// scripts/diag/prove-mem.mjs <buildDir> <slots> [proofServer]
// One period-0 attest proved through a real proof server's /prove, to measure
// the prover's memory for a given circuit size. Diagnostic only.
import { resolve } from 'node:path';
import { createConstructorContext, createCircuitContext, sampleContractAddress, proofDataIntoSerializedPreimage } from '@midnight-ntwrk/compact-runtime';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';

const [dir, slotsArg, ps = 'http://localhost:6301'] = process.argv.slice(2);
const SLOTS = Number(slotsArg);
const { Contract } = await import(resolve(dir, 'contract/index.js'));
const NOW = BigInt(Math.floor(Date.now() / 1000));
const b = (x, n = 32) => new Uint8Array(n).fill(x);
const empty = { positions: Array(SLOTS).fill(0n), debt: 0n, nonce: b(0) };
const w = {
  positionSizes: ({ privateState: s }) => [s, s.positions],
  claimedProceeds: ({ privateState: s }) => [s, s.proceeds],
  debtAmount: ({ privateState: s }) => [s, s.debt],
  commitmentNonce: ({ privateState: s }) => [s, s.nonce],
  attestorSecret: ({ privateState: s }) => [s, b(0xa7)],
  previousOpening: ({ privateState: s }) => [s, empty],
};
const pad = { chainId: 0n, pool: b(0, 20), collateralIsToken0: false, decX: 0n, decY: 0n, feeBps: 0n, syncBlock: 0n, syncTx: b(0), logIndex: 0n, refBlock: 0n, refTime: 0n, reserveX: 1n, reserveY: 1n };
const X = 27_000_000n * 1_000_000n, Y = 21_000_000n * 1_000_000n, q = 1_000_000n * 1_000_000n;
const v = { ...pad, chainId: 8453n, pool: b(0x6c, 20), decX: 18n, decY: 6n, feeBps: 30n, syncBlock: 100n, syncTx: b(0x22), logIndex: 1n, refBlock: 101n, refTime: NOW - 60n, reserveX: X, reserveY: Y };
const p = (Y * q * 9970n) / (X * 10000n + q * 9970n);
const ps0 = { positions: [q, ...Array(SLOTS - 1).fill(0n)], proceeds: [p, ...Array(SLOTS - 1).fill(0n)], debt: 1n, nonce: b(1) };
const c = new Contract(w);
const init = await c.initialState(createConstructorContext(ps0, '0'.repeat(64)), 21600n);
const ctx = createCircuitContext(sampleContractAddress(), '0'.repeat(64), init.currentContractState, ps0, undefined, undefined, Number(NOW));
const { proofData } = c.circuits.attest(ctx, [v, ...Array(SLOTS - 1).fill(pad)], 1_000_000n, NOW);
const pre = proofDataIntoSerializedPreimage(proofData.input, proofData.output, proofData.publicTranscript, proofData.privateTranscriptOutputs, 'attest');
const prover = httpClientProvingProvider(ps, new NodeZkConfigProvider(resolve(dir)));
const t = Date.now();
const proof = await prover.prove(pre, 'attest');
console.log(`proved ${SLOTS}-slot attest in ${((Date.now() - t) / 1000).toFixed(1)} s, ${proof.length} bytes`);
