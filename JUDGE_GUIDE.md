# Judge guide: verify every claim in five minutes

Nothing here asks to be taken on trust. Every step uses public data: the Midnight Preprod indexer (Blockfrost's since Midnight retired its own on 9 October 2026), Base mainnet through a public RPC, and this repository. The page needs no key; the page reads the indexer through datum-api's read-only relay, which holds the Blockfrost token.

## 1. The page (1 minute)

Open <https://datum.ochinimus.app>.

- The first sentence says what proof of reserves shows and what it misses.
- **Two real books**, Moonwell's WELL and AERO collateral on Base: coverage at the oracle mark, coverage at realisable exit, and the dollars that do not exist at exit (about a third of WELL's marked value). Press **Recompute from Base** on each: the page reads Moonwell and the pool at the stated Base block and should show **MATCHES BASE**.
- **Each book's attestation on chain** shows the verdict, the transaction hash, the block, the hiding book commitment, and the venue with its Sync block, log index, Sync transaction, reference block and the quote's USD rate (WETH for WELL, at Moonwell's own price; USDC at $1.00 for AERO).

## 2. Verify, then tamper (1 minute)

On the same card:

- **Verify from chain**: expect **VERIFIED**. That is the venue digest recomputed with the contract's own pure circuit, the chain of periods, and thirteen provenance checks per venue against Base, including the WETH rate against Moonwell's oracle at that block.
- **Tamper with a copy**: changes one reserve in a copy of the published venue array by one millionth of a dollar. Expect **MISMATCH** on exactly two checks: the digest the proof bound, and the reserve against the Sync log on Base. Nothing on chain changes.

## 3. Attest a book yourself (2 minutes)

In **Attest a book yourself**:

- Read the **privacy boundary**: the hosted demo prover sees the sample book; a real lender proves locally.
- The pill shows the sponsor's state. It should read **Sponsor ready**. If it reads that the sponsor wallet is syncing with Midnight, it is catching up with the chain after Preprod's indexer moved to Blockfrost on 9 October; sections 1, 2, 4 and 5 do not depend on it.
- Keep **Overlevered AERO book** selected (the preview shows the balance-threshold check passing and datum failing) and press **Attest this book on Midnight**.
- Watch the steps: reading fresh reserves from Base, preparing the private book, proving in zero knowledge, the sponsor adding DUST, submitting, the block. Each step shows its own seconds as it runs.
- The result shows the transaction hash, block and verdict (**NOT COVERED** for this book), then the page verifies it from chain by itself: expect **VERIFIED**.

Limits: one job in flight and three per hour per visitor, one proof at a time overall. If the pill says the sponsor is busy, your job queues and shows its position.

## 4. Check an attestation without the page (30 seconds)

The relay answers the one contract read the page sends, so a terminal can ask the same question:

```bash
curl -s -X POST https://datum-api.ochinimus.app/api/indexer -H 'Content-Type: application/json' \
  -d '{"query":"query Datum($addr: HexEncoded!) {\n  contractAction(address: $addr) { __typename state transaction { hash block { height timestamp } } }\n}","variables":{"addr":"60c0dc62d6989724d602202a5d5b18e8c7af64ae48f9506588398d64bf4184f1"}}' \
  | node -e 'const a=JSON.parse(require("fs").readFileSync(0)).data.contractAction;console.log(a.__typename,a.transaction.hash,a.transaction.block.height)'
```

Expect `ContractCall bbf66ac0ff8ff6a408d039c4406bc0a6d26117895b2c1a5273ae658055b297ec 2890434`: the AERO book's attestation, in block 2,890,434. For the WELL book use `d2bd781efab363c369be91bc9f8214e6907a2607823fae363b36594e8c901ac8`; expect `18c8bd723287f72a9a2b6558a4dec3954306c8ddeb4834c20320a85f5951aecd` in block 2,890,448. Any other query is refused with HTTP 400, by design.

## 5. From the repository (optional, about 5 minutes)

```bash
git clone https://github.com/seekdaseek/datum && cd datum
npm install && npm run build
export BLOCKFROST_PROJECT_ID=...                      # free Midnight Preprod project at blockfrost.io; only the CLI needs it
npm test                                             # 86 pass
node scripts/verify.mjs --network preprod            # both books VERIFIED, exit 0
node scripts/verify.mjs --network preprod --tamper   # MISMATCH on both, exit 1
node test/mutants.mjs                                # 14 of 14 mutants killed
```

## Claim by claim

| Claim | Where to check | Expected |
|---|---|---|
| The verdict is about realisable exit prices, not marks | `contract/src/datum.compact`, the per-slot fee bound in `attest` | `p * (X*10000 + q*g) <= Y*q*g` |
| Venues are real pools with provenance | page venue table; `scripts/provenance.mjs` | chain id, pool, Sync block, Sync tx, log index, ref block per slot |
| A tampered copy reads MISMATCH | page **Tamper with a copy**; `verify.mjs --tamper`; test `TAMPER: a copy of the published venue array with one reserve changed` in `test/verify-core.test.mjs` | MISMATCH on the digest and on the reserve |
| An old, deeper Sync cannot be cherry-picked | test `CHERRY-PICK: an attestation proved on a real but stale Sync` in `test/verify-core.test.mjs`, and `CHERRY-PICK` in `test/provenance.test.mjs` | rejected by the no-newer-Sync window check alone |
| Freshness is enforced by the ledger | `blockTimeGt(rt)` and `blockTimeLt(rt + maxRefAge)` in `attest`; `FRESHNESS` tests | stale or future reference blocks fail |
| Only the attestor can attest | `attestorKey` in the contract; `ATTESTOR` tests | a different secret fails |
| Each period is chained to the last | `history` on the page; `CHAIN` tests | period N links to N−1 and ends at the head |
| A mark-based check passes a book datum fails | `contract/src/control.compact`; `test/control.test.mjs` | control COVERED, datum NOT COVERED on the same book |
| The simulator matches the real prover | `npm run test:zk` (needs a proof server on :6300) | 6 of 6 |
| The hosted prover cannot take its host down | `ops/ecosystem.dedicated.config.cjs`; `service/capacity.mjs`; README, *Attest a book from the page* | prover MemoryMax 768M with no swap, CPUQuota=100%, nice 10, oom_score_adj 1000, started only when 700 MB is free |
| The Blockfrost token is not on the page or in a log | `service/redact.mjs`, `test/redact.test.mjs`; view source of the page | the page holds no token; the relay refuses every query but one |
| The real books' figures are Base's | page **Recompute from Base**; `node scripts/books/moonwell.mjs WELL` (or `AERO`) | the same supplied amount, oracle price and values |
| A WETH-quoted pool is valued at a checked rate | test `PRICED QUOTE` in `test/provenance.test.mjs`, `QUOTE RATE` in `test/datum.test.mjs` | a rate one unit off the oracle fails exactly the rate check |
| Reviewed against Midnight's own checklists | [docs/REVIEW.md](docs/REVIEW.md) | 16 findings, each fixed or answered |
