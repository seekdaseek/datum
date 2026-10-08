#!/usr/bin/env node
//
// scripts/fill-docs.mjs — put the deployed numbers into the docs.
//
//   node scripts/fill-docs.mjs [--network preprod] [--set KEY=VALUE ...] [--check]
//
// The docs carry ⟨TOKEN⟩ placeholders for every figure that comes from a
// deployment. This replaces them from deployments/<network>.json, plus any
// measured values passed with --set (e.g. VPS_PROOF=12.3 s). It refuses to
// write if any placeholder would be left unfilled, and --check only lists
// them, so a stale or invented number cannot reach the README.
//
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// docs/VIDEO.md is filled by hand at recording time: its numbers are spoken words.
const FILES = ['README.md', 'JUDGE_GUIDE.md', 'docs/SUBMISSION-WAVE2.md'];
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const NET = arg('--network', 'preprod');
const dep = JSON.parse(readFileSync(resolve(ROOT, `deployments/${NET}.json`), 'utf8'));

const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
const x2 = (n) => `${n.toFixed(2)}x`;
const pct = (n) => `${n.toFixed(1)}%`;
const int = (n) => Math.round(Number(n)).toLocaleString('en-US');

const T = {};
for (const [market, b] of Object.entries(dep.books ?? {})) {
  const a = b.attest;
  if (!a) continue;
  const f = a.figures;
  const P = (k, v) => { T[`${market}_${k}`] = v; };
  P('ADDR', b.address);
  P('TX', a.txHash);
  P('TX_SHORT', `${a.txHash.slice(0, 10)}…${a.txHash.slice(-6)}`);
  P('BLOCK', int(a.block));
  P('VERDICT', a.covered === false ? 'NOT COVERED' : 'COVERED');
  P('RATIO', `${(a.requiredRatio ?? 1).toFixed(2)}x`);
  P('SUPPLIED', int(f.supplied));
  P('MARK_X', x2(f.markedCoverage));
  P('REAL_X', x2(f.realisableCoverage));
  P('MARKED_USD', usd(f.markedUsd));
  P('REAL_USD', usd(f.realisableUsd));
  P('GAP_USD', usd(f.gapUsd));
  P('GAP_PCT', pct(f.gapPct));
  P('DEBT_USD', usd(f.debtUsd));
  P('CF', `${Math.round(f.collateralFactor * 100)}%`);
  P('ORACLE', f.oraclePrice.toPrecision(6));
  P('BASE_BLOCK', int(a.baseRefBlock));
  if (f.quoteLeg) {
    P('WETH', f.quoteRateUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    P('WETH_SOLD', f.quoteLeg.wethSold.toFixed(2));
    P('LEG_USD', usd(f.quoteLeg.throughPoolUsd));
    P('LEG_PCT', pct(f.quoteLeg.extraImpactPct));
  }
}
if (dep.demo) T.DEMO_ADDR = dep.demo.address;

const rows = [];
for (const [market, b] of Object.entries(dep.books ?? {})) {
  if (b.deploy) rows.push(`| ${market} book: deploy | \`${b.address}\` | \`${b.deploy.txHash}\` | ${int(b.deploy.block)} |`);
  if (b.attest) rows.push(`| ${market} book: attest, period ${b.attest.period}, ${b.attest.covered === false ? 'NOT COVERED' : 'COVERED'} | | \`${b.attest.txHash}\` | ${int(b.attest.block)} |`);
}
if (dep.demo?.deploy) rows.push(`| Demo contract (hosted attest flow): deploy | \`${dep.demo.address}\` | \`${dep.demo.deploy.txHash}\` | ${int(dep.demo.deploy.block)} |`);
T.DEPLOY_TABLE = ['| Step | Contract | Transaction hash | Block |', '|---|---|---|---|', ...rows].join('\n');

for (let i = 0; i < args.length; i++) if (args[i] === '--set') { const [k, ...v] = args[i + 1].split('='); T[k] = v.join('='); }

let missing = [];
const out = {};
for (const f of FILES) {
  const path = resolve(ROOT, f);
  const s = readFileSync(path, 'utf8');
  const filled = s.replace(/⟨([A-Z0-9_]+)⟩/g, (m, k) => (k in T ? T[k] : (missing.push(`${f}: ${k}`), m)));
  out[path] = filled;
}
if (args.includes('--check') || missing.length) {
  console.log(missing.length ? `unfilled:\n  ${[...new Set(missing)].join('\n  ')}` : 'every placeholder can be filled');
  console.log(`known: ${Object.keys(T).sort().join(' ')}`);
  process.exit(missing.length ? 1 : 0);
}
for (const [path, s] of Object.entries(out)) writeFileSync(path, s);
console.log(`filled ${FILES.length} files from deployments/${NET}.json`);
