import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  attest,
  bookFor,
  padZeros,
  padVenues,
  venueIdOf,
  nonceOf,
  realisableProceeds,
  markedValue,
  pureCircuits,
  MICRO,
  RATIO_SCALE,
  UINT64_CAP,
} from './harness.mjs';

// ---------------------------------------------------------------------------
// A deep pool and a book large enough to move it.
//
// Reserves are 1,000,000 collateral against 50,000,000 quote, so the oracle
// spot price is 50 quote per collateral unit. The book is 500,000 collateral —
// half the pool. Everything is in micro-units.
// ---------------------------------------------------------------------------
const POOL_X = 1_000_000n * MICRO;
const POOL_Y = 50_000_000n * MICRO;
const BOOK_Q = 500_000n * MICRO;

const RATIO_120 = 1_200_000n; // 120%

const oneVenue = [
  { venueId: venueIdOf(7), reserveX: POOL_X, reserveY: POOL_Y, blockHeight: 21_000_000n },
];

// ===========================================================================
// THE HEADLINE TEST
// ===========================================================================
describe('THE PRODUCT: a book that is solvent at oracle marks is NOT COVERED at realisable prices', () => {
  test('same book, same ratio: marks say covered, datum says not covered', async () => {
    // 20,000,000 quote of debt against a book worth 25,000,000 at the mark.
    const debt = 20_000_000n * MICRO;

    // What a conventional solvency dashboard reports: size times spot.
    const marked = markedValue(POOL_X, POOL_Y, BOOK_Q);
    // What the book would actually fetch, selling into this pool's depth.
    const realisable = realisableProceeds(POOL_X, POOL_Y, BOOK_Q);

    // The gap is real and it is large: the mark overstates by ~50%.
    assert.ok(marked > realisable, 'the mark must overstate the realisable value');

    // At oracle marks this book clears a 120% requirement.
    assert.ok(
      marked * RATIO_SCALE >= debt * RATIO_120,
      'precondition: the book must look solvent at oracle marks',
    );
    // At realisable prices it does not.
    assert.ok(
      realisable * RATIO_SCALE < debt * RATIO_120,
      'precondition: the book must be insolvent at realisable prices',
    );

    // And that is exactly what the contract publishes.
    const out = await attest({
      privateState: bookFor(oneVenue, [BOOK_Q], debt),
      venues: oneVenue,
      ratio: RATIO_120,
    });

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
    // Same book and pool, half the debt.
    const debt = 10_000_000n * MICRO;
    const realisable = realisableProceeds(POOL_X, POOL_Y, BOOK_Q);
    assert.ok(realisable * RATIO_SCALE >= debt * RATIO_120);

    const out = await attest({
      privateState: bookFor(oneVenue, [BOOK_Q], debt),
      venues: oneVenue,
      ratio: RATIO_120,
    });

    assert.equal(out.covered, true, 'verdict must be COVERED');
    assert.equal(out.attestationCount, 1n);
  });

  test('publishes the venue array in the clear and a digest a verifier can recompute', async () => {
    const out = await attest({
      privateState: bookFor(oneVenue, [BOOK_Q], 10_000_000n * MICRO),
      venues: oneVenue,
      ratio: RATIO_120,
    });

    // The public inputs land on the ledger unchanged.
    assert.equal(out.venues.length, 8);
    assert.equal(out.venues[0].reserveX, POOL_X);
    assert.equal(out.venues[0].reserveY, POOL_Y);
    assert.equal(out.venues[0].blockHeight, 21_000_000n);
    assert.deepEqual(out.venues[0].venueId, venueIdOf(7));

    // And the digest is reproducible from them alone, with no private input.
    const recomputed = pureCircuits.venueDigest(padVenues(oneVenue));
    assert.deepEqual(out.venuesHash, recomputed, 'venuesHash must be recomputable from public data');
  });
});

// ===========================================================================
// SOUNDNESS: the asserts are the product
// ===========================================================================
describe('zero-padding cannot be used to smuggle proceeds', () => {
  test('a nonzero p through a q=0 padding slot is rejected', async () => {
    const debt = 20_000_000n * MICRO;
    const book = bookFor(oneVenue, [BOOK_Q], debt);

    // Slot 1 is padding: q = 0. Claim proceeds through it anyway — enough to
    // close the gap that made the headline test fail.
    assert.equal(book.positions[1], 0n, 'slot 1 must be a padding slot');
    book.proceeds[1] = 10_000_000n * MICRO;

    await assert.rejects(
      attest({ privateState: book, venues: oneVenue, ratio: RATIO_120 }),
      /claimed proceeds exceed realisable proceeds/,
      'a padding slot must not be able to contribute proceeds',
    );
  });

  test('the same smuggled book would otherwise have passed', async () => {
    // Proof that the previous test is testing something: with the smuggled
    // proceeds counted, the book clears the bar. The assert is the only thing
    // standing between this book and a false COVERED.
    const debt = 20_000_000n * MICRO;
    const honest = realisableProceeds(POOL_X, POOL_Y, BOOK_Q);
    const smuggled = honest + 10_000_000n * MICRO;
    assert.ok(honest * RATIO_SCALE < debt * RATIO_120, 'honest book fails');
    assert.ok(smuggled * RATIO_SCALE >= debt * RATIO_120, 'smuggled book would pass');
  });
});

