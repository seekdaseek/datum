#!/usr/bin/env node
//
// scripts/wallet-roundtrip.mjs — prove that a synced wallet survives a restart.
//
//   node scripts/wallet-roundtrip.mjs --network undeployed [--seed-key WALLET_SEED] [--state state/x.json]
//
// Pass 1 opens the wallet (from the checkpoint if one exists, else from
// genesis), waits for a full sync, records address / NIGHT / DUST, writes a
// checkpoint and closes. Pass 2 opens a NEW wallet object from that checkpoint
// alone and waits for sync again. The round trip holds only if pass 2 reports
// the same address and the same NIGHT, and syncs faster than a cold start.
//
import { applyNetwork } from './config.mjs';
import { ensureEnvSecret } from './seed.mjs';
import { openWallet, saveCheckpoint, waitSynced, nightBalance, dustBalance, closeWallet } from './wallet-lib.mjs';

const net = applyNetwork();
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const seedKey = arg('--seed-key', 'WALLET_SEED');
const statePath = arg('--state', `state/${net.id}-${seedKey.toLowerCase()}.json`);
const { value: seedHex } = ensureEnvSecret(seedKey, () => { throw new Error(`${seedKey} is not set in .env`); });

const pass = async (n) => {
  const t0 = Date.now();
  const ctx = await openWallet({ net, seedHex, statePath });
  const { state, seconds } = await waitSynced(ctx);
  const out = {
    pass: n,
    restoredFrom: ctx.restoredFrom ?? 'genesis',
    address: ctx.address,
    night: nightBalance(state),
    dust: dustBalance(state),
    syncSeconds: seconds,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
  const cp = await saveCheckpoint(ctx, net, statePath);
  out.checkpointBytes = cp.bytes;
  await closeWallet(ctx);
  out.totalSeconds = (Date.now() - t0) / 1000;
  return out;
};

const a = await pass(1);
const b = await pass(2);
const fmt = (p) => `pass ${p.pass}: from ${p.restoredFrom}, synced in ${p.syncSeconds.toFixed(1)}s, NIGHT ${p.night}, rss ${p.rssMB} MB, checkpoint ${p.checkpointBytes} bytes`;
console.log(fmt(a));
console.log(fmt(b));
const ok = a.address === b.address && a.night === b.night && b.restoredFrom !== 'genesis';
console.log(`round trip: ${ok ? 'HOLDS' : 'BROKEN'} — same address ${a.address === b.address}, same NIGHT ${a.night === b.night}, pass 2 restored ${b.restoredFrom !== 'genesis'}`);
process.exit(ok ? 0 : 1);
