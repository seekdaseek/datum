#!/usr/bin/env node
//
// service/server.mjs — the hosted "Attest a book" flow.
//
// A judge picks a sample book on datum.ochinimus.app (or edits one); this
// service builds fresh venue provenance from Base, proves the attestation, and
// submits it to the demo contract on Midnight with a SPONSOR wallet that pays
// the DUST fee. The page then verifies the result from public data on its own.
//
// PRIVACY BOUNDARY — stated plainly, and repeated in the API response:
//   this demo prover SEES the demo book. That is acceptable only because every
//   demo book is a sample chosen on a public web page. A real lender runs the
//   prover locally (scripts/deploy.mjs) and the book never leaves their
//   machine; only the commitment and the verdict reach the chain.
//
// OPERATING LIMITS
//   - one proof at a time, in a FIFO queue capped at QUEUE_MAX
//   - per client IP: one job in flight, RATE_PER_HOUR jobs per rolling hour
//   - the sponsor's state is visible at GET /api/status: starting, syncing,
//     ready, proving, low-dust — never a bare spinner
//
// ENVIRONMENT (service/.env.service, mode 0600 — never committed)
//   DATUM_NETWORK, SPONSOR_SEED, DEMO_ATTESTOR_SECRET, PRIVATE_STATE_PASSWORD,
//   DEMO_CONTRACT, PROOF_SERVER, PORT, ALLOWED_ORIGINS, STATE_DIR
//
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

import { NETWORKS } from '../scripts/networks.mjs';
import { buildVenueSlot } from '../scripts/provenance.mjs';
import { buildMoonwellBook, MOONWELL, MARKETS } from '../scripts/books/moonwell.mjs';
import { openWallet, saveCheckpoint, waitSynced, nightBalance, dustBalance, walletProviderFor } from '../scripts/wallet-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------
const loadEnv = (file) => {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
};
// SERVICE_ENV may list several files, comma-separated (local runs read the
// repo's .env and .env.sponsor); later files and the process env win.
const envFiles = (process.env.SERVICE_ENV ?? resolve(ROOT, 'service/.env.service')).split(',').map((f) => resolve(ROOT, f));
const ENV = Object.assign({}, ...envFiles.map(loadEnv), process.env);
const need = (k) => { if (!ENV[k]) { console.error(`service: ${k} is not set`); process.exit(1); } return ENV[k]; };

const NET = NETWORKS[ENV.DATUM_NETWORK ?? 'preprod'];
if (!NET) { console.error(`service: unknown network ${ENV.DATUM_NETWORK}`); process.exit(1); }
setNetworkId(NET.id); // before any provider is constructed
const net = { ...NET, proofServer: ENV.PROOF_SERVER ?? NET.proofServer };

const PORT = Number(ENV.PORT ?? 3034);
const STATE_DIR = resolve(ENV.STATE_DIR ?? resolve(ROOT, 'state'));
const CHECKPOINT = resolve(STATE_DIR, `${NET.id}-sponsor.json`);
const JOB_LOG = resolve(STATE_DIR, `${NET.id}-jobs.jsonl`);
const ZK_DIR = resolve(ROOT, 'build/datum-full');
const DEMO_CONTRACT = need('DEMO_CONTRACT');
const LAST_OPENING = resolve(STATE_DIR, `${NET.id}-demo-${DEMO_CONTRACT.slice(0, 16)}-opening.json`);
const ALLOWED = (ENV.ALLOWED_ORIGINS ?? 'https://datum.ochinimus.app,https://datum-9ib.pages.dev,http://localhost:4173,http://localhost:5173').split(',');

const QUEUE_MAX = 5;
const RATE_PER_HOUR = Number(ENV.RATE_PER_HOUR ?? 3); // raised only for the pre-go-live load test
const CHECKPOINT_EVERY_MS = 10 * 60 * 1000;
const MIN_DUST = 1_000_000_000_000_000n; // 1 DUST; below this, refuse new jobs

