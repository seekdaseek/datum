//
// scripts/verify.mjs — read the published attestation back off chain.
//
//   node scripts/verify.mjs --network undeployed --address <hex>
//
// Reads only PUBLIC state through the indexer. No wallet, no seed, no private
// input: this is what any third party can do to check an attestation.
//
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { applyNetwork } from './config.mjs';
import { ledger, pureCircuits } from '../build/datum-full/contract/index.js';

const NET = applyNetwork();
const i = process.argv.indexOf('--address');
const address = i >= 0 ? process.argv[i + 1] : null;
if (!address) { console.error('usage: verify.mjs --network <id> --address <hex>'); process.exit(1); }

const provider = indexerPublicDataProvider(NET.indexerHttp, NET.indexerWs);
const state = await provider.queryContractState(address);
if (!state) { console.error(`no contract state at ${address} on ${NET.id}`); process.exit(1); }

const L = ledger(state.data);
const hex = (u) => Buffer.from(u).toString('hex');

console.log(`network          : ${NET.id}`);
console.log(`contract         : ${address}`);
console.log(`attestationCount : ${L.attestationCount}`);
console.log(`covered          : ${L.covered}   <-- the verdict`);
console.log(`requiredRatio    : ${L.requiredRatio}  (= ${Number(L.requiredRatio) / 1e6}x)`);
console.log(`attestedAt       : ${L.attestedAt}  (${new Date(Number(L.attestedAt) * 1000).toISOString()})`);
console.log(`bookCommitment   : ${hex(L.bookCommitment)}`);
console.log(`venuesHash       : ${hex(L.venuesHash)}`);
console.log('');
console.log('venue array as published:');
L.venues.forEach((v, n) => {
  const active = v.reserveX > 1n;
  console.log(`  [${n}] ${active ? 'ACTIVE ' : 'padding'} X=${v.reserveX} Y=${v.reserveY} h=${v.blockHeight} id=${hex(v.venueId).slice(0, 8)}…`);
});
console.log('');
const recomputed = pureCircuits.venueDigest(L.venues);
const ok = hex(recomputed) === hex(L.venuesHash);
console.log(`venuesHash recomputed from the published venue array: ${ok ? 'MATCHES' : 'MISMATCH'}`);
process.exit(ok ? 0 : 1);
