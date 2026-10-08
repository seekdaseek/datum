//
// scripts/verify-core.mjs — every check on a datum attestation, from public
// data only. Shared verbatim by the CLI (scripts/verify.mjs), the page
// (frontend/src/main.js) and the tamper tests (test/verify-core.test.mjs).
//
// Input is the decoded ledger state, read from the Midnight indexer by the
// caller. Nothing here needs a wallet, a seed or a key. Three checks:
//
//   1. venuesHash — recompute the digest of the published venue array with
//      the contract's own pure circuit and compare it with the one the proof
//      bound;
//   2. history — walk every period's record and confirm each links to the
//      one before, ending at the published head;
//   3. provenance — for each active slot, re-fetch the cited Sync log from a
//      public RPC on its source chain and confirm the reserves, the factory,
//      the fee, and that no newer Sync existed at the reference block.
//
// `venues` can be passed in place of L.venues. That is how the tamper demo
// works: it changes one number in a COPY of the published array and runs the
// same checks, which must then read MISMATCH.
//
import { verifyVenueSlot, isPaddingSlot, CHAINS } from './provenance.mjs';

const hex = (u) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

export const verifyAttestation = async ({ L, pureCircuits, venues = L.venues, fetchImpl, onCheck = () => {} }) => {
  const sections = [];
  let ok = true;
  const section = (title) => {
    const s = { title, checks: [] };
    sections.push(s);
    return (pass, name, detail = '') => {
      const c = { ok: pass, name, detail };
      s.checks.push(c);
      if (!pass) ok = false;
      onCheck(s, c);
    };
  };

  // 1. the digest the proof bound
  const digest = section('The venue array the proof bound');
  const recomputed = hex(pureCircuits.venueDigest(venues));
  const bound = hex(L.venuesHash);
  digest(
    recomputed === bound,
    recomputed === bound ? 'venuesHash recomputed from the venue array MATCHES' : 'venuesHash MISMATCH: this venue array is not the one the proof bound',
    `recomputed ${recomputed.slice(0, 16)}…  on chain ${bound.slice(0, 16)}…`,
  );

  // 2. the chain of periods
  const chain = section('History chain');
  let prev = '00'.repeat(32);
  for (let p = 0n; p < L.attestationCount; p++) {
    const r = L.history.lookup(p);
    chain(
      hex(r.prev) === prev,
      `period ${p} links to ${p === 0n ? 'genesis' : `period ${p - 1n}`}`,
      `covered ${r.covered}, bar ${(Number(r.requiredRatio) / 1e6).toFixed(2)}x, at ${new Date(Number(r.attestedAt) * 1000).toISOString()}`,
    );
    prev = hex(r.commitment);
  }
  chain(prev === hex(L.head), 'the chain ends at the published head', `${hex(L.head).slice(0, 16)}…`);

  // 3. each venue, re-fetched from its source chain
  for (const [n, slot] of venues.entries()) {
    if (isPaddingSlot(slot)) continue;
    const name = CHAINS[Number(slot.chainId)]?.name ?? `chain ${slot.chainId}`;
    const v = section(`Slot ${n}: ${name} pool 0x${hex(slot.pool)}, Sync at block ${slot.syncBlock} log ${slot.logIndex}, reference block ${slot.refBlock}`);
    let r;
    try {
      r = await verifyVenueSlot(slot, { fetchImpl });
    } catch (e) {
      v(false, 'could not re-fetch this venue from its source chain', e?.message ?? String(e));
      continue;
    }
    for (const c of r.checks) v(c.ok, c.name, c.detail);
  }

  return { ok, sections };
};

/** A copy of the venue array with one reserve changed by one unit. */
export const tamperedCopy = (venues, { slot = 0, field = 'reserveY', delta = 1n } = {}) =>
  venues.map((v, i) => (i === slot ? { ...v, [field]: v[field] + delta } : v));