mkdirSync(STATE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// the books a judge can pick
// ---------------------------------------------------------------------------
const MICRO = 1_000_000n;
const realisable = (X, Y, q, f) => (q === 0n ? 0n : (Y * q * (10000n - f)) / (X * 10000n + q * (10000n - f)));
const marked = (X, Y, q) => (q * Y) / X;

export const BOOKS = {
  'aero-overlevered': {
    name: 'Overlevered AERO book',
    blurb: '10,000,000 AERO against $5,500,000 of debt at a 120% bar. Clears at oracle marks, fails at the price the pool would actually pay.',
    aero: 10_000_000, debtUsd: 5_500_000, ratio: 1.2,
  },
  'aero-conservative': {
    name: 'Conservative AERO book',
    blurb: '2,000,000 AERO against $900,000 of debt at 150%. Small against the depth, so marks and realisable values agree.',
    aero: 2_000_000, debtUsd: 900_000, ratio: 1.5,
  },
  'moonwell-aero': {
    name: 'Moonwell\'s AERO collateral (real)',
    blurb: 'The AERO supplied to Moonwell on Base, against the most debt Moonwell\'s own 60% collateral factor lets it secure. Read live from Base.',
    live: true,
  },
};
const LIMITS = { aero: [1_000, 25_000_000], debtUsd: [1_000, 50_000_000], ratio: [0.5, 3] };

const resolveBook = async (spec) => {
  if (spec.book === 'moonwell-aero') {
    const b = await buildMoonwellBook('AERO');
    return { name: BOOKS['moonwell-aero'].name, venue: b.venue, q: b.book.positions[0], debt: b.book.debt, ratio: b.ratio, refBlock: b.refBlock };
  }
  const base = spec.book === 'custom' ? spec.custom ?? {} : BOOKS[spec.book];
  if (!base) throw new Error(`unknown book ${spec.book}`);
  const clamp = (v, [lo, hi], k) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} must be between ${lo} and ${hi}`);
    return n;
  };
  const aero = clamp(base.aero, LIMITS.aero, 'aero');
  const debtUsd = clamp(base.debtUsd, LIMITS.debtUsd, 'debtUsd');
  const ratio = clamp(base.ratio, LIMITS.ratio, 'ratio');
  const { slot } = await buildVenueSlot({ chainId: MOONWELL.chainId, pool: MARKETS.AERO.pool, collateral: MARKETS.AERO.token });
  return {
    name: spec.book === 'custom' ? 'Custom AERO book' : base.name,
    venue: slot,
    q: BigInt(Math.round(aero)) * MICRO,
    debt: BigInt(Math.round(debtUsd)) * MICRO,
    ratio: BigInt(Math.round(ratio * 1_000_000)),
    refBlock: slot.refBlock,
  };
};

// ---------------------------------------------------------------------------
// sponsor wallet and demo contract
// ---------------------------------------------------------------------------
const status = {
  state: 'starting',
  network: NET.id,
  demoContract: DEMO_CONTRACT,
  sponsor: null,
  startedAt: new Date().toISOString(),
  syncedAt: null,
  lastCheckpoint: null,
  lastAttestation: null,
  privacy: 'This hosted demo prover sees the demo book you submit. A real lender runs the prover locally and the book never leaves their machine.',
};
let ctx;
let demo;
let providers;

const SLOTS = 4;
const emptyOpening = () => ({ positions: Array(SLOTS).fill(0n), debt: 0n, nonce: new Uint8Array(32) });
const witnesses = {
  positionSizes: ({ privateState }) => [privateState, privateState.positions],
  claimedProceeds: ({ privateState }) => [privateState, privateState.proceeds],
  debtAmount: ({ privateState }) => [privateState, privateState.debt],
  commitmentNonce: ({ privateState }) => [privateState, privateState.nonce],
  attestorSecret: ({ privateState }) => [privateState, privateState.attestorSecret],
  previousOpening: ({ privateState }) => [privateState, privateState.prev ?? emptyOpening()],
};
const padding = () => ({
  chainId: 0n, pool: new Uint8Array(20), collateralIsToken0: false, decX: 0n, decY: 0n, feeBps: 0n,
  syncBlock: 0n, syncTx: new Uint8Array(32), logIndex: 0n, refBlock: 0n, refTime: 0n, reserveX: 1n, reserveY: 1n, quoteRate: 0n,
});
const pad8 = (xs, fill) => [...xs, ...Array(SLOTS - xs.length).fill(null).map(fill)];
const hexOf = (u) => Buffer.from(u).toString('hex');
const bytesOf = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

// The last opening is also kept in a plain file. If the encrypted store were
// lost, the demo chain could not continue: every period must prove it holds
// the previous one. The demo books are public sample data, so this file holds
// nothing private.
const saveLastOpening = (o) => {
  const tmp = `${LAST_OPENING}.tmp`;
  writeFileSync(tmp, JSON.stringify({ positions: o.positions.map(String), debt: String(o.debt), nonce: hexOf(o.nonce) }), { mode: 0o600 });
  renameSync(tmp, LAST_OPENING);
};
const loadLastOpening = () => {
  if (!existsSync(LAST_OPENING)) return null;
  const j = JSON.parse(readFileSync(LAST_OPENING, 'utf8'));
  return { positions: j.positions.map(BigInt), debt: BigInt(j.debt), nonce: bytesOf(j.nonce) };
};

const refreshSponsor = async () => {
  const s = await ctx.wallet.waitForSyncedState();
  status.sponsor = { address: ctx.address, night: String(nightBalance(s)), dust: String(dustBalance(s)) };
  return s;
};

const checkpoint = async () => {
  try {
    await saveCheckpoint(ctx, net, CHECKPOINT);
    status.lastCheckpoint = new Date().toISOString();
  } catch (e) {
    console.error(`checkpoint failed: ${e.message}`);
  }
};

// Mark each job step at the moment Midnight.js enters it, so the page shows
// what is actually happening rather than a guess: proveTx is the ZK proof,
// balanceTx is the sponsor adding DUST for the fee, submitTx sends it to the
// node, and the wait after that is finality.
let current = null;
const tracked = (provider, method, label) => ({
  ...provider,
  [method]: async (...a) => {
    if (current) step(current, label);
    const out = await provider[method](...a);
    if (current && method === 'submitTx') step(current, 'confirming');
    return out;
  },
});

const boot = async () => {
  status.state = 'syncing';
  ctx = await openWallet({ net, seedHex: need('SPONSOR_SEED'), statePath: CHECKPOINT });
  console.log(`sponsor ${ctx.address} — ${ctx.restoredFrom ? `restored from checkpoint ${ctx.restoredFrom}` : 'cold start'}`);
  const { seconds } = await waitSynced(ctx, { quiet: true });
  status.syncedAt = new Date().toISOString();
  console.log(`synced in ${seconds.toFixed(1)} s`);
  await refreshSponsor();
  await checkpoint();
  setInterval(checkpoint, CHECKPOINT_EVERY_MS).unref();

  const zk = new NodeZkConfigProvider(ZK_DIR);
  const wm = walletProviderFor(ctx);
  providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `datum-sponsor-demo-private-state`,
      signingKeyStoreName: `datum-sponsor-demo-signing-keys`,
      privateStoragePasswordProvider: () => need('PRIVATE_STATE_PASSWORD'),
      accountId: ctx.address,
    }),
    publicDataProvider: indexerPublicDataProvider(net.indexerHttp, net.indexerWs),
    zkConfigProvider: zk,
    proofProvider: tracked(httpClientProofProvider(net.proofServer, zk), 'proveTx', 'proving'),
    walletProvider: tracked(wm, 'balanceTx', 'paying-dust'),
    midnightProvider: tracked(wm, 'submitTx', 'submitting'),
  };
  const compiled = CompiledContract.make('datum', (await import('../build/datum-full/contract/index.js')).Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(ZK_DIR),
  );
  demo = await findDeployedContract(providers, { compiledContract: compiled, contractAddress: DEMO_CONTRACT, privateStateId: 'demo', initialPrivateState: { attestorSecret: bytesOf(need('DEMO_ATTESTOR_SECRET')), ...emptyOpening(), proceeds: Array(SLOTS).fill(0n) } });
  status.state = 'ready';
  console.log(`ready: demo contract ${DEMO_CONTRACT}`);
  pump();
};

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------
const jobs = new Map();
const queue = [];
const perIp = new Map(); // ip -> [timestamps]
let busy = false;

const publicJob = (j) => ({
  id: j.id,
  book: j.bookName,
  status: j.status,
  position: j.status === 'queued' ? queue.indexOf(j) + 1 : 0,
  steps: j.steps,
  result: j.result,
  error: j.error,
  createdAt: j.createdAt,
  privacy: status.privacy,
});
// Finished jobs stay readable for a day, then go; the JSONL log keeps them.
setInterval(() => {
  const cutoff = Date.now() - 86400_000;
  for (const [id, j] of jobs) if (['landed', 'failed'].includes(j.status) && Date.parse(j.createdAt) < cutoff) jobs.delete(id);
  for (const [ip, ts] of perIp) if (ts.every((t) => Date.now() - t > 3600_000)) perIp.delete(ip);
}, 600_000).unref();
const step = (j, s) => { j.status = s; j.steps.push({ step: s, at: new Date().toISOString() }); };

const runJob = async (j) => {
  step(j, 'reading-base');
  const b = await resolveBook(j.spec);
  j.bookName = b.name;
  const q = b.q;
  const p = realisable(b.venue.reserveX, b.venue.reserveY, q, b.venue.feeBps);
  j.preview = {
    // quote micro-units -> USD via the slot's public rate (1.0 for USDC)
    markedUsd: Number((marked(b.venue.reserveX, b.venue.reserveY, q) * b.venue.quoteRate) / MICRO) / 1e6,
    realisableUsd: Number((p * b.venue.quoteRate) / MICRO) / 1e6,
    debtUsd: Number(b.debt) / 1e6,
    ratio: Number(b.ratio) / 1e6,
    baseRefBlock: String(b.refBlock),
  };

  step(j, 'preparing');
  const { ledger } = await import('../build/datum-full/contract/index.js');
  const count = ledger((await providers.publicDataProvider.queryContractState(DEMO_CONTRACT)).data).attestationCount;
  const prior = loadLastOpening();
  if (count > 0n && !prior) throw new Error('demo chain cannot continue: the previous opening is missing');
  const ps = {
    attestorSecret: bytesOf(need('DEMO_ATTESTOR_SECRET')),
    positions: pad8([q], () => 0n),
    proceeds: pad8([p], () => 0n),
    debt: b.debt,
    nonce: new Uint8Array(randomBytes(32)),
    prev: count > 0n ? prior : emptyOpening(),
  };
  await providers.privateStateProvider.set('demo', ps);

  const call = await demo.callTx.attest(pad8([b.venue], padding), b.ratio, BigInt(Math.floor(Date.now() / 1000)));
  saveLastOpening({ positions: ps.positions, debt: ps.debt, nonce: ps.nonce });

  const after = ledger((await providers.publicDataProvider.queryContractState(DEMO_CONTRACT)).data);
  j.result = {
    contract: DEMO_CONTRACT,
    network: NET.id,
    txHash: call.public.txHash,
    txIdentifier: call.public.txId,
    block: call.public.blockHeight,
    status: String(call.public.status),
    period: String(count),
    covered: after.covered,
    ...j.preview,
  };
  status.lastAttestation = { txHash: j.result.txHash, block: j.result.block, covered: j.result.covered, at: new Date().toISOString() };
  step(j, 'landed');
};

const pump = async () => {
  if (busy || status.state !== 'ready' || queue.length === 0) return;
  busy = true;
  const j = queue.shift();
  current = j;
  status.state = 'proving';
  try {
    await runJob(j);
  } catch (e) {
    j.error = e?.message ?? String(e);
    step(j, 'failed');
    console.error(`job ${j.id} failed: ${j.error}`);
  } finally {
    try {
      appendFileSync(JOB_LOG, JSON.stringify({ id: j.id, ip: j.ipHash, book: j.spec.book, status: j.status, result: j.result, error: j.error, at: new Date().toISOString() }) + '\n');
    } catch {}
    await refreshSponsor().catch(() => {});
    await checkpoint();
    status.state = BigInt(status.sponsor?.dust ?? '0') < MIN_DUST ? 'low-dust' : 'ready';
    current = null;
    busy = false;
    setImmediate(pump);
  }
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const clientIp = (req) => (req.headers['cf-connecting-ip'] ?? req.socket.remoteAddress ?? '?').toString();
const ipHash = (ip) => Buffer.from(ip).toString('base64url').slice(0, 10); // logs keep no raw IPs

const send = (req, res, code, body, extra = {}) => {
  const origin = req.headers.origin;
  const cors = origin && ALLOWED.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra });
  res.end(JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

const readBody = (req) => new Promise((ok, fail) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 4096) { fail(new Error('body too large')); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { fail(new Error('body is not JSON')); } });
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') {
    return send(req, res, 204, {}, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600' });
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return send(req, res, 200, { ...status, queue: queue.length, busy, limits: { perIpPerHour: RATE_PER_HOUR, queueMax: QUEUE_MAX } });
    }
    if (req.method === 'GET' && url.pathname === '/api/books') {
      return send(req, res, 200, { books: BOOKS, limits: LIMITS, venue: { chain: 'Base', pool: MARKETS.AERO.pool, kind: 'Aerodrome volatile AERO/USDC (x*y=k)' } });
    }
    const m = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const j = jobs.get(m[1]);
      return j ? send(req, res, 200, publicJob(j)) : send(req, res, 404, { error: 'no such job' });
    }
    if (req.method === 'POST' && url.pathname === '/api/attest') {
      if (status.state === 'starting' || status.state === 'syncing') return send(req, res, 503, { error: `sponsor is ${status.state}; try again shortly`, state: status.state });
      if (status.state === 'low-dust') return send(req, res, 503, { error: 'sponsor DUST is regenerating; try again later', state: status.state });
      const body = await readBody(req);
      if (!body.book || !(body.book in BOOKS || body.book === 'custom')) return send(req, res, 400, { error: 'pick a book: ' + [...Object.keys(BOOKS), 'custom'].join(', ') });
      if (body.book === 'custom') {
        // validate before queuing so a bad edit fails fast, not after a wait
        for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
          const n = Number(body.custom?.[k]);
          if (!Number.isFinite(n) || n < lo || n > hi) return send(req, res, 400, { error: `${k} must be between ${lo} and ${hi}` });
        }
      }
      const ip = clientIp(req);
      const now = Date.now();
      const recent = (perIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
      if ([...jobs.values()].some((j) => j.ip === ip && !['landed', 'failed'].includes(j.status))) {
        return send(req, res, 429, { error: 'you already have an attestation in progress' });
      }
      if (recent.length >= RATE_PER_HOUR) return send(req, res, 429, { error: `limit is ${RATE_PER_HOUR} attestations per hour per visitor` }, { 'Retry-After': '900' });
      if (queue.length >= QUEUE_MAX) return send(req, res, 429, { error: 'the queue is full; try again in a few minutes' }, { 'Retry-After': '120' });
      perIp.set(ip, [...recent, now]);
      const j = { id: randomUUID(), ip, ipHash: ipHash(ip), spec: { book: body.book, custom: body.custom }, bookName: BOOKS[body.book]?.name ?? 'Custom AERO book', status: 'queued', steps: [{ step: 'queued', at: new Date().toISOString() }], createdAt: new Date().toISOString() };
      jobs.set(j.id, j);
      queue.push(j);
      setImmediate(pump);
      return send(req, res, 202, publicJob(j));
    }
    send(req, res, 404, { error: 'not found' });
  } catch (e) {
    send(req, res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`datum sponsor service on 127.0.0.1:${PORT} (${NET.id})`));
boot().catch((e) => {
  status.state = 'down';
  status.error = e?.message ?? String(e);
  console.error(`boot failed: ${status.error}`);
});
