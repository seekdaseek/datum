//
// scripts/seed.mjs — seed handling and key derivation, shared by every script.
//
// SECRET HANDLING
// The seed lives only in .env (mode 0600, gitignored). Nothing in this module
// prints, logs, or throws seed material, and no error message interpolates it.
// Callers get derived keys, never the seed itself.
//
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HDWallet, Roles, createKeystore, generateRandomSeed } from '@midnightntwrk/wallet-sdk';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(ROOT, '.env');
const GITIGNORE_PATH = resolve(ROOT, '.gitignore');

export const die = (msg) => {
  console.error(`datum: ${msg}`);
  process.exit(1);
};

/** Refuse to touch a secret in a tree that would commit it. */
const assertEnvIgnored = () => {
  if (!existsSync(GITIGNORE_PATH)) die('no .gitignore found — refusing to handle a seed');
  const patterns = readFileSync(GITIGNORE_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!patterns.includes('.env')) die('.env is not listed in .gitignore — refusing to handle a seed');
};

const readSeedHex = () => {
  if (!existsSync(ENV_PATH)) return null;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = /^\s*WALLET_SEED\s*=\s*(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
};

/**
 * Return the seed hex, generating and persisting one only if absent.
 * Never regenerates: a fresh seed per run would create a new empty wallet and
 * strand the funds held by the previous one.
 *
 * @returns {{ seedHex: string, generated: boolean }}
 */
export const ensureSeed = () => {
  assertEnvIgnored();
  let seedHex = readSeedHex();
  if (seedHex !== null) {
    if (!/^[0-9a-f]+$/i.test(seedHex)) die('WALLET_SEED in .env is not hex');
    return { seedHex, generated: false };
  }
  // generateRandomSeed() is 32 bytes of CSPRNG output. Bound to a local, written
  // straight to disk, never returned to a logger.
  seedHex = Buffer.from(generateRandomSeed()).toString('hex');
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const body = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  writeFileSync(ENV_PATH, `${body}WALLET_SEED=${seedHex}\n`, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
  return { seedHex, generated: true };
};

/** Derive the Zswap / NightExternal / Dust role keys for account 0, index 0. */
export const deriveKeys = (seedHex) => {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') die(`seed rejected by HDWallet (${hd.type})`);
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') die(`key derivation failed (${derived.type})`);
  hd.hdWallet.clear(); // wipe private material from the HD tree
  return derived.keys;
};

/** The unshielded keystore, which is what produces the Bech32m address. */
export const unshieldedKeystoreFor = (keys) => createKeystore(keys[Roles.NightExternal], getNetworkId());

export { Roles };
