import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  attest,
  attestOn,
  deploy,
  bookFor,
  venue,
  paddingSlot,
  padVenues,
  padZeros,
  poolOf,
  nonceOf,
  bytesOf,
  realisableProceeds,
  markedValue,
  pureCircuits,
  emptyOpening,
  MICRO,
  RATIO_SCALE,
  UINT64_CAP,
  NOW,
  MAX_REF_AGE,
} from './harness.mjs';

// ---------------------------------------------------------------------------
// A real pool. Reserves of the Aerodrome volatile AERO/USDC pool on Base at
// block 52327009 (log 630), as recorded in test/fixtures by
// scripts/record-fixtures.mjs and verified against the chain by
// test/provenance.test.mjs. AERO is the collateral, USDC the quote.
// ---------------------------------------------------------------------------
const fx = JSON.parse(readFileSync(new URL('./fixtures/base-aero-usdc.json', import.meta.url)));
const big = (s) => BigInt(s.slice(0, -1));
const AERO_X = big(fx.honestSlot.reserveX); // ~27.8M AERO, micro-units
const AERO_Y = big(fx.honestSlot.reserveY); // ~21.6M USDC, micro-units

const aeroPool = venue({ pool: poolOf(0x6c), reserveX: AERO_X, reserveY: AERO_Y, feeBps: 30n });
const RATIO_120 = 1_200_000n;
const BOOK_Q = 10_000_000n * MICRO; // 10M AERO, about a third of the pool's AERO side

// ===========================================================================
// THE HEADLINE TEST
// ===========================================================================
describe('THE PRODUCT: a book that is solvent at oracle marks is NOT COVERED at realisable prices', () => {
  test('real AERO/USDC depth: marks say covered, datum says not covered', async () => {
    const debt = 5_500_000n * MICRO;
    const marked = markedValue(AERO_X, AERO_Y, BOOK_Q);
    const realisable = realisableProceeds(AERO_X, AERO_Y, BOOK_Q, 30n);

    assert.ok(marked > realisable, 'the mark must overstate the realisable value');
    assert.ok(marked * RATIO_SCALE >= debt * RATIO_120, 'precondition: solvent at oracle marks');
    assert.ok(realisable * RATIO_SCALE < debt * RATIO_120, 'precondition: insolvent at realisable prices');

    const out = await attest({ privateState: bookFor([aeroPool], [BOOK_Q], debt), venues: [aeroPool], ratio: RATIO_120 });
    assert.equal(out.covered, false, 'verdict must be NOT COVERED');
    assert.equal(out.attestationCount, 1n);
    assert.equal(out.requiredRatio, RATIO_120);
  });
});

// ===========================================================================
// THE HAPPY PATH
// ===========================================================================
describe('a genuinely solvent book', () => {
  test('is COVERED', async () => {
    const debt = 4_000_000n * MICRO;
    const out = await attest({ privateState: bookFor([aeroPool], [BOOK_Q], debt), venues: [aeroPool], ratio: RATIO_120 });
    assert.equal(out.covered, true);
  });

  test('publishes the venue provenance in the clear and a digest a verifier can recompute', async () => {
    const out = await attest({ privateState: bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO), venues: [aeroPool], ratio: RATIO_120 });
    const v = out.venues[0];
    assert.equal(v.chainId, 8453n);
    assert.deepEqual(v.pool, poolOf(0x6c));
    assert.equal(v.syncBlock, aeroPool.syncBlock);
    assert.equal(v.logIndex, aeroPool.logIndex);
    assert.equal(v.refBlock, aeroPool.refBlock);
    assert.equal(v.reserveX, AERO_X);
    assert.deepEqual(out.venuesHash, pureCircuits.venueDigest(padVenues([aeroPool])));
  });
});

