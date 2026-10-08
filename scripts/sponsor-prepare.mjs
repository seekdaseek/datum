#!/usr/bin/env node
//
// scripts/sponsor-prepare.mjs — get the DUST sponsor wallet ready on the Mac,
// so the VPS never pays the cold sync.
//
//   node scripts/sponsor-prepare.mjs --network preprod
//
// Runs alongside scripts/deploy.mjs, on its own core. It syncs the sponsor
// wallet from genesis (or its checkpoint), checkpoints, waits for the NIGHT
// that deploy.mjs sends it, registers that NIGHT for DUST, waits for DUST to
// become spendable, and checkpoints again. The final checkpoint is what ships
// to the VPS.
//
// The sponsor's seed is SPONSOR_SEED in .env.sponsor (mode 0600) and is used
// for nothing else.
//
import { resolve } from 'node:path';
import * as Rx from 'rxjs';
import { applyNetwork } from './config.mjs';
import { ensureEnvSecret, SPONSOR_ENV, ROOT, die } from './seed.mjs';
import { openWallet, saveCheckpoint, waitSynced, nightBalance, registerDustWithRetry, waitForDust, closeWallet, log } from './wallet-lib.mjs';

const NET = applyNetwork();
const STATE = resolve(ROOT, `state/${NET.id}-sponsor.json`);
const t0 = Date.now();
const stamp = () => `[sponsor ${((Date.now() - t0) / 60000).toFixed(1)}m]`;

const { value: seedHex } = ensureEnvSecret('SPONSOR_SEED', () => die('SPONSOR_SEED missing — run scripts/wallet.mjs --sponsor first'), SPONSOR_ENV);
const ctx = await openWallet({ net: NET, seedHex, statePath: STATE });
log(`${stamp()} ${ctx.address} — ${ctx.restoredFrom ? `restored from ${ctx.restoredFrom}` : 'cold start from genesis'}`);

const { state, seconds } = await waitSynced(ctx);
log(`${stamp()} synced in ${(seconds / 60).toFixed(1)} min; rss ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
await saveCheckpoint(ctx, NET, STATE);
log(`${stamp()} checkpoint written`);

let night = nightBalance(state);
if (night === 0n) {
  log(`${stamp()} waiting for NIGHT from the deploy process…`);
  night = await Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.map(nightBalance), Rx.filter((b) => b > 0n), Rx.timeout({ each: 4 * 3600_000 })));
}
log(`${stamp()} NIGHT ${night}`);

const reg = await registerDustWithRetry(ctx);
if (reg.registered) log(`${stamp()} registered ${reg.registered} NIGHT UTXO(s) for DUST`);
log(`${stamp()} DUST spendable: ${await waitForDust(ctx, 3600_000)}`);

const cp = await saveCheckpoint(ctx, NET, STATE);
log(`${stamp()} final checkpoint ${cp.bytes} bytes → ${STATE}`);
await closeWallet(ctx);
process.exit(0);
