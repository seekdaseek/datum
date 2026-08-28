//
// scripts/deploy.mjs — deploy datum and publish one real attestation.
//
// Network is chosen entirely by scripts/config.mjs:
//   node scripts/deploy.mjs --network undeployed
//   node scripts/deploy.mjs --network preview
// Nothing else in this file is network-specific.
//
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

import * as Rx from 'rxjs';
import {
  WalletFacade,
  ShieldedWallet,
  UnshieldedWallet,
  DustWallet,
  PublicKey,
  DustAddress,
  MidnightBech32m,
  NoOpTransactionHistoryStorage,
  Roles,
} from '@midnightntwrk/wallet-sdk';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import { resolve } from 'node:path';
import { applyNetwork } from './config.mjs';
import { ensureSeed, ensureStorePassword, deriveKeys, unshieldedKeystoreFor, ROOT, die } from './seed.mjs';

import { Contract } from '../build/datum-full/contract/index.js';

const NET = applyNetwork();
const ZK_DIR = resolve(ROOT, 'build/datum-full');
const MICRO = 1_000_000n;
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// The book being attested. Private — it never leaves this process.
// Deliberately the headline case: solvent at oracle marks, insolvent at
// realisable prices, so the attestation that lands on chain reads NOT COVERED.
// ---------------------------------------------------------------------------
const POOL_X = 1_000_000n * MICRO;
const POOL_Y = 50_000_000n * MICRO;
const BOOK_Q = 500_000n * MICRO;
const DEBT = 20_000_000n * MICRO;
const RATIO = 1_200_000n; // 120%, scaled by RATIO_SCALE = 1e6

const pad = (xs, n = 8, fill = 0n) => [...xs, ...Array(n - xs.length).fill(fill)];
const venueId = (b) => new Uint8Array(32).fill(b);
const realisable = (X, Y, q) => (q === 0n ? 0n : (Y * q) / (X + q));

const VENUES = pad(
  [{ venueId: venueId(7), reserveX: POOL_X, reserveY: POOL_Y, blockHeight: 1n }],
  8,
  { venueId: venueId(0), reserveX: 1n, reserveY: 1n, blockHeight: 0n },
);
const POSITIONS = pad([BOOK_Q]);
const PROCEEDS = POSITIONS.map((q, i) => realisable(VENUES[i].reserveX, VENUES[i].reserveY, q));

const privateState = {
  positions: POSITIONS,
  proceeds: PROCEEDS,
  debt: DEBT,
  nonce: new Uint8Array(32).fill(1),
};

const witnesses = {
  positionSizes: ({ privateState }) => [privateState, privateState.positions],
  claimedProceeds: ({ privateState }) => [privateState, privateState.proceeds],
  debtAmount: ({ privateState }) => [privateState, privateState.debt],
  commitmentNonce: ({ privateState }) => [privateState, privateState.nonce],
};

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
const buildWallet = async () => {
  const { seedHex } = ensureSeed();
  const keys = deriveKeys(seedHex);
  const unshieldedKeystore = unshieldedKeystoreFor(keys);

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);

  const indexerClientConnection = { indexerHttpUrl: NET.indexerHttp, indexerWsUrl: NET.indexerWs };
  const shieldedConfig = {
    networkId: getNetworkId(),
    indexerClientConnection,
    provingServerUrl: new URL(NET.proofServer),
    relayURL: new URL(NET.node.replace(/^http/, 'ws')),
  };
  const unshieldedConfig = {
    networkId: getNetworkId(),
    indexerClientConnection,
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  };
  const dustConfig = {
    ...shieldedConfig,
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };

  const wallet = await WalletFacade.init({
    configuration: { ...shieldedConfig, ...unshieldedConfig, ...dustConfig },
    shielded: (cfg) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, unshieldedKeystore, shieldedSecretKeys, dustSecretKey };
};

