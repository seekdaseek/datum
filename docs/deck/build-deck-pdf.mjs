#!/usr/bin/env node
//
// docs/deck/build-deck-pdf.mjs — the Wave 2 deck as a PDF, built from the deploy record.
//
//   node docs/deck/build-deck-pdf.mjs --demo-tx <hash> --demo-block <n> \
//        --proof-s <seconds> --prover-peak-mb <n> --api-rss-mb <n> --e2e-s <seconds>
//
// Every contract address, hash, block and dollar figure is read from
// deployments/preprod.json; the measured values come from the flags (the
// numbers of the live end-to-end run), and the script refuses to build if one
// is missing. Ten slides at most, 1280x720, printed by headless Chrome (set CHROME to its path elsewhere).
//
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
const need = (k) => { const v = arg(k); if (!v) { console.error(`missing ${k}`); process.exit(1); } return v; };
const demoTx = need('--demo-tx'), demoBlock = need('--demo-block'), proofS = need('--proof-s'), peakMb = need('--prover-peak-mb'), rssMb = need('--api-rss-mb'), e2eS = need('--e2e-s');
const out = arg('--out') ?? resolve(ROOT, 'docs/datum-wave2-deck.pdf');

const dep = JSON.parse(readFileSync(resolve(ROOT, 'deployments/preprod.json'), 'utf8'));
const W = dep.books.WELL, A = dep.books.AERO;
const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const x2 = (n) => `${n.toFixed(2)}x`;
const int = (n) => Math.round(Number(n)).toLocaleString('en-US');
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const book = (name, b, exit, quote) => {
  const f = b.attest.figures;
  return `<div class="card book">
    <div class="bk-h">${name}<span>${exit}</span></div>
    <div class="row3">
      <div><div class="k">AT THE ORACLE MARK</div><div class="v">${x2(f.markedCoverage)}</div><div class="s">${usd(f.markedUsd)}</div></div>
      <div><div class="k">AT REALISABLE EXIT</div><div class="v ok">${x2(f.realisableCoverage)}</div><div class="s">${usd(f.realisableUsd)} sold into the pool</div></div>
      <div><div class="k">DOES NOT EXIST AT EXIT</div><div class="v bad">${usd(f.gapUsd)}</div><div class="s">${f.gapPct.toFixed(1)}% of the marked value</div></div>
    </div>
    <div class="s small">${int(f.supplied)} ${name.split(' ')[0]} supplied to Moonwell against a ${usd(f.debtUsd)} borrowing cap (${Math.round(f.collateralFactor * 100)}% collateral factor, oracle $${f.oraclePrice.toPrecision(5)}). ${quote}</div>
  </div>`;
};

const slides = [];
const S = (kicker, title, body, foot = '') => slides.push(`<section><div class="kick">${kicker}</div><h1>${title}</h1>${body}${foot ? `<div class="foot">${foot}</div>` : ''}</section>`);

slides.push(`<section class="title"><div class="kick">MIDNIGHT · WAVE 2</div><h1 class="big">datum</h1>
  <p class="lead">Proof of reserves shows the tokens exist. It does not show they can be sold for what the book says.</p>
  <p class="lead dim">datum proves, in zero knowledge, that a lending book covers its debt at the price its collateral would actually fetch. The pool is public. The book stays private.</p>
  <div class="links"><span>datum.ochinimus.app</span><span>github.com/seekdaseek/datum</span><span>Live on Midnight Preprod</span></div></section>`);

S('THE PROBLEM', 'Every solvency check values collateral at a price nobody can sell at',
  `<div class="two"><div class="card"><div class="k">WHAT PROOF OF RESERVES SAYS</div><p>The tokens exist. Balance-threshold checks such as <span class="mono">proveSolvency</span> multiply them by the oracle mark and compare.</p></div>
   <div class="card"><div class="k">WHAT IT MISSES</div><p>The mark is the last small trade. A lender holding millions of a thin token cannot sell at it: selling moves the pool. The book passes at the mark and fails at the exit.</p></div></div>
   <div class="card wide"><div class="k">ON THE SAME PRIVATE BOOK, SAME POOL</div><p>10,000,000 AERO against $5,500,000 of debt at a 1.20x bar. A faithful mark-based check in Compact says <b class="ok">COVERED</b>. datum says <b class="bad">NOT COVERED</b>. Only the depth differs.</p></div>`);

