//
// scripts/provenance.mjs — build and verify venue slots against the source chain.
//
// Shared verbatim by the CLI and the browser: plain fetch JSON-RPC, no Node
// APIs, no dependencies. Every RPC listed here was measured keyless, CORS-open
// and archive-capable (logs and eth_call 2M blocks back) on 2026-10-08.
//
// What a slot claims, and what this file checks:
//   (1) `pool` was deployed by a known constant-product factory, and that
//       factory names it as the volatile pool for its token pair. Anyone can
//       deploy a contract that emits a Sync event with any numbers in it, so
//       an unrecognised pool is rejected outright.
//   (2) the collateral and quote sides, their decimals, and the fee match
//       the pool at refBlock; the quote side is a USD stablecoin (rate 1.0)
//       or a priced quote whose quoteRate equals its oracle at refBlock.
//   (3) the log at (syncBlock, logIndex) is that pool's Sync, inside syncTx,
//       and its raw reserves normalise to exactly reserveX / reserveY.
//   (4) there is NO later Sync from the pool in (syncBlock:logIndex, refBlock].
//       Without this a prover could cite an old Sync from when the pool was
//       deeper: real reserves, real log, wrong moment.
//   (5) refTime is refBlock's timestamp.
// The contract separately enforces that refTime is within maxRefAge of the
// Midnight block that includes the attestation.
//

export const MICRO = 1_000_000n;

export const CHAINS = {
  8453: {
    name: 'Base',
    // [url, max getLogs range]. Order is preference; the next is a fallback.
    rpcs: [
      ['https://mainnet.base.org', 500],
      ['https://base.gateway.tenderly.co', 1000],
    ],
    explorer: 'https://basescan.org',
    // Known constant-product factories. Only pools these factories vouch for
    // are accepted.
    factories: {
      '0x420dd381b31aef6683db6b902084cb0ffece40da': {
        kind: 'aerodrome-volatile',
        label: 'Aerodrome volatile (x*y=k)',
        // event Sync(uint256 reserve0, uint256 reserve1) — NOT Uniswap's uint112
        syncTopic: '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a',
      },
    },
    stables: {
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
    },
    // Quote assets that are not USD, valued at a public oracle. The slot's
    // quoteRate must equal this oracle's price at refBlock. This values the
    // quote leg AT THE MARK; the README measures that leg's depth.
    priced: {
      '0x4200000000000000000000000000000000000006': {
        symbol: 'WETH',
        decimals: 18,
        source: 'Moonwell oracle, mWETH',
        comptroller: '0xfbb21d0380bee3312b33c4353c8936a0f13ef26c',
        mToken: '0x628ff693426583d9a7fb391e54366292f509d457',
      },
    },
  },
};

// Function selectors, computed with `cast sig`, not typed from memory.
const SEL = {
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  decimals: '0x313ce567',
  factory: '0xc45a0155',
  stable: '0x22be3de1',
  getPool: '0x79bc57d5', // getPool(address,address,bool)
  getFee: '0xcc56b2c5', // getFee(address,bool)
  oracle: '0x7dc0d1d0', // Comptroller.oracle()
  getUnderlyingPrice: '0xfc57d4df', // getUnderlyingPrice(address)
};

/** USD micro-units per one STABLE quote token. */
export const USD_RATE = 1_000_000n;

// ---------------------------------------------------------------------------
// encoding helpers
// ---------------------------------------------------------------------------
const strip = (h) => (h.startsWith('0x') ? h.slice(2) : h);
const hexToBytes = (h) => {
  const s = strip(h);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};
export const bytesToHex = (u) => '0x' + Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const word = (h, i) => BigInt('0x' + strip(h).slice(i * 64, i * 64 + 64));
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
const boolWord = (b) => (b ? '1' : '0').padStart(64, '0');
const asAddress = (h) => '0x' + strip(h).slice(-40).toLowerCase();
const toHex = (n) => '0x' + BigInt(n).toString(16);

