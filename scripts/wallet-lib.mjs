//
// scripts/wallet-lib.mjs — one wallet code path for the deploy script, the
// round-trip proof and the hosted sponsor.
//
// The expensive part of every Midnight write is the first wallet sync: about
// two hours on Preprod against ~20 s locally, CPU-bound, because the SDK walks
// the chain from genesis and holds the result in memory only. This module adds
// checkpoints: after a sync, each sub-wallet's state is serialised to disk and
// the next process restores from it instead of starting over.
//
// The checkpoint file is SENSITIVE — it is wallet state for a funded key. It is
// written mode 0600 under state/, which is gitignored, and is never printed.
//
import { WebSocket } from 'ws';
if (!globalThis.WebSocket) globalThis.WebSocket = WebSocket;

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import * as Rx from 'rxjs';
import {
  WalletFacade,
  ShieldedWallet,
  UnshieldedWallet,
  DustWallet,
  PublicKey,
  DustAddress,
  MidnightBech32m,
  UnshieldedAddress,
  NoOpTransactionHistoryStorage,
  Roles,
} from '@midnightntwrk/wallet-sdk';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { unshieldedToken, nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import { deriveKeys, unshieldedKeystoreFor } from './seed.mjs';

const log = (...a) => console.log(...a);

const configsFor = (net) => {
  const indexerClientConnection = { indexerHttpUrl: net.indexerHttp, indexerWsUrl: net.indexerWs };
  const shielded = {
    networkId: getNetworkId(),
    indexerClientConnection,
    provingServerUrl: new URL(net.proofServer),
    relayURL: new URL(net.node.replace(/^http/, 'ws')),
  };
  const unshielded = { networkId: getNetworkId(), indexerClientConnection, txHistoryStorage: new NoOpTransactionHistoryStorage() };
  const dust = { ...shielded, costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 } };
  return { shielded, unshielded, dust };
};

/**
 * Build a wallet for `seedHex` on `net`. If `statePath` holds a checkpoint,
 * restore from it instead of syncing from genesis.
 */
export const openWallet = async ({ net, seedHex, statePath }) => {
  const keys = deriveKeys(seedHex);
  const unshieldedKeystore = unshieldedKeystoreFor(keys);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const cfg = configsFor(net);

  const checkpoint = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
  if (checkpoint && checkpoint.network !== net.id) throw new Error(`checkpoint is for ${checkpoint.network}, not ${net.id}`);

  const wallet = await WalletFacade.init({
    configuration: { ...cfg.shielded, ...cfg.unshielded, ...cfg.dust },
    shielded: (c) => (checkpoint ? ShieldedWallet(c).restore(checkpoint.shielded) : ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys)),
    unshielded: (c) => (checkpoint ? UnshieldedWallet(c).restore(checkpoint.unshielded) : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore))),
    dust: (c) => (checkpoint ? DustWallet(c).restore(checkpoint.dust) : DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust)),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return {
    wallet,
    unshieldedKeystore,
    shieldedSecretKeys,
    dustSecretKey,
    address: unshieldedKeystore.getBech32Address().asString(),
    restoredFrom: checkpoint ? checkpoint.savedAt : null,
  };
};

/** Serialise every sub-wallet to `statePath`, atomically, mode 0600. */
export const saveCheckpoint = async (ctx, net, statePath) => {
  const body = {
    network: net.id,
    savedAt: new Date().toISOString(),
    address: ctx.address,
    shielded: await ctx.wallet.shielded.serializeState(),
    unshielded: await ctx.wallet.unshielded.serializeState(),
    dust: await ctx.wallet.dust.serializeState(),
  };
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, statePath);
  return { bytes: JSON.stringify(body).length, savedAt: body.savedAt };
};

// Measured 2026-10-08 against the local chain: shielded and dust progress
// carry appliedIndex but leave highestIndex at 0 throughout, so a percentage
// is meaningless; unshielded progress has a different shape altogether
// (appliedId / highestTransactionId). The honest signal is the absolute
// applied counter of each sub-wallet, which climbs while the sync is working.
const appliedOf = (ws) => {
  const p = ws?.progress;
  if (!p) return '?';
  if (p.appliedIndex !== undefined) return String(p.appliedIndex);
  if (p.appliedId !== undefined) return `${p.appliedId}/${p.highestTransactionId ?? '?'}`;
  return '?';
};

