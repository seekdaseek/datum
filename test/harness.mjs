// Simulation harness for the datum v2 contract.
//
// Drives the compiled contract through the Compact runtime's circuit context,
// so every assert in the .compact source is live — including the kernel
// block-time queries, which read the block time the context is created with.
// Deployments are stateful: attestOn() threads the contract state from one
// period to the next, which is what lets the chaining tests run.

import { Contract, ledger, pureCircuits } from '../build/datum/contract/index.js';
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

export const SLOTS = 4;
export const RATIO_SCALE = 1_000_000n;
export const FEE_SCALE = 10_000n;
export const MICRO = 1_000_000n;     // micro-units per whole token
export const UINT64_CAP = 1n << 64n; // Uint<64> is Uint<0..2^64>, exclusive
export const MAX_REF_AGE = 21_600n;  // six hours
export const USD_RATE = 1_000_000n;  // quoteRate of a USD stablecoin: 1.0

// A fixed "now" for every simulated block, close to the recorded Base
// reference block so real fixtures fall inside maxRefAge.
export const NOW = 1_791_443_400n;

const COIN_PUBLIC_KEY = '0'.repeat(64);

export const bytesOf = (byte, n = 32) => new Uint8Array(n).fill(byte);
export const nonceOf = (byte) => bytesOf(byte);
export const poolOf = (byte) => bytesOf(byte, 20);
export const ATTESTOR_SECRET = bytesOf(0xa7);

// The private state the witnesses read. This is the book.
export const witnesses = {
  positionSizes: ({ privateState }) => [privateState, privateState.positions],
  claimedProceeds: ({ privateState }) => [privateState, privateState.proceeds],
  debtAmount: ({ privateState }) => [privateState, privateState.debt],
  commitmentNonce: ({ privateState }) => [privateState, privateState.nonce],
  attestorSecret: ({ privateState }) => [privateState, privateState.attestorSecret ?? ATTESTOR_SECRET],
  previousOpening: ({ privateState }) => [privateState, privateState.prev ?? emptyOpening()],
};

export const emptyOpening = () => ({ positions: Array(SLOTS).fill(0n), debt: 0n, nonce: bytesOf(0) });

/** An active venue slot. Defaults describe a fresh Aerodrome-style pool on Base. */
export const venue = (o = {}) => ({
  chainId: 8453n,
  pool: poolOf(0x11),
  collateralIsToken0: false,
  decX: 18n,
  decY: 6n,
  feeBps: 30n,
  syncBlock: 1_000n,
  syncTx: bytesOf(0x22),
  logIndex: 7n,
  refBlock: 1_006n,
  refTime: NOW - 60n,
  reserveX: 1_000_000n * MICRO,
  reserveY: 50_000_000n * MICRO,
  quoteRate: USD_RATE,
  ...o,
});

/** A padding slot: inactive, contributes nothing. */
export const paddingSlot = () => ({
  chainId: 0n,
  pool: poolOf(0),
  collateralIsToken0: false,
  decX: 0n,
  decY: 0n,
  feeBps: 0n,
  syncBlock: 0n,
  syncTx: bytesOf(0),
  logIndex: 0n,
  refBlock: 0n,
  refTime: 0n,
  reserveX: 1n,
  reserveY: 1n,
  quoteRate: 0n,
});

export const padVenues = (slots) => {
  const out = slots.slice();
  while (out.length < SLOTS) out.push(paddingSlot());
  return out;
};
export const padZeros = (xs) => {
  const out = xs.slice();
  while (out.length < SLOTS) out.push(0n);
  return out;
};

/**
 * Exact constant-product-with-fee output, floored: the tight lower bound the
 * circuit accepts. floor(...) satisfies the bound and floor(...)+1 does not.
 */
export const realisableProceeds = (X, Y, q, feeBps = 30n) => {
  if (q === 0n) return 0n;
  const g = FEE_SCALE - feeBps;
  return (Y * q * g) / (X * FEE_SCALE + q * g);
};

/** The oracle-mark valuation of the same size: size times spot, spot = Y/X. */
export const markedValue = (X, Y, q) => (q * Y) / X;

/** Build the private book for a set of venues and sizes, claiming the tight bound. */
export const bookFor = (venues, sizes, debt, nonceByte = 1) => {
  const vs = padVenues(venues);
  const positions = padZeros(sizes);
  return {
    positions,
    proceeds: vs.map((v, i) => (v.chainId === 0n ? 0n : realisableProceeds(v.reserveX, v.reserveY, positions[i], v.feeBps))),
    debt,
    nonce: nonceOf(nonceByte),
  };
};

/** Deploy a fresh contract. Returns a mutable deployment handle. */
export const deploy = async ({ privateState = {}, refAge = MAX_REF_AGE } = {}) => {
  const contract = new Contract(witnesses);
  const address = sampleContractAddress();
  const initial = await contract.initialState(
    createConstructorContext({ ...privateState }, COIN_PUBLIC_KEY),
    refAge,
  );
  return { contract, address, state: initial.currentContractState, privateState: initial.currentPrivateState };
};

/**
 * Run `attest` against a deployment and advance its state. Throws whatever the
 * circuit throws — the failure tests depend on that propagating unchanged.
 */
export const attestOn = async (dep, { privateState, venues, ratio, timestamp = NOW, now = NOW }) => {
  // Runtime 0.16.0: createCircuitContext(address, coinPK, state, privateState,
  // gasLimit?, costModel?, time?). `time` becomes the block's
  // secondsSinceEpoch, which the kernel block-time queries read.
  const context = createCircuitContext(dep.address, COIN_PUBLIC_KEY, dep.state, privateState, undefined, undefined, Number(now));
  const { context: after, proofData } = await dep.contract.circuits.attest(context, padVenues(venues), ratio, timestamp);
  dep.state = after.currentQueryContext.state;
  // Kept so test/zk.check.mjs can hand the same execution to the real ZK
  // checker: the simulator runs JavaScript, and JavaScript skips untaken
  // branches that the circuit still evaluates.
  dep.lastProofData = proofData;
  return ledger(dep.state);
};

/** One-shot: deploy and attest once. */
export const attest = async (args) => {
  const dep = await deploy({ privateState: args.privateState });
  return attestOn(dep, args);
};

export { pureCircuits, ledger };
