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

import { randomBytes } from 'node:crypto';

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

/** Read one key out of .env, or null. Never logs the value. */
const readEnvValue = (key) => {
  if (!existsSync(ENV_PATH)) return null;
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`);
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = re.exec(line);
    if (m) return m[1];
  }
  return null;
};

/** Append one key to .env at mode 0600. The value is never returned to a logger. */
const appendEnvValue = (key, value) => {
  const existing = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  const body = existing && !existing.endsWith('\n') ? existing + '\n' : existing;
  writeFileSync(ENV_PATH, `${body}${key}=${value}\n`, { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
};

/**
 * Return a secret from .env, generating and persisting one only if absent.
 * Used for both the wallet seed and the private-state-store password: neither
 * belongs in source, and a hardcoded store password makes the store's
 * encryption worthless the moment the repo is public.
 */
export const ensureEnvSecret = (key, generate) => {
  assertEnvIgnored();
  const found = readEnvValue(key);
  if (found !== null) return { value: found, generated: false };
  const value = generate();
  appendEnvValue(key, value);
  return { value, generated: true };
};

/**
 * The private-state-store password. levelPrivateStateProvider requires 16+
 * characters across three of four character classes; this generates 32 bytes
 * of base64 plus a fixed suffix guaranteeing the classes are present.
 */
export const ensureStorePassword = () =>
  ensureEnvSecret('PRIVATE_STATE_PASSWORD', () => `${randomBytes(24).toString('base64url')}aA1!`);

/**
 * Return the seed hex, generating and persisting one only if absent.
 * Never regenerates: a fresh seed per run would create a new empty wallet and
 * strand the funds held by the previous one.
 *
 * @returns {{ seedHex: string, generated: boolean }}
 */
export const ensureSeed = () => {
  // generateRandomSeed() is 32 bytes of CSPRNG output, written straight to
  // disk and never returned to a logger.
  const { value: seedHex, generated } = ensureEnvSecret('WALLET_SEED', () =>
    Buffer.from(generateRandomSeed()).toString('hex'),
  );
  if (!/^[0-9a-f]+$/i.test(seedHex)) die('WALLET_SEED in .env is not hex');
  return { seedHex, generated };
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