const registerDustIfNeeded = async (ctx) => {
  const state = await ctx.wallet.waitForSyncedState();
  const unregistered = state.unshielded.availableCoins.filter(
    (c) => c.meta?.registeredForDustGeneration !== true,
  );
  if (unregistered.length === 0) {
    log('DUST: all NIGHT already registered');
    return;
  }
  log(`DUST: registering ${unregistered.length} NIGHT UTXO(s) for generation`);
  const target = String(DustAddress.encodePublicKey(getNetworkId(), state.dust.publicKey));
  const dustReceiver = MidnightBech32m.parse(target).decode(DustAddress, getNetworkId());
  const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
    unregistered,
    ctx.unshieldedKeystore.getPublicKey(),
    (payload) => ctx.unshieldedKeystore.signData(payload),
    dustReceiver,
  );
  const finalized = await ctx.wallet.finalizeRecipe(recipe);
  await ctx.wallet.submitTransaction(finalized);
  log('DUST: registration submitted');
};

const waitForDust = async (ctx) => {
  log('DUST: waiting for a spendable balance...');
  const bal = await Rx.firstValueFrom(
    ctx.wallet.state().pipe(
      Rx.map((s) => s.dust.balance(new Date())),
      Rx.filter((b) => b > 0n),
      Rx.timeout({ each: 600_000 }),
    ),
  );
  log(`DUST: balance ${bal}`);
};

// ---------------------------------------------------------------------------
// Providers — the six required slots.
// ---------------------------------------------------------------------------
const buildProviders = (ctx) => {
  const zkConfigProvider = new NodeZkConfigProvider(ZK_DIR);
  const ttlOneHour = () => new Date(Date.now() + 3_600_000);
  const walletAndMidnightProvider = {
    getCoinPublicKey: () => ctx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => ctx.shieldedSecretKeys.encryptionPublicKey,
    balanceTx: async (tx, ttl = ttlOneHour()) => {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl },
      );
      return await ctx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx) => ctx.wallet.submitTransaction(tx),
  };
  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'datum-private-state',
      signingKeyStoreName: 'datum-signing-keys',
      // Read from .env, generated on first use. A hardcoded password here would
      // make the store's encryption worthless the moment the repo is public.
      privateStoragePasswordProvider: () => ensureStorePassword().value,
      accountId: ctx.unshieldedKeystore.getBech32Address().asString(),
    }),
    publicDataProvider: indexerPublicDataProvider(NET.indexerHttp, NET.indexerWs),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(NET.proofServer, zkConfigProvider),
    walletProvider: walletAndMidnightProvider,
    midnightProvider: walletAndMidnightProvider,
  };
};