describe('degenerate reserves are rejected in every slot', () => {
  test('X = 0 in a padding slot fails', async () => {
    const venues = padVenues(oneVenue);
    venues[3] = { ...venues[3], reserveX: 0n };
    await assert.rejects(
      attest({
        privateState: bookFor(oneVenue, [BOOK_Q], 10_000_000n * MICRO),
        venues,
        ratio: RATIO_120,
      }),
      /reserveX must be positive in every slot/,
    );
  });

  test('Y = 0 in a padding slot fails', async () => {
    const venues = padVenues(oneVenue);
    venues[3] = { ...venues[3], reserveY: 0n };
    await assert.rejects(
      attest({
        privateState: bookFor(oneVenue, [BOOK_Q], 10_000_000n * MICRO),
        venues,
        ratio: RATIO_120,
      }),
      /reserveY must be positive in every slot/,
    );
  });

  test('X = 0 in the active slot fails', async () => {
    const venues = [{ ...oneVenue[0], reserveX: 0n }];
    const book = bookFor(oneVenue, [BOOK_Q], 10_000_000n * MICRO);
    await assert.rejects(
      attest({ privateState: book, venues, ratio: RATIO_120 }),
      /reserveX must be positive in every slot/,
    );
  });

  test('X = 0 with a nonzero claim is exactly the unbounded-proceeds hole', async () => {
    // This is the case the positivity assert exists for. With X = 0 and q = 0
    // the per-slot constraint reads p*0 <= Y*0, i.e. 0 <= 0, which holds for
    // any p at all. Without assert(X > 0) this book would be COVERED.
    const venues = padVenues(oneVenue);
    venues[3] = { ...venues[3], reserveX: 0n };

    const debt = 20_000_000n * MICRO;
    const book = bookFor(oneVenue, [BOOK_Q], debt);
    book.proceeds[3] = 10_000_000n * MICRO; // unbounded claim through a dead slot

    // The constraint alone does not stop it...
    const X = 0n, q = 0n, Y = venues[3].reserveY, p = book.proceeds[3];
    assert.ok(p * (X + q) <= Y * q, 'the per-slot constraint is satisfied at X=0');
    // ...the positivity assert does.
    await assert.rejects(
      attest({ privateState: book, venues, ratio: RATIO_120 }),
      /reserveX must be positive in every slot/,
    );
  });

  test('a zero required ratio is rejected', async () => {
    await assert.rejects(
      attest({
        privateState: bookFor(oneVenue, [BOOK_Q], 20_000_000n * MICRO),
        venues: oneVenue,
        ratio: 0n,
      }),
      /requiredRatio must be positive/,
    );
  });
});

describe('proceeds cannot be overclaimed', () => {
  test('p exactly at the realisable bound is accepted', async () => {
    const book = bookFor(oneVenue, [BOOK_Q], 10_000_000n * MICRO);
    assert.equal(book.proceeds[0], realisableProceeds(POOL_X, POOL_Y, BOOK_Q));
    const out = await attest({ privateState: book, venues: oneVenue, ratio: RATIO_120 });
    assert.equal(out.covered, true);
  });

  test('p one micro-unit above the bound is rejected', async () => {
    const book = bookFor(oneVenue, [BOOK_Q], 10_000_000n * MICRO);
    book.proceeds[0] = book.proceeds[0] + 1n;
    await assert.rejects(
      attest({ privateState: book, venues: oneVenue, ratio: RATIO_120 }),
      /claimed proceeds exceed realisable proceeds/,
    );
  });

  test('p far above the bound is rejected', async () => {
    const book = bookFor(oneVenue, [BOOK_Q], 20_000_000n * MICRO);
    book.proceeds[0] = 40_000_000n * MICRO;
    await assert.rejects(
      attest({ privateState: book, venues: oneVenue, ratio: RATIO_120 }),
      /claimed proceeds exceed realisable proceeds/,
    );
  });

  test('underclaiming p only hurts the prover', async () => {
    // A book that would clear the bar honestly fails to clear it when the
    // prover understates proceeds. No assert fires; the verdict just flips.
    const debt = 10_000_000n * MICRO;
    const book = bookFor(oneVenue, [BOOK_Q], debt);
    book.proceeds[0] = 1n;
    const out = await attest({ privateState: book, venues: oneVenue, ratio: RATIO_120 });
    assert.equal(out.covered, false);
  });
});