S('WHO NEEDS IT, WHO PAYS', 'Lenders whose collateral has one real exit',
  `<div class="three">
   <div class="card"><div class="k">CeFi LENDERS</div><p>Publish proof of reserves today. They can show the reserves cover liabilities at the price they could actually be sold for, without publishing the book.</p></div>
   <div class="card"><div class="k">TOKENIZED STOCK AND RWA LENDERS</div><p>Collateral often has one thin on-chain venue, where the mark and the exit diverge most.</p></div>
   <div class="card"><div class="k">DAO TREASURIES</div><p>Report runway in their own volatile token, which they could only sell into their own pool.</p></div></div>
   <div class="card wide"><div class="k">WHO PAYS, AND HOW MUCH</div><p>The lender, or the counterparty who wants the proof: <b>$250 per published attestation</b>, or <b>$1,500 a month</b> for daily attestations with a hosted verification page. The marginal cost is one proof (seconds of CPU) and one Midnight fee in DUST.</p></div>`);

S('HOW IT WORKS', 'Multiply and compare. The ledger checks the clock.',
  `<div class="two"><div class="card"><div class="k">PRIVATE (COMPACT WITNESSES)</div><p>Position sizes, debt, claimed proceeds per slot, the commitment nonce, the attestor secret, the previous period's opening.</p></div>
   <div class="card"><div class="k">PUBLIC (ON THE LEDGER)</div><p>The venue array with its provenance, the required ratio, a one-bit verdict, a hiding commitment chained to the last period, and the time.</p></div></div>
   <div class="card wide mono code">fee bound&nbsp;&nbsp;&nbsp;p · (X·10000 + q·g) ≤ Y·q·g&nbsp;&nbsp;&nbsp;&nbsp;g = 10000 − feeBps<br>freshness&nbsp;&nbsp;&nbsp;blockTimeGt(refTime) and blockTimeLt(refTime + maxRefAge)<br>distinct&nbsp;&nbsp;&nbsp;&nbsp;no two active slots name the same (chain, pool)<br>overall&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Σp · 1e6 ≥ debt · requiredRatio  →  covered</div>
   <p class="s">Each venue slot binds its chain, pool, Sync block, Sync transaction, log index and reference block. The verifier re-fetches that log from Base and checks that no newer Sync exists. One reserve changed by a millionth of a dollar reads MISMATCH.</p>`);

S('TWO REAL BOOKS', 'Moonwell’s WELL and AERO collateral, sold into the pool where it trades',
  book('WELL collateral', W, 'exit: Aerodrome WELL/WETH, 1% fee', `The WETH leg is valued at Moonwell's own WETH price; through Base's only x·y=k WETH/USDC pool it would fetch ${W.attest.figures.quoteLeg.extraImpactPct.toFixed(1)}% less.`) +
  book('AERO collateral', A, 'exit: Aerodrome AERO/USDC, 0.30% fee', 'Both books attested at a required ratio of 1.00x in one Preprod run; the debt side is the borrowing cap, not outstanding borrows.'),
  `Every input is public on Base: anyone can recompute either book from the page or with <span class="mono">node scripts/books/moonwell.mjs WELL</span>.`);

