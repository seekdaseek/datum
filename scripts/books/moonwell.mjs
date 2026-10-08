#!/usr/bin/env node
//
// scripts/books/moonwell.mjs — real lending books from Moonwell on Base.
//
//   node scripts/books/moonwell.mjs [AERO|WELL]
//
// A book is everything supplied to one Moonwell market, against the most debt
// Moonwell's own collateral factor lets that collateral secure:
//   positions = mToken.totalSupply * exchangeRateStored   (underlying, raw)
//   marked    = positions * Moonwell oracle price
//   debt      = marked * collateralFactor
//   ratio     = 1.00x (the bar Moonwell itself applies)
// Realisable value sells the whole position into the market's main exit, a
// factory-vouched Aerodrome volatile (x*y=k) pool, with its fee, and values
// the quote side at the slot's quoteRate: 1.0 for USDC, Moonwell's own WETH
// price for WETH. Every input is public on Base at one pinned block.
//
// The book is public on purpose: a judge can recompute every number. A real
// lender's book would not be, and datum would never publish it.
//
import { makeRpc, buildVenueSlot, normaliseDown, readPool } from '../provenance.mjs';

export const MOONWELL = {
  chainId: 8453,
  comptroller: '0xfbb21d0380bee3312b33c4353c8936a0f13ef26c',
};

// Each market's main exit, measured 2026-10-08 (scripts/diag/well-facts.mjs).
export const MARKETS = {
  AERO: {
    mToken: '0x73902f619ceb9b31fd8efecf435cbdf89e369ba6',
    token: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
    decimals: 18,
    pool: '0x6cdcb1c4a4d1c3c6d054b27ac5b77e89eafb971d', // Aerodrome volatile AERO/USDC, 0.30%
    quote: 'USDC',
  },
  WELL: {
    mToken: '0xdc7810b47eaab250de623f0ee07764afa5f71ed1',
    token: '0xa88594d404727625a9437c3f886c7643872296ae',
    decimals: 18,
    pool: '0x89d0f320ac73dd7d9513ffc5bc58d1161452a657', // Aerodrome volatile WELL/WETH, 1.00%
    quote: 'WETH',
  },
};

// The only x*y=k WETH/USDC pool on Base, used to MEASURE the WETH leg that a
// WETH-quoted book values at the mark. Not part of the attestation.
const WETH_USDC_CP = '0xcdac0d6c6c59727a65f871236188350531885c43';

const SEL = {
  totalSupply: '0x18160ddd',
  exchangeRateStored: '0x182df0f5',
  markets: '0x8e8f294b',
  oracle: '0x7dc0d1d0',
  getUnderlyingPrice: '0xfc57d4df',
  getReserves: '0x0902f1ac',
};
const word = (h, i = 0) => BigInt('0x' + h.slice(2 + i * 64, 2 + i * 64 + 64));
const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const E18 = 10n ** 18n;
const MICRO = 1_000_000n;

/** Exact constant-product-with-fee output, floored — the circuit's bound. */
export const realisable = (X, Y, q, feeBps) => (q === 0n ? 0n : (Y * q * (10000n - feeBps)) / (X * 10000n + q * (10000n - feeBps)));
/** USD micro-units of `amount` quote micro-units at `rate` USD micro per whole quote token. */
export const toUsd = (amount, rate) => (amount * rate) / MICRO;

