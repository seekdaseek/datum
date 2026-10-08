#!/usr/bin/env node
//
// scripts/record-fixtures.mjs — record real Base RPC traffic for the
// provenance tests, so they run offline and deterministically.
//
// Pinned to one Aerodrome volatile AERO/USDC Sync and a reference block six
// blocks after it. The cherry-pick case cites a real, older Sync of the same
// pool. Rerunning regenerates test/fixtures/base-aero-usdc.json byte-for-byte
// as long as the chain history is unchanged, which for these blocks it is.
//
import { writeFileSync } from 'node:fs';
import { verifyVenueSlot, buildVenueSlot } from './provenance.mjs';

export const FIXTURE = {
  chainId: 8453,
  pool: '0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d',      // Aerodrome volatile AERO/USDC
  collateral: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO
  refBlock: 52327015n,
  cherry: { syncBlock: 52326621n, logIndex: 288n },
};

const tape = {};
const recordingFetch = async (url, init) => {
  const req = JSON.parse(init.body);
  const key = JSON.stringify([req.method, req.params]);
  const res = await fetch(url, init);
  const body = await res.json();
  if (!body.error) tape[key] = body.result;
  return { ok: res.ok, status: res.status, json: async () => body };
};

const main = async () => {
  const { slot } = await buildVenueSlot({ ...FIXTURE });
  const honest = await verifyVenueSlot(slot, { fetchImpl: recordingFetch });
  if (!honest.ok) throw new Error('the pinned honest slot no longer verifies');

  // the cherry-picked case needs the older log's coordinates and reserves
  const r = await recordingFetch('https://mainnet.base.org', {
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{
      address: FIXTURE.pool.toLowerCase(),
      topics: ['0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a'],
      fromBlock: '0x' + FIXTURE.cherry.syncBlock.toString(16), toBlock: '0x' + FIXTURE.cherry.syncBlock.toString(16) }] }),
  });
  const olds = (await r.json()).result;
  const old = olds.find((l) => BigInt(l.logIndex) === FIXTURE.cherry.logIndex);
  const cherrySlot = {
    ...slot,
    syncBlock: FIXTURE.cherry.syncBlock,
    logIndex: FIXTURE.cherry.logIndex,
    syncTx: old.transactionHash,
    rawReserve0: old.data.slice(2, 66),
    rawReserve1: old.data.slice(66, 130),
  };
  await verifyVenueSlot({ ...slot, syncBlock: cherrySlot.syncBlock, logIndex: cherrySlot.logIndex,
    syncTx: Uint8Array.from(old.transactionHash.slice(2).match(/../g).map((h) => parseInt(h, 16))) }, { fetchImpl: recordingFetch });

  const ser = (o) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? '0x' + Buffer.from(v).toString('hex') : v)));
  writeFileSync('test/fixtures/base-aero-usdc.json', JSON.stringify({
    note: 'Recorded from Base mainnet by scripts/record-fixtures.mjs. Do not hand-edit.',
    honestSlot: ser(slot),
    cherry: { syncBlock: `${FIXTURE.cherry.syncBlock}n`, logIndex: `${FIXTURE.cherry.logIndex}n`, syncTx: old.transactionHash, reserve0: '0x' + cherrySlot.rawReserve0, reserve1: '0x' + cherrySlot.rawReserve1 },
    tape,
  }, null, 1) + '\n');
  console.log(`recorded ${Object.keys(tape).length} RPC responses`);
};
main().catch((e) => { console.error(e.message); process.exit(1); });