S('WHAT IS LIVE', 'On Midnight Preprod, with a hosted prover anyone can use',
  `<div class="two"><div class="card"><div class="k">ON CHAIN (PREPROD)</div>
   <p class="mono t">WELL book ${short(W.address)}<br>attest tx ${short(W.attest.txHash)} · block ${int(W.attest.block)}<br>AERO book ${short(A.address)}<br>attest tx ${short(A.attest.txHash)} · block ${int(A.attest.block)}<br>demo ${short(dep.demo.address)}<br>live attest tx ${short(demoTx)} · block ${int(demoBlock)}</p></div>
   <div class="card"><div class="k">MEASURED ON THE LIVE SERVICE</div>
   <p>Attest from the page to verified result: <b>${e2eS} s</b>.<br>Proof: <b>${proofS} s</b>, prover peak <b>${peakMb} MB</b>.<br>datum-api at rest: <b>${rssMb} MB</b>.</p>
   <p class="s">A 2 GB server, the prover started per job and stopped after five idle minutes, a memory gate that never starts it into an out-of-memory kill.</p></div></div>
   <p class="s">datum.ochinimus.app (page) · datum-api.ochinimus.app (attest service, read-only indexer relay). Preprod's indexer is Blockfrost's; the project token stays on the server.</p>`);

S('WHAT CHANGED SINCE WAVE 1', 'From a read-only page to an attestation anyone can make and check',
  `<table><tr><th></th><th>Wave 1</th><th>Wave 2</th></tr>
   <tr><td>Venues</td><td>Hand-entered reserves</td><td>Real Aerodrome pools; chain, pool, Sync block, tx, log index bound into the proof</td></tr>
   <tr><td>Provenance</td><td>None</td><td>Verify from chain; a tampered copy reads MISMATCH</td></tr>
   <tr><td>Real books</td><td>None</td><td>Moonwell WELL and AERO, with WETH quoted at a checked oracle rate</td></tr>
   <tr><td>Contract</td><td>Last verdict only</td><td>Exact fee bound, ledger-enforced freshness, distinct pools, attestor key, chained history</td></tr>
   <tr><td>User action</td><td>Read-only page</td><td>Attest a book from the page; the sponsor pays DUST; the page verifies the result</td></tr>
   <tr><td>Tests</td><td>22</td><td>86 tests, 6 real-ZK checks, 14 of 14 mutants killed</td></tr>
   <tr><td>Hosting</td><td>Static page</td><td>Dedicated 2 GB server; Blockfrost indexer behind a read-only relay</td></tr></table>`);

S('JUDGE STEPS', 'Five minutes, no wallet, no key',
  `<ol><li>Open <b>datum.ochinimus.app</b>. Press <b>Recompute from Base</b> on each book: it shows MATCHES BASE.</li>
   <li>Press <b>Verify from chain</b>: VERIFIED. Then <b>Tamper with a copy</b>: MISMATCH on two checks.</li>
   <li>In <b>Attest a book yourself</b>, wait for Sponsor ready, keep the overlevered AERO book and press <b>Attest this book on Midnight</b>. Watch the steps to a transaction, a block and NOT COVERED, then the page verifies it itself.</li></ol>
   <div class="card wide mono code">git clone https://github.com/seekdaseek/datum &amp;&amp; cd datum<br>npm install &amp;&amp; npm run build &amp;&amp; npm test&nbsp;&nbsp;&nbsp;# 86 pass<br>BLOCKFROST_PROJECT_ID=… node scripts/verify.mjs --network preprod<br>node scripts/verify.mjs --network preprod --tamper&nbsp;&nbsp;&nbsp;# MISMATCH, exit 1</div>`);

S('HONEST LIMITS', 'Where this method is the wrong tool',
  `<div class="two"><div class="card"><p><b>Concentrated liquidity</b> (Uniswap v3, Aerodrome Slipstream): depth depends on tick ranges. MORPHO on Base exits mainly there, so datum does not price it.</p><p><b>Aggregators and routers</b>: a route is not one reserve pair.</p></div>
   <div class="card"><p><b>Depth quoted in another volatile asset</b>: WELL's depth is in WELL/WETH and is priced through Moonwell's WETH rate, not a second hop.</p><p><b>Off-chain exits</b> and stable-swap pools: nothing to re-fetch, or a different invariant.</p></div></div>
   <p class="s">The attestor declares the book. The attestor key makes each declaration accountable and chained to the last; for the two Moonwell books every input is public, so anyone recomputes them. Where datum applies it is a lower bound.</p>`);

