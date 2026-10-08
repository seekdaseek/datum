#!/usr/bin/env node
//
// scripts/deploy.mjs — datum v2: one process, every write.
//
//   node scripts/deploy.mjs --network preprod [--sync-only] [--book moonwell-aero]
//                           [--book-address <hex>] [--skip-demo] [--sponsor-night <n>]
//
// Wallet sync is the dominant cost of every write on a public network (about
// two hours on Preprod), so everything that needs a synced wallet happens in
// this one process, in this order:
//
//   1. open the wallet, restoring from a checkpoint if one exists; sync;
//      checkpoint immediately
//   2. make sure NIGHT is registered for DUST and DUST is spendable
//   3. deploy the BOOK contract (unless --book-address is given)
//   4. build the book against a reference block taken NOW, after the sync,
//      so the reserves are fresh when the proof lands — then attest it
//   5. deploy the DEMO contract that the hosted "Attest a book" flow writes to
//   6. send NIGHT to the sponsor wallet that will pay DUST for that flow
//   7. checkpoint again and write deployments/<network>.json (public data only)
//
// Secrets: WALLET_SEED, BOOK_ATTESTOR_SECRET, DEMO_ATTESTOR_SECRET and
// PRIVATE_STATE_PASSWORD come from .env; SPONSOR_SEED from .env.sponsor. None
// is printed. The book's private state (positions, debt, nonce) is kept by the
// encrypted level private-state provider so the next period can prove it
// still holds this one's opening.
//
import { randomBytes } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import { applyNetwork } from './config.mjs';
import { ensureEnvSecret, ensureStorePassword, ROOT, die } from './seed.mjs';
import {
  openWallet, saveCheckpoint, waitSynced, nightBalance, dustBalance,
  registerDustIfNeeded, waitForDust, transferNight, walletProviderFor, closeWallet, log,
} from './wallet-lib.mjs';
import { buildMoonwellAeroBook } from './books/moonwell-aero.mjs';
import { Contract, ledger } from '../build/datum-full/contract/index.js';

const NET = applyNetwork();
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(k);

const ZK_DIR = resolve(ROOT, 'build/datum-full');
const STATE = resolve(ROOT, `state/${NET.id}-wallet_seed.json`);
const MAX_REF_AGE = 21_600n; // six hours
const SLOTS = 4;

