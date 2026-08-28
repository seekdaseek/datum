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
| compiler | 0.31.1 |
| language | 0.23.0 |
| ledger | `ledger-8.0.2` |
| runtime (`@midnight-ntwrk/compact-runtime`) | 0.16.0 |
| node / npm | v24.16.0 / 11.13.0 |

This targets **ledger 8**, which is what the public Preview network runs. The contract was originally written against ledger 9 (toolchain 0.34.0, language 0.26.0, runtime 0.19.0) and migrated; [Ledger 8 and ledger 9](#ledger-8-and-ledger-9) records why, and the `ledger-9` branch preserves that build.

Note that the Compact reference docs still show `pragma language_version 0.16;` in the tutorial. The literal that compiles under language 0.23.0 is `pragma language_version 0.23;`. Where the docs and the compiler disagree, the compiler is right.

## Build

Compilation is positional — source first, then target directory:

```bash
compact compile --skip-zk contract/src/hello.compact build/hello
```

`--skip-zk` skips proving-key generation, which is slow. Drop it when real proofs are needed.

`contract/src/hello.compact` is a permanent toolchain smoke test, not part of the attestation logic. It exists so that a failure to compile can always be localised to either the toolchain or the contract, never ambiguously both.

## Ledger 8 and ledger 9

This contract was written, tested and proved on **ledger 9** first, then migrated to **ledger 8**. That was a deliberate reversal and the evidence is worth keeping.

### What was found

Preview runs ledger 8. Read off the live chain, not from a table:

```bash
curl -s -X POST https://rpc.preview.midnight.network \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}'
# {"jsonrpc":"2.0","id":1,"result":"1.0.1-5edf8ddd"}
```

Node `1.0.1` matches the Preview row of the compatibility matrix exactly, so the matrix is current rather than stale. The dependency graph confirms the split from the other side:

| | ledger 8 line | ledger 9 line |
|---|---|---|
| Midnight.js | `midnight-js-protocol@4.1.1` | `@5.0.0-beta.7` |
| Ledger | `ledger-v8@8.1.0` | `ledger-v9@1.0.0-rc.3` |
| On-chain runtime | `onchain-runtime-v3@3.0.0` | `onchain-runtime-v4@4.0.0-rc.3` |
| Compact runtime | `0.16.0` | `0.19.0-rc.0` |
| Proof server image | `8.1.0` | `9.0.0-rc.7` |

**No Midnight.js version bridges them**, because they are different chains. Every ledger-9 component is still pre-release. The Compact 0.34.0 release notes say it plainly: *"Ledger version 9 will be, but is not yet, deployed."*

Being ahead of the deployed network is not an advantage. A contract nobody can call is not deployed software.

### What the migration cost

The contract source changed by **one character**:

```diff
-pragma language_version 0.26;
+pragma language_version 0.23;
```

Nothing else. Not one line of circuit logic, not one type width, not one assert.

A compatibility probe under an isolated 0.31.1 toolchain checked each construct the contract depends on before any migration began:

| Construct | Result |
|---|---|
| `Uint<136>` accumulators | works — max width is 248 on both, so the overflow budget carries over unchanged |
| `pure` modifier | works — `venueDigest` still lands in `PureCircuits` |
| Witness-disclosure analysis | **present and identical**, with the same path-tracing diagnostics |
| `Vector<8, VenueSlot>` ledger field | works |
| `persistentHash` / `persistentCommit` | works |

The disclosure analysis mattering most: it is not a ledger-9 feature, and privacy enforcement survives the migration intact.

### Digests are unchanged across the two ledgers

Checked before migrating, because a changed digest would have staled every recorded hash. `persistentHash` and `persistentCommit` produce **byte-identical** output on runtime 0.16.0 and 0.19.0:

```
persistentHash   Bytes<32>(0x01*32)    72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793
persistentHash   Uint<64>(12345)       e1543551249113046932741cc28f36b4bbcc542233eb5094874072d3167f160a
persistentHash   Vector<8,Uint<64>>    5131651e4f3093ef86a9ef5eb6aefc9ca332c4f2d96f9dc5022e9543931749b9
persistentCommit Bytes<32>             c57d4f59c961b13e406cd991b0f342ec79e571dc2c1415ff72c6550645a3b198
persistentCommit Vector<8,Uint<64>>    9798322cb37852fd5ee8b57e10cca435981d8903f57bec1feba4e99750b749ff
```

End to end through both generated contracts, on the same fixture, the same holds:

```
bookCommitment  1543fcb5bc18069ab4d0715dda68dfe09702360353fc4a87d32104ad29a90c74
venuesHash      6eb5156b0ddece7294f2edd1306ab8dcc54ecf7cc61cf010fa347026cc5f0dc5
```

And the proof artefacts themselves are byte-identical across the two ledgers — `keys/attest.prover`, `keys/attest.verifier`, `zkir/attest.zkir` and `zkir/attest.bzkir` all compare equal. Only the generated JavaScript differs, and only in that ledger 8's circuit calls are synchronous where ledger 9's return promises. **The zero-knowledge circuit is the same circuit.**

### What is preserved

The `ledger-9` branch holds the ledger-9 build exactly as it stood: toolchain 0.34.0, language 0.26.0, `ledger-9.1.0.0-rc.3`, runtime 0.19.0, its own proving measurements and its `contract-manifest.json` with the key hashes inside it.

```bash
git checkout ledger-9
```

Same keys, same hashes — see above.

## Deployment

Three targets. Read the labels — one is a public network anyone can query, one is a local chain on a laptop, one is blocked.

### PREPROD — public network, LIVE

Deployed and attested on **Midnight Preprod**, the public test network closest to mainnet.

**Live page: <https://datum.ochinimus.app>** — reads the attestation below straight from the public indexer. No wallet, no install, no setup.

Mirror: <https://datum-9ib.pages.dev> — the same deployment on its `pages.dev` hostname. Both serve a byte-identical bundle; use the mirror if the custom domain's certificate ever misbehaves.

| Deliverable | Value |
|---|---|
| Network | `preprod` (public) |
| **Contract address** | `8086d2e3db45c9eb2a45b58796202d8e076e04c49e03142db36a98815bb30a05` |
| **Deploy tx hash** | `e0bd90e0b26b890dd2488683ed778e22c55490054e3c1db5d9f45fc4caeb02b7` |
| Deploy block | 2293934 |
| **Attest tx hash** | `b29dc307bb2c42541ffdf9e8e8836391873794d411a17b4ff070a56ea8ee64c5` |
| Attest block | 2295258 |
| Attest status | `SucceedEntirely` |
| Verdict on chain | **`covered: false`** |
| Live frontend | <https://datum.ochinimus.app> (Cloudflare Pages) |
| Frontend mirror | <https://datum-9ib.pages.dev> (same deployment, fallback hostname) |

The attested book is the headline case: solvent at oracle marks, insolvent at realisable prices.

**The verify command** — public data only, no wallet, no key:

```bash
node scripts/verify.mjs --network preprod \
  --address 8086d2e3db45c9eb2a45b58796202d8e076e04c49e03142db36a98815bb30a05
```

```
attestationCount : 1
covered          : false   <-- the verdict
requiredRatio    : 1200000  (= 1.2x)
attestedAt       : 1787884105  (2026-08-28T02:28:25.000Z)
bookCommitment   : 1543fcb5bc18069ab4d0715dda68dfe09702360353fc4a87d32104ad29a90c74
venuesHash       : e8c1c5e2de006d6082c4a6c50e2ea36d4545129de135551bcfdb875094b465c7

venuesHash recomputed from the published venue array: MATCHES
```

**The indexer query that proves the attestation landed** — anyone can run this:

```bash
curl -s -X POST https://indexer.preprod.midnight.network/api/v4/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ contractAction(address: \"8086d2e3db45c9eb2a45b58796202d8e076e04c49e03142db36a98815bb30a05\") { __typename address ... on ContractCall { entryPoint deploy { address } } transaction { hash block { height } } } }"}'
```

```json
{"data":{"contractAction":{
  "__typename":"ContractCall",
  "address":"8086d2e3db45c9eb2a45b58796202d8e076e04c49e03142db36a98815bb30a05",
  "entryPoint":"attest",
  "deploy":{"address":"8086d2e3db45c9eb2a45b58796202d8e076e04c49e03142db36a98815bb30a05"},
  "transaction":{"hash":"b29dc307bb2c42541ffdf9e8e8836391873794d411a17b4ff070a56ea8ee64c5","block":{"height":2295258}}}}}
```

### Transaction hash vs transaction identifier

A Midnight transaction has **one hash** and **several identifiers**, and both are queryable. The scripts print both, which is worth explaining because they look interchangeable and are not.

| | Deploy | Attest |
|---|---|---|
| **`hash`** (use this) | `e0bd90e0b26b890dd2488683ed778e22c55490054e3c1db5d9f45fc4caeb02b7` | `b29dc307bb2c42541ffdf9e8e8836391873794d411a17b4ff070a56ea8ee64c5` |
| `identifiers[0]` | `00fd7c47e1d0c4a32853b10a5d0babdb844c54c710cd2189080895ab4fffacd061` | `0021dc8766335ff906ecf899b138f0610ebe58bf10b119a534d760e451e9f87794` |
| `identifiers[1]` | `00aa704046aed16ba728d1e6d6bde27aa9c42f6785d20fffbffc1007ba8044206c` | `00114951453e0dbae86c7471ccea99c4e4da4ef118188fc5f5da11ae75a3dbb668` |

Both resolve to the same transaction. Verified against the indexer, not inferred:

```bash
# by hash
curl -s -X POST https://indexer.preprod.midnight.network/api/v4/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ transactions(offset:{hash:\"e0bd90e0b26b890dd2488683ed778e22c55490054e3c1db5d9f45fc4caeb02b7\"}) { hash block { height } ... on RegularTransaction { identifiers transactionResult { status } } contractActions { __typename address } } }"}'
```

```bash
# by identifier — same transaction back
curl -s -X POST https://indexer.preprod.midnight.network/api/v4/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ transactions(offset:{identifier:\"00aa704046aed16ba728d1e6d6bde27aa9c42f6785d20fffbffc1007ba8044206c\"}) { hash block { height } } }"}'
```

Both return `hash: e0bd90e0…02b7`, `block: 2293934`, `status: SUCCESS`, and the `ContractDeploy` at `8086d2e3…`.

Two practical notes:

- **`identifiers` is a field on `RegularTransaction`, not on the `Transaction` interface.** Querying it without an inline fragment fails with *"Unknown field \"identifiers\" on type \"Transaction\""*.
- Midnight.js's `FinalizedTxData` exposes `txHash` (the hash), `identifiers` (all of them), and `txId` — whose own doc comment reads *"One of the transaction ID"*. `txId` is therefore **one arbitrary element of the identifier set**, not a distinct canonical id. `scripts/deploy.mjs` labels it accordingly.

**This README quotes the `hash` everywhere a transaction is named**, because it is the single canonical value per transaction and the one block explorers key on. The identifiers are recorded here for completeness.

### The same commitment on three independent chains

The `bookCommitment` published on Preprod is **byte-identical** to the one the simulation tests produce and the one the local chain published:

```
1543fcb5bc18069ab4d0715dda68dfe09702360353fc4a87d32104ad29a90c74
```

| Where | bookCommitment |
|---|---|
| Simulation tests (`npm test`) | `1543fcb5…0c74` |
| Local `undeployed` chain | `1543fcb5…0c74` |
| **Public Preprod** | `1543fcb5…0c74` |

That is the binding property demonstrated rather than asserted. The same book under the same nonce commits to the same value regardless of which chain it lands on, and a different debt, a different position, or a different nonce would change it — which the test suite proves independently by changing each one in isolation.

### Wallet sync is the dominant cost, measured

| | Wallet sync to usable state |
|---|---|
| Local `undeployed` chain | **~20 seconds** |
| Public Preprod, deploy run | **1h 55m** |
| Public Preprod, attest run | **2h 11m** |

Roughly **350×**, CPU-bound at ~95–105% of one core across 2.29M blocks. Midnight's wallet SDK holds sync state in memory only — a restarted process re-syncs from genesis — so deploy and attest each paid the cost in full.

This is the empirical justification for the [read-only frontend](#the-frontend): a wallet-gated page spends that budget before it renders. It is also a practical note for anyone building here — batch every write into one process, because splitting them doubles the wait.

### LOCAL deployment (network `undeployed`)

Kept for reproducibility. **A local chain, not a public one** — this address is not reachable by anyone else.

| Deliverable | Value |
|---|---|
| Contract address | `64a99b83376d198af51cfb6fad7bfee9a963fb07623cb624682a49ca7ba5d5c0` |
| Deploy tx hash | `6df0155818acf391ab243f058648a617b4eac7accbb6453b12e160f310b65d61` (block 35) |
| Attest tx hash | `d6a25587c4b5bca305c9571dbeed843b5e034ccbdc854bc61b49d81f23a8914b` (block 55) |
| Verdict | `covered: false` |

```bash
node scripts/verify.mjs --network undeployed --address 64a99b83…
```

Reproduce with [midnight-local-dev](https://github.com/midnightntwrk/midnight-local-dev):

```bash
docker compose -p midnight-local-dev -f standalone.yml up -d
npm start                                        # menu option 2, paste the address
node scripts/wallet.mjs --network undeployed     # prints the address to fund
node scripts/deploy.mjs --network undeployed     # deploy, then attest
```

### PREVIEW — blocked, faucet down

| Deliverable | Value |
|---|---|
| Contract address | *not deployed — faucet outage* |
| Transaction hash | *not deployed — faucet outage* |

The Preview faucet self-reports the failure:

```bash
curl -s https://midnight-tmnight-preview.nethermind.dev/api/health
```
```json
{"status":"NOT_SERVING","reason":"SYNC_STUCK_RECOVERY","needsRestart":true}
```

HTTP 503. Its wallet is stuck in sync recovery and the service asks for an operator restart, so a captcha retry would fail and consume a rate-limited attempt. Preprod answers `{"status":"ok","details":{"faucet-wallet":"ok"}}` on the same path, which is why the public deployment target is Preprod. The Preview address is derived and waiting:

```
mn_addr_preview1n2cuarawfep4s693f85qdhnej00u3jkumd3ye00zpea9pa2rl62sqtrt3l
```

Deploying there once the faucet recovers is one key change in `scripts/networks.mjs`.

### Docker memory for the local stack, capped explicitly

| Service | Cap | Observed |
|---|---|---|
| `midnight-node` | 900 MiB | 175–192 MiB |
| `midnight-indexer` | 900 MiB | 18–20 MiB |
| `midnight-proof-server` | 1200 MiB | 6.7 MiB idle, **82 MiB during real proving** |

3000 MiB ceiling against 3917 MiB available; combined usage stayed under 300 MiB.

### Provider architecture

Determined from package sources, not inference.

**The proof server consumes the prover key.** `httpClientProofProvider` calls `zkConfigProvider.get(circuitId)` to read the key material locally, then POSTs it to the proof server's `/prove` endpoint as `application/octet-stream`. So the 10 MB `attest.prover` is read by the client and shipped over HTTP on every proof. On a Node deploy that is a local file read plus a loopback POST. In a browser it would be a 10 MB download first — the reason a frontend should serve artifacts from the same origin and cache them.

**`httpClientProofProvider`, not `dappConnectorProofProvider`.** `midnight-js-dapp-connector-proof-provider` depends on `@midnight-ntwrk/dapp-connector-api`, the browser wallet extension interface. It proves *through* the extension and cannot run in a CLI.

**`NodeZkConfigProvider`, not `FetchZkConfigProvider`.** `NodeZkConfigProvider(dir)` reads `keys/<circuit>.prover`, `keys/<circuit>.verifier` and `zkir/<circuit>.bzkir` from the filesystem. `FetchZkConfigProvider` fetches the same three paths over HTTP for browsers.

Note that the provider reads `.bzkir`, the binary ZKIR, which a `--skip-zk` build does not produce. Deployment requires the full compile.

### Proof server, measured

`midnightntwrk/proof-server:8.1.0` — the tag matching Preview.

| | |
|---|---|
| Image on disk | 142 MB (`arm64/linux`) |
| Download | 25.5 MiB compressed, 47 s |
| Container writable layer | 34.2 MB (SRS fetched from `srs.midnight.network` at startup) |
| Idle memory | 7.1 MiB |
| Memory cap applied | 2 GiB (`--memory=2g --memory-swap=2g`), 0.34% used |

```bash
docker run -d --name datum-proof --memory=2g --memory-swap=2g --cpus=4 \
  -p 6300:6300 midnightntwrk/proof-server:8.1.0
```

`GET /` and `GET /health` return 200. The cap is explicit rather than default — the image is distroless and takes what it is given otherwise. Memory under real proving load is **UNMEASURED**.

## The frontend

**Live page: read-only, no wallet, no proving.** A judge opens a URL and sees a live attestation with zero setup — no extension to install, no keys, no sync to sit through.

```bash
npm run build:web     # -> frontend-dist/, static output
npm run dev           # local dev server
```

### Why read-only is a design decision, not a shortcut

The measurement made the argument. Wallet sync on a public network is the dominant cost of every write path:

| | Wallet sync to usable state |
|---|---|
| Local `undeployed` chain | **~20 seconds** |
| Public Preprod, deploy run | **1h 55m** |
| Public Preprod, attest run | **2h 11m** |

Roughly 350×, CPU-bound across 2.29M blocks. A wallet-gated page spends that budget before it renders anything. It loses the reader at the door. So the write path — proving, DUST, deploy, attest — stays in the CLI where it is already proven, and the page does the one thing a reader needs: read the attestation and let them check it.

Three consequences worth stating plainly:

- **The 10 MB prover key never reaches the browser.** Proving happens in the CLI against a local proof server, so `attest.prover` is never downloaded by a reader. That is a consequence of the architecture, not a limitation of it.
- **No key material exists in the client at all.** No wallet connect, no seed, no signing. There is nothing in the page for a malicious extension or a hostile network to take.
- **The page cannot lie about private data**, because it never has any. It renders public ledger state and values recomputed from that state.

### What it shows

Everything on screen is read from chain or derived from values on chain:

- the marked-versus-realisable gap at any exit size, computed from the **published venue reserves**
- the on-chain verdict, COVERED or NOT COVERED
- `requiredRatio` beside the verdict, badged **SUB-COLLATERALISED** when below `RATIO_SCALE`
- the venue array actually used — venue id, reserve X, reserve Y, block height, per slot
- `venuesHash`, with a recompute-and-compare indicator
- `attestedAt`, `bookCommitment`, the attest transaction hash and its block height

Position sizes, debt and claimed proceeds are **not shown and not implied**. They are not in public state, and the page says so where a reader would otherwise assume the comparison is the book's.

### The headline comparison is a hypothetical size, and the page says so loudly

The marked-versus-realisable figures are computed for an **exit size the reader chooses**, against the reserves published on chain. They are **not the attested book's numbers**, and they cannot be: position size `q` is a private witness, so neither the marked value `q × Y/X` nor the realisable value `Y·q/(X+q)` is derivable from public state — by this page or by anyone else.

Showing the book's own figures would require either publishing `q`, which defeats the contract, or inventing them, which would be fabricated data on a page whose entire claim is verifiability. Neither is acceptable, so the page shows the mechanism using the real published depth and makes the distinction impossible to miss:

- a full-width banner **above** the numbers, at the same visual weight as the numbers, headed **NOT THE ATTESTED BOOK** — *"These are hypothetical figures for a size you choose"*
- a **HYPOTHETICAL** chip on the size line, which reads *"chosen here, not read from the book"*
- both value columns labelled **"· hypothetical size"**, so the framing travels with the numbers if the banner scrolls away

That distinction is the product, not a disclaimer about it. A book whose size is public is a book with no privacy left to prove.

At 50% of pool reserves the curve happens to reproduce the headline case exactly: 25,000,000 marked against 16,666,666 realisable, a 33.3% overstatement — the same book the tests use, arrived at from public data alone.

### Deck screenshots

Regenerable from the real page rather than hand-captured, so they cannot drift from what the page renders:

```bash
npm run build:web && npm run screenshots
```

Serves `frontend-dist/` on an ephemeral port, waits for the verify indicator to resolve to a real verdict rather than capturing the pending state, and writes three element-clipped PNGs at 2× into `docs/screenshots/` (gitignored — the script is the artifact):

| File | Contents |
|---|---|
| `1-headline-comparison.png` | the gap, with the NOT-THE-ATTESTED-BOOK banner always in frame |
| `2-verify-match.png` | provenance plus the client-side `venuesHash` recompute reading MATCHES |
| `3-venue-array.png` | the published venue state, all eight slots |

### The Verify button

One control that re-runs verification client-side: refetch the contract state from the indexer, recompute `venuesHash` over the published venue array using the contract's own `venueDigest` pure circuit, compare, and report. It is the product's claim made interactive — a reader checks it rather than trusting the page.

### Network-agnostic

The page and the CLI read the **same** `scripts/networks.mjs`. Retargeting is one key:

```js
export const DEFAULT_NETWORK = 'preprod';   // -> 'undeployed' | 'preview'
```

Verified by doing it, not assumed: the page shipped pointing at the local chain, then flipping that string to `preprod` and rebuilding repointed it at the public network with no other change. `?network=<id>` overrides at runtime for side-by-side checks. A network whose `contract` is still `null` renders a precise, actionable message rather than a spinner.

### Bundle

| Asset | Raw | Gzip |
|---|---|---|
| `midnight_onchain_runtime_wasm_bg.wasm` | 1,398 kB | 412 kB |
| app JS (2 chunks) | 79 kB | 22 kB |
| CSS | 5 kB | 1.7 kB |
| **Total** | **~1.48 MB** | **~436 kB** |

The first build pulled **10 MB** of additional WASM because `indexerPublicDataProvider` drags in `ledger-v8`, Apollo and `graphql-ws` for transaction, zswap and subscription features a read-only page never uses. Replacing it with one GraphQL query plus the runtime's own `ContractState.deserialize` cut the module graph from 1,235 modules to 33 and removed that 10 MB entirely.

Dependencies added for the whole frontend: **`vite`** and **`vite-plugin-wasm`**, both dev-only. No framework.

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

**Host:** Apple M2, 8 cores, 8 GB RAM, macOS 25.5.0. Toolchain 0.31.1.

| Run | Wall clock | Peak RSS |
|---|---|---|
| 1 | 11.33 s | 364.3 MiB |
| 2 | 10.71 s | 391.7 MiB |
| 3 | 11.26 s | 394.4 MiB |

Peak RSS is `maximum resident set size` from `/usr/bin/time -l`. Zero swap events on an 8 GB machine — key generation for this circuit is not memory-bound.

Generated artefacts:

| File | Bytes |
|---|---|
| `keys/attest.prover` | 9,970,294 |
| `keys/attest.verifier` | 2,119 |
| `zkir/attest.zkir` | 19,862 |
| `zkir/attest.bzkir` | 1,272 |
| `contract/index.js` | 41,476 |
| `contract/index.d.ts` | 2,469 |
| `contract/index.js.map` | 2,194 |
| `compiler/contract-info.json` | 6,103 |
| **Total** | **9.6 MB** |

One circuit is proved — `attest`. `venueDigest` is `pure`, so it compiles to no ZK circuit and costs nothing here.

### Key determinism, reproducible

Three independent compiles into three separate directories produce byte-identical keys. Toolchain 0.31.1 emits no `contract-manifest.json`, so the hashes are recorded here directly. Regenerate and compare:

```bash
compact compile contract/src/datum.compact /tmp/datum-verify
shasum -a 256 /tmp/datum-verify/keys/attest.prover /tmp/datum-verify/keys/attest.verifier
```

Expected output:

```
a1789f2a1809a9fa8b54818ab6dca0901ca828feeb406bdbca3260f039bc14be  keys/attest.prover
ccc85e1495d7a5e72e9aff09cfe89cb411bf3279abe5cf147ae6243a61b4e47a  keys/attest.verifier
```

Those two hashes are the artefact fingerprint. Nothing here asks to be taken on trust.

**`--skip-zk` is a faithful dev loop.** A `--skip-zk` build differs from a full build only by the absence of the `keys/` directory and `zkir/attest.bzkir`. The 22 tests pass identically against both.

## Reading `requiredRatio`

`requiredRatio` is public, it is written to the ledger, and **a verifier must read it — the verdict is meaningless without it.** `covered: true` does not mean "solvent." It means "cleared the bar that this attestation declared," and the attestation declares its own bar.

The contract asserts only that the ratio is positive. It deliberately imposes no floor, because a sub-100% requirement is a legitimate configuration — a book backed by other collateral, or a tranche where partial coverage is the designed state.

That freedom is exactly why the number must be read. A worked example:

> `requiredRatio: 800000` is 800000 / 1000000 = **0.8**, an 80% requirement. A book publishing `covered: true` at this ratio is asserting that its realisable proceeds reach **80% of its debt** — that is, it is attesting to being **20% short**, and doing so truthfully. The verdict bit is `true` and the book is under water. Both statements are correct at once.

Reading the flag without the ratio is a category error. Anything below `RATIO_SCALE` (1000000) is a sub-collateralised attestation and any interface displaying the verdict must display the ratio beside it and mark that case as such.

## How a judge tests this

0. Open <https://datum.ochinimus.app> — the live attestation, read from the public indexer in the browser. Press **Verify from chain** to recompute `venuesHash` client-side. (Mirror, if needed: <https://datum-9ib.pages.dev>.)

   Or query it directly — no install, no wallet, one command:

   ```bash
   curl -s -X POST https://indexer.preprod.midnight.network/api/v4/graphql \
     -H 'Content-Type: application/json' \
     -d '{"query":"{ contractAction(address: \"8086d2e3db45c9eb2a45b58796202d8e076e04c49e03142db36a98815bb30a05\") { __typename ... on ContractCall { entryPoint } transaction { hash block { height } } } }"}'
   ```

1. `compact compile --skip-zk contract/src/datum.compact build/datum` — must exit 0 (toolchain 0.31.1).
2. `npm install && npm test` — 22 tests, all passing.
3. Optionally `compact compile contract/src/datum.compact build/datum-full` for the real proving keys — ~11 s and ~390 MiB on an 8 GB M2. Compare the two key hashes against [Key determinism](#key-determinism-reproducible).
4. Read the headline test first. It is the product in twenty lines.
5. Read the `for` loop in [`contract/src/datum.compact`](contract/src/datum.compact). The two positivity asserts and the cross-multiplied inequality are the whole soundness argument, and the tests that break them are named after them.
6. Grep the contract for `disclose(`. There are six. Each carries a one-line justification directly above it. Four are public inputs going back out. Two are derived from private data — the hiding book commitment and the one-bit verdict — and both are the intended output of the attestation.

## License

[Apache-2.0](LICENSE).