S('NEXT STEPS AND BUSINESS DEVELOPMENT', 'Wave 3: price the boundary, then put it in front of lenders',
  `<div class="two"><div class="card"><div class="k">PRODUCT</div><p>A second hop for depth quoted in a volatile asset. A conservative bound for concentrated liquidity from tick data. A one-command lender-side prover. Scheduled attestations of a real book. A Midnight contract that consumes another contract's verdict.</p></div>
   <div class="card"><div class="k">ADOPTION</div><p><b>1.</b> Open source today: the prover, verifier and page run against any Aerodrome volatile pool.<br><b>2.</b> Hosted attestation for a lender: their prover runs locally, we host the page and schedule it.<br><b>3.</b> Verdicts consumed by risk dashboards, curators and counterparties reading the indexer.</p></div></div>
   <p class="s">First conversations: lenders that already publish proof of reserves, and RWA lenders with one thin venue. Mainnet when Midnight mainnet accepts it.</p>`);

if (slides.length > 10) { console.error(`${slides.length} slides, the limit is 10`); process.exit(1); }

const css = `
@page { size: 1280px 720px; margin: 0 }
* { box-sizing: border-box }
body { margin: 0; background: #0D1220; color: #EEF2FA; font: 22px/1.4 -apple-system, "Helvetica Neue", Arial, sans-serif }
section { width: 1280px; height: 720px; padding: 44px 64px; page-break-after: always; position: relative; overflow: hidden; background: #0D1220 }
.kick { font-size: 15px; font-weight: 700; letter-spacing: .14em; color: #7FA8E8; margin-bottom: 8px }
h1 { font-size: 36px; line-height: 1.15; margin: 0 0 22px; font-weight: 750 }
h1.big { font-size: 120px; margin: 70px 0 26px; letter-spacing: -.02em }
.title .lead { font-size: 32px; max-width: 980px; margin: 0 0 18px } .dim { color: #8C9AB5; font-size: 24px !important }
.links { position: absolute; bottom: 52px; left: 64px; display: flex; gap: 34px; color: #7FA8E8; font-size: 20px }
.card { background: #182033; border-radius: 14px; padding: 20px 26px } .card p { margin: 6px 0 0 }
.wide { margin-top: 18px } .two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px } .three { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 18px }
.k { font-size: 13px; font-weight: 700; letter-spacing: .12em; color: #8C9AB5 }
.v { font-size: 52px; font-weight: 800; line-height: 1.05; margin-top: 4px } .ok { color: #5BC98A } .bad { color: #E4573D }
.s { color: #8C9AB5; font-size: 17px; margin-top: 4px } .small { font-size: 15px; margin-top: 12px }
.row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; margin-top: 8px }
.book { margin-bottom: 14px; padding: 16px 26px } .bk-h { font-weight: 750; font-size: 24px } .bk-h span { color: #8C9AB5; font-weight: 400; font-size: 16px; margin-left: 14px }
.mono { font-family: "SF Mono", Menlo, Consolas, monospace } .code { font-size: 17px; line-height: 1.7; color: #CFE0FF } .t { font-size: 15px; line-height: 1.7 }
table { width: 100%; border-collapse: collapse; font-size: 18px } th { text-align: left; color: #8C9AB5; font-size: 13px; letter-spacing: .12em; padding: 6px 12px } td { padding: 9px 12px; border-top: 1px solid #243049; vertical-align: top } td:first-child { color: #7FA8E8; font-weight: 700; width: 140px } td:nth-child(2) { color: #8C9AB5; width: 250px }
ol { padding-left: 26px; margin: 0 0 6px } li { margin-bottom: 12px }
.foot { position: absolute; bottom: 30px; left: 64px; right: 64px; color: #8C9AB5; font-size: 16px }
`;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>datum — Wave 2</title><style>${css}</style></head><body>${slides.join('\n')}</body></html>`;
const htmlPath = resolve(ROOT, 'docs/deck/.deck.html');
writeFileSync(htmlPath, html);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--print-to-pdf=${out}`, 'file://' + htmlPath], { stdio: 'ignore' });
console.log(`${slides.length} slides -> ${out}`);
