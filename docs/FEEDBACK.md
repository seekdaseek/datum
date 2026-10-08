# Midnight tooling feedback

Everything below was hit while building datum for real, on Preprod and on the
local stack, between August and October 2026. Each item says what happened,
how it was found, what it cost, and what would have prevented it. Most useful
first.

Versions: Compact toolchain 0.31.1 (language 0.23.0, ledger 8.0.2, runtime
0.16.0), compact devtools 0.5.2, midnight-js 4.1.1, `@midnightntwrk/wallet-sdk`
1.2.0, proof server 8.1.0, Preprod node 1.0.2, Node 24 (Mac) and 22 (VPS).

---

## 1. The simulator and the prover disagree on untaken branches

**What happened.** The v2 contract opened the previous period with
`(period - 1) as Uint<64>` inside `if (period > 0)`. Every simulator test
passed. The first real proof of period 0 failed at the proof server's `/check`
with `Inputs did not match alignment`, and the offending value was r − 1 in the
BLS12-381 scalar field.

**Why.** The JavaScript simulator skips a branch it does not take. The circuit
evaluates both sides of every conditional, so at period 0 it computed
`0 - 1`, which wraps in the field and no longer fits a `Uint<64>`.

**Cost.** Half a day, and it would have shipped: 47 of 47 simulator tests were
green on the broken contract.

**What we did.** Moved the previous period number into the ledger
(`headPeriod`) so no subtraction is needed, and added `npm run test:zk`, which
sends the simulator's own `proofData` for five scenarios through the real
proof server's `/check`. On the old contract that suite fails the three
period-0 scenarios while the simulator passes all of them.

**What would help.** Either the simulator evaluating both branches (or at
least range-checking casts in untaken ones), or a compiler warning for
subtraction under a cast inside a conditional. A `/check` error that names the
circuit operation instead of "alignment" would have saved most of the time.

## 2. Wallet sync is memory-only, about two hours per process on Preprod

**What happened.** Every process that writes to Preprod starts the wallet from
genesis and syncs for about two hours, CPU-bound, before it can do anything.
A crash, a restart or a second script pays it again.

**What we found.** Each sub-wallet already has `serializeState()`, and
`ShieldedWallet(cfg).restore(s)`, `UnshieldedWallet(cfg).restore(s)` and
`DustWallet(cfg).restore(s)` accept it. Wiring them into `WalletFacade.init`
gives a working checkpoint: 13.9 KB, written mode 0600, restored in 0.1 s
against 1.2 s cold locally (`scripts/wallet-lib.mjs`,
`scripts/wallet-roundtrip.mjs`). The hosted sponsor on our VPS restores from a
checkpoint made on a Mac and never pays the sync.

**What would help.** A documented checkpoint path on the facade itself
(`facade.serialize()` / `WalletFacade.restore()`), and a warning in the docs
that the checkpoint is sensitive wallet state.

## 3. Two copies of the on-chain runtime break `instanceof`

**What happened.** Every circuit call failed with
`expected instance of StateValue`.

**Why.** `compact-runtime@0.16.0` resolved `onchain-runtime-v3` to 3.1.0
while `midnight-js-protocol@4.1.1` pinned 3.0.0. Two WASM instances were
loaded, and a `StateValue` built by one failed `instanceof` in the other.

**What we did.** An npm `overrides` entry pinning
`@midnight-ntwrk/onchain-runtime-v3` to 3.0.0 and a clean reinstall, so one
copy hoists.

**What would help.** A peer dependency instead of a direct one, so npm
refuses the split, or a runtime check that names both versions in the error.

## 4. The indexer's `identifiers` needs an inline fragment, and `txId` is "one of" them

`identifiers` lives on `RegularTransaction`, not on the `Transaction`
interface, so a plain query fails with *Unknown field "identifiers" on type
"Transaction"*. Midnight.js's `FinalizedTxData.txId` is documented as
"One of the transaction ID", one arbitrary element of `identifiers`, while
`txHash` is the one canonical value. We quote the hash everywhere and
explain the difference in the README. A sentence in the docs would have
saved an hour.

## 5. The proof server: memory, binding, parameters

Measured while putting a proof server on a shared 4 GB VPS.

- **Memory scales with k and nothing reports k.** The 8-slot v2 circuit is
  k=16 and peaked at 940 MB in the proof server; the 4-slot version is k=15
  and peaked at 481 MB (`scripts/diag/prove-mem.mjs`, cgroup `memory.peak`,
  one thread). The compiler does not print k; we read it from the prover key
  size (19.5 MB against 10.05 MB) and from which `bls_midnight_2p*` file it
  fetched. Printing k and an estimated prover memory at compile time would
  make this a design input instead of a production surprise.
- **No bind address.** It listens on `0.0.0.0` with no option to change it.
  On a host without a firewall that is a public prover. We confined it with a
  systemd scope (`IPAddressDeny=any`, `IPAddressAllow=localhost`); a
  `--host` flag would be simpler.
- **Parameters are fetched at startup** into `$HOME/.cache/midnight` from
  `srs.midnight.network` (k=10 to 15 plus the zswap and dust keys, 33 MB),
  and the log calls that host "not a trusted service". Fetch once, then run
  with `MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS=true` and no egress. A k=16
  circuit is fetched lazily on first use, which a no-egress deployment would
  only discover at proving time.
- **It runs without Docker.** The image is a Nix closure: copying
  `/nix/store` paths (82 MB) to a host gives a native binary. Worth
  documenting for hosts that cannot run Docker.

## 6. Wallet sync progress reports no total

Shielded and dust progress carry `appliedIndex` but keep `highestIndex` at 0
for the whole sync, so a percentage is impossible; unshielded progress has a
different shape (`appliedId` / `highestTransactionId`). We print the absolute
applied counters. One progress shape with a real total would let a hosted
service show an honest "syncing, 40%".

## 7. A local chain left idle for weeks stops producing usable blocks

After the local stack sat stopped from Aug 28 to Oct 8, every block after the
first v2 deploy hit `HitBlockWeightLimit`. The deploy was 9.2% of a block's
write budget (`scripts/diag/deploy-cost.mjs`), so the transaction was not the
problem. `docker compose down -v` and a fresh start fixed it. A note in
midnight-local-dev that a stale chain should be reset, not resumed, would have
saved the diagnosis.

## 8. Smaller things

- `deployContract` takes `compiledContract`, built with
  `CompiledContract.make(name, Contract).pipe(withWitnesses(w),
  withCompiledFileAssets(dir))`; older examples pass `contract`.
- Runtime 0.16 circuits are synchronous, so a test expecting a rejection has
  to wrap the call (`assert.rejects(async () => ...)`).
- The Preview faucet answered `NOT_SERVING` (`SYNC_STUCK_RECOVERY`) for the
  whole of Wave 1, which is why datum is on Preprod.

## What worked well

- Kernel block-time queries (`blockTimeGt`, `blockTimeLt`) made freshness a
  rule the ledger enforces, not one the prover promises.
- `persistentCommit` and `persistentHash` gave one digest the circuit, the CLI
  and the browser all recompute byte for byte.
- Exporting a `pure` circuit (`venueDigest`) meant nobody had to reimplement
  the field alignment by hand to verify a published array.
- Compact's widening arithmetic (`Uint<64> * Uint<64>` to a wider type) made
  the 160-bit fee bound straightforward to state and check.
