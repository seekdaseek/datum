#!/usr/bin/env node
//
// scripts/wallet.mjs — derive the datum deploy wallet's PUBLIC address.
//
// SECRET HANDLING
// The seed is generated in this process and written straight to .env with mode
// 0600. It is never printed, never logged, never passed as a command argument,
// and never interpolated into a shell string. The only thing this script writes
// to stdout is the public unshielded address.
//
// The script refuses to run if .env is not gitignored, and it will not
// regenerate a seed when one already exists — a fresh seed on every run would
// silently create a new empty wallet and strand the funds in the previous one.
//
// Usage:  node scripts/wallet.mjs
//
import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HDWallet, Roles, createKeystore, generateRandomSeed } from '@midnightntwrk/wallet-sdk';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

const NETWORK = 'preview';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env');
const GITIGNORE_PATH = resolve(ROOT, '.gitignore');

const die = (msg) => {
  console.error(`wallet.mjs: ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// Guard: never write a secret into a directory that would commit it.
// ---------------------------------------------------------------------------
if (!existsSync(GITIGNORE_PATH)) die('no .gitignore found — refusing to write a seed');
const ignoredPatterns = readFileSync(GITIGNORE_PATH, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
if (!ignoredPatterns.includes('.env')) {
  die('.env is not listed in .gitignore — refusing to write a seed');
}

// ---------------------------------------------------------------------------
// Seed: reuse if present, generate exactly once otherwise.
// ---------------------------------------------------------------------------
const readSeedHex = () => {
  if (!existsSync(ENV_PATH)) return null;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*WALLET_SEED\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
};

let seedHex = readSeedHex();
let generated = false;

if (seedHex === null) {
  // Buffer.from(...) then hex; the value is bound to a local and goes straight
  // to disk. It is never returned, printed, or thrown.
  seedHex = Buffer.from(generateRandomSeed()).toString('hex');
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const body = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  writeFileSync(ENV_PATH, `${body}WALLET_SEED=${seedHex}\n`, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
  generated = true;
}

if (!/^[0-9a-f]+$/i.test(seedHex)) die('WALLET_SEED in .env is not hex');

// ---------------------------------------------------------------------------
// Derivation. Public output only.
// ---------------------------------------------------------------------------
setNetworkId(NETWORK);

const deriveKeys = (hex) => {
  const hd = HDWallet.fromSeed(Buffer.from(hex, 'hex'));
  if (hd.type !== 'seedOk') die(`seed rejected by HDWallet (${hd.type})`);
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') die(`key derivation failed (${derived.type})`);
  hd.hdWallet.clear();
  return derived.keys;
};

const keys = deriveKeys(seedHex);
const address = String(createKeystore(keys[Roles.NightExternal], getNetworkId()).getBech32Address());

if (!address.startsWith(`mn_addr_${NETWORK}1`)) {
  die(`derived address has the wrong prefix for ${NETWORK}`);
}

// ---------------------------------------------------------------------------
// Output: the address, and nothing else.
// ---------------------------------------------------------------------------
const mode = (statSync(ENV_PATH).mode & 0o777).toString(8);
console.error(`[.env ${generated ? 'created' : 'reused'}, mode ${mode}, gitignored]`);
console.log(address);
