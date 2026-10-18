#!/usr/bin/env node
//
// scripts/sync-sponsor.mjs — sync the sponsor wallet and write a checkpoint the
// hosted service can restore, so the host does not pay the long first sync.
//
//   node --env-file=.env.sponsor --env-file=.env.blockfrost scripts/sync-sponsor.mjs --out state/preprod-sponsor.json
//
// Reads SPONSOR_SEED and BLOCKFROST_PROJECT_ID from the environment, prints the
// public address and per-subscription progress (cursor against the indexer's
// tip), and saves the checkpoint every 10 minutes and when the wallet is synced.
// It never prints the seed or the token.
//
import { writeFileSync } from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { NETWORKS, withBlockfrost } from './networks.mjs';
import { openWallet, saveCheckpoint, waitSynced } from './wallet-lib.mjs';
import { installWsProbe } from '../service/wsprobe.mjs';
import { makeRedactor } from '../service/redact.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const out = arg('--out', 'state/preprod-sponsor.json');
const netId = arg('--network', 'preprod');
const seed = process.env.SPONSOR_SEED, token = process.env.BLOCKFROST_PROJECT_ID;
if (!/^[0-9a-fA-F]{64}$/.test(seed ?? '')) { console.error('SPONSOR_SEED must be 64 hex characters'); process.exit(1); }
const NET = NETWORKS[netId];
if (!NET) { console.error(`unknown network ${netId}`); process.exit(1); }
if (NET.blockfrost && !token) { console.error('BLOCKFROST_PROJECT_ID is not set'); process.exit(1); }
const redact = makeRedactor([token]);
for (const s of [process.stdout, process.stderr]) { const w = s.write.bind(s); s.write = (c, ...r) => w(typeof c === 'string' ? redact(c) : c, ...r); }
setNetworkId(NET.id);
const net = withBlockfrost(NET, token);

const events = {};
installWsProbe({
  log: (...a) => console.log(new Date().toISOString().slice(11, 19), redact(a.join(' '))),
  redact,
  onProgress: (name, at, tip) => { events[name] = { at, tip }; },
});
const t0 = Date.now();
setInterval(() => {
  const parts = Object.entries(events).map(([k, v]) => `${k} ${v.at}${v.tip ? `/${v.tip} (${((100 * v.at) / v.tip).toFixed(1)}%)` : ''}`);
  console.log(new Date().toISOString().slice(11, 19), `[sync ${Math.round((Date.now() - t0) / 1000)}s] ${parts.join(' | ') || 'no event yet'}`);
}, 30_000).unref();

const ctx = await openWallet({ net, seedHex: seed, statePath: out });
console.log(`sponsor ${ctx.address} — ${ctx.restoredFrom ? `restored from checkpoint ${ctx.restoredFrom}` : 'cold start'}`);
const save = async () => { const r = await saveCheckpoint(ctx, NET, out); console.log(`checkpoint saved ${r.savedAt} (${(r.bytes / 1e6).toFixed(1)} MB)`); };
const timer = setInterval(() => save().catch((e) => console.error(`checkpoint failed: ${e.message}`)), 10 * 60_000);
await waitSynced(ctx, { quiet: true, onProgress: (p) => { events.facade = { at: JSON.stringify(p), tip: null }; } });
clearInterval(timer);
await save();
console.log(`SYNCED in ${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(0);