// ===========================================================================
// SOUNDNESS CARRIED FROM v1
// ===========================================================================
describe('zero-padding cannot be used to smuggle proceeds', () => {
  test('a padding slot claiming proceeds is rejected', async () => {
    const book = bookFor([aeroPool], [BOOK_Q], 5_500_000n * MICRO);
    book.proceeds[1] = 3_000_000n * MICRO;
    await assert.rejects(
      attest({ privateState: book, venues: [aeroPool], ratio: RATIO_120 }),
      /a padding slot cannot claim proceeds/,
    );
  });

  test('the same smuggled book would otherwise have passed', () => {
    const debt = 5_500_000n * MICRO;
    const honest = realisableProceeds(AERO_X, AERO_Y, BOOK_Q, 30n);
    assert.ok(honest * RATIO_SCALE < debt * RATIO_120);
    assert.ok((honest + 3_000_000n * MICRO) * RATIO_SCALE >= debt * RATIO_120);
  });
});

describe('degenerate reserves are rejected in every slot', () => {
  const book = () => bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO);
  test('X = 0 in a padding slot fails', async () => {
    const vs = padVenues([aeroPool]); vs[3] = { ...vs[3], reserveX: 0n };
    await assert.rejects(attest({ privateState: book(), venues: vs, ratio: RATIO_120 }), /reserveX must be positive in every slot/);
  });
  test('Y = 0 in a padding slot fails', async () => {
    const vs = padVenues([aeroPool]); vs[3] = { ...vs[3], reserveY: 0n };
    await assert.rejects(attest({ privateState: book(), venues: vs, ratio: RATIO_120 }), /reserveY must be positive in every slot/);
  });
  test('X = 0 in the active slot fails', async () => {
    await assert.rejects(attest({ privateState: book(), venues: [{ ...aeroPool, reserveX: 0n }], ratio: RATIO_120 }), /reserveX must be positive/);
  });
  test('a zero required ratio is rejected', async () => {
    await assert.rejects(attest({ privateState: book(), venues: [aeroPool], ratio: 0n }), /requiredRatio must be positive/);
  });
});

describe('proceeds cannot be overclaimed', () => {
  test('p exactly at the fee-adjusted bound is accepted', async () => {
    const b = bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO);
    const out = await attest({ privateState: b, venues: [aeroPool], ratio: RATIO_120 });
    assert.equal(out.covered, true);
  });
  test('p one micro-unit above the bound is rejected', async () => {
    const b = bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO);
    b.proceeds[0] += 1n;
    await assert.rejects(attest({ privateState: b, venues: [aeroPool], ratio: RATIO_120 }), /claimed proceeds exceed realisable proceeds/);
  });
  test('underclaiming p only hurts the prover', async () => {
    const b = bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO);
    b.proceeds[0] = 1n;
    assert.equal((await attest({ privateState: b, venues: [aeroPool], ratio: RATIO_120 })).covered, false);
  });
});

// ===========================================================================
// NEW IN v2: THE FEE IS IN THE BOUND
// ===========================================================================
describe('FEE: v1 ignored the pool fee; v2 does not', () => {
  test('a claim at the fee-free bound Y*q/(X+q) is now rejected', async () => {
    const b = bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO);
    const feeFree = realisableProceeds(AERO_X, AERO_Y, BOOK_Q, 0n);
    assert.ok(feeFree > b.proceeds[0], 'the fee-free figure overstates a real sale');
    b.proceeds[0] = feeFree;
    await assert.rejects(attest({ privateState: b, venues: [aeroPool], ratio: RATIO_120 }), /claimed proceeds exceed realisable proceeds/);
  });
  test('feeBps of 10000 or more is rejected', async () => {
    await assert.rejects(attest({ privateState: bookFor([aeroPool], [BOOK_Q], 1n), venues: [{ ...aeroPool, feeBps: 10_000n }], ratio: RATIO_120 }), /feeBps must be below 10000/);
  });
});

