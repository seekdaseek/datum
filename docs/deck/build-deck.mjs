#!/usr/bin/env node
//
// docs/deck/build-deck.mjs — the Wave 2 deck, built from the deploy record.
//
//   node docs/deck/build-deck.mjs [--network preprod] [--demo-tx <hash> --demo-block <n>]
//
// Every hash, block and figure on the slides is read from
// deployments/<network>.json, so the deck cannot drift from what is deployed.
// Same palette and type as the Wave 1 deck.
//
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pptxgen from 'pptxgenjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const NET = arg('--network', 'preprod');
const dep = JSON.parse(readFileSync(resolve(ROOT, `deployments/${NET}.json`), 'utf8'));
const a = dep.book.attest;
const f = a.figures;

const C = { bg: '0D1220', card: '182033', fg: 'EEF2FA', dim: '8C9AB5', accent: '7FA8E8', bad: 'E4573D', warn: 'E0A44C', ok: '5BC98A' };
const H = 'Calibri';
const M = 'Courier New';
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const x2 = (n) => `${n.toFixed(2)}x`;
const split = (h) => `${h.slice(0, 32)}\n${h.slice(32)}`;

const pptx = new pptxgen();
pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
pptx.title = 'datum — Wave 2';

const slide = (kicker, title) => {
  const s = pptx.addSlide();
  s.background = { color: C.bg };
  if (kicker) s.addText(kicker, { x: 0.6, y: 0.4, w: 12, h: 0.35, fontFace: H, fontSize: 13, bold: true, color: C.accent, charSpacing: 2 });
  if (title) s.addText(title, { x: 0.6, y: 0.75, w: 12.1, h: 0.9, fontFace: H, fontSize: 30, bold: true, color: C.fg });
  return s;
};
const card = (s, x, y, w, h, fill = C.card) => s.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: fill }, line: { color: fill }, rectRadius: 0.12 });
const body = (s, text, o) => s.addText(text, { fontFace: H, fontSize: 16, color: C.dim, valign: 'top', ...o });

// 1. title
{
  const s = slide(null, null);
  s.addText('Proof of reserves shows the tokens exist,\nnot that they can be sold for what the book says.', { x: 0.6, y: 0.9, w: 12.1, h: 1.8, fontFace: H, fontSize: 32, bold: true, color: C.fg });
  s.addText('datum', { x: 0.6, y: 2.9, w: 6, h: 0.8, fontFace: H, fontSize: 40, bold: true, color: C.accent });
  body(s, 'Proves, in zero knowledge on Midnight, that a lending book covers its debt at realisable exit prices: what its collateral would fetch sold into the pool where it trades. The depth is public. The book stays private.', { x: 0.6, y: 3.7, w: 11.5, h: 1.2, fontSize: 18 });
  const rows = [['LIVE', 'datum.ochinimus.app'], ['NETWORK', 'Midnight Preprod'], ['REPO', 'github.com/seekdaseek/datum']];
  rows.forEach(([k, v], i) => {
    s.addText(k, { x: 0.6, y: 5.3 + i * 0.45, w: 1.6, h: 0.4, fontFace: H, fontSize: 12, bold: true, color: C.dim, charSpacing: 2 });
    s.addText(v, { x: 2.2, y: 5.3 + i * 0.45, w: 8, h: 0.4, fontFace: H, fontSize: 16, color: C.fg });
  });
  s.addText('Midnight Buildathon · Wave 2', { x: 0.6, y: 6.8, w: 8, h: 0.4, fontFace: H, fontSize: 12, color: C.dim });
}

