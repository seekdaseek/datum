# datum

**A solvency attestation that proves a lending book covers its debt at realisable exit prices — not oracle marks — without publishing a single position.**

Built in [Compact](https://docs.midnight.network/compact) for [Midnight](https://midnight.network).

> Status: in development. Toolchain gate passed — see [Toolchain](#toolchain). Circuit logic is being built now.

## The problem

Every solvency dashboard in DeFi values collateral at the oracle mark: the last traded price, multiplied by the number of tokens held. That number is a fiction the moment the book is large relative to the venue that would have to absorb it. Selling into a constant-product pool moves the price against you, so a book that reads as 130% collateralised at the mark can be under 100% the instant anyone tries to realise it. The gap between *marked* and *sellable* is where lending protocols die.

The honest measurement is public and mechanical: take the venue reserves, take the size you would have to sell, compute the proceeds. The obstacle is not the math — it is that publishing the position sizes to prove you did the math is exactly what a lender cannot do.

`datum` closes that gap. It proves the depth-adjusted realisable value of a book covers its debt at a required ratio, and it publishes nothing but the verdict and the public inputs anyone can recheck.

## What is public and what is private

The split is the whole design, and it is deliberate.

**Public** — lands on the ledger, independently recomputable by anyone:

| Input | Why public |
|---|---|
| Venue reserves `X`, `Y` per slot | On-chain state. Anyone can read it. |
| Venue identifier | Identifies which pool was used. |
| Block height per slot | Pins the reserves to a checkable moment. |
| Required collateral ratio (scaled) | The bar being cleared. Fixed at attestation time, never prover-chosen. |

**Private** — witness, never disclosed:

| Input | Why private |
|---|---|
| Position sizes `q` | The book. |
| Debt figure | The liability. |
| Claimed proceeds lower bounds `p` | Derived from the book; leaks it if revealed. |

Venue depth is not a secret and is not treated as one. An earlier draft of this design let the prover supply the haircut parameters privately — that put a publicly checkable number behind the veil and left the verdict resting on figures nobody could audit. Public inputs go on the ledger so a verifier recomputes them; only the book stays hidden.

## The math

Selling size `q` into a constant-product pool with reserves `(X, Y)` yields:

```
proceeds = Y*q / (X + q)
```

There is no division in a circuit. So the prover supplies `p` as a private witness, claimed to be a *lower bound* on those proceeds, and the circuit enforces the inequality instead:

```
per slot:   p_i * (X_i + q_i)  <=  Y_i * q_i
overall:    sum(p_i)           >=  debt * required_ratio
```

Claiming `p_i` too high violates the per-slot constraint and the proof fails. Claiming it too low only makes the book look worse than it is, which hurts the prover and never the verifier. Multiply and compare only — sound, and no division anywhere.

## Toolchain

Measured on the build machine. These are the versions the contract is known to compile under.

| Component | Version |
|---|---|
| `compact` devtools | 0.5.2 |
| compiler | 0.34.0 |
| language | 0.26.0 |
| ledger | `ledger-9.1.0.0-rc.3` |
| runtime (`@midnight-ntwrk/compact-runtime`) | 0.19.0 |
| node / npm | v24.16.0 / 11.13.0 |

Note that the Compact reference docs still show `pragma language_version 0.16;` in the tutorial. The literal that compiles under language 0.26.0 is `pragma language_version 0.26;`. Where the docs and the compiler disagree, the compiler is right.

## Build

Compilation is positional — source first, then target directory:

```bash
compact compile --skip-zk contract/src/hello.compact build/hello
```

`--skip-zk` skips proving-key generation, which is slow. Drop it when real proofs are needed.

`contract/src/hello.compact` is a permanent toolchain smoke test, not part of the attestation logic. It exists so that a failure to compile can always be localised to either the toolchain or the contract, never ambiguously both.

## Deployment

**Status: BLOCKED on a network version boundary. Not deployed.** No contract address, no transaction hash. The block is upstream of anything in this repo and upstream of funding.

### Preview endpoints

From the [Environment reference](https://docs.midnight.network/guides/networks-and-environments), verified live:

| Service | Endpoint |
|---|---|
| Network ID | `preview` |
| Node RPC | `https://rpc.preview.midnight.network` |
| Node WebSocket | `wss://rpc.preview.midnight.network` |
| Indexer (GraphQL) | `https://indexer.preview.midnight.network/api/v4/graphql` |
| Indexer (WebSocket) | `wss://indexer.preview.midnight.network/api/v4/graphql/ws` |
| Proof server | `http://127.0.0.1:6300` (always local) |
| Faucet | <https://midnight-tmnight-preview.nethermind.dev/> |

Both are up. `system_chain` returns `Midnight Preview`; the indexer answers at block 606908.

### The blocker

This contract is compiled for **ledger 9**. Preview runs **ledger 8**.

| | This repo | Preview (live) |
|---|---|---|
| Compact toolchain | 0.34.0 | 0.31.1 |
| Compact runtime | 0.19.0 | 0.16.0 |
| On-chain runtime | `onchain-runtime-v4` 4.0.0-rc.3 | `onchain-runtime-v3` 3.0.0 |
| Ledger | `ledger-9.1.0.0-rc.3` | `ledger-v8` 8.1.0 |
| Midnight.js | would need 5.0.0-beta.7 | 4.1.1 |
| Proof server | would need 9.0.0-rc.7 | 8.1.0 |

Node version was read from the live chain, not from a table:

```bash
curl -s -X POST https://rpc.preview.midnight.network \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"1.0.1-5edf8ddd"}
```

That matches the Preview row of the [compatibility matrix](https://docs.midnight.network/relnotes/support-matrix) exactly, so the matrix is current rather than stale. The dependency pins confirm the split from the other direction — `@midnight-ntwrk/midnight-js-protocol@4.1.1` depends on `ledger-v8@8.1.0` and `onchain-runtime-v3@3.0.0`, while `@5.0.0-beta.7` depends on `ledger-v9@1.0.0-rc.3` and `onchain-runtime-v4@4.0.0-rc.3`. There is no version of Midnight.js that bridges them, because they are different chains.

The Compact 0.34.0 release notes say it plainly: *"Ledger version 9 will be, but is not yet, deployed."*

Every ledger-9 component is still a release candidate: Midnight.js is at `5.0.0-beta.7`, the proof server at `9.0.0-rc.7`. There is no stable ledger-9 stack to deploy against and no ledger-9 public network to deploy to.

### Provider architecture, for when the network moves

Determined from package sources, not inference.

**The proof server consumes the prover key.** `httpClientProofProvider` calls `zkConfigProvider.get(circuitId)` to read the key material locally, then POSTs it to the proof server's `/prove` endpoint as `application/octet-stream`. So the 10 MB `attest.prover` is read by the client and shipped over HTTP on every proof. On a Node deploy that is a local file read plus a loopback POST. In a browser it would be a 10 MB download first — the reason a frontend should serve artifacts from the same origin and cache them.

**`httpClientProofProvider`, not `dappConnectorProofProvider`.** `midnight-js-dapp-connector-proof-provider` depends on `@midnight-ntwrk/dapp-connector-api`, the browser wallet extension interface. It proves *through* the wallet extension and cannot run in a CLI. `httpClientProofProvider` takes a proof server URL and the `zkConfigProvider` directly.

**`NodeZkConfigProvider`, not `FetchZkConfigProvider`.** `NodeZkConfigProvider(dir)` reads `keys/<circuit>.prover`, `keys/<circuit>.verifier` and `zkir/<circuit>.bzkir` from the filesystem with `fs.readFile`. `FetchZkConfigProvider` fetches the same three paths over HTTP for browsers. A node-side deploy script points `NodeZkConfigProvider` at `build/datum-full`.

Note that the provider reads `.bzkir`, the binary ZKIR — which a `--skip-zk` build does not produce. Deployment requires the full compile.

### Proof server, measured

`midnightntwrk/proof-server:8.1.0` (the Preview-matching tag; `latest` is the same digest).

| | |
|---|---|
| Image on disk | 142 MB (`arm64/linux`) |
| Download | 25.5 MiB compressed, 47 s |
| Container writable layer | 34.2 MB (SRS fetched from `srs.midnight.network` at startup) |
| Idle memory | **7.1 MiB** |
| Memory cap applied | **2 GiB** (`--memory=2g --memory-swap=2g`), 0.34% used |
| Docker VM available | 4.1 GB, 5 CPUs |

```bash
docker run -d --name datum-proof --memory=2g --memory-swap=2g --cpus=4 \
  -p 6300:6300 midnightntwrk/proof-server:8.1.0
```

`GET /` and `GET /health` return 200; `POST /check` returns 400 on a malformed body, so the service is live and routing. The cap is explicit rather than default — the image is distroless and takes what it is given otherwise. Memory under real proving load is **UNMEASURED**: it needs a valid `/prove` request, which needs a deployable contract.

The ledger-9 equivalent is `midnightntwrk/proof-server:9.0.0-rc.7` (31.6 MiB compressed, arm64).

### Funding, when it unblocks

Deployment needs tNIGHT registered for tDUST. The route is **half scriptable**:

1. **Scriptable.** Derive the wallet from a seed with the wallet SDK — `HDWallet.fromSeed`, giving the shielded, unshielded and DUST sub-wallets. The seed comes from `WALLET_SEED` in the environment so re-runs reuse the same wallet. Print the `mn_addr_preview1...` unshielded address.
2. **Requires a human and a browser.** The faucet at <https://midnight-tmnight-preview.nethermind.dev/> is captcha-gated. The page is a 710-byte SPA shell that loads its challenge in JavaScript; there is no scriptable path, and the captcha must be completed by a person.
3. **Scriptable.** Register the tNIGHT for tDUST generation via the wallet SDK, or in Lace via **Generate tDUST**. Holding tNIGHT generates nothing until registration lands.
4. Wait for the tDUST tank to fill, then deploy.

Step 2 is the only manual step, and it is manual by design.

## License

[Apache-2.0](LICENSE).

## Scale conventions

Two scales, both fixed, both checked by the tests.

**Quantities are micro-units.** Every reserve, position size, proceeds figure and debt figure entering the contract is normalised to 1e-6 of one whole token before it is passed in. Raw token base units are not accepted — an 18-decimal token at realistic pool size blows the overflow budget, and mixing decimal conventions across venues silently corrupts the comparison. Normalised quantities are capped at 2^64, which is ~1.8e13 whole tokens: above any real pool or book.

**The ratio is scaled by `RATIO_SCALE = 1_000_000`.** A 150% requirement is `requiredRatio = 1500000`. A 120% requirement is `1200000`.

The two scales are reconciled inside the circuit without dividing:

```
proceeds * RATIO_SCALE  >=  debt * requiredRatio
```

Multiplying the left side by `RATIO_SCALE` puts both sides in the same units. Left side stays under 2^87, right side under 2^128, both inside the `Uint<136>` accumulators.

## Recomputing `venuesHash`

The point of publishing the venue array is that someone who is not the prover can pull it, fetch the same pools at the same block heights, and confirm the attestation was made against real depth. That requires the digest to be reproducible exactly.

`venuesHash` is `persistentHash<Vector<8, VenueSlot>>(venueState)` over:

- all **8** slots in index order 0 through 7 — padding slots are included in the preimage, never skipped;
- each slot serialised in **declared field order**: `venueId` (`Bytes<32>`), `reserveX` (`Uint<64>`), `reserveY` (`Uint<64>`), `blockHeight` (`Uint<64>`);
- no length prefix, no separator, no domain tag beyond what `persistentHash` itself applies.

The contract exports `venueDigest` as a `pure` circuit precisely so nobody has to reimplement that alignment by hand:

```js
import { pureCircuits } from './build/datum/contract/index.js';

const recomputed = pureCircuits.venueDigest(venues); // venues: VenueSlot[8]
// compare against ledger.venuesHash
```

It takes only public data and returns the digest. `test/datum.test.mjs` asserts that the value it produces equals the `venuesHash` the contract wrote.

## Testing

```bash
npm install
npm run build
npm test
```

`npm test` runs `node --test test/*.test.mjs` — the Node built-in test runner, no external test framework. The tests drive the **compiled contract** through the Compact runtime's circuit context, so every `assert` in the `.compact` source is live; they are not exercising a JavaScript re-implementation of the circuit.

The headline test is first in the file and named so it is impossible to miss:

> **THE PRODUCT: a book that is solvent at oracle marks is NOT COVERED at realisable prices**

One book, one pool, one required ratio of 120%. The book is 500,000 collateral against reserves of 1,000,000 collateral and 50,000,000 quote — half the pool. At the oracle spot of 50, it marks at 25,000,000 against 20,000,000 of debt and clears the bar. Sold into that depth it realises 16,666,666, and does not. The test asserts both facts, then asserts the contract publishes `covered: false`.

The rest covers the solvent path, the venue digest round-trip, zero-padding smuggling, degenerate reserves in both active and padding slots, over- and under-claimed proceeds, the accumulator width at the 2^64 boundary on both the public and witness sides, and commitment binding over positions, debt and nonce independently.

## Proving-key generation, measured

The dev loop uses `--skip-zk`. These are the numbers for the real thing, with proving keys, measured on the machine below rather than estimated.

```bash
compact compile contract/src/datum.compact build/datum-full
```

**Host:** Apple M2, 8 cores, 8 GB RAM, macOS 25.5.0.

| Run | Wall clock | Peak RSS | Swaps |
|---|---|---|---|
| 1 (cold) | 13.46 s | 400.7 MiB | 0 |
| 2 | 11.01 s | 406.1 MiB | 0 |
| 3 | 10.86 s | 419.2 MiB | 0 |

Peak RSS is `maximum resident set size` from `/usr/bin/time -l`, cross-checked against a 2-second sampler summing RSS across every `compactc`/`zkir` process, which peaked at 383 MiB. Zero swap events on an 8 GB machine — key generation for this circuit is not memory-bound and needs no headroom management.

Generated artefacts:

| File | Bytes |
|---|---|
| `keys/attest.prover` | 9,970,294 |
| `keys/attest.verifier` | 2,119 |
| `zkir/attest.zkir` | 19,862 |
| `zkir/attest.bzkir` | 1,272 |
| `contract/index.js` | 42,499 |
| `contract/index.d.ts` | 2,571 |
| `contract/index.js.map` | 2,214 |
| `compiler/contract-info.json` | 6,103 |
| `compiler/contract-manifest.json` | 1,521 |
| **Total** | **~10 MB** |

One circuit is proved — `attest`. `venueDigest` is `pure`, so it compiles to no ZK circuit at all and costs nothing here.

**Key generation is deterministic.** Three independent compiles into three separate directories produced byte-identical keys:

```
a1789f2a1809a9fa8b54818ab6dca090…  attest.prover   (all 3 runs)
ccc85e1495d7a5e72e9aff09cfe89cb4…  attest.verifier (all 3 runs)
```

So a reviewer can regenerate the keys and compare hashes against the `contract-manifest.json` in this repo rather than taking anyone's word for the artefact.

**`--skip-zk` is a faithful dev loop.** The only difference in generated JavaScript between a `--skip-zk` build and a full build is the `expectedVk` constant, empty in the former and carrying the verifier key hash in the latter:

```diff
-export const expectedVk = {};
+export const expectedVk = {
+  'attest': '…',
+};
```

Nothing else differs. The 22 tests pass identically against both builds.

## Reading `requiredRatio`

`requiredRatio` is public, it is written to the ledger, and **a verifier must read it — the verdict is meaningless without it.** `covered: true` does not mean "solvent." It means "cleared the bar that this attestation declared," and the attestation declares its own bar.

The contract asserts only that the ratio is positive. It deliberately imposes no floor, because a sub-100% requirement is a legitimate configuration — a book backed by other collateral, or a tranche where partial coverage is the designed state.

That freedom is exactly why the number must be read. A worked example:

> `requiredRatio: 800000` is 800000 / 1000000 = **0.8**, an 80% requirement. A book publishing `covered: true` at this ratio is asserting that its realisable proceeds reach **80% of its debt** — that is, it is attesting to being **20% short**, and doing so truthfully. The verdict bit is `true` and the book is under water. Both statements are correct at once.

Reading the flag without the ratio is a category error. Anything below `RATIO_SCALE` (1000000) is a sub-collateralised attestation and any interface displaying the verdict must display the ratio beside it and mark that case as such.

## How a judge tests this

1. `compact compile --skip-zk contract/src/datum.compact build/datum` — must exit 0.
2. `npm install && npm test` — 22 tests, all passing.
3. Optionally `compact compile contract/src/datum.compact build/datum-full` for the real proving keys — ~11 s and ~400 MiB on an 8 GB M2. Compare the key hashes against the table above.
4. Read the headline test first. It is the product in twenty lines.
5. Read the `for` loop in [`contract/src/datum.compact`](contract/src/datum.compact). The two positivity asserts and the cross-multiplied inequality are the whole soundness argument, and the tests that break them are named after them.
6. Grep the contract for `disclose(`. There are six. Each carries a one-line justification directly above it. Four are public inputs going back out. Two are derived from private data — the hiding book commitment and the one-bit verdict — and both are the intended output of the attestation.
