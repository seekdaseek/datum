#!/usr/bin/env node
//
// scripts/wallet.mjs — print the datum wallet's PUBLIC address for a network.
//
//   node scripts/wallet.mjs --network undeployed
//   node scripts/wallet.mjs --network preview
//
// The seed is generated on first run and written straight to .env with mode
// 0600. It is never printed, logged, passed as an argument, or interpolated
// into a shell string. Stdout carries the address and nothing else.
//
// Seed handling and derivation live in scripts/seed.mjs; this file is only the
// address printer.
//
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { applyNetwork } from './config.mjs';
import { ensureSeed, ensureEnvSecret, deriveKeys, unshieldedKeystoreFor, SPONSOR_ENV, ROOT, die } from './seed.mjs';
import { generateRandomSeed } from '@midnightntwrk/wallet-sdk';

// Resolves --network / $DATUM_NETWORK and calls setNetworkId before anything
// else touches the SDK. One seed serves every network; only the address
// encoding differs, so the same wallet is addressable on each.
const NET = applyNetwork();

// --sponsor: the hosted flow's DUST sponsor. Its own seed, in its own file,
// never reused for anything else.
const sponsor = process.argv.includes('--sponsor');
const { seedHex, generated } = sponsor
  ? (({ value, generated }) => ({ seedHex: value, generated }))(
      ensureEnvSecret('SPONSOR_SEED', () => Buffer.from(generateRandomSeed()).toString('hex'), SPONSOR_ENV),
    )
  : ensureSeed();
const address = unshieldedKeystoreFor(deriveKeys(seedHex)).getBech32Address().asString();

if (!address.startsWith(`${NET.addressPrefix}1`)) {
  die(`derived address has the wrong prefix for ${NET.id} (expected ${NET.addressPrefix}1...)`);
}

const envPath = sponsor ? SPONSOR_ENV : resolve(ROOT, '.env');
const mode = existsSync(envPath) ? (statSync(envPath).mode & 0o777).toString(8) : '?';
console.error(`[network ${NET.id}${sponsor ? ' — SPONSOR' : ''} — ${sponsor ? '.env.sponsor' : '.env'} ${generated ? 'created' : 'reused'}, mode ${mode}, gitignored]`);
console.log(address);