// 2. the real book
{
  const s = slide('A REAL BOOK', 'Moonwell’s AERO collateral on Base');
  body(s, `All AERO supplied to Moonwell, against the most debt its ${Math.round(f.collateralFactor * 100)}% collateral factor lets it secure. Base block ${Number(a.baseRefBlock).toLocaleString('en-US')}. Exit: Aerodrome volatile AERO/USDC, 0.30% fee.`, { x: 0.6, y: 1.65, w: 12, h: 0.8 });
  const cols = [
    ['AT THE ORACLE MARK', x2(f.markedCoverage), `${usd(f.markedUsd)} at $${f.oraclePrice.toFixed(4)}`, C.fg, C.card],
    ['DOES NOT EXIST AT EXIT', usd(f.gapUsd), `${f.gapPct.toFixed(1)}% of the marked value`, C.bad, '2A1418'],
    ['AT REALISABLE EXIT', x2(f.realisableCoverage), `${usd(f.realisableUsd)} sold into the pool`, C.fg, C.card],
  ];
  cols.forEach(([k, big, sub, col, fill], i) => {
    const x = 0.6 + i * 4.1;
    card(s, x, 2.7, 3.85, 2.6, fill);
    s.addText(k, { x, y: 2.9, w: 3.85, h: 0.4, align: 'center', fontFace: H, fontSize: 12, bold: true, color: C.dim, charSpacing: 2 });
    s.addText(big, { x, y: 3.4, w: 3.85, h: 1.0, align: 'center', fontFace: H, fontSize: 44, bold: true, color: col });
    s.addText(sub, { x, y: 4.5, w: 3.85, h: 0.5, align: 'center', fontFace: H, fontSize: 14, color: C.dim });
  });
  body(s, `${Math.round(f.suppliedAero).toLocaleString('en-US')} AERO supplied · debt it may secure ${usd(f.debtUsd)}. Every input is public on Base; the page recomputes it from a public node. This book is public so judges can check it; a lender’s would not be.`, { x: 0.6, y: 5.6, w: 12, h: 1 });
}

// 3. three checks, one book
{
  const s = slide('THE CONTROL', 'Three checks, one book');
  body(s, '10,000,000 AERO against $5,500,000 of debt at a 1.20x bar, priced against the same pool. The balance-threshold check is a faithful mark-based check written in Compact and run on the same private book.', { x: 0.6, y: 1.65, w: 12, h: 0.8 });
  const rows = [
    ['', 'Proof of reserves', 'Balance threshold', 'datum'],
    ['Proves the tokens exist', 'yes', 'yes', 'yes, privately'],
    ['Values collateral at', 'nothing', 'the oracle mark', 'the price the pool pays'],
    ['Depth and price impact', 'no', 'no', 'constant-product with fee'],
    ['Venue provable from its chain', 'n/a', 'n/a', 'Sync log, block, tx, log index'],
    ['Verdict on this book', 'none', 'COVERED 1.41x', 'NOT COVERED 1.04x'],
  ];
  s.addTable(rows.map((r, i) => r.map((c, j) => ({
    text: c,
    options: {
      fontFace: H, fontSize: i === 0 ? 13 : 15, bold: i === 0 || i === rows.length - 1,
      color: i === rows.length - 1 && j === 2 ? C.ok : i === rows.length - 1 && j === 3 ? C.bad : i === 0 ? C.dim : C.fg,
      fill: { color: j === 3 ? '15233D' : C.card },
    },
  }))), { x: 0.6, y: 2.6, w: 12.1, colW: [3.4, 2.6, 2.8, 3.3], border: { type: 'solid', color: C.bg, pt: 2 }, rowH: 0.55 });
  body(s, 'Not rigged: on a book small against the depth both say COVERED; on a book short even at the mark both say NOT COVERED. test/control.test.mjs', { x: 0.6, y: 6.2, w: 12, h: 0.7, fontSize: 14 });
}

// 4. provenance
{
  const s = slide('PROVENANCE', 'Every reserve comes with its own proof of origin');
  const items = [
    ['Bound into the proof', 'Per slot: chain id, pool, Sync block, Sync tx hash, log index, reference block and its timestamp, reserves. One digest, venuesHash, recomputed by an exported pure circuit.'],
    ['Re-fetched by anyone', 'Twelve checks per slot against a public Base RPC: known constant-product factory, volatile pool, USD quote, decimals, fee at the block, the log, its transaction, both reserves.'],
    ['Tamper', 'A copy with one reserve changed by one millionth of a dollar reads MISMATCH twice: against the bound digest and against the Sync log. On the page, in the CLI, and in a named test.'],
    ['Cherry-pick', 'A real but older Sync, from when the pool was deeper, passes every log check and is rejected by the window: no newer Sync may exist before the reference block. The ledger enforces the reference block is fresh.'],
  ];
  items.forEach(([k, v], i) => {
    const x = 0.6 + (i % 2) * 6.15, y = 1.8 + Math.floor(i / 2) * 2.55;
    card(s, x, y, 5.95, 2.35);
    s.addText(k, { x: x + 0.25, y: y + 0.2, w: 5.5, h: 0.45, fontFace: H, fontSize: 18, bold: true, color: i >= 2 ? C.warn : C.accent });
    body(s, v, { x: x + 0.25, y: y + 0.7, w: 5.5, h: 1.6, fontSize: 15 });
  });
}

