# Contract review: Midnight Expert checklists

**What was reviewed:** `contract/src/datum.compact` (v2, the deployed contract) and `contract/src/control.compact` (the mark-based comparison, never deployed), with their witnesses (`scripts/deploy.mjs`, `service/server.mjs`, `test/harness.mjs`) and tests.

**How.** Midnight's own plugin marketplace (`https://midnightntwrk.expert`, repo `github.com/midnightntwrk/midnight-expert`), plugins `compact-core` 0.12.0 and `midnight-verify` 0.14.0. Its `/compact-core:review-compact` command could not run headless because the standalone Claude CLI on the build machine was not logged in, so the review applied the same material directly: the command's ten categories and every item in `compact-review/references/*-review.md`, plus `compact-security` (threat catalogue, witness trust boundary) and `compact-privacy-disclosure`. Every finding below is either fixed, with the commit, or answered with the reason it stays.

**After the fixes:** 64 tests pass, 11 of 11 mutants are killed (`node test/mutants.mjs`), 6 of 6 real-ZK scenarios pass, and the circuit is still k=15 at 32,606 rows (`zkir mock-compile`), with a 482 MB prover peak.

## Findings

| # | Category | Severity | Finding | Disposition |
|---|---|---|---|---|
| 1 | Architecture | Medium | `attestor` and `maxRefAge` are set once in the constructor and never written again, but were plain `ledger` fields. A later circuit could have changed who may attest. | **Fixed.** Both are `sealed ledger`, so the ledger itself refuses any write after deployment. |
| 2 | Architecture / code quality | Low | `bookCommitment` was written with the same value as `head` on every attestation: two fields, one fact. | **Fixed.** Removed; `head` is the latest book commitment. The CLI and page read `head`. |
| 3 | Architecture | Low | Non-ADT ledger fields relied on implicit zero initialisation. | **Fixed.** The constructor sets every field explicitly; the zero head is the genesis `prev` the verifier expects. |
| 4 | Code quality | Low | `attest` was about 150 lines doing authorisation, per-slot checks, distinctness, the sum and the chain. | **Fixed.** Per-slot checks moved into `circuit checkSlot(slot, q, p, age)`; `attest` keeps authorisation, distinctness, the sum and the chain. Rows unchanged (helper circuits are inlined). |
| 5 | Documentation | Low | The header's list of what the circuit cannot check omitted the factory, side, decimals, fee and the new `quoteRate`. | **Fixed.** Items (d) and (e) added, each matched to a verifier check. |
| 6 | Testing | Low | Two asserts had no test: `timestamp out of range` and the control's zero ratio. | **Fixed.** Tests added for both. Every assert in both contracts now has a test that triggers it. |
| 7 | Security / crypto | Low | `persistentCommit<BookPreimage>` and `venueDigest` carry no domain-separation tag. | **Answered.** A domain field on the book preimage costs about 3,800 rows across the two commitments and moves the circuit to k=16, which doubles prover memory (measured). The preimage already includes this contract's own previous head and period, plus a fresh 32-byte nonce, so a collision would need an identical typed preimage from another protocol, and the commitment is never used as a key anywhere. `venueDigest` hashes public data only; its job is binding, not hiding. |
| 8 | Input validation | Low | `quoteRate` has no positivity assert in-circuit. | **Answered.** A zero or low rate can only understate proceeds, so it can make a verdict falsely NOT COVERED, never falsely COVERED. The verifier checks every rate against its source at the reference block. Test: `a zero rate cannot help the prover`. |
| 9 | Input validation | Info | `decX`, `decY`, `collateralIsToken0`, `syncTx`, `logIndex` are published but not checked in-circuit. | **Answered.** A circuit cannot read Base. Each is bound into `venuesHash` and checked against the chain by the verifier (`verifyVenueSlot`, 13 checks); tampering with any of them fails the digest or the chain check (TAMPER tests). |
| 10 | Input validation | Info | `requiredRatio` has no floor; a bar below 1.00x is accepted. | **Answered.** Deliberate: a sub-100% bar is a legitimate configuration, and the verdict means nothing without its bar. The page shows the bar beside every verdict ([docs/WAVE1.md](WAVE1.md#reading-requiredratio)). |
| 11 | Concurrency | Info | `attest` reads `attestationCount`, `head` and `prevHead` and writes them back, so two attestations in flight conflict and one fails. | **Answered.** Intended: a book's history must be a single chain. The book contracts have one attestor; the hosted demo service runs one proof at a time from a queue. |
| 12 | Privacy | Info | `disclose(venueState)` at the top of `attest`. | **Answered.** `venueState` is a public input written to the ledger anyway, and disclosing it before branching is required because the slot's activity decides which kernel block-time queries appear in the public transcript. |
| 13 | Privacy | Info | The verdict bit is derived from private proceeds and debt. | **Answered.** It is the product: the one deliberate leak, alongside the hiding commitment. Positions, debt and per-slot proceeds stay private. |
| 14 | Architecture (control) | Info | `control.markCheck` has no authorisation. | **Answered.** The control is a comparison harness run only in the simulator (`test/control.test.mjs`); it is never deployed and holds nothing. Its header says so. |
| 15 | Compilation | Pass | No deprecated syntax, no hallucinated stdlib calls; both contracts compile on toolchain 0.31.1 (language 0.23). | — |
| 16 | Token / economic | N/A | Neither contract holds or moves tokens. | — |

## What the review did not cover

The off-chain verifier (`scripts/provenance.mjs`, `scripts/verify-core.mjs`) is plain JavaScript, outside the plugin's scope. It is covered by its own tests on recorded Base traffic and by three verifier mutants in `test/mutants.mjs`.
