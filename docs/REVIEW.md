# Contract review: Midnight Expert checklists

**What was reviewed:** `contract/src/datum.compact` (v2, the deployed contract) and `contract/src/control.compact` (the mark-based comparison, never deployed), with their witnesses (`scripts/deploy.mjs`, `service/server.mjs`, `test/harness.mjs`) and tests.

**How, in two passes, from Midnight's own plugin marketplace** (`https://midnightntwrk.expert`, repo `github.com/midnightntwrk/midnight-expert`; plugins `compact-core` 0.12.0 and `midnight-verify` 0.14.0):

1. **Manual checklist pass** (findings 1–16 below). Before the plugin's commands could run headless, the ten categories of `/compact-core:review-compact` and every item in `compact-review/references/*-review.md`, `compact-security` and `compact-privacy-disclosure` were applied by hand.
2. **The plugin's own agents** (sections A and B). `/compact-core:audit-compact` (the `security-reviewer` agent, with Critical/High findings confirmed through `midnight-verify` against the real ZK checker) and `/compact-core:review-compact` (the parallel reviewer agents), run headless on the final contract and the control.

Every finding is either fixed, with the commit, or answered with the reason it stays.

**After all fixes:** 80 tests pass, 14 of 14 mutants are killed (`node test/mutants.mjs`), 6 of 6 real-ZK scenarios pass, and `attest` is k=15 at 32,555 rows (`zkir mock-compile`); the new `rotateAttestor` circuit is k=13 at 4,457 rows.

## Manual checklist pass