// ===========================================================================
// NEW IN v2: A SLOT MAY BE QUOTED IN WETH, VALUED AT A PUBLIC RATE
// ===========================================================================
describe('QUOTE RATE: a WETH-quoted slot is valued at its public USD rate', () => {
  // Moonwell's WELL book against the Aerodrome WELL/WETH pool, Base block
  // 52,331,062: reserves in micro-units, 1% fee, WETH at $2,558.358868.
  const WELL_X = 271_920_150n * MICRO;
  const WELL_Y = 256_156_648n;            // 256.156648 WETH in micro-WETH
  const WETH_RATE = 2_558_358_868n;       // USD micro per whole WETH
  const wellPool = venue({ pool: poolOf(0x89), reserveX: WELL_X, reserveY: WELL_Y, feeBps: 100n, quoteRate: WETH_RATE });
  const Q = 131_253_121n * MICRO;
  const DEBT = 173_283n * MICRO;          // the 55% collateral factor's debt cap
  const RATIO = 1_000_000n;

  test('valued at the WETH rate the book clears its bar; at half that rate it does not', async () => {
    const book = bookFor([wellPool], [Q], DEBT);
    const usd = (book.proceeds[0] * WETH_RATE) / 1_000_000n; // USD micro-units
    assert.ok(usd >= DEBT && usd / 2n < DEBT, `proceeds ${Number(usd) / 1e6} USD`);
    assert.equal((await attest({ privateState: book, venues: [wellPool], ratio: RATIO })).covered, true);
    const half = { ...wellPool, quoteRate: WETH_RATE / 2n };
    assert.equal((await attest({ privateState: bookFor([half], [Q], DEBT), venues: [half], ratio: RATIO })).covered, false);
  });

  test('the rate is bound into venuesHash, so a different rate is a different venue array', () => {
    const a = pureCircuits.venueDigest(padVenues([wellPool]));
    const b = pureCircuits.venueDigest(padVenues([{ ...wellPool, quoteRate: WETH_RATE + 1n }]));
    assert.notDeepEqual(a, b);
  });

  test('a zero rate cannot help the prover: it can only understate', async () => {
    const zero = { ...wellPool, quoteRate: 0n };
    assert.equal((await attest({ privateState: bookFor([zero], [Q], 1n), venues: [zero], ratio: RATIO })).covered, false);
  });
});

// ===========================================================================
// NEW IN v2: FRESHNESS ENFORCED BY THE LEDGER'S BLOCK TIME
// ===========================================================================
describe('FRESHNESS: reserves must be recent, judged by Midnight block time', () => {
  const b = () => bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO);
  test('a reference block older than maxRefAge is rejected', async () => {
    const stale = { ...aeroPool, refTime: NOW - MAX_REF_AGE - 1n };
    await assert.rejects(attest({ privateState: b(), venues: [stale], ratio: RATIO_120 }), /reference block is older than maxRefAge/);
  });
  test('a reference block just inside maxRefAge is accepted', async () => {
    const fresh = { ...aeroPool, refTime: NOW - MAX_REF_AGE + 1n };
    assert.equal((await attest({ privateState: b(), venues: [fresh], ratio: RATIO_120 })).covered, true);
  });
  test('a reference block timestamped in the future is rejected', async () => {
    await assert.rejects(attest({ privateState: b(), venues: [{ ...aeroPool, refTime: NOW + 1n }], ratio: RATIO_120 }), /reference block is in the future/);
  });
  test('a refBlock before its own Sync is rejected', async () => {
    await assert.rejects(attest({ privateState: b(), venues: [{ ...aeroPool, refBlock: aeroPool.syncBlock - 1n }], ratio: RATIO_120 }), /refBlock precedes the Sync/);
  });
  test('attestedAt more than ten minutes from block time is rejected', async () => {
    await assert.rejects(attest({ privateState: b(), venues: [aeroPool], ratio: RATIO_120, timestamp: NOW - 700n }), /attestedAt is too far in the past/);
    await assert.rejects(attest({ privateState: b(), venues: [aeroPool], ratio: RATIO_120, timestamp: NOW + 700n }), /attestedAt is too far in the future/);
  });
});

