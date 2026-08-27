// Simulation harness for the datum contract.
//
// Drives the compiled contract through the Compact runtime's circuit context
// so the tests exercise the real generated circuit, not a JS re-implementation
// of it. Every assert in the .compact file is live here.

import {
  Contract,
  ledger,
  pureCircuits,
} from '../build/datum/contract/index.js';
import {
  createConstructorContext,
  createCircuitContext,
  sampleContractAddress,
} from '@midnight-ntwrk/compact-runtime';

export const SLOTS = 8;
export const RATIO_SCALE = 1_000_000n;
export const MICRO = 1_000_000n;      // micro-units per whole token
export const UINT64_CAP = 1n << 64n;  // Uint<64> is Uint<0..2^64>, exclusive

const COIN_PUBLIC_KEY = '0'.repeat(64);

// The private state carried between witness calls. This is the book.
export const witnesses = {
  positionSizes: ({ privateState }) => [privateState, privateState.positions],
  claimedProceeds: ({ privateState }) => [privateState, privateState.proceeds],
  debtAmount: ({ privateState }) => [privateState, privateState.debt],
  commitmentNonce: ({ privateState }) => [privateState, privateState.nonce],
};

export const nonceOf = (byte) => new Uint8Array(32).fill(byte);
export const venueIdOf = (byte) => new Uint8Array(32).fill(byte);

/** A padding slot: real reserves, nothing sold into it. */
export const paddingSlot = (i = 0) => ({
  venueId: venueIdOf(0),
  reserveX: 1n,
  reserveY: 1n,
  blockHeight: 0n,
});

/** Pad a partial venue list out to SLOTS entries. */
export const padVenues = (slots) => {
  const out = slots.slice();
  while (out.length < SLOTS) out.push(paddingSlot(out.length));
  return out;
};

/** Pad a partial bigint list out to SLOTS entries with zeros. */
export const padZeros = (xs) => {
  const out = xs.slice();
  while (out.length < SLOTS) out.push(0n);
  return out;
};

/**
 * The true realisable proceeds of selling q into constant-product reserves
 * (X, Y), floored. This is the tight lower bound the circuit will accept:
 * floor(Y*q/(X+q)) satisfies p*(X+q) <= Y*q, and floor(...)+1 does not.
 */
export const realisableProceeds = (X, Y, q) => (q === 0n ? 0n : (Y * q) / (X + q));

/**
 * The oracle-mark valuation of the same position: size times spot price,
 * with spot taken as Y/X. This is the number a conventional solvency
 * dashboard reports, and the number the contract refuses to trust.
 */
export const markedValue = (X, Y, q) => (q * Y) / X;

/** Build the private book for a set of venues and sizes. */
export const bookFor = (venues, sizes, debt, nonceByte = 1) => ({
  positions: padZeros(sizes),
  proceeds: padZeros(
    padVenues(venues).map((v, i) =>
      realisableProceeds(v.reserveX, v.reserveY, padZeros(sizes)[i]),
    ),
  ),
  debt,
  nonce: nonceOf(nonceByte),
});

/** Deploy a fresh contract instance with the given private state. */
export const deploy = async (privateState) => {
  const contract = new Contract(witnesses);
  const address = sampleContractAddress();
  const initial = await contract.initialState(
    createConstructorContext(privateState, COIN_PUBLIC_KEY),
  );
  return { contract, address, initial };
};

/**
 * Run `attest` once against a fresh deployment. Returns the resulting public
 * ledger. Throws whatever the circuit throws — the failure tests depend on
 * that propagating unchanged.
 */
export const attest = async ({ privateState, venues, ratio, timestamp = 1_700_000_000n }) => {
  const { contract, address, initial } = await deploy(privateState);
  // Runtime 0.16.0's createCircuitContext takes no circuitId argument, and
  // exposes the query context flat on the CircuitContext rather than nested
  // under callContext. Those two lines are the whole ledger-8 adaptation.
  const context = createCircuitContext(
    address,
    COIN_PUBLIC_KEY,
    initial.currentContractState,
    initial.currentPrivateState,
  );
  const { context: after } = await contract.circuits.attest(
    context,
    padVenues(venues),
    ratio,
    timestamp,
  );
  return ledger(after.currentQueryContext.state);
};

export { pureCircuits, padVenues as venues8 };