| # | Category | Severity | Finding | Disposition |
|---|---|---|---|---|
| 1 | Architecture | Medium | `attestor` and `maxRefAge` are set once in the constructor and never written again, but were plain `ledger` fields. | **Fixed**, then revised: `maxRefAge` is `sealed`. `attestor` was sealed too, until the plugin's audit (A-H3) showed that makes a leaked key unrecoverable; it is now writable only by `rotateAttestor`, gated on the current secret. |
| 2 | Architecture / code quality | Low | `bookCommitment` was written with the same value as `head` on every attestation: two fields, one fact. | **Fixed.** Removed; `head` is the latest book commitment. The CLI and page read `head`. |
| 3 | Architecture | Low | Non-ADT ledger fields relied on implicit zero initialisation. | **Fixed.** The constructor sets every field explicitly; the zero head is the genesis `prev` the verifier expects. |
| 4 | Code quality | Low | `attest` was about 150 lines doing authorisation, per-slot checks, distinctness, the sum and the chain. | **Fixed.** Per-slot checks moved into `circuit checkSlot(slot, q, p, age)`; `attest` keeps authorisation, distinctness, the sum and the chain. Rows unchanged (helper circuits are inlined). |
| 5 | Documentation | Low | The header's list of what the circuit cannot check omitted the factory, side, decimals, fee and the new `quoteRate`. | **Fixed.** Items (d) and (e) added, each matched to a verifier check. |
| 6 | Testing | Low | Two asserts had no test: `timestamp out of range` and the control's zero ratio. | **Fixed.** Tests added for both. Every assert in both contracts now has a test that triggers it. |
| 7 | Security / crypto | Low | `persistentCommit<BookPreimage>` and `venueDigest` carry no domain-separation tag. | **Answered.** A domain field on the book preimage costs about 3,800 rows across the two commitments and moves the circuit to k=16, which doubles prover memory (measured). The preimage already includes this contract's own previous head and period, plus a fresh 32-byte nonce, so a collision would need an identical typed preimage from another protocol, and the commitment is never used as a key anywhere. `venueDigest` hashes public data only; its job is binding, not hiding. |
| 8 | Input validation | Low | `quoteRate` has no positivity assert in-circuit. | **Superseded by A-H2**: now bounded by type and non-zero on active slots. |
| 9 | Input validation | Info | `decX`, `decY`, `collateralIsToken0`, `syncTx`, `logIndex` are published but not checked in-circuit. | **Answered.** A circuit cannot read Base. Each is bound into `venuesHash` and checked against the chain by the verifier (`verifyVenueSlot`, 13 checks); tampering with any of them fails the digest or the chain check (TAMPER tests). |
| 10 | Input validation | Info | `requiredRatio` has no floor; a bar below 1.00x is accepted. | **Answered.** Deliberate: a sub-100% bar is a legitimate configuration, and the verdict means nothing without its bar. The page shows the bar beside every verdict ([docs/WAVE1.md](WAVE1.md#reading-requiredratio)). |
| 11 | Concurrency | Info | `attest` reads `attestationCount`, `head` and `prevHead` and writes them back, so two attestations in flight conflict and one fails. | **Answered.** Intended: a book's history must be a single chain. The book contracts have one attestor; the hosted demo service runs one proof at a time from a queue. |
| 12 | Privacy | Info | `disclose(venueState)` at the top of `attest`. | **Answered.** `venueState` is a public input written to the ledger anyway, and disclosing it before branching is required because the slot's activity decides which kernel block-time queries appear in the public transcript. |
| 13 | Privacy | Info | The verdict bit is derived from private proceeds and debt. | **Answered.** It is the product: the one deliberate leak, alongside the hiding commitment. Positions, debt and per-slot proceeds stay private. |
| 14 | Architecture (control) | Info | `control.markCheck` has no authorisation. | **Answered.** The control is a comparison harness run only in the simulator (`test/control.test.mjs`); it is never deployed and holds nothing. Its header says so. |
| 15 | Compilation | Pass | No deprecated syntax, no hallucinated stdlib calls; both contracts compile on toolchain 0.31.1 (language 0.23). | — |
| 16 | Token / economic | N/A | Neither contract holds or moves tokens. | — |

## A. The plugin's `security-reviewer` agent (`/compact-core:audit-compact`)

0 Critical, 3 High, 6 Medium, 11 Low, 6 suggestions. "Confirmed" means the agent reproduced it against the real circuit. The agent ran on a snapshot taken before the memory gate (`service/capacity.mjs`) was wired into the service, which is why M5 reports it unused.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| A-H1 | High, confirmed | The book `(q, debt)` is declared by the attestor; with `debt = 0` the verdict is COVERED and every off-chain check still passes. | **Answered: the stated boundary.** No proof system can show what a lender owns off-chain; datum proves the arithmetic over the book the attestor commits to, and the attestor key makes that commitment accountable period after period. For the two Moonwell books every input is public and **Recompute from Base** checks it. The README states this. |
| A-H2 | High, confirmed | `quoteRate` was an unbounded public multiplier: inflating it alone flips the verdict on chain (the verifier still catches it). | **Fixed.** `Uint<40>` (under $1.1M per quote token) and `!= 0` on active slots. Tests: a rate at 2^40 is rejected by type; a zero rate is rejected; mutants for both. Rows: 32,606 to 32,555. |
| A-H3 | High, confirmed | A `sealed` attestor key cannot be rotated: a leak is permanent. | **Fixed.** `rotateAttestor(newKey)`, gated on the current secret (k=13, separate circuit, costs `attest` nothing). Tests: rotation, old key refused, outsider cannot rotate; mutant. |
| A-M1 | Medium, confirmed | A padding slot could carry a non-zero position, committed into the book. | **Fixed.** `assert(q == 0)` on padding; test and mutant. |
| A-M2 | Medium | The bar is chosen per attestation. | **Answered.** It is public, written to the ledger and to every history record, and shown beside every verdict. The demo contract needs per-book bars; the real books use 1.00x, Moonwell's own cap. |
| A-M3 | Medium | Many periods leak one inequality each. | **Answered and stated.** That is what publishing a verdict per period means: each verdict is one bit about the book against public venues and a public bar. The README says so under *How it works*. |
| A-M4 | Medium | `control.markCheck` has no access control. | **Answered.** Never deployed; a simulator-only comparison. |
| A-M5 | Medium | Per-IP limit keys on `cf-connecting-ip`; memory gate unused. | **Answered / already fixed.** The service binds 127.0.0.1 and is reachable only through its Cloudflare tunnel, which sets that header itself. The memory gate was wired after the snapshot (commit 33da38f). |
| A-M6 | Medium | The demo opening was saved after the transaction landed; a crash in between bricks the demo chain. | **Fixed.** Openings are written ahead, keyed by period; `deploy.mjs` refuses to continue a chain whose previous opening is missing. |
| A-L1 | Low | No domain tag on the book commitment. | **Answered**, measured: +3,800 rows, k=16 (manual finding 7). |
| A-L2–L5, L7 | Low | Per-deployment salt; past venue arrays not on the ledger; `attestedAt` and `refBlock` not monotonic; range errors surface before the adjacent assert. | **Answered.** Operational or off-chain (one secret per deployment; the verifier orders by period); in-circuit versions cost rows the budget does not have. |
| A-L6 | Low | The control asserts on a private zero. | **Answered.** Simulator-only contract. |
| A-L8 | Low | `body.book in BOOKS` matches prototype keys. | **Fixed.** `Object.hasOwn`. |
| A-L9 | Low | A malformed hex secret fails at the first job, not at boot. | **Fixed.** Validated at boot. |
| A-L10 | Low, confirmed | The test witness table fell back to a test key; production does not. | **Fixed.** Fallback removed; every fixture sets its secret. |
| A-L11 | Low, confirmed | Runtime accepts extra tuple elements and in-place private-state mutation. | **Answered.** Witness bodies are pure reads in all three tables. |
| A-S1, S2 | Suggestion | Window comment said inclusive; `headPeriod` comment misstated why. | **Fixed** (comments). |
| A-S3–S6 | Suggestion | `attestorKey` export, verifier-only fields, more tests, toolchain upgrade. | Export kept (rotation needs it off-chain); tests added for padding `q`, zero and inflated rates; toolchain stays at 0.31.1 for this wave. |

## B. The plugin's reviewer agents (`/compact-core:review-compact`)

0 Critical, 1 High, 13 Medium, 19 Low, 16 suggestions. The agents ran on the same snapshot as section A, before its fixes, so their A3 (rotation) and S1 (padding position) are the audit's H3 and M1, already fixed. They also confirmed by execution: the attestor gate, both block-time windows (exactly `rt < now < rt + age` and `|ts − now| < 600`), the fee bound's soundness at extremal inputs, and that `venueDigest` reproduces the on-ledger `venuesHash`.

| # | Sev | Finding | Disposition |
|---|---|---|---|
| A1 | High | Past periods' venue arrays are not on the ledger (only their `venuesHash`), so only the latest is re-checkable from chain alone. | **Fixed off-chain:** `deploy.mjs` writes each period's venue array into `deployments/<network>.json`; any of them can be checked against that period's `venuesHash` in `history`. Storing them on-ledger would cost rows the budget does not have. |
| T1 | Med | Nothing forces the verifier to run before a verdict is reported. | **Fixed:** `deploy.mjs` runs `verifyAttestation` after every attestation and records `provenanceVerified` (true for both books in the local rehearsal). |
| CP1 | Med | Exact `pragma language_version 0.23` breaks on any upgrade. | **Fixed:** `>= 0.23`, both contracts. |
| CP2 | Med | `as Uint<16>` widens the static bound beyond the documented budget. | **Fixed:** `const g = 10000 - slot.feeBps;` (0 rows, measured). |
| A2, D1–D3 | Med/Low | Comment inaccuracies: `attestorKey` is not public-data-only; enforcement summary omitted `refBlock >= syncBlock`; (d) overstated `collateralIsToken0`; control overflow table off by one bit. | **Fixed** (comments). |
| A3 | Med | No rotation. | **Fixed** as A-H3. |
| P1, D4 | Low | `control` disclosed its public `prices` argument needlessly. | **Fixed:** removed. |
| CP3 | Low | No-op cast on `ts - 600`. | **Fixed:** removed. |
| S1, TS1, TS3, TS5, TS7 | Med/Low | Untested: padding position, active `reserveY = 0`, initial ledger state, `proceeds == debt × ratio` exactly, `refBlock == syncBlock`. | **Fixed:** five tests added (80 pass). |
| CC1, CC3, A4, A5 | Med/Low | Serialised chain head; silent `Map.insert` upsert; flattened latest fields duplicate `history`; unbounded history. | **Answered:** all by design for a single-attestor, append-only chain; the hosted service serialises jobs. |
| CC2 | Med | ±600 s may be tight for prove-to-include latency. | **Answered with a measurement:** prove + balance + submit + inclusion took 54–98 s per attestation locally and about 2 minutes end to end; 600 s is several times that. |
| PF1 | Med | No automated guard on the row margin. | **Answered:** `zkir mock-compile` is part of the documented build (README) and every contract change in this wave was measured with it; a CI test needs the toolchain binary in CI. |
| TS2, TS4, TS6 | Med/Low | Exact window boundaries, three-period ledger assertions, padding sharing an active pool's bytes. | **Answered:** windows are covered ±1 s by tests and exactly by the agents' own execution above; three periods are exercised by `test/zk.check.mjs` and the chain tests; padding is inactive by `chainId = 0` before any pool comparison. |
| PF2, Q1–Q6 | Low | Hoist `q*g` (−4 rows), named constants, `DISCLOSE` tag, `default<T>` style, further extraction. | **Answered:** cosmetic or single-digit rows; deferred to keep this wave's contract stable after review. |
| S2 | Sug | `venueDigest` has no domain prefix. | Agents recommend not fixing: it hashes public data and gates nothing. Agreed. |
| S3 | Sug | `markCheck` would need the attestor gate if ever deployed. | Agreed; it is not deployed. |


## What the review did not cover

The off-chain verifier (`scripts/provenance.mjs`, `scripts/verify-core.mjs`) is plain JavaScript, outside the plugin's scope. It is covered by its own tests on recorded Base traffic and by three verifier mutants in `test/mutants.mjs`.
