import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Contract as Control, ledger as controlLedger } from '../build/control/contract/index.js';
import { createConstructorContext, createCircuitContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { attest, bookFor, venue, poolOf, padZeros, realisableProceeds, markedValue, MICRO, RATIO_SCALE } from './harness.mjs';

// ---------------------------------------------------------------------------
// THE CONTROL
//
// contract/src/control.compact is a faithful, mark-based solvency check — what
// a balance-threshold "proveSolvency" does — written in Compact over the same
// private book datum attests. Both run in the simulator against the same
// witnesses. The mark is taken from the SAME pool's spot price (Y/X), so the
// only difference between the two checks is whether depth is priced in.
// ---------------------------------------------------------------------------
const fx = JSON.parse(readFileSync(new URL('./fixtures/base-aero-usdc.json', import.meta.url)));
const big = (s) => BigInt(s.slice(0, -1));
const X = big(fx.honestSlot.reserveX); // AERO micro-units
const Y = big(fx.honestSlot.reserveY); // USDC micro-units
const pool = venue({ pool: poolOf(0x6c), reserveX: X, reserveY: Y });

// Spot price, USD micro-units per WHOLE token, from the same reserves.
const SPOT_E6 = (Y * MICRO) / X;
const COIN_PK = '0'.repeat(64);

const runControl = async (positions, debt, ratio) => {
  const ps = { positions: padZeros(positions), debt };
  const w = {
    positionSizes: ({ privateState }) => [privateState, privateState.positions],
    debtAmount: ({ privateState }) => [privateState, privateState.debt],
  };
  const c = new Control(w);
  const init = await c.initialState(createConstructorContext(ps, COIN_PK));
  const ctx = createCircuitContext(sampleContractAddress(), COIN_PK, init.currentContractState, ps);
  const prices = padZeros([SPOT_E6]);
  const { context } = await c.circuits.markCheck(ctx, prices, ratio);
  return controlLedger(context.currentQueryContext.state);
};

describe('CONTROL: a fair mark-based check passes the book datum says is NOT COVERED', () => {
  const Q = 10_000_000n * MICRO;        // 10M AERO, about a third of the pool's AERO side
  const DEBT = 5_500_000n * MICRO;      // $5.5M
  const RATIO = 1_200_000n;             // 120%

  test('same private book, same bar: the mark says COVERED, datum says NOT COVERED', async () => {
    const control = await runControl([Q], DEBT, RATIO);
    const datum = await attest({ privateState: bookFor([pool], [Q], DEBT), venues: [pool], ratio: RATIO });

    assert.equal(control.covered, true, 'the balance-threshold check passes');
    assert.equal(datum.covered, false, 'datum does not');

    // And the reason is exactly the depth:
    const marked = markedValue(X, Y, Q);
    const realisable = realisableProceeds(X, Y, Q, 30n);
    assert.ok(marked * RATIO_SCALE >= DEBT * RATIO, `marks ${Number(marked * 100n / DEBT) / 100}x`);
    assert.ok(realisable * RATIO_SCALE < DEBT * RATIO, `realisable ${Number(realisable * 100n / DEBT) / 100}x`);
  });

  test('on a book small against the depth, the two checks agree — the control is not rigged', async () => {
    const small = 50_000n * MICRO;      // 50k AERO, 0.2% of the pool
    const debt = 30_000n * MICRO;
    const control = await runControl([small], debt, RATIO);
    const datum = await attest({ privateState: bookFor([pool], [small], debt), venues: [pool], ratio: RATIO });
    assert.equal(control.covered, true);
    assert.equal(datum.covered, true);
  });

  test('both reject a book that is short even at the mark', async () => {
    const debt = 9_000_000n * MICRO;
    const control = await runControl([Q], debt, RATIO);
    const datum = await attest({ privateState: bookFor([pool], [Q], debt), venues: [pool], ratio: RATIO });
    assert.equal(control.covered, false);
    assert.equal(datum.covered, false);
  });

  test('the control refuses to count a held position at a zero price', async () => {
    const ps = { positions: padZeros([Q]), debt: 1n };
    const w = { positionSizes: ({ privateState }) => [privateState, privateState.positions], debtAmount: ({ privateState }) => [privateState, privateState.debt] };
    const c = new Control(w);
    const init = await c.initialState(createConstructorContext(ps, COIN_PK));
    const ctx = createCircuitContext(sampleContractAddress(), COIN_PK, init.currentContractState, ps);
    // Runtime 0.16 circuits are synchronous, so wrap the call to observe the throw.
    await assert.rejects(async () => c.circuits.markCheck(ctx, padZeros([0n]), RATIO), /a held position has no oracle price/);
  });
});
