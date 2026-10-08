#!/usr/bin/env node
//
// scripts/verify.mjs — check a datum attestation with public data only.
//
//   node scripts/verify.mjs --network preprod --address <hex> [--tamper]
//
// --tamper runs the same checks on a COPY of the published venue array with
// one reserve changed by one unit. It must exit 1 and print MISMATCH.
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
import { verifyAttestation, tamperedCopy } from './verify-core.mjs';
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

const tamper = process.argv.includes('--tamper');
if (tamper) console.log('TAMPER: checking a copy of the venue array with slot 0 reserveY + 1\n');
const { ok } = await verifyAttestation({
  L,
  pureCircuits,
  venues: tamper ? tamperedCopy(L.venues) : L.venues,
  onCheck: (() => {
    let last;
    return (section, c) => {
      if (section !== last) { console.log(section.title); last = section; }
      console.log(`  ${c.ok ? '✔' : '✘'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    };
  })(),
});

console.log('');
console.log(ok ? 'VERIFIED — every check passed using public data only' : 'NOT VERIFIED — see the ✘ lines above');
process.exit(ok ? 0 : 1);