/** Wait for a full sync, printing per-sub-wallet progress to stderr. */
export const waitSynced = async (ctx, { quiet = false } = {}) => {
  const t0 = Date.now();
  const sub = ctx.wallet.state().subscribe((st) => {
    if (quiet) return;
    process.stderr.write(
      `\r  sync applied: shielded ${appliedOf(st.shielded)}  dust ${appliedOf(st.dust)}  unshielded ${appliedOf(st.unshielded)}  ${Math.round((Date.now() - t0) / 1000)}s   `,
    );
  });
  const state = await ctx.wallet.waitForSyncedState();
  sub.unsubscribe();
  if (!quiet) process.stderr.write('\n');
  return { state, seconds: (Date.now() - t0) / 1000 };
};

export const nightBalance = (state) => state.unshielded.balances[unshieldedToken().raw] ?? 0n;
export const dustBalance = (state) => state.dust.balance(new Date());

// Freshly received NIGHT must first generate enough DUST to pay its own
// registration fee (measured on Preprod: 1.0e14 of the 3.0e14 needed, minutes
// after arrival). Retry instead of failing the whole run.
export const registerDustWithRetry = async (ctx, { tries = 30, waitMs = 60_000 } = {}) => {
  for (let i = 1; ; i++) {
    try {
      return await registerDustIfNeeded(ctx);
    } catch (e) {
      if (!/Insufficient generated dust/.test(e?.message ?? '') || i >= tries) throw e;
      log(`  DUST for the registration fee is still accruing (try ${i}/${tries}); waiting ${waitMs / 1000} s`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
};

export const registerDustIfNeeded = async (ctx) => {
  const state = await ctx.wallet.waitForSyncedState();
  const unregistered = state.unshielded.availableCoins.filter((c) => c.meta?.registeredForDustGeneration !== true);
  if (unregistered.length === 0) return { registered: 0 };
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
  return { registered: unregistered.length };
};

export const waitForDust = async (ctx, timeoutMs = 900_000) =>
  Rx.firstValueFrom(
    ctx.wallet.state().pipe(
      Rx.map((s) => s.dust.balance(new Date())),
      Rx.filter((b) => b > 0n),
      Rx.timeout({ each: timeoutMs }),
    ),
  );

/** Send `amount` NIGHT (smallest unit) to a bech32 unshielded address. */
export const transferNight = async (ctx, toBech32, amount) => {
  const receiverAddress = MidnightBech32m.parse(toBech32).decode(UnshieldedAddress, getNetworkId());
  const recipe = await ctx.wallet.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: nativeToken().raw, receiverAddress, amount }] }],
    { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
    { ttl: new Date(Date.now() + 30 * 60 * 1000) },
  );
  const signed = await ctx.wallet.signRecipe(recipe, (payload) => ctx.unshieldedKeystore.signData(payload));
  const finalized = await ctx.wallet.finalizeRecipe(signed);
  return ctx.wallet.submitTransaction(finalized);
};

/** The wallet/midnight provider pair Midnight.js needs, over the facade. */
export const walletProviderFor = (ctx) => ({
  getCoinPublicKey: () => ctx.shieldedSecretKeys.coinPublicKey,
  getEncryptionPublicKey: () => ctx.shieldedSecretKeys.encryptionPublicKey,
  balanceTx: async (tx, ttl = new Date(Date.now() + 3_600_000)) => {
    const recipe = await ctx.wallet.balanceUnboundTransaction(
      tx,
      { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
      { ttl },
    );
    return ctx.wallet.finalizeRecipe(recipe);
  },
  submitTx: (tx) => ctx.wallet.submitTransaction(tx),
});

export const closeWallet = async (ctx) => {
  try {
    await ctx.wallet.stop?.();
  } catch {}
  try {
    await ctx.wallet.close?.();
  } catch {}
};

export { log };