// ===========================================================================
// OVERFLOW BOUNDARY
// ===========================================================================
describe('the declared accumulator width holds at the boundary', () => {
  const MAX_U64 = UINT64_CAP - 1n; // 2^64 - 1, the largest Uint<64> value

  test('maximum-width inputs compute without overflow', async () => {
    // X = Y = q = 2^64 - 1 drives p*(X+q) to just under 2^129, the widest
    // intermediate in the circuit. The Uint<136> accumulators must absorb it.
    const venues = [
      { venueId: venueIdOf(9), reserveX: MAX_U64, reserveY: MAX_U64, blockHeight: MAX_U64 },
    ];
    const p = realisableProceeds(MAX_U64, MAX_U64, MAX_U64);

    // Confirm we are actually at the boundary this test claims to probe.
    const widest = p * (MAX_U64 + MAX_U64);
    assert.ok(widest > 1n << 126n, 'the intermediate must be near 2^129');
    assert.ok(widest < 1n << 136n, 'and must still fit the declared accumulator');

    const book = {
      positions: padZeros([MAX_U64]),
      proceeds: padZeros([p]),
      debt: 1n,
      nonce: nonceOf(1),
    };

    const out = await attest({ privateState: book, venues, ratio: RATIO_120 });
    assert.equal(out.covered, true);
  });

  test('a reserve at 2^64 is rejected: Uint<64> excludes its upper bound', async () => {
    const venues = [
      { venueId: venueIdOf(9), reserveX: UINT64_CAP, reserveY: MAX_U64, blockHeight: 0n },
    ];
    await assert.rejects(
      attest({
        privateState: bookFor(oneVenue, [BOOK_Q], 1n),
        venues,
        ratio: RATIO_120,
      }),
      /attest argument 1 .*expected value of type Vector<8, struct VenueSlot/s,
      'the public reserve must be caught by the circuit argument type check',
    );
  });

  test('a position size at 2^64 is rejected at the witness boundary', async () => {
    // The private side is range-checked too: a prover cannot widen a witness
    // past its declared type to escape the accumulator budget.
    const book = bookFor(oneVenue, [BOOK_Q], 1n);
    book.positions[0] = UINT64_CAP;
    await assert.rejects(
      attest({ privateState: book, venues: oneVenue, ratio: RATIO_120 }),
      /positionSizes return value .*expected value of type Vector<8, Uint<0\.\.18446744073709551616>>/s,
      'the witness must be caught by the witness return type check',
    );
  });

  test('a claimed proceeds value at 2^64 is rejected at the witness boundary', async () => {
    const book = bookFor(oneVenue, [BOOK_Q], 1n);
    book.proceeds[0] = UINT64_CAP;
    await assert.rejects(
      attest({ privateState: book, venues: oneVenue, ratio: RATIO_120 }),
      /claimedProceeds return value .*expected value of type Vector<8, Uint<0\.\.18446744073709551616>>/s,
    );
  });
});

// ===========================================================================
// COMMITMENT BINDING
// ===========================================================================
describe('the book commitment binds positions, debt and nonce', () => {
  const baseVenues = oneVenue;
  const commitmentFor = async (mutate) => {
    const book = bookFor(baseVenues, [BOOK_Q], 10_000_000n * MICRO);
    mutate?.(book);
    const out = await attest({ privateState: book, venues: baseVenues, ratio: RATIO_120 });
    return Buffer.from(out.bookCommitment).toString('hex');
  };

  test('changing only the debt changes the commitment', async () => {
    const before = await commitmentFor();
    const after = await commitmentFor((b) => {
      b.debt = 10_000_001n * MICRO;
    });
    assert.notEqual(before, after, 'debt must be bound by the commitment');
  });

  test('changing only a position size changes the commitment', async () => {
    const before = await commitmentFor();
    const after = await commitmentFor((b) => {
      // Shrink the position and re-derive its honest proceeds, so the change
      // is to the book alone and no constraint is violated.
      b.positions[0] = BOOK_Q - MICRO;
      b.proceeds[0] = realisableProceeds(POOL_X, POOL_Y, b.positions[0]);
    });
    assert.notEqual(before, after, 'positions must be bound by the commitment');
  });

  test('changing only the nonce changes the commitment', async () => {
    const before = await commitmentFor();
    const after = await commitmentFor((b) => {
      b.nonce = nonceOf(2);
    });
    assert.notEqual(before, after, 'the nonce must be bound, so equal books are unlinkable');
  });

  test('an identical book with an identical nonce gives an identical commitment', async () => {
    const a = await commitmentFor();
    const b = await commitmentFor();
    assert.equal(a, b, 'the commitment must be deterministic');
  });
});
