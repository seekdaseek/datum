# Judging criteria, mapped to evidence

Each line points at something you can open or run. New in Wave 2 unless marked.

## Engineering (40)

| Evidence | Where |
|---|---|
| A new Compact contract, not a rename: venue provenance bound into the proof, ledger-enforced freshness via kernel block time, fee-exact bound in Uint<160>, distinct pools, attestor key, chained history with an in-circuit opening of the previous period | [`contract/src/datum.compact`](../contract/src/datum.compact) |
| A control written in Compact: a faithful mark-based check on the same private book | [`contract/src/control.compact`](../contract/src/control.compact), [`test/control.test.mjs`](../test/control.test.mjs) |
| Provenance from a real chain: Aerodrome volatile `Sync(uint256,uint256)` logs on Base, factory and fee checked at the reference block, cherry-picking closed by a no-newer-Sync window, WETH quotes valued at Moonwell's oracle at that block | [`scripts/provenance.mjs`](../scripts/provenance.mjs) |
| Circuit kept at k=15 by measurement: one 8-byte field crossed a SHA-256 block (32,731 to 35,209 rows); narrowing ids and block numbers brought it to 32,606 | [`contract/src/datum.compact`](../contract/src/datum.compact) header, [FEEDBACK.md](FEEDBACK.md) §2 |
| One verifier for CLI, page and tests | [`scripts/verify-core.mjs`](../scripts/verify-core.mjs) |
| A JS/ZK divergence found and fixed, with a test that sends the simulator's proof data through the real prover's `/check` | [`test/zk.check.mjs`](../test/zk.check.mjs), [docs/FEEDBACK.md](FEEDBACK.md) §1 |
| Circuit sized from measurement: 8 slots (k=16, 940 MB prover peak) cut to 4 (k=15, 481 MB) | [`scripts/diag/prove-mem.mjs`](../scripts/diag/prove-mem.mjs), README *What changed* |
| Wallet checkpoints: sync once, restore in 0.1 s | [`scripts/wallet-lib.mjs`](../scripts/wallet-lib.mjs), [`scripts/wallet-roundtrip.mjs`](../scripts/wallet-roundtrip.mjs) |
| Deploy, real attestation, demo contract and sponsor funding in one process | [`scripts/deploy.mjs`](../scripts/deploy.mjs), [`deployments/preprod.json`](../deployments/preprod.json) |
| Hosted prover on a shared host under hard cgroup limits, proven on the live process | [`ops/ecosystem.config.cjs`](../ops/ecosystem.config.cjs), [`ops/loadtest.sh`](../ops/loadtest.sh) |

## Quality assurance (15)

| Evidence | Where |
|---|---|
| 64 tests: contract simulator, provenance on recorded Base traffic (USDC and WETH-quoted pools), the full verifier, the control | `npm test` |
| Named negative tests: TAMPER (page, CLI, tests), CHERRY-PICK, FEE, FRESHNESS, DISTINCT POOLS, ATTESTOR, CHAIN, overflow at 2^64, padding smuggling, overclaim | [`test/`](../test) |
| 6 real-ZK scenarios through the proof server | `npm run test:zk` |
| 14 mutants, each neutralising one check (fee, quote rate, both freshness bounds, distinct pools, continuity, attestor, padding, digest compare, cherry-pick window, rate check); every one is killed by the tests named for it | `node test/mutants.mjs` |
| Reviewed against Midnight Expert's ten-category checklists: 16 findings fixed or answered | [REVIEW.md](REVIEW.md) |
| Load test with automatic rollback gates before go-live | [`ops/loadtest.sh`](../ops/loadtest.sh), README *Attest a book from the page* |

## Product (15)

| Evidence | Where |
|---|---|
| Real books, not toys: Moonwell's WELL and AERO collateral on Base, both attested on Preprod, with the gap between marks and exit in dollars | README *The headline*, page |
| The difference from balance-threshold proofs, shown on one book | README *The control*, page *Three checks, one book* |
| The boundary stated: concentrated liquidity, aggregators, second-hop depth, stable-swap, off-chain exits | README *Where this method is the wrong tool* |

## UX: frontend connected end to end (15)

| Evidence | Where |
|---|---|
| Attest a book from the page: pick or edit, hosted proof, sponsor-paid DUST, Preprod transaction, verdict | <https://datum.ochinimus.app> |
| Each step shown as it happens, with timings; sponsor state always visible; queue position; per-visitor limits stated | page *Attest a book yourself* |
| Verify from chain and Tamper with a copy, in the browser | page, both attestation cards |
| Privacy boundary stated before the button | page, README |
| Works at phone width with no horizontal scroll | page at 375 px |

## Communication (10)

| Evidence | Where |
|---|---|
| First sentence names what the judge knows and what it misses | README, page |
| Five-minute verification path | [JUDGE_GUIDE.md](../JUDGE_GUIDE.md) |
| Tooling feedback, most useful first | [FEEDBACK.md](FEEDBACK.md) |
| Video, scripted first | [VIDEO.md](VIDEO.md) |

## Business development (5)

| Evidence | Where |
|---|---|
| Named users, adoption path, price per attestation, Wave 3 roadmap | README *Who it is for*, *Wave 3* |
| Why Midnight, in one sentence | README *Midnight primitives used* |
