//
// scripts/books/moonwell-aero.mjs — a real lending market's public collateral,
// read at one pinned Base block, as a datum book.
//
// THE BOOK
//   positions  the AERO supplied to Moonwell's mAERO market on Base
//   debt       the most debt that collateral is allowed to secure under
//              Moonwell's own parameters: collateralFactor x supplied x
//              Moonwell's oracle price. If datum says COVERED against this,
//              it is covered against any real debt the AERO actually backs.
//   ratio      1.00x — the question is whether the debt is recoverable at exit
//
// THE VENUE
//   Aerodrome volatile AERO/USDC (x*y=k). Measured on 2026-10-08 it holds 68%
//   of AERO's DEX liquidity on Base, so a constant-product model is the right
//   tool for this book. The remaining 32% (Slipstream concentrated-liquidity
//   pools, WETH pairs, Uniswap v3) is excluded, which can only make the
//   realisable figure conservative.
//
// The book is public on purpose: a judge can recompute every number from Base.
// A real lender's book would not be, and datum would never publish it.
//
import { makeRpc, buildVenueSlot, normaliseDown, MICRO } from '../provenance.mjs';

export const MOONWELL = {
  chainId: 8453,
  comptroller: '0xfbb21d0380bee3312b33c4353c8936a0f13ef26c',
  mAERO: '0x73902f619ceb9b31fd8efecf435cbdf89e369ba6',
  aero: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
  pool: '0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d',
};

// selectors via `cast sig`
const SEL = {
  totalSupply: '0x18160ddd',
  exchangeRateStored: '0x182df0f5',
  markets: '0x8e8f294b',
  oracle: '0x7dc0d1d0',
  getUnderlyingPrice: '0xfc57d4df',
};
const word = (h, i = 0) => BigInt('0x' + h.slice(2 + i * 64, 2 + i * 64 + 64));
const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const E18 = 10n ** 18n;

/** Exact constant-product-with-fee output, floored — the circuit's bound. */
export const realisable = (X, Y, q, feeBps) => (q === 0n ? 0n : (Y * q * (10000n - feeBps)) / (X * 10000n + q * (10000n - feeBps)));

export const buildMoonwellAeroBook = async ({ refBlock } = {}) => {
  const rpc = makeRpc(MOONWELL.chainId);
  const ref = BigInt(refBlock ?? BigInt(await rpc.call('eth_blockNumber', [])) - 10n);

  const { slot, evidence } = await buildVenueSlot({ chainId: MOONWELL.chainId, pool: MOONWELL.pool, collateral: MOONWELL.aero, refBlock: ref });

  // Moonwell state at the same block.
  const ts = word(await rpc.ethCall(MOONWELL.mAERO, SEL.totalSupply, ref));
  const er = word(await rpc.ethCall(MOONWELL.mAERO, SEL.exchangeRateStored, ref));
  const mk = await rpc.ethCall(MOONWELL.comptroller, SEL.markets + pad(MOONWELL.mAERO), ref);
  const cf = word(mk, 1); // collateralFactorMantissa, 1e18 = 100%
  const oracle = '0x' + (await rpc.ethCall(MOONWELL.comptroller, SEL.oracle, ref)).slice(-40);
  const px = word(await rpc.ethCall(oracle, SEL.getUnderlyingPrice + pad(MOONWELL.mAERO), ref)); // USD * 1e18 per AERO

  const suppliedRaw = (ts * er) / E18;           // AERO, 18 decimals
  const q = normaliseDown(suppliedRaw, 18);      // micro-AERO, rounded down
  const marked = (suppliedRaw * px) / E18 / 10n ** 12n; // USD micro-units
  const debt = (marked * cf) / E18;              // the most debt this collateral may secure
  const proceeds = realisable(slot.reserveX, slot.reserveY, q, slot.feeBps);

  return {
    refBlock: ref,
    venue: slot,
    book: { positions: [q], proceeds: [proceeds], debt },
    ratio: 1_000_000n,
    figures: {
      suppliedAero: Number(q) / 1e6,
      oraclePrice: Number(px) / 1e18,
      collateralFactor: Number(cf) / 1e18,
      markedUsd: Number(marked) / 1e6,
      debtUsd: Number(debt) / 1e6,
      realisableUsd: Number(proceeds) / 1e6,
      markedCoverage: Number(marked) / Number(debt),
      realisableCoverage: Number(proceeds) / Number(debt),
      gapUsd: Number(marked - proceeds) / 1e6,
      gapPct: (Number(marked - proceeds) / Number(marked)) * 100,
    },
    sources: {
      chain: 'Base (8453)',
      block: ref.toString(),
      comptroller: MOONWELL.comptroller,
      mToken: MOONWELL.mAERO,
      oracle,
      pool: MOONWELL.pool,
      raw: { mTokenTotalSupply: ts.toString(), exchangeRateStored: er.toString(), collateralFactorMantissa: cf.toString(), oraclePrice: px.toString() },
      venueEvidence: { kind: evidence.label, feeBps: evidence.feeBps, quote: evidence.quoteSymbol },
    },
  };
};

if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv?.[1]}`) {
  const b = await buildMoonwellAeroBook();
  const f = b.figures;
  const usd = (x) => '$' + x.toLocaleString('en', { maximumFractionDigits: 0 });
  console.log(`Moonwell AERO book at Base block ${b.refBlock}`);
  console.log(`  supplied            ${f.suppliedAero.toLocaleString('en', { maximumFractionDigits: 0 })} AERO`);
  console.log(`  Moonwell oracle     $${f.oraclePrice.toFixed(6)}  collateral factor ${(f.collateralFactor * 100).toFixed(0)}%`);
  console.log(`  marked value        ${usd(f.markedUsd)}`);
  console.log(`  debt it may secure  ${usd(f.debtUsd)}`);
  console.log(`  realisable at exit  ${usd(f.realisableUsd)}   (sold into ${b.sources.venueEvidence.kind}, ${b.sources.venueEvidence.feeBps} bps)`);
  console.log(`  coverage at marks       ${f.markedCoverage.toFixed(2)}x`);
  console.log(`  coverage at realisable  ${f.realisableCoverage.toFixed(2)}x`);
  console.log(`  value that does not exist at exit: ${usd(f.gapUsd)} (${f.gapPct.toFixed(1)}% of the marked value)`);
}