// 5. the circuit
{
  const s = slide('THE CIRCUIT, v2', 'Multiply and compare. The ledger checks the clock.');
  const lines = [
    ['fee bound', 'p × (X·10000 + q·g)  ≤  Y × q × g        g = 10000 − fee'],
    ['freshness', 'blockTimeGt(refTime)  and  blockTimeLt(refTime + maxRefAge)'],
    ['distinct', 'no two active slots name the same (chain, pool)'],
    ['attestor', 'hash(secret) = the registered attestor key'],
    ['chain', 'open period N−1 privately; commit period N to its head'],
    ['verdict', 'Σp × 10⁶  ≥  debt × requiredRatio   →  covered'],
  ];
  lines.forEach(([k, v], i) => {
    s.addText(k, { x: 0.6, y: 1.9 + i * 0.72, w: 2.2, h: 0.55, fontFace: H, fontSize: 16, bold: true, color: C.accent });
    s.addText(v, { x: 2.8, y: 1.9 + i * 0.72, w: 10, h: 0.55, fontFace: M, fontSize: 16, color: C.fg });
  });
  body(s, 'Private: positions, debt, claimed proceeds, nonce, attestor secret, previous opening. Public: venues with provenance, ratio, verdict, chained commitment, history. 4 slots, k=15.', { x: 0.6, y: 6.3, w: 12, h: 0.8, fontSize: 14 });
}

// 6. attest from the page
{
  const s = slide('THE USER ACTION', 'Attest a book from the page');
  const steps = ['Pick or edit a sample book', 'Fresh reserves read from Base', 'Proved in zero knowledge', 'Sponsor wallet pays DUST', 'Lands on Preprod: hash, block, verdict', 'The page verifies it from chain itself'];
  steps.forEach((t, i) => {
    card(s, 0.6, 1.8 + i * 0.68, 5.6, 0.56);
    s.addText(`${i + 1}  ${t}`, { x: 0.8, y: 1.8 + i * 0.68, w: 5.3, h: 0.56, fontFace: H, fontSize: 16, color: C.fg, valign: 'middle' });
  });
  card(s, 6.6, 1.8, 6.1, 1.9, '15233D');
  s.addText('PRIVACY BOUNDARY', { x: 6.85, y: 1.95, w: 5.6, h: 0.4, fontFace: H, fontSize: 12, bold: true, color: C.accent, charSpacing: 2 });
  body(s, 'The hosted demo prover sees the sample book. A real lender runs the same prover locally; the book never leaves their machine.', { x: 6.85, y: 2.4, w: 5.6, h: 1.2, fontSize: 15, color: C.fg });
  body(s, 'Hosted on a shared VPS as its own PM2 processes and tunnel, each under systemd-run --scope: hard memory cap, no swap, one core, nice 10, OOM-killed first. Prover reachable only on loopback. One proof at a time; per-visitor limits; sponsor state always visible. Sponsor wallet synced once on a Mac and shipped as a checkpoint.', { x: 6.6, y: 3.95, w: 6.1, h: 2.6, fontSize: 14 });
}

