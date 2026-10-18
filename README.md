# datum

**Proof of reserves shows the tokens exist, not that they can be sold for what the book says.** datum proves, in zero knowledge on [Midnight](https://midnight.network), that a lending book covers its debt at **realisable exit prices** (what its collateral would fetch if sold into the constant-product pool where it actually trades), not at the oracle mark a balance-threshold `proveSolvency` check uses. The pool's depth is public and re-fetchable from its own chain; the book stays private.

> **Live on Midnight Preprod** (public test network, not mainnet). Two real books attested in one run:
> Moonwell's WELL collateral, contract `d2bd781efab363c369be91bc9f8214e6907a2607823fae363b36594e8c901ac8`, transaction `18c8bd723287f72a9a2b6558a4dec3954306c8ddeb4834c20320a85f5951aecd`, block 2,890,448;
> Moonwell's AERO collateral, contract `60c0dc62d6989724d602202a5d5b18e8c7af64ae48f9506588398d64bf4184f1`, transaction `bbf66ac0ff8ff6a408d039c4406bc0a6d26117895b2c1a5273ae658055b297ec`, block 2,890,434.
> Page: <https://datum.ochinimus.app> · hosted attest service: <https://datum-api.ochinimus.app/api/status> · judge guide: [JUDGE_GUIDE.md](JUDGE_GUIDE.md) (every claim, five minutes).

## Judge steps

**On the page, <https://datum.ochinimus.app> (about five minutes, no wallet, no key):**

1. Read the two real books. Press **Recompute from Base** on each: the page re-reads Moonwell and the Aerodrome pool at the stated Base block and shows **MATCHES BASE**.
2. On the same cards press **Verify from chain**: expect **VERIFIED**. Then **Tamper with a copy**: one reserve changed by one millionth of a dollar, expect **MISMATCH** on exactly two checks. Nothing on chain changes.
3. In **Attest a book yourself** wait for the sponsor pill to read **Sponsor ready**, keep **Overlevered AERO book** selected and press **Attest this book on Midnight**. Watch each step to the transaction, block and verdict (**NOT COVERED**); the page then verifies the result from chain by itself. If the pill still reads that the sponsor wallet is syncing with Midnight, the sponsor is catching up with the chain after Midnight moved Preprod's indexer to Blockfrost on 9 October; attest opens when it is done, and steps 1 and 2 do not depend on it.

**From a terminal (optional):**

```bash
git clone https://github.com/seekdaseek/datum && cd datum
npm install && npm run build
export BLOCKFROST_PROJECT_ID=...                      # a free Midnight Preprod project at blockfrost.io; only the CLI needs it
node scripts/verify.mjs --network preprod            # every check, exits 0
node scripts/verify.mjs --network preprod --tamper   # MISMATCH, exits 1
npm test                                             # 86 tests
node test/mutants.mjs                                # 14 of 14 mutants killed
```

Every claim with its expected output: [JUDGE_GUIDE.md](JUDGE_GUIDE.md).

## The headline, on two real books

Everything supplied to two [Moonwell](https://moonwell.fi) markets on Base, each sold into its main exit, a factory-vouched Aerodrome volatile (x·y=k) pool. **The debt side is Moonwell's borrowing cap for that collateral** (supplied × oracle price × collateral factor): the most that could be borrowed against it, **not the borrows actually outstanding**.

| Moonwell market | Supplied | Coverage of the borrowing cap at the oracle mark | At realisable exit | Does not exist at exit | Attested at required ratio | Verdict |
|---|---|---|---|---|---|---|
| **WELL** (exit: WELL/WETH, 1% fee) | 131,253,121 WELL | **1.82x** ($315,634) | **1.21x** ($210,570) | **$105,064**, 33.3% | 1.00x | COVERED |
| **AERO** (exit: AERO/USDC, 0.30% fee) | 3,404,767 AERO | **1.67x** ($2,647,788) | **1.48x** ($2,349,653) | **$298,134**, 11.3% | 1.00x | COVERED |

Coverage is value divided by that borrowing cap: $173,598 for WELL (55% collateral factor, oracle $0.00240477) and $1,588,673 for AERO (60%, oracle $0.777671), read at Base blocks 52,335,556 and 52,335,516. Each attestation used a required ratio of 1.00x, the cap itself, and produced WELL COVERED and AERO COVERED. The number to read is the gap: 33.3% of WELL's marked value is not there at exit.

**WELL's pool is quoted in WETH**, so its slot carries a public `quoteRate`: Moonwell's own WETH price at the reference block ($2,540.56), which the verifier re-reads from Base. That values the WETH leg at the mark. Measured against the only x·y=k WETH/USDC pool on Base, selling the 82.88 WETH there would fetch $199,845, 5.1% less; WETH's deeper concentrated-liquidity pools are not measured.

Every input is public on Base, so anyone can recompute either book (`node scripts/books/moonwell.mjs WELL`, or **Recompute from Base** on the page). The books are public by construction so judges can check them; a lender's own book would stay private and only its commitment and verdict would be published.

A flip from COVERED to NOT COVERED is shown on the AERO pool by the overlevered sample book: **COVERED at 1.41x on the mark, NOT COVERED at 1.04x realisable**, against a 1.20x bar ([the control](#the-control-three-checks-one-book)).

## What changed since Wave 1

| | Wave 1 (v1) | Wave 2 (v2) |
|---|---|---|
| Venues | Hand-entered reserves, no source | Real Aerodrome pools on Base. Each slot binds chain id, pool, Sync block, Sync tx hash, log index, reference block and its timestamp |
| Quote side | USD only, implicitly | USDC at 1.0, or WETH at Moonwell's oracle price, as a public per-slot `quoteRate` the verifier re-reads |
| Real books | None | Moonwell's WELL and AERO collateral, attested in one Preprod run |
| Provenance | None | **Verify from chain** re-fetches the cited Sync log from a public Base RPC; a copy with one reserve changed reads **MISMATCH** (page, CLI `--tamper`, named tests) |
| Cherry-picking an old, deeper Sync | Not addressed | The verifier checks there is no newer Sync in (syncBlock, refBlock]; the **ledger** enforces refBlock freshness with kernel block-time queries |
| Fee | Ignored | Exact constant-product-with-fee bound per slot (Uint<160> cross-multiplication) |
| Who may attest | Anyone | A registered attestor key (hash of a secret, checked in-circuit) |
| History | Last verdict only | Every period chained to the previous commitment; period N must open period N−1 privately in-circuit |
| Slots | 8 (k=15) | 4 (k=15, 32,606 rows). The 8-slot v2 circuit was k=16 and peaked at 940 MB in the prover; 4 slots peak at 482 MB (493 MB measured on the 2 GB host), which is what lets a prover run on a 2 GB host |
| User action | Read-only page | **Attest a book** from the page: hosted prover, sponsor wallet pays DUST, then the page verifies the result from chain |
| Control | None | A faithful mark-based check, in Compact, run on the same private book |
| Tests | 22 | 86 (simulator, provenance replay, verifier, control, capacity gate, redaction), 6 of 6 real-ZK `/check` scenarios, 14 of 14 mutants killed |
| Indexer | Midnight's public Preprod indexer | Blockfrost's: Midnight retired its own Preprod indexer and RPC on 9 Oct 2026. The page reads it through datum-api's read-only relay (one fixed contract query, cached, rate limited); the Blockfrost project token stays on the server and in no log |
| Hosting | Static page only | A dedicated 2 GB server for the attest service: on-demand prover, a memory gate sized for the box, its own Cloudflare tunnel |
| Review | None | Midnight Expert checklists, 16 findings fixed or answered ([docs/REVIEW.md](docs/REVIEW.md)) |

Wave 1 record: [docs/WAVE1.md](docs/WAVE1.md).

## How it works

**Private (Compact witnesses, never disclosed):** position sizes, debt, claimed proceeds per slot, the commitment nonce, the attestor secret, and the previous period's opening.

**Public (on the ledger):** the venue array with its provenance, the required ratio, the one-bit verdict, a hiding commitment to the book chained to the previous one, `attestedAt`, and the history of every period. Each verdict is one bit about the private book against public venues and a public bar, so a long history of verdicts narrows what the book could be; no position or debt is ever published in the clear.

**What it cannot prove:** that the committed book is the lender's real book. The attestor declares it, and the attestor key makes each declaration accountable and chained to the last. For the two Moonwell books every input is public on Base, so **Recompute from Base** checks them.

**Per active slot the circuit enforces:**

```
fee bound      p * (X*10000 + q*g)  <=  Y*q*g        g = 10000 - feeBps
freshness      blockTimeGt(refTime)  and  blockTimeLt(refTime + maxRefAge)
order          refBlock >= syncBlock
distinct       no two active slots name the same (chainId, pool)
overall        sum(p) * 1e6  >=  debt * requiredRatio   ->  covered
```

Claiming proceeds above what the pool would pay fails the proof. Claiming less only hurts the prover. There is no division in the circuit.

**What the circuit cannot see, the verifier checks** ([scripts/verify-core.mjs](scripts/verify-core.mjs), shared by the CLI, the page and the tests). Thirteen checks per slot against the source chain: the pool was deployed by a known constant-product factory and the factory vouches for it as volatile; the quote side is a USD stablecoin or WETH, and `quoteRate` equals 1.0 or Moonwell's WETH price at the reference block; decimals and fee match at the reference block; the cited log exists at (block, log index), sits inside the cited transaction and carries exactly the published reserves; the reference block is at or after the Sync; **no newer Sync exists before the reference block**; the reference time is that block's timestamp. Plus the venue digest the proof bound, and the chain of periods to the published head.

## Verify it yourself

```bash
npm install && npm run build
export BLOCKFROST_PROJECT_ID=...                      # free Midnight Preprod project at blockfrost.io (the CLI reads the indexer directly; the page needs no key)
node scripts/verify.mjs --network preprod            # every check, public data only, exits 0
node scripts/verify.mjs --network preprod --tamper   # one reserve changed: MISMATCH, exits 1
npm test                                             # 86 tests
npm run test:zk                                      # 6 scenarios through a real proof server (needs one on :6300)
node test/mutants.mjs                                # 14 mutants, each must be killed
```

Or on the page: **Verify from chain**, then **Tamper with a copy**. Step-by-step with expected output: [JUDGE_GUIDE.md](JUDGE_GUIDE.md).

## The control: three checks, one book

[`contract/src/control.compact`](contract/src/control.compact) is a fair mark-based solvency check: same witnesses, same scale, same disclosure discipline, hard asserts on its inputs. [`test/control.test.mjs`](test/control.test.mjs) runs it and datum on the same private book against the same pool, with the mark taken from that pool's own spot price, so the only difference is depth:

| | Proof of reserves | Balance threshold (`proveSolvency`) | datum |
|---|---|---|---|
| Proves the tokens exist | yes | yes | yes, privately |
| Values collateral at | nothing | the oracle mark | the price the pool would pay |
| Accounts for depth and price impact | no | no | yes, constant-product with fee |
| Positions and debt stay private | often not | yes | yes |
| Venue data provable from its source chain | n/a | n/a | yes: Sync log, block, tx, log index |
| 10M AERO vs $5.5M debt at 1.20x | no verdict | **COVERED** | **NOT COVERED** |

The same test shows the control is not rigged: on a book small against the depth, both say COVERED; on a book short even at the mark, both say NOT COVERED.

## Where this method is the wrong tool

Stated as a boundary, not a footnote:

- **Concentrated liquidity** (Uniswap v3, Aerodrome Slipstream): depth depends on tick ranges, not x·y=k. MORPHO on Base exits mainly through a Slipstream pool, so datum does not price it.
- **Aggregators and routers:** a route across pools is not one reserve pair, and a quote is not a log anyone can re-fetch.
- **Depth quoted in another volatile asset:** WELL's depth is in WELL/WETH; pricing through WETH needs a second hop datum does not model yet.
- **Stable-swap pools:** a different invariant; the verifier rejects Aerodrome stable pools.
- **Off-chain exits:** CEX order books and OTC desks have nothing to re-fetch.

Where it applies, datum is a lower bound: the book's main exit is one constant-product pool per asset, and selling there would fetch at least what was proved.

## Attest a book from the page

A judge picks a sample book (or edits one), presses **Attest this book on Midnight**, and watches each step as it happens: reading fresh reserves from Base, preparing the private book, proving in zero knowledge, the sponsor adding DUST for the fee, submitting, waiting for the block. The page then shows the transaction hash, block and verdict, and **verifies it from chain without trusting the service**.

**Privacy boundary, stated plainly:** the hosted demo prover sees the demo book you submit. That is acceptable only because every demo book is sample data chosen on a public page. A real lender runs the same prover locally (`scripts/deploy.mjs`) and the book never leaves their machine; only the commitment and the verdict reach the chain.

**How it is hosted** ([`service/server.mjs`](service/server.mjs), [`ops/ecosystem.dedicated.config.cjs`](ops/ecosystem.dedicated.config.cjs)): its own PM2 processes and its own Cloudflare tunnel on a dedicated 2 GB server (1 vCPU). Each process runs under `systemd-run --scope` with a hard memory limit, one core, nice 10 and `oom_score_adj` 1000. The prover's cgroup has no swap and admits only loopback traffic; the API may use up to 512 MB of swap. The prover is started per job and stopped after five idle minutes, and only when 700 MB is available ([`service/capacity.mjs`](service/capacity.mjs): the 454 MB prover peak plus a 250 MB floor kept for the host, set with `PROVER_FLOOR_MB`; the default floor of 500 MB is for a shared host). One proof at a time in a queue; one job in flight and three per hour per visitor; the sponsor's state (syncing, ready, proving, DUST regenerating) is shown on the page, never a bare spinner. The sponsor wallet's first sync from genesis is long on one vCPU, so [`scripts/sync-sponsor.mjs`](scripts/sync-sponsor.mjs) syncs it on a faster machine against the same indexer and the service restores that checkpoint. Measured on the host: two real 4-slot attest proofs through the prover took 13.3 s and 10.8 s, and the prover's cgroup peaked at 493 MB (limit 768 MB). The time from pressing attest to a verified result is recorded in the next update.

## Midnight primitives used

- **Compact witnesses** for the book, the claimed proceeds, the nonce, the attestor secret and the previous opening.
- **`sealed` ledger fields** for the attestor key and `maxRefAge`, fixed at deployment.
- **`disclose`** at seven sites, each justified in the source: in the constructor the attestor key and `maxRefAge`; in `attest` the venue array, the timestamp, the hiding commitment, the one-bit verdict and the ratio.
- **Dual-ledger state:** public ledger fields (venues, verdict, history) beside private state kept by Midnight.js's encrypted level private-state provider.
- **Kernel block time** (`blockTimeGt` / `blockTimeLt`): freshness enforced by the node, not promised by the prover.
- **`persistentCommit` / `persistentHash`:** the chained book commitment and the venue digest, recomputed byte for byte by the CLI and the browser through an exported `pure` circuit.
- **DUST sponsorship:** a sponsor wallet registers NIGHT for DUST and pays every visitor's fee.
- **Midnight.js:** `deployContract`, `findDeployedContract`, `callTx`, the HTTP proof provider, the indexer public-data provider.
- **Indexer:** the page and the CLI read contract state over its GraphQL API with no wallet. Since 9 October 2026 Preprod's indexer is Blockfrost's; the CLI takes a free project token from `BLOCKFROST_PROJECT_ID`, and the page goes through datum-api's read-only relay (`POST /api/indexer`, the one contract query the page sends, nothing else).

**Why Midnight:** the depth is public and the book is private, and Midnight is a chain where a contract can hold both at once and prove a statement that joins them.

## Who it is for

- **CeFi lenders that publish proof of reserves**, to show the reserves cover liabilities at the price they could actually be sold for, without publishing the book.
- **Tokenized-stock and RWA lenders**, whose collateral often has one thin on-chain venue where the mark and the exit diverge most.
- **DAO treasuries** reporting runway in their own volatile token, which they could only sell into their own pool.

**Adoption path.** (1) Open source today: the CLI prover, the verifier and the page run against any Aerodrome volatile pool on Base. (2) Hosted attestation for a lender: their prover runs locally, we host the verification page and schedule attestations. (3) Integration where verdicts are consumed: risk dashboards, curators and counterparties reading `covered` and the history from the indexer, and in Wave 3 from another Midnight contract.

**Price.** $250 per published attestation, or $1,500 a month for daily attestations with a hosted verification page. The marginal cost is one proof (seconds of CPU) and one Midnight transaction fee in DUST.

## Wave 3

- A second hop for depth quoted in a volatile asset (WELL through WETH), and Uniswap V2 pools on Base.
- A conservative bound for concentrated liquidity from tick data, so Slipstream exits are priced rather than excluded.
- A packaged lender-side prover (one command, no Docker), and scheduled attestations for the real book.
- A Midnight contract that consumes another contract's `covered` and history, so counterparties can act on a verdict on chain.
- Mainnet when Midnight mainnet accepts it.

## Build and test

Toolchain: Compact 0.31.1 (language 0.23, ledger 8), compact devtools 0.5.2, Node 22 or 24, midnight-js 4.1.1, wallet SDK 1.2.0, proof server 8.1.0.

```bash
npm install
npm run build            # both contracts, --skip-zk
npm test                 # 86 tests
compact compile contract/src/datum.compact build/datum-full   # proving keys, ~22 s
npm run test:zk          # 6 scenarios through the real proof server's /check
node test/mutants.mjs    # 14 mutants
```

Proving keys (4 slots, k=15, 32,606 rows by `zkir mock-compile`):

```
46bfe581adaa0901535c5a2811fc89820dbe084b6ddc7ccd16814e0930efc8a1  keys/attest.prover   (9,996,671 bytes)
58cf93e1b60668e6761841c2c9f2f87a7495a402cd8033eb39deb10875033886  keys/attest.verifier (2,119 bytes)
```

## Deployment record (Preprod)

| Step | Contract | Transaction hash | Block |
|---|---|---|---|
| AERO book: deploy | `60c0dc62d6989724d602202a5d5b18e8c7af64ae48f9506588398d64bf4184f1` | `33aa5ad296aee02cb8fc42674377c4b714b1b895f435ec69293a8babd6d3d3f8` | 2,890,426 |
| AERO book: attest, period 0, COVERED | | `bbf66ac0ff8ff6a408d039c4406bc0a6d26117895b2c1a5273ae658055b297ec` | 2,890,434 |
| WELL book: deploy | `d2bd781efab363c369be91bc9f8214e6907a2607823fae363b36594e8c901ac8` | `648d09185b9f91ea6f6b5fab49a435c40aebfbd3ac4db0deb9a24fc37c83adf7` | 2,890,439 |
| WELL book: attest, period 0, COVERED | | `18c8bd723287f72a9a2b6558a4dec3954306c8ddeb4834c20320a85f5951aecd` | 2,890,448 |
| Demo contract (hosted attest flow): deploy | `763d37058edb5a23442145318d3ba041f1bbd0286942a624240d80696be7910c` | `6704c11cf431d4672988d5645227b4752a0320d99510c5ec393c91f115248608` | 2,890,453 |

Every hash above is the transaction **hash** (canonical; Midnight.js's `txId` is one of several identifiers, see [docs/WAVE1.md](docs/WAVE1.md#transaction-hash-vs-transaction-identifier)). Full record: [deployments/preprod.json](deployments/preprod.json).

## Docs

- [JUDGE_GUIDE.md](JUDGE_GUIDE.md): verify every claim in five minutes.
- [docs/CRITERIA.md](docs/CRITERIA.md): each judging criterion, mapped to evidence.
- [docs/FEEDBACK.md](docs/FEEDBACK.md): Midnight tooling feedback, most useful first.
- [docs/REVIEW.md](docs/REVIEW.md): the contract review against Midnight Expert's checklists.
- [docs/WAVE1.md](docs/WAVE1.md): the Wave 1 record.

## License

[Apache-2.0](LICENSE).