const pow10 = (d) => 10n ** BigInt(d);
/** Collateral side: ceil(raw * 1e6 / 10^dec). Rounds against the prover. */
export const normaliseUp = (raw, dec) => (raw * MICRO + pow10(dec) - 1n) / pow10(dec);
/** Quote side: floor(raw * 1e6 / 10^dec). Rounds against the prover. */
export const normaliseDown = (raw, dec) => (raw * MICRO) / pow10(dec);

// Public RPCs answer 429 under bursts. Retry a rate-limited call twice with a
// short pause before moving to the next RPC.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const fetchWithBackoff = async (fetchImpl, url, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, init);
    if (res.status !== 429 || attempt >= 2) return res;
    await pause(800 * (attempt + 1));
  }
};

// ---------------------------------------------------------------------------
// JSON-RPC with fallback
// ---------------------------------------------------------------------------
export const makeRpc = (chainId, { fetchImpl = fetch } = {}) => {
  const chain = CHAINS[chainId];
  if (!chain) throw new Error(`chain ${chainId} is not supported`);
  let id = 0;
  const call = async (method, params) => {
    const errors = [];
    for (const [url] of chain.rpcs) {
      try {
        const res = await fetchWithBackoff(fetchImpl, url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
        return body.result;
      } catch (e) {
        errors.push(`${url}: ${e.message}`);
      }
    }
    throw new Error(`${method} failed on every RPC — ${errors.join(' | ')}`);
  };
  const ethCall = (to, data, block = 'latest') =>
    call('eth_call', [{ to, data }, typeof block === 'string' ? block : toHex(block)]);

  // Chunk by the most restrictive range in the list, so a fallback RPC never
  // receives a range only the primary accepts.
  const maxRange = Math.min(...chain.rpcs.map(([, r]) => r));
  const getLogs = async (address, topic, from, to) => {
    const out = [];
    for (let a = BigInt(from); a <= BigInt(to); a += BigInt(maxRange)) {
      const b = a + BigInt(maxRange) - 1n < BigInt(to) ? a + BigInt(maxRange) - 1n : BigInt(to);
      const logs = await call('eth_getLogs', [
        { address, topics: [topic], fromBlock: toHex(a), toBlock: toHex(b) },
      ]);
      out.push(...logs);
    }
    return out;
  };
  return { chain, call, ethCall, getLogs, maxRange };
};

// ---------------------------------------------------------------------------
// pool facts, read at a given block
// ---------------------------------------------------------------------------
export const readPool = async (rpc, pool, block) => {
  const p = pool.toLowerCase();
  const factory = asAddress(await rpc.ethCall(p, SEL.factory, block));
  const fdef = rpc.chain.factories[factory];
  if (!fdef) return { pool: p, factory, recognised: false };

  const token0 = asAddress(await rpc.ethCall(p, SEL.token0, block));
  const token1 = asAddress(await rpc.ethCall(p, SEL.token1, block));
  const dec0 = Number(word(await rpc.ethCall(token0, SEL.decimals, block), 0));
  const dec1 = Number(word(await rpc.ethCall(token1, SEL.decimals, block), 0));

  let vouched = false;
  let stable = null;
  let feeBps = null;
  if (fdef.kind === 'aerodrome-volatile') {
    stable = word(await rpc.ethCall(p, SEL.stable, block), 0) !== 0n;
    const named = asAddress(
      await rpc.ethCall(factory, SEL.getPool + addrWord(token0) + addrWord(token1) + boolWord(false), block),
    );
    vouched = named === p && stable === false;
    feeBps = Number(word(await rpc.ethCall(factory, SEL.getFee + addrWord(p) + boolWord(false), block), 0));
  }
  return { pool: p, factory, recognised: true, kind: fdef.kind, label: fdef.label, syncTopic: fdef.syncTopic, token0, token1, dec0, dec1, stable, vouched, feeBps };
};

/**
 * The USD rate of a quote token at a block: USD micro-units per whole token.
 * USD stablecoins are 1.0 by definition. Priced assets read Moonwell's oracle,
 * which scales prices by 1e(36 - decimals); the rate is floored.
 */
export const quoteRateAt = async (rpc, quote, block) => {
  if (rpc.chain.stables[quote]) return { rate: USD_RATE, symbol: rpc.chain.stables[quote], source: 'USD stablecoin, 1.0' };
  const pq = rpc.chain.priced?.[quote];
  if (!pq) return null;
  const oracle = asAddress(await rpc.ethCall(pq.comptroller, SEL.oracle, block));
  const price = word(await rpc.ethCall(oracle, SEL.getUnderlyingPrice + addrWord(pq.mToken), block), 0);
  return { rate: (price * MICRO) / pow10(36 - pq.decimals), symbol: pq.symbol, source: `${pq.source} at the reference block` };
};

const decodeSync = (log) => ({
  blockNumber: BigInt(log.blockNumber),
  logIndex: BigInt(log.logIndex),
  txHash: log.transactionHash.toLowerCase(),
  reserve0: word(log.data, 0),
  reserve1: word(log.data, 1),
});
const after = (a, b) => a.blockNumber > b.blockNumber || (a.blockNumber === b.blockNumber && a.logIndex > b.logIndex);

// ---------------------------------------------------------------------------
// BUILD: the slot for a pool, current as of refBlock
// ---------------------------------------------------------------------------
/**
 * Find the pool's last Sync at or before refBlock and turn it into a slot.
 * `collateral` is the token address the book would sell into this pool.
 */
export const buildVenueSlot = async ({ chainId, pool, collateral, refBlock, lookback = 20000 }) => {
  const rpc = makeRpc(chainId);
  const ref = BigInt(refBlock ?? (await rpc.call('eth_blockNumber', [])));
  const facts = await readPool(rpc, pool, ref);
  if (!facts.recognised) throw new Error(`pool ${pool} was not deployed by a known constant-product factory (factory ${facts.factory})`);
  if (!facts.vouched) throw new Error(`factory does not vouch for ${pool} as a volatile pool`);

  const col = collateral.toLowerCase();
  const collateralIsToken0 = col === facts.token0;
  if (!collateralIsToken0 && col !== facts.token1) throw new Error(`${collateral} is not a side of ${pool}`);
  const quote = collateralIsToken0 ? facts.token1 : facts.token0;
  const qr = await quoteRateAt(rpc, quote, ref);
  if (!qr) throw new Error(`quote side ${quote} is neither a USD stablecoin nor a priced quote`);

  // Walk back from refBlock in chunks until the most recent Sync is found.
  let latest = null;
  for (let hi = ref; hi > ref - BigInt(lookback) && !latest; hi -= BigInt(rpc.maxRange)) {
    const lo = hi - BigInt(rpc.maxRange) + 1n;
    const logs = (await rpc.getLogs(facts.pool, facts.syncTopic, lo, hi)).map(decodeSync);
    for (const l of logs) if (!latest || after(l, latest)) latest = l;
  }
  if (!latest) throw new Error(`no Sync from ${pool} in the ${lookback} blocks before ${ref}`);

  const blk = await rpc.call('eth_getBlockByNumber', [toHex(ref), false]);
  const decX = collateralIsToken0 ? facts.dec0 : facts.dec1;
  const decY = collateralIsToken0 ? facts.dec1 : facts.dec0;
  const rawX = collateralIsToken0 ? latest.reserve0 : latest.reserve1;
  const rawY = collateralIsToken0 ? latest.reserve1 : latest.reserve0;

  return {
    slot: {
      chainId: BigInt(chainId),
      pool: hexToBytes(facts.pool),
      collateralIsToken0,
      decX: BigInt(decX),
      decY: BigInt(decY),
      feeBps: BigInt(facts.feeBps),
      syncBlock: latest.blockNumber,
      syncTx: hexToBytes(latest.txHash),
      logIndex: latest.logIndex,
      refBlock: ref,
      refTime: BigInt(blk.timestamp),
      reserveX: normaliseUp(rawX, decX),
      reserveY: normaliseDown(rawY, decY),
      quoteRate: qr.rate,
    },
    evidence: { ...facts, collateral: col, quote, quoteSymbol: qr.symbol, quoteRateSource: qr.source, rawX, rawY },
  };
};

// ---------------------------------------------------------------------------
// VERIFY: every check a judge can repeat with no key
// ---------------------------------------------------------------------------
export const isPaddingSlot = (s) => BigInt(s.chainId) === 0n;

export const verifyVenueSlot = async (slot, { fetchImpl } = {}) => {
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return ok; };

  const chainId = Number(slot.chainId);
  if (!CHAINS[chainId]) {
    check('chain supported', false, `chain ${chainId}`);
    return { ok: false, checks };
  }
  const rpc = makeRpc(chainId, { fetchImpl });
  const pool = bytesToHex(slot.pool).toLowerCase();
  const ref = BigInt(slot.refBlock);
  const syncBlock = BigInt(slot.syncBlock);
  const logIndex = BigInt(slot.logIndex);

  // (1)+(2) pool facts at the reference block
  const f = await readPool(rpc, pool, ref);
  if (!check('pool from a known constant-product factory', f.recognised, `factory ${f.factory}`)) return { ok: false, checks };
  check('factory vouches for the pool (volatile, not stable)', f.vouched, `stable=${f.stable}`);
  const col = slot.collateralIsToken0 ? f.token0 : f.token1;
  const quote = slot.collateralIsToken0 ? f.token1 : f.token0;
  const qr = await quoteRateAt(rpc, quote, ref);
  check('quote side is a USD stablecoin or a priced quote', !!qr, `${qr?.symbol ?? 'unknown'} ${quote}`);
  check('quoteRate matches its source at refBlock', !!qr && qr.rate === BigInt(slot.quoteRate ?? 0n), qr ? `${qr.source}: ${qr.rate} vs slot ${slot.quoteRate}` : 'no source');
  const decX = slot.collateralIsToken0 ? f.dec0 : f.dec1;
  const decY = slot.collateralIsToken0 ? f.dec1 : f.dec0;
  check('decimals match the tokens', BigInt(decX) === BigInt(slot.decX) && BigInt(decY) === BigInt(slot.decY), `collateral ${decX}, quote ${decY}`);
  check('fee matches the pool at refBlock', BigInt(f.feeBps) === BigInt(slot.feeBps), `${f.feeBps} bps`);

  // (3) the cited Sync log
  const atBlock = (await rpc.getLogs(pool, f.syncTopic, syncBlock, syncBlock)).map(decodeSync);
  const cited = atBlock.find((l) => l.logIndex === logIndex);
  const syncTx = bytesToHex(slot.syncTx).toLowerCase();
  if (!check('cited Sync log exists at (syncBlock, logIndex)', !!cited, `block ${syncBlock} log ${logIndex}`)) return { ok: false, checks };
  check('cited log is inside syncTx', cited.txHash === syncTx, cited.txHash);
  const rawX = slot.collateralIsToken0 ? cited.reserve0 : cited.reserve1;
  const rawY = slot.collateralIsToken0 ? cited.reserve1 : cited.reserve0;
  const nX = normaliseUp(rawX, decX);
  const nY = normaliseDown(rawY, decY);
  check('reserveX matches the log (normalised, rounded up)', nX === BigInt(slot.reserveX), `chain ${nX} vs slot ${slot.reserveX}`);
  check('reserveY matches the log (normalised, rounded down)', nY === BigInt(slot.reserveY), `chain ${nY} vs slot ${slot.reserveY}`);

  // (4) nothing newer up to refBlock — the cherry-pick check
  if (check('refBlock is at or after the Sync', ref >= syncBlock, `${ref} >= ${syncBlock}`)) {
    const newer = (await rpc.getLogs(pool, f.syncTopic, syncBlock, ref)).map(decodeSync).filter((l) => after(l, cited));
    check(
      'no newer Sync before refBlock (reserves are current, not cherry-picked)',
      newer.length === 0,
      newer.length ? `${newer.length} later Sync(s), first at block ${newer[0].blockNumber} log ${newer[0].logIndex}` : 'none',
    );
  }

  // (5) the reference timestamp
  const blk = await rpc.call('eth_getBlockByNumber', [toHex(ref), false]);
  check('refTime is refBlock\'s timestamp', BigInt(blk.timestamp) === BigInt(slot.refTime), `chain ${BigInt(blk.timestamp)} vs slot ${slot.refTime}`);

  return { ok: checks.every((c) => c.ok), checks, pool, collateral: col, quote };
};