const hex = (u) => Buffer.from(u).toString('hex');
const randomSecret = () => randomBytes(32).toString('hex');
const bytes = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 60000).toFixed(1)}m]`;

// ---------------------------------------------------------------------------
// witnesses — read the book from private state
// ---------------------------------------------------------------------------
const emptyOpening = () => ({ positions: Array(SLOTS).fill(0n), debt: 0n, nonce: new Uint8Array(32) });
const witnesses = {
  positionSizes: ({ privateState }) => [privateState, privateState.positions],
  claimedProceeds: ({ privateState }) => [privateState, privateState.proceeds],
  debtAmount: ({ privateState }) => [privateState, privateState.debt],
  commitmentNonce: ({ privateState }) => [privateState, privateState.nonce],
  attestorSecret: ({ privateState }) => [privateState, privateState.attestorSecret],
  previousOpening: ({ privateState }) => [privateState, privateState.prev ?? emptyOpening()],
};
const compiled = CompiledContract.make('datum', Contract).pipe(
  CompiledContract.withWitnesses(witnesses),
  CompiledContract.withCompiledFileAssets(ZK_DIR),
);

const padding = () => ({
  chainId: 0n, pool: new Uint8Array(20), collateralIsToken0: false, decX: 0n, decY: 0n, feeBps: 0n,
  syncBlock: 0n, syncTx: new Uint8Array(32), logIndex: 0n, refBlock: 0n, refTime: 0n, reserveX: 1n, reserveY: 1n,
});
const pad8 = (xs, fill) => [...xs, ...Array(SLOTS - xs.length).fill(null).map(fill)];

const providersFor = (ctx, storeName) => {
  const zk = new NodeZkConfigProvider(ZK_DIR);
  const wm = walletProviderFor(ctx);
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `${storeName}-private-state`,
      signingKeyStoreName: `${storeName}-signing-keys`,
      privateStoragePasswordProvider: () => ensureStorePassword().value,
      accountId: ctx.address,
    }),
    publicDataProvider: indexerPublicDataProvider(NET.indexerHttp, NET.indexerWs),
    zkConfigProvider: zk,
    proofProvider: httpClientProofProvider(NET.proofServer, zk),
    walletProvider: wm,
    midnightProvider: wm,
  };
};

const txFields = (pub) => ({ txHash: pub.txHash, txIdentifier: pub.txId, block: pub.blockHeight, status: String(pub.status) });

// ---------------------------------------------------------------------------
const main = async () => {
  log(`datum v2 deploy — network ${NET.id}`);
  const { value: seedHex } = ensureEnvSecret('WALLET_SEED', () => die('WALLET_SEED missing'));
  const { value: bookSecret } = ensureEnvSecret('BOOK_ATTESTOR_SECRET', randomSecret);
  const { value: demoSecret } = ensureEnvSecret('DEMO_ATTESTOR_SECRET', randomSecret);

  // 1. wallet
  const ctx = await openWallet({ net: NET, seedHex, statePath: STATE });
  log(`${stamp()} wallet ${ctx.address} — ${ctx.restoredFrom ? `restored from checkpoint ${ctx.restoredFrom}` : 'cold start from genesis'}`);
  const { state, seconds } = await waitSynced(ctx);
  log(`${stamp()} synced in ${(seconds / 60).toFixed(1)} min; rss ${Math.round(process.memoryUsage().rss / 1048576)} MB; NIGHT ${nightBalance(state)}`);
  const cp = await saveCheckpoint(ctx, NET, STATE);
  log(`${stamp()} checkpoint written (${cp.bytes} bytes)`);
  if (nightBalance(state) === 0n) die('wallet holds no NIGHT');
  if (flag('--sync-only')) {
    log(`${stamp()} --sync-only: checkpoint saved, stopping before any transaction`);
    await closeWallet(ctx);
    process.exit(0);
  }

  // 2. DUST
  const reg = await registerDustIfNeeded(ctx);
  if (reg.registered) log(`${stamp()} registered ${reg.registered} NIGHT UTXO(s) for DUST`);
  log(`${stamp()} DUST spendable: ${await waitForDust(ctx)}`);

  const record = { network: NET.id, generatedAt: new Date().toISOString(), contractVersion: 'v2' };

  // 3. book contract
  const bookProviders = providersFor(ctx, 'datum-book');
  let book;
  const existing = arg('--book-address');
  if (existing) {
    book = await findDeployedContract(bookProviders, { compiledContract: compiled, contractAddress: existing, privateStateId: 'book' });
    log(`${stamp()} attached to book contract ${existing}`);
    record.book = { address: existing };
  } else {
    log(`${stamp()} deploying the book contract…`);
    book = await deployContract(bookProviders, {
      compiledContract: compiled,
      privateStateId: 'book',
      initialPrivateState: { attestorSecret: bytes(bookSecret), ...emptyOpening(), proceeds: Array(SLOTS).fill(0n) },
      args: [MAX_REF_AGE],
    });
    record.book = { address: book.deployTxData.public.contractAddress, deploy: txFields(book.deployTxData.public) };
    log(`${stamp()} book contract ${record.book.address} — deploy tx ${record.book.deploy.txHash} block ${record.book.deploy.block}`);
  }

  // 4. the real book, built against a reference block taken now
  const bookName = arg('--book', 'moonwell-aero');
  if (bookName !== 'moonwell-aero') die(`unknown book ${bookName}`);
  const b = await buildMoonwellAeroBook();
  const f = b.figures;
  log(`${stamp()} book built at Base block ${b.refBlock}: marks ${f.markedCoverage.toFixed(2)}x, realisable ${f.realisableCoverage.toFixed(2)}x, gap $${Math.round(f.gapUsd).toLocaleString('en')}`);

  const prior = await bookProviders.privateStateProvider.get('book');
  const period = BigInt(ledger((await bookProviders.publicDataProvider.queryContractState(record.book.address)).data).attestationCount);
  const ps = {
    attestorSecret: bytes(bookSecret),
    positions: pad8(b.book.positions, () => 0n),
    proceeds: pad8(b.book.proceeds, () => 0n),
    debt: b.book.debt,
    nonce: new Uint8Array(randomBytes(32)),
    prev: period > 0n && prior ? { positions: prior.positions, debt: prior.debt, nonce: prior.nonce } : emptyOpening(),
  };
  await bookProviders.privateStateProvider.set('book', ps);
  const venues = pad8([b.venue], padding);
  const call = await book.callTx.attest(venues, b.ratio, BigInt(Math.floor(Date.now() / 1000)));
  record.book.attest = { ...txFields(call.public), period: period.toString(), baseRefBlock: b.refBlock.toString(), figures: f, sources: b.sources };
  log(`${stamp()} ATTESTED period ${period}: tx ${record.book.attest.txHash} block ${record.book.attest.block} ${record.book.attest.status}`);

  // 5. demo contract for the hosted flow
  if (!flag('--skip-demo')) {
    const demoProviders = providersFor(ctx, 'datum-demo');
    log(`${stamp()} deploying the demo contract…`);
    const demo = await deployContract(demoProviders, {
      compiledContract: compiled,
      privateStateId: 'demo',
      initialPrivateState: { attestorSecret: bytes(demoSecret), ...emptyOpening(), proceeds: Array(SLOTS).fill(0n) },
      args: [MAX_REF_AGE],
    });
    record.demo = { address: demo.deployTxData.public.contractAddress, deploy: txFields(demo.deployTxData.public) };
    log(`${stamp()} demo contract ${record.demo.address} — deploy tx ${record.demo.deploy.txHash}`);
  }

  // 6. fund the sponsor wallet
  const sponsorNight = BigInt(arg('--sponsor-night', '400000000')); // 400 tNIGHT
  const sponsorAddr = arg('--sponsor-address');
  if (sponsorAddr) {
    const id = await transferNight(ctx, sponsorAddr, sponsorNight);
    record.sponsorFunding = { to: sponsorAddr, amount: sponsorNight.toString(), txIdentifier: id };
    log(`${stamp()} sent ${sponsorNight} NIGHT to the sponsor: ${id}`);
  }

  // 7. checkpoint + public record
  await saveCheckpoint(ctx, NET, STATE);
  mkdirSync(resolve(ROOT, 'deployments'), { recursive: true });
  const out = resolve(ROOT, `deployments/${NET.id}.json`);
  const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
  writeFileSync(out, JSON.stringify({ ...previous, ...record, history: [...(previous.history ?? []), record] }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
  log(`${stamp()} wrote deployments/${NET.id}.json`);
  await closeWallet(ctx);
  process.exit(0);
};

main().catch((e) => {
  console.error(`${stamp()} deploy failed: ${e?.message ?? e}`);
  console.error(e?.stack ?? '');
  process.exit(1);
});