// 7. deployed
{
  const s = slide('IT IS DEPLOYED', 'Live on Midnight Preprod');
  const rows = [
    ['BOOK CONTRACT', split(dep.book.address)],
    ['ATTEST TX', split(a.txHash)],
    ['BLOCK', `${a.block}   ·   ${a.status}`],
    ['DEMO CONTRACT', split(dep.demo.address)],
  ];
  if (arg('--demo-tx')) rows.push(['DEMO ATTEST TX', `${split(arg('--demo-tx'))}`]);
  rows.forEach(([k, v], i) => {
    s.addText(k, { x: 0.6, y: 1.8 + i * 0.95, w: 2.8, h: 0.8, fontFace: H, fontSize: 13, bold: true, color: C.dim, charSpacing: 2, valign: 'top' });
    s.addText(v, { x: 3.4, y: 1.8 + i * 0.95, w: 9.3, h: 0.85, fontFace: M, fontSize: 16, color: C.fg, valign: 'top' });
  });
  body(s, 'Check it cold: node scripts/verify.mjs --network preprod  (VERIFIED, exit 0)  ·  --tamper  (MISMATCH, exit 1)', { x: 0.6, y: 6.6, w: 12, h: 0.5, fontSize: 14 });
}

// 8. who and how much
{
  const s = slide('WHO IT IS FOR', 'Lenders whose collateral has one real exit');
  const who = [
    ['CeFi lenders publishing proof of reserves', 'Show the reserves cover liabilities at the price they could be sold for, without publishing the book.'],
    ['Tokenized-stock and RWA lenders', 'Thin on-chain venues are where the mark and the exit diverge most.'],
    ['DAO treasuries', 'Runway in their own token, which they could only sell into their own pool.'],
  ];
  who.forEach(([k, v], i) => {
    s.addText(k, { x: 0.6, y: 1.8 + i * 1.1, w: 6.2, h: 0.45, fontFace: H, fontSize: 18, bold: true, color: C.fg });
    body(s, v, { x: 0.6, y: 2.25 + i * 1.1, w: 6.2, h: 0.6, fontSize: 14 });
  });
  card(s, 7.2, 1.8, 5.5, 4.4);
  s.addText('ADOPTION', { x: 7.45, y: 1.95, w: 5, h: 0.4, fontFace: H, fontSize: 12, bold: true, color: C.accent, charSpacing: 2 });
  body(s, '1  Open source: CLI prover, verifier, page\n2  Hosted attestations, lender proves locally\n3  Verdicts consumed by dashboards, curators and other Midnight contracts', { x: 7.45, y: 2.4, w: 5, h: 1.8, fontSize: 15, color: C.fg });
  s.addText('PRICE', { x: 7.45, y: 4.3, w: 5, h: 0.4, fontFace: H, fontSize: 12, bold: true, color: C.accent, charSpacing: 2 });
  body(s, '$250 per published attestation\n$1,500 / month for daily attestations', { x: 7.45, y: 4.75, w: 5, h: 1.2, fontSize: 16, color: C.fg });
}

// 9. boundary and wave 3
{
  const s = slide('HONEST LIMITS, AND WHAT IS NEXT', 'Where this method is the wrong tool');
  body(s, '• Concentrated liquidity (Uniswap v3, Slipstream): depth is tick ranges, not x·y=k\n• Aggregators and routers: a route is not one reserve pair\n• Depth quoted in another volatile asset (WELL via WETH)\n• Stable-swap pools: a different invariant\n• Off-chain exits: nothing to re-fetch\n• The prover still supplies its own book; the chained commitment makes a lie costly to maintain', { x: 0.6, y: 1.8, w: 6.2, h: 4.5, fontSize: 15, color: C.fg, paraSpaceAfter: 6 });
  card(s, 7.2, 1.8, 5.5, 4.5);
  s.addText('WAVE 3', { x: 7.45, y: 1.95, w: 5, h: 0.4, fontFace: H, fontSize: 12, bold: true, color: C.accent, charSpacing: 2 });
  body(s, '• Second hop for depth in a volatile quote\n• Conservative bound for concentrated liquidity\n• Packaged lender-side prover, scheduled attestations\n• A Midnight contract that consumes another’s verdict\n• Mainnet', { x: 7.45, y: 2.4, w: 5, h: 3.8, fontSize: 15, color: C.fg, paraSpaceAfter: 6 });
  s.addText('Why Midnight: the depth is public and the book is private, and Midnight holds both in one contract.', { x: 0.6, y: 6.55, w: 12.1, h: 0.5, fontFace: H, fontSize: 15, bold: true, color: C.accent });
}

const out = resolve(ROOT, 'docs/datum-wave2-deck.pptx');
await pptx.writeFile({ fileName: out });
console.log(`wrote ${out}`);