export const buildMoonwellBook = async (market, { refBlock } = {}) => {
  const m = MARKETS[market];
  if (!m) throw new Error(`unknown Moonwell market ${market}`);
  const rpc = makeRpc(MOONWELL.chainId);
  const ref = BigInt(refBlock ?? BigInt(await rpc.call('eth_blockNumber', [])) - 10n);

  const { slot, evidence } = await buildVenueSlot({ chainId: MOONWELL.chainId, pool: m.pool, collateral: m.token, refBlock: ref });

  const ts = word(await rpc.ethCall(m.mToken, SEL.totalSupply, ref));
  const er = word(await rpc.ethCall(m.mToken, SEL.exchangeRateStored, ref));
  const cf = word(await rpc.ethCall(MOONWELL.comptroller, SEL.markets + pad(m.mToken), ref), 1);
  const oracle = '0x' + (await rpc.ethCall(MOONWELL.comptroller, SEL.oracle, ref)).slice(-40);
  const px = word(await rpc.ethCall(oracle, SEL.getUnderlyingPrice + pad(m.mToken), ref)); // USD * 1e(36-dec)
  const pxScale = 10n ** BigInt(36 - m.decimals);

  const suppliedRaw = (ts * er) / E18;
  const q = normaliseDown(suppliedRaw, m.decimals);           // collateral micro-units, rounded down
  const marked = (suppliedRaw * px * MICRO) / pxScale / 10n ** BigInt(m.decimals); // USD micro
  const debt = (marked * cf) / E18;
  const proceeds = realisable(slot.reserveX, slot.reserveY, q, slot.feeBps); // quote micro-units
  const realisedUsd = toUsd(proceeds, slot.quoteRate);

  // The quote leg. For USDC there is none. For WETH, measure what selling the
  // proceeds into Base's only x*y=k WETH/USDC pool would cost on top: the
  // attestation values WETH at the mark, and this number says how much that
  // assumption is worth at this size.
  let quoteLeg = null;
  if (m.quote === 'WETH') {
    const r = await rpc.ethCall(WETH_USDC_CP, SEL.getReserves, ref);
    const wethRes = normaliseDown(word(r, 0), 18);
    const usdcRes = normaliseDown(word(r, 1), 6);
    const facts = await readPool(rpc, WETH_USDC_CP, ref);
    const viaPool = realisable(wethRes, usdcRes, proceeds, BigInt(facts.feeBps));
    quoteLeg = {
      pool: WETH_USDC_CP,
      label: facts.label,
      feeBps: facts.feeBps,
      wethReserve: Number(wethRes) / 1e6,
      usdcReserve: Number(usdcRes) / 1e6,
      wethSold: Number(proceeds) / 1e6,
      atMarkUsd: Number(realisedUsd) / 1e6,
      throughPoolUsd: Number(viaPool) / 1e6,
      extraImpactPct: (Number(realisedUsd - viaPool) / Number(realisedUsd)) * 100,
    };
  }

  return {
    market,
    refBlock: ref,
    venue: slot,
    book: { positions: [q], proceeds: [proceeds], debt },
    ratio: 1_000_000n,
    figures: {
      market,
      supplied: Number(q) / 1e6,
      oraclePrice: Number(px) / Number(pxScale),
      collateralFactor: Number(cf) / 1e18,
      quote: m.quote,
      quoteRateUsd: Number(slot.quoteRate) / 1e6,
      markedUsd: Number(marked) / 1e6,
      debtUsd: Number(debt) / 1e6,
      realisableQuote: Number(proceeds) / 1e6,
      realisableUsd: Number(realisedUsd) / 1e6,
      markedCoverage: Number(marked) / Number(debt),
      realisableCoverage: Number(realisedUsd) / Number(debt),
      gapUsd: Number(marked - realisedUsd) / 1e6,
      gapPct: (Number(marked - realisedUsd) / Number(marked)) * 100,
      poolQuoteReserve: Number(slot.reserveY) / 1e6,
      poolCollateralReserve: Number(slot.reserveX) / 1e6,
      quoteLeg,
    },
    sources: {
      chain: 'Base (8453)',
      block: ref.toString(),
      comptroller: MOONWELL.comptroller,
      mToken: m.mToken,
      oracle,
      pool: m.pool,
      raw: { mTokenTotalSupply: ts.toString(), exchangeRateStored: er.toString(), collateralFactorMantissa: cf.toString(), oraclePrice: px.toString() },
      venueEvidence: { kind: evidence.label, feeBps: evidence.feeBps, quote: evidence.quoteSymbol, quoteRateSource: evidence.quoteRateSource },
    },
  };
};

if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv?.[1]}`) {
  const b = await buildMoonwellBook((process.argv[2] ?? 'AERO').toUpperCase());
  const f = b.figures;
  const usd = (x) => '$' + x.toLocaleString('en', { maximumFractionDigits: 0 });
  console.log(`Moonwell ${f.market} book at Base block ${b.refBlock}`);
  console.log(`  supplied            ${f.supplied.toLocaleString('en', { maximumFractionDigits: 0 })} ${f.market}`);
  console.log(`  Moonwell oracle     $${f.oraclePrice.toPrecision(6)}  collateral factor ${(f.collateralFactor * 100).toFixed(0)}%`);
  console.log(`  marked value        ${usd(f.markedUsd)}`);
  console.log(`  debt it may secure  ${usd(f.debtUsd)}`);
  console.log(`  realisable at exit  ${usd(f.realisableUsd)}   (${f.realisableQuote.toLocaleString('en', { maximumFractionDigits: 2 })} ${f.quote} from ${b.sources.venueEvidence.kind}, ${b.sources.venueEvidence.feeBps} bps; ${f.quote} at $${f.quoteRateUsd})`);
  console.log(`  coverage at marks       ${f.markedCoverage.toFixed(2)}x`);
  console.log(`  coverage at realisable  ${f.realisableCoverage.toFixed(2)}x`);
  console.log(`  value that does not exist at exit: ${usd(f.gapUsd)} (${f.gapPct.toFixed(1)}% of the marked value)`);
  if (f.quoteLeg) {
    const l = f.quoteLeg;
    console.log(`  WETH leg: ${l.wethSold.toFixed(2)} WETH at the mark ${usd(l.atMarkUsd)}; through ${l.label} ${l.pool} (${l.wethReserve.toFixed(0)} WETH / ${usd(l.usdcReserve)}) ${usd(l.throughPoolUsd)}, ${l.extraImpactPct.toFixed(2)}% less`);
  }
}
