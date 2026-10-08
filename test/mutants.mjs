#!/usr/bin/env node
//
// test/mutants.mjs — does each check have a test that notices it is gone?
//
//   node test/mutants.mjs            (about five minutes)
//
// Each mutant neutralises one check in the contract or the verifier, rebuilds
// if needed, runs the suite, and must make at least one test fail. The source
// is restored after every mutant, including on error. Exits 0 only if every
// mutant is killed.
//
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const C = 'contract/src/datum.compact';

const MUTANTS = [
  { name: 'fee ignored in the bound', file: C,
    from: 'const g = (10000 - slot.feeBps) as Uint<16>;', to: 'const g = 10000 as Uint<16>;' },
  { name: 'quoteRate ignored in the sum', file: C,
    from: '  const proceedsUsd =\n    p[0] * vs[0].quoteRate + p[1] * vs[1].quoteRate +\n    p[2] * vs[2].quoteRate + p[3] * vs[3].quoteRate;',
    to: '  const proceedsUsd = (p[0] + p[1] + p[2] + p[3]) * 1000000;' },
  { name: 'freshness: maxRefAge not enforced', file: C,
    from: 'assert(blockTimeLt((rt + age) as Uint<64>), "datum: reference block is older than maxRefAge");', to: '' },
  { name: 'freshness: future reference block allowed', file: C,
    from: 'assert(blockTimeGt(rt), "datum: reference block is in the future");', to: '' },
  { name: 'distinct pools not enforced', file: C,
    from: '!(isActive(other) && other.chainId == slot.chainId && other.pool == slot.pool)',
    to: '!(isActive(other) && other.chainId == slot.chainId && other.pool == slot.pool && false)' },
  { name: 'continuity not enforced', file: C,
    from: 'assert(reopened == currentHead, "datum: previous period\'s opening does not match the chain head");', to: '' },
  { name: 'attestor not checked', file: C,
    from: 'assert(attestor == attestorKey(attestorSecret()), "datum: caller is not the registered attestor");', to: '' },
  { name: 'padding may claim proceeds', file: C,
    from: 'assert(p[i] == 0, "datum: a padding slot cannot claim proceeds");', to: '' },
  { name: 'verifier: digest compare always matches', file: 'scripts/verify-core.mjs',
    from: 'const bound = hex(L.venuesHash);', to: 'const bound = recomputed;' },
  { name: 'verifier: cherry-pick window disabled', file: 'scripts/provenance.mjs',
    from: '      newer.length === 0,', to: '      true,' },
  { name: 'verifier: quoteRate not checked', file: 'scripts/provenance.mjs',
    from: "!!qr && qr.rate === BigInt(slot.quoteRate ?? 0n)", to: '!!qr' },
];

const run = (cmd) => {
  try { return { ok: true, out: execSync(cmd, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 << 20 }) }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};
const failedTests = (out) => [...out.matchAll(/^\s*✖ (.+?) \(\d/gm)].map((m) => m[1]).filter((n, i, a) => a.indexOf(n) === i);

let survived = 0;
for (const m of MUTANTS) {
  const path = resolve(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  if (!original.includes(m.from)) { console.log(`?? ${m.name}: pattern not found in ${m.file}`); survived++; continue; }
  try {
    writeFileSync(path, original.replace(m.from, m.to));
    if (m.file.endsWith('.compact')) {
      const b = run('npm run build');
      if (!b.ok) { console.log(`ok ${m.name}: killed at compile time`); continue; }
    }
    const t = run('node --test test/*.test.mjs');
    const killers = failedTests(t.out);
    if (t.ok || killers.length === 0) { console.log(`XX ${m.name}: SURVIVED`); survived++; }
    else console.log(`ok ${m.name}: killed by ${killers.slice(0, 3).map((k) => `"${k}"`).join(', ')}${killers.length > 3 ? ` and ${killers.length - 3} more` : ''}`);
  } finally {
    writeFileSync(path, original);
    // Rebuild from the restored source, or the next mutant runs on this one.
    if (m.file.endsWith('.compact')) run('npm run build');
  }
}
run('npm run build');
console.log(survived ? `${survived} mutant(s) survived` : `all ${MUTANTS.length} mutants killed`);
process.exit(survived ? 1 : 0);
