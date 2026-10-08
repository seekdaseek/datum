#!/usr/bin/env node
//
// scripts/verify.mjs — check a datum attestation with public data only.
//
//   node scripts/verify.mjs --network preprod --address <hex>
//
// No wallet, no seed, no key. Three sources, all public:
//   - the Midnight indexer, for the contract's public state and history;
//   - the contract's own pure circuits, to recompute venuesHash and check the
//     history links;
//   - a public RPC on each venue's source chain, to re-fetch the Sync log every
//     active slot cites and confirm nothing newer existed at its reference
//     block (scripts/provenance.mjs).
// Exits 0 only if everything checks out.
//
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;

import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { applyNetwork } from './config.mjs';
import { verifyVenueSlot, isPaddingSlot, bytesToHex, CHAINS } from './provenance.mjs';
import { ledger, pureCircuits } from '../build/datum-full/contract/index.js';

const NET = applyNetwork();
const i = process.argv.indexOf('--address');
const address = i >= 0 ? process.argv[i + 1] : NET.contract;
if (!address) { console.error('usage: verify.mjs --network <id> --address <hex>'); process.exit(1); }

const hex = (u) => Buffer.from(u).toString('hex');
const provider = indexerPublicDataProvider(NET.indexerHttp, NET.indexerWs);
const state = await provider.queryContractState(address);
if (!state) { console.error(`no contract state at ${address} on ${NET.id}`); process.exit(1); }
const L = ledger(state.data);

let ok = true;
const line = (pass, text) => { if (!pass) ok = false; console.log(`  ${pass ? '✔' : '✘'} ${text}`); };

console.log(`network          : ${NET.id}`);
console.log(`contract         : ${address}`);
console.log(`attestations     : ${L.attestationCount}`);
console.log(`covered          : ${L.covered}   <-- the latest verdict`);
console.log(`requiredRatio    : ${L.requiredRatio}  (= ${(Number(L.requiredRatio) / 1e6).toFixed(2)}x)`);
console.log(`attestedAt       : ${L.attestedAt}  (${new Date(Number(L.attestedAt) * 1000).toISOString()})`);
console.log(`maxRefAge        : ${L.maxRefAge} s`);
console.log(`bookCommitment   : ${hex(L.bookCommitment)}`);
console.log(`venuesHash       : ${hex(L.venuesHash)}`);
console.log('');

console.log('contract state');
line(hex(pureCircuits.venueDigest(L.venues)) === hex(L.venuesHash), 'venuesHash recomputed from the published venue array MATCHES');

console.log('history chain');
let prev = '00'.repeat(32);
for (let p = 0n; p < L.attestationCount; p++) {
  const r = L.history.lookup(p);
  line(hex(r.prev) === prev, `period ${p} links to ${p === 0n ? 'genesis' : `period ${p - 1n}`} — covered ${r.covered}, ratio ${(Number(r.requiredRatio) / 1e6).toFixed(2)}x`);
  prev = hex(r.commitment);
}
line(prev === hex(L.head), 'the chain ends at the published head');

console.log('venue provenance (re-fetched from each source chain)');
for (const [n, slot] of L.venues.entries()) {
  if (isPaddingSlot(slot)) continue;
  const chain = CHAINS[Number(slot.chainId)];
  console.log(`  slot ${n}: ${chain?.name ?? `chain ${slot.chainId}`} pool 0x${hex(slot.pool)}  Sync @ block ${slot.syncBlock} log ${slot.logIndex}  ref block ${slot.refBlock}`);
  const r = await verifyVenueSlot(slot);
  for (const c of r.checks) line(c.ok, `${c.name} — ${c.detail}`);
}

console.log('');
console.log(ok ? 'VERIFIED — every check passed using public data only' : 'NOT VERIFIED — see the ✘ lines above');
process.exit(ok ? 0 : 1);