// ---------------------------------------------------------------------------
const main = async () => {
  log(`network: ${NET.id} (${NET.label})`);
  log(`  node    ${NET.node}`);
  log(`  indexer ${NET.indexerHttp}`);
  log(`  proof   ${NET.proofServer}`);

  const ctx = await buildWallet();
  log(`address: ${ctx.unshieldedKeystore.getBech32Address().asString()}`);

  // Report sync progress rather than blocking silently. On a public network the
  // wallet has millions of blocks to walk, and a silent wait is indistinguishable
  // from a hang.
  const progressSub = ctx.wallet.state().subscribe((st) => {
    // FacadeState has no top-level syncProgress. Each sub-wallet carries its
    // own SyncProgressData { appliedIndex, highestIndex, highestRelevantIndex,
    // highestRelevantWalletIndex, isConnected }, and isSynced is the roll-up.
    // The accessor is `progress`, not `syncProgress`, and it returns
    // SyncProgressData { appliedIndex, highestIndex, highestRelevantIndex,
    // highestRelevantWalletIndex, isConnected } — all bigint except isConnected.
    const part = (name, ws) => {
      const p = ws?.progress ?? ws?.syncProgress;
      if (!p) return `${name}=?`;
      const a = Number(p.appliedIndex ?? 0n);
      const h = Number(p.highestIndex ?? 0n);
      return `${name}=${h > 0 ? ((a / h) * 100).toFixed(1) : '0.0'}% (${a}/${h})`;
    };
    process.stderr.write(
      `\r  sync ${part('unshielded', st.unshielded)} ${part('shielded', st.shielded)} ${part('dust', st.dust)} isSynced=${st.isSynced}      `,
    );
  });

  const synced = await ctx.wallet.waitForSyncedState();
  progressSub.unsubscribe();
  process.stderr.write('\n');

  const night = synced.unshielded.balances[unshieldedToken().raw] ?? 0n;
  log(`NIGHT balance: ${night}`);
  if (process.argv.includes('--balance-only')) {
    log(`DUST balance : ${synced.dust.balance(new Date())}`);
    const unreg = synced.unshielded.availableCoins.filter((c) => c.meta?.registeredForDustGeneration !== true);
    log(`unregistered NIGHT UTXOs: ${unreg.length}`);
    await ctx.wallet.close?.();
    process.exit(night > 0n ? 0 : 1);
  }
  if (night === 0n) die('wallet holds no NIGHT — fund it before deploying');

  await registerDustIfNeeded(ctx);
  await waitForDust(ctx);

  const providers = buildProviders(ctx);

  // deployContract takes a CompiledContract wrapper, not a bare `new Contract(...)`.
  // make(tag, ctor) takes the CLASS; witnesses and the compiled-asset directory
  // are attached to it, not passed separately.
  const compiledContract = CompiledContract.make('datum', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(ZK_DIR),
  );

  // --address <hex> attaches to an already-deployed contract instead of
  // deploying a new one. Deploy and call are separate steps on purpose: the
  // call reads contract state through the indexer, and running it in the same
  // breath as the deploy races the indexer's view of the new contract.
  const addrIdx = process.argv.indexOf('--address');
  const existingAddress = addrIdx >= 0 ? process.argv[addrIdx + 1] : null;

  let deployed;
  if (existingAddress) {
    log(`attaching to deployed contract ${existingAddress}...`);
    deployed = await findDeployedContract(providers, {
      compiledContract,
      contractAddress: existingAddress,
      privateStateId: 'datumPrivateState',
      initialPrivateState: privateState,
    });
    log(`CONTRACT ADDRESS : ${existingAddress}`);
  } else {
    log('deploying contract...');
    deployed = await deployContract(providers, {
      compiledContract,
      privateStateId: 'datumPrivateState',
      initialPrivateState: privateState,
    });

    // FinalizedDeployTxData is privacy-sensitive: read named public fields only,
    // never spread or stringify the whole object.
    log('');
    log(`CONTRACT ADDRESS : ${deployed.deployTxData.public.contractAddress}`);
    log(`DEPLOY TX HASH   : ${deployed.deployTxData.public.txHash}`);
    // txId is ONE OF the transaction's identifiers, not a distinct canonical id.
    // The hash above is the value to quote and to query with.
    log(`DEPLOY TX IDENT  : ${deployed.deployTxData.public.txId}  (one of several identifiers)`);
    log(`DEPLOY BLOCK     : ${deployed.deployTxData.public.blockHeight}`);
  }

  if (process.argv.includes('--deploy-only')) {
    log('');
    log('--deploy-only: stopping before attest');
    await ctx.wallet.close?.();
    process.exit(0);
  }

  log('');
  log('calling attest...');
  const called = await deployed.callTx.attest(VENUES, RATIO, BigInt(Math.floor(Date.now() / 1000)));
  const attestTxHash = called.public.txHash;
  const attestTxIdent = called.public.txId;
  const attestBlock = called.public.blockHeight;
  const attestStatus = called.public.status;

  log('');
  log(`ATTEST TX HASH   : ${attestTxHash}`);
  log(`ATTEST TX IDENT  : ${attestTxIdent}  (one of several identifiers)`);
  log(`ATTEST BLOCK     : ${attestBlock}`);
  log(`ATTEST STATUS    : ${attestStatus}`);

  await ctx.wallet.close?.();
  process.exit(0);
};

main().catch((e) => {
  console.error('deploy failed:', e?.message ?? e);
  console.error(e?.stack ?? '');
  process.exit(1);
});