// ===========================================================================
// NEW IN v2: ONE POOL, ONE SLOT
// ===========================================================================
describe('DISTINCT POOLS: a pool listed twice would undercount price impact', () => {
  test('splitting one sale across two copies of the same pool is rejected', async () => {
    const half = BOOK_Q / 2n;
    const twin = { ...aeroPool, logIndex: aeroPool.logIndex };
    const b = bookFor([aeroPool, twin], [half, half], 5_500_000n * MICRO);
    // Two halves into two copies of the same depth fetch more than one sale
    // into the real pool — which is exactly why this must be rejected.
    const split = b.proceeds[0] + b.proceeds[1];
    const whole = realisableProceeds(AERO_X, AERO_Y, BOOK_Q, 30n);
    assert.ok(split > whole, 'the split overstates proceeds');
    await assert.rejects(attest({ privateState: b, venues: [aeroPool, twin], ratio: RATIO_120 }), /the same pool is listed in two slots/);
  });
  test('a duplicate in non-adjacent slots, behind a padding slot, is rejected', async () => {
    // The circuit checks each pair once, from the lower index; this pins that
    // the pair (1, 3) is still reached when slot 2 is padding.
    const otherPool = { ...aeroPool, pool: poolOf(0x77) };
    const venues = [otherPool, aeroPool, paddingSlot(), aeroPool];
    const b = bookFor(venues, [1n * MICRO, BOOK_Q / 2n, 0n, BOOK_Q / 2n], 1n * MICRO);
    await assert.rejects(attest({ privateState: b, venues, ratio: RATIO_120 }), /the same pool is listed in two slots/);
  });
  test('the same pool address on a different chain is a different pool', async () => {
    const other = { ...aeroPool, chainId: 1n };
    const b = bookFor([aeroPool, other], [BOOK_Q, 0n], 4_000_000n * MICRO);
    assert.equal((await attest({ privateState: b, venues: [aeroPool, other], ratio: RATIO_120 })).covered, true);
  });
});

// ===========================================================================
// NEW IN v2: ONLY THE ATTESTOR, AND EVERY PERIOD CHAINED
// ===========================================================================
describe('ATTESTOR: only the registered key can attest', () => {
  test('a different secret is rejected', async () => {
    const dep = await deploy();
    const b = { ...bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO), attestorSecret: bytesOf(0x01) };
    await assert.rejects(attestOn(dep, { privateState: b, venues: [aeroPool], ratio: RATIO_120 }), /caller is not the registered attestor/);
  });
  test('the published attestor key is the hash of the secret, not the secret', async () => {
    const dep = await deploy();
    const out = await attestOn(dep, { privateState: bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO), venues: [aeroPool], ratio: RATIO_120 });
    assert.deepEqual(out.attestor, pureCircuits.attestorKey(bytesOf(0xa7)));
    assert.notDeepEqual(out.attestor, bytesOf(0xa7));
  });
  test('maxRefAge must be positive at deployment', async () => {
    await assert.rejects(deploy({ refAge: 0n }), /maxRefAge must be positive/);
  });
});

describe('CHAIN: each period commits to the last, and must be able to open it', () => {
  const p0 = () => bookFor([aeroPool], [BOOK_Q], 5_500_000n * MICRO, 1);
  const p1Book = (prev) => ({ ...bookFor([aeroPool], [BOOK_Q / 2n], 2_000_000n * MICRO, 2), prev });

  test('a second period with the correct previous opening is accepted and linked', async () => {
    const dep = await deploy();
    const b0 = p0();
    const l0 = await attestOn(dep, { privateState: b0, venues: [aeroPool], ratio: RATIO_120 });
    const l1 = await attestOn(dep, {
      privateState: p1Book({ positions: b0.positions, debt: b0.debt, nonce: b0.nonce }),
      venues: [aeroPool],
      ratio: RATIO_120,
    });
    assert.equal(l1.attestationCount, 2n);
    assert.equal(l1.history.size(), 2n);
    const r0 = l1.history.lookup(0n);
    const r1 = l1.history.lookup(1n);
    assert.deepEqual(r0.commitment, l0.bookCommitment);
    assert.deepEqual(r1.prev, r0.commitment, 'period 1 links to period 0');
    assert.deepEqual(r0.prev, bytesOf(0), 'period 0 links to genesis');
    assert.equal(r0.covered, false);
    assert.equal(r1.covered, true, 'history keeps each period\'s own verdict');
    assert.deepEqual(l1.prevHead, r0.commitment);
    assert.deepEqual(l1.head, r1.commitment);
  });

  test('a wrong previous opening is rejected — the attestor must hold last period\'s book', async () => {
    const dep = await deploy();
    const b0 = p0();
    await attestOn(dep, { privateState: b0, venues: [aeroPool], ratio: RATIO_120 });
    const lie = { positions: b0.positions, debt: b0.debt - 1n, nonce: b0.nonce };
    await assert.rejects(
      attestOn(dep, { privateState: p1Book(lie), venues: [aeroPool], ratio: RATIO_120 }),
      /previous period's opening does not match the chain head/,
    );
  });

  test('a forgotten previous nonce is rejected', async () => {
    const dep = await deploy();
    const b0 = p0();
    await attestOn(dep, { privateState: b0, venues: [aeroPool], ratio: RATIO_120 });
    await assert.rejects(
      attestOn(dep, { privateState: p1Book({ positions: b0.positions, debt: b0.debt, nonce: nonceOf(9) }), venues: [aeroPool], ratio: RATIO_120 }),
      /previous period's opening does not match/,
    );
  });

  test('the same book and nonce commit differently at a different period', async () => {
    const depA = await deploy();
    const b0 = p0();
    const a0 = await attestOn(depA, { privateState: b0, venues: [aeroPool], ratio: RATIO_120 });
    const a1 = await attestOn(depA, { privateState: { ...b0, prev: { positions: b0.positions, debt: b0.debt, nonce: b0.nonce } }, venues: [aeroPool], ratio: RATIO_120 });
    assert.notDeepEqual(a0.bookCommitment, a1.bookCommitment, 'a commitment cannot be replayed at another period');
  });
});

// ===========================================================================
// OVERFLOW BOUNDARY
// ===========================================================================
describe('the declared accumulator width holds at the boundary', () => {
  const MAX_U64 = UINT64_CAP - 1n;
  test('maximum-width inputs compute without overflow', async () => {
    const v = venue({ reserveX: MAX_U64, reserveY: MAX_U64 });
    const p = realisableProceeds(MAX_U64, MAX_U64, MAX_U64, 30n);
    const widest = p * (MAX_U64 * 10_000n + MAX_U64 * 9_970n);
    assert.ok(widest > 1n << 140n, 'the intermediate must be near the 2^143 budget');
    assert.ok(widest < 1n << 160n, 'and must fit the declared Uint<160> accumulator');
    const book = { positions: padZeros([MAX_U64]), proceeds: padZeros([p]), debt: 1n, nonce: nonceOf(1) };
    assert.equal((await attest({ privateState: book, venues: [v], ratio: RATIO_120 })).covered, true);
  });
  test('a reserve at 2^64 is rejected: Uint<64> excludes its upper bound', async () => {
    await assert.rejects(
      attest({ privateState: bookFor([aeroPool], [1n], 1n), venues: [{ ...aeroPool, reserveX: UINT64_CAP }], ratio: RATIO_120 }),
      /attest argument 1 .*expected value of type Vector<4, struct VenueSlot/s,
    );
  });
  test('a position size at 2^64 is rejected at the witness boundary', async () => {
    const b = bookFor([aeroPool], [1n], 1n);
    b.positions[0] = UINT64_CAP;
    await assert.rejects(attest({ privateState: b, venues: [aeroPool], ratio: RATIO_120 }), /positionSizes return value .*expected value of type Vector<4, Uint<0\.\.18446744073709551616>>/s);
  });
});

// ===========================================================================
// COMMITMENT BINDING
// ===========================================================================
describe('the book commitment binds positions, debt and nonce', () => {
  const commitmentFor = async (mutate) => {
    const b = bookFor([aeroPool], [BOOK_Q], 4_000_000n * MICRO);
    mutate?.(b);
    const out = await attest({ privateState: b, venues: [aeroPool], ratio: RATIO_120 });
    return Buffer.from(out.bookCommitment).toString('hex');
  };
  test('changing only the debt changes the commitment', async () => {
    assert.notEqual(await commitmentFor(), await commitmentFor((b) => { b.debt += MICRO; }));
  });
  test('changing only a position size changes the commitment', async () => {
    assert.notEqual(await commitmentFor(), await commitmentFor((b) => {
      b.positions[0] -= MICRO;
      b.proceeds[0] = realisableProceeds(AERO_X, AERO_Y, b.positions[0], 30n);
    }));
  });
  test('changing only the nonce changes the commitment', async () => {
    assert.notEqual(await commitmentFor(), await commitmentFor((b) => { b.nonce = nonceOf(2); }));
  });
  test('an identical book with an identical nonce gives an identical commitment', async () => {
    assert.equal(await commitmentFor(), await commitmentFor());
  });
});
