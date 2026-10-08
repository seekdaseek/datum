//
// frontend/src/main.js — datum v2.
//
// What this page does, and what it never does:
//   - It READS the Midnight ledger through the public indexer and decodes the
//     contract state with the runtime's own deserializer.
//   - It VERIFIES from public data only, in the browser: the venue digest the
//     proof bound, the chain of periods, and every venue's Sync log re-fetched
//     from a public Base RPC (scripts/verify-core.mjs — the same code the CLI
//     and the tests run).
//   - It can ask the hosted demo service to ATTEST a sample book. That service
//     proves and a sponsor wallet pays the DUST fee. The page never holds a
//     key and never proves anything itself.
//
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { resolveNetwork } from './config.js';
import { verifyAttestation, tamperedCopy } from '../../scripts/verify-core.mjs';
import { CHAINS, isPaddingSlot } from '../../scripts/provenance.mjs';
import { buildMoonwellBook } from '../../scripts/books/moonwell.mjs';
import './style.css';

const DEPLOYMENTS = import.meta.glob('../../deployments/*.json', { eager: true, import: 'default' });
const REPO = 'https://github.com/seekdaseek/datum';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const short = (s, n = 8) => (s && s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const el = (tag, cls, ...kids) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== undefined && k !== null) e.append(k);
  return e;
};
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const num = (n, d = 0) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d });
const x2 = (n) => `${Number(n).toFixed(2)}x`;
const fromMicro = (v) => Number(v) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Constant-product proceeds with fee, floored — the circuit's exact bound. */
const realisable = (X, Y, q, f) => (q === 0n ? 0n : (Y * q * (10000n - f)) / (X * 10000n + q * (10000n - f)));
const marked = (X, Y, q) => (q * Y) / X;

const copyable = (text, label = text) => {
  const b = el('button', 'copy mono', label);
  b.title = 'Copy';
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(text); b.classList.add('done'); setTimeout(() => b.classList.remove('done'), 900); } catch {}
  };
  return b;
};

// ---------------------------------------------------------------------------
// chain reads
// ---------------------------------------------------------------------------
const gql = async (net, query, variables) => {
  const res = await fetch(net.indexerHttp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`indexer returned HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`indexer: ${body.errors[0].message}`);
  return body.data;
};
const ACTION = `query Datum($addr: HexEncoded!) {
  contractAction(address: $addr) { __typename state transaction { hash block { height timestamp } } }
}`;
const fromHexStr = (h) => Uint8Array.from((h.startsWith('0x') ? h.slice(2) : h).match(/../g).map((b) => parseInt(b, 16)));

const readContract = async (net, lib, address) => {
  const a = (await gql(net, ACTION, { addr: address })).contractAction;
  if (!a) throw new Error(`no contract at ${address} on ${net.id}`);
  return { L: lib.ledger(ContractState.deserialize(fromHexStr(a.state)).data), tx: a.transaction };
};

// ---------------------------------------------------------------------------
// verification panel — shared by the book, the demo, and the tamper copy
// ---------------------------------------------------------------------------
const verifyPanel = (container, { L, lib, venues, title }) => {
  container.innerHTML = '';
  const head = el('div', 'vhead', el('span', 'vchip run', 'VERIFYING'), el('span', 'vtitle', title));
  const list = el('div', 'vlist');
  container.append(head, list);
  const sections = new Map();
  return verifyAttestation({
    L,
    pureCircuits: lib.pureCircuits,
    venues,
    onCheck: (s, c) => {
      if (!sections.has(s)) {
        const box = el('div', 'vsec', el('div', 'vsec-t', s.title));
        list.append(box);
        sections.set(s, box);
      }
      sections.get(s).append(el('div', `vrow ${c.ok ? 'ok' : 'bad'}`, el('span', 'vmark', c.ok ? '✔' : '✘'), el('span', 'vname', c.name), c.detail ? el('span', 'vdetail mono', c.detail) : null));
    },
  }).then((r) => {
    head.firstChild.className = `vchip ${r.ok ? 'ok' : 'bad'}`;
    head.firstChild.textContent = r.ok ? 'VERIFIED' : 'MISMATCH';
    const failed = r.sections.flatMap((s) => s.checks.filter((c) => !c.ok));
    container.append(
      el('p', `vsum ${r.ok ? 'ok' : 'bad'}`, r.ok
        ? 'Every check passed using public data only: the Midnight indexer, the contract’s own pure circuit, and a public Base RPC.'
        : `${failed.length} check${failed.length === 1 ? '' : 's'} failed. This venue array is not what the proof bound, or not what Base says.`),
    );
    return r;
  });
};

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------
const hero = (net) => {
  const h = el('header', 'head');
  const brand = el('div', 'brand', el('h1', null, 'datum'));
  brand.append(el('p', 'tag', 'Solvency at the price the market would actually pay.'));
  const badge = el('div', `netbadge ${net.public ? 'pub' : 'local'}`, el('span', 'netdot'), el('span', null, `Midnight ${net.label}`));
  h.append(brand, badge);

  const lead = el('section', 'hero');
  lead.append(el('p', 'hero-1', 'Proof of reserves shows the tokens exist, not that they can be sold for what the book says.'));
  lead.append(el('p', 'hero-2',
    'datum proves, in zero knowledge on Midnight, that a lending book covers its debt at realisable exit prices: what its collateral would fetch if sold into the constant-product pool where it actually trades. ',
    el('strong', null, 'The pool’s depth is public; the book stays private.'),
    ' Balance-threshold “proveSolvency” checks value collateral at the oracle mark, so they pass books that cannot be unwound at that price.'));
  return [h, lead];
};

const BOOK_TEXT = {
  WELL: (f, a) => `All WELL supplied to Moonwell on Base at block ${num(a.baseRefBlock)}, against the most debt Moonwell’s own ${Math.round(f.collateralFactor * 100)}% collateral factor lets it secure. WELL’s main exit is the Aerodrome volatile WELL/WETH pool (x·y=k, 1% fee), holding ${num(f.poolCollateralReserve)} WELL and ${num(f.poolQuoteReserve, 2)} WETH: ${num(f.supplied)} WELL would have to sell into it.`,
  AERO: (f, a) => `All AERO supplied to Moonwell on Base at block ${num(a.baseRefBlock)}, against the most debt Moonwell’s own ${Math.round(f.collateralFactor * 100)}% collateral factor lets it secure. The exit is the Aerodrome volatile AERO/USDC pool, the deepest AERO pool on Base.`,
};

const realBook = (net, market, rec) => {
  const s = el('section', 'card');
  s.append(el('h2', null, `A real book: Moonwell’s ${market} collateral on Base`));
  const a = rec?.attest;
  if (!a?.figures) {
    s.append(el('p', 'lede', 'This book is not attested on this network yet.'));
    return s;
  }
  const f = a.figures;
  s.append(el('p', 'lede', BOOK_TEXT[market]?.(f, a) ?? ''));

  const grid = el('div', 'triple');
  grid.append(
    el('div', 'tcol', el('div', 'tlabel', 'At the oracle mark'), el('div', 'tbig', x2(f.markedCoverage)), el('div', 'tsub', `${usd(f.markedUsd)} at $${f.oraclePrice.toPrecision(4)}`)),
    el('div', 'tcol gap', el('div', 'tlabel', 'Does not exist at exit'), el('div', 'tbig neg', usd(f.gapUsd)), el('div', 'tsub', `${f.gapPct.toFixed(1)}% of the marked value`)),
    el('div', 'tcol', el('div', 'tlabel', 'At realisable exit'), el('div', 'tbig', x2(f.realisableCoverage)), el('div', 'tsub', `${usd(f.realisableUsd)} sold into the pool`)),
  );
  s.append(grid);
  s.append(el('p', 'lede small', `${num(f.supplied)} ${market} supplied · debt it may secure ${usd(f.debtUsd)} · coverage = value ÷ that debt · verdict on chain: ${a.covered === false ? 'NOT COVERED' : 'COVERED'} at Moonwell’s own 1.00x`));
  if (f.quoteLeg) {
    const l = f.quoteLeg;
    s.append(el('p', 'lede small', `The pool is quoted in WETH, so the ${num(l.wethSold, 2)} WETH it pays out is valued at Moonwell’s own WETH price, at the mark. Measured against the only x·y=k WETH/USDC pool on Base (${num(l.wethReserve)} WETH / ${usd(l.usdcReserve)}), selling it there would fetch ${usd(l.throughPoolUsd)}, ${l.extraImpactPct.toFixed(1)}% less. WETH’s deeper concentrated-liquidity pools are not measured here.`));
  }

  const out = el('div', 'recompute');
  const btn = el('button', 'btn ghost', `Recompute from Base at block ${num(a.baseRefBlock)}`);
  btn.onclick = async () => {
    btn.disabled = true;
    out.textContent = 'Reading Moonwell and the pool from a public Base RPC…';
    try {
      const b = await buildMoonwellBook(market, { refBlock: BigInt(a.baseRefBlock) });
      const same = (k) => Math.abs(b.figures[k] - f[k]) <= 1e-6 * Math.max(1, Math.abs(f[k]));
      const ok = ['supplied', 'oraclePrice', 'markedUsd', 'debtUsd', 'realisableUsd'].every(same);
      out.innerHTML = '';
      out.append(el('span', `vchip ${ok ? 'ok' : 'bad'}`, ok ? 'MATCHES BASE' : 'DIFFERS'),
        ` supplied ${num(b.figures.supplied)} ${market} · oracle $${b.figures.oraclePrice.toPrecision(6)} · marked ${usd(b.figures.markedUsd)} · realisable ${usd(b.figures.realisableUsd)}`);
    } catch (e) {
      out.textContent = `Could not read Base: ${e.message}`;
    } finally {
      btn.disabled = false;
    }
  };
  s.append(el('div', 'row', btn), out);
  return s;
};

const attestationCard = (net, lib, { L, tx }, address, label) => {
  const s = el('section', 'card');
  s.append(el('h2', null, label));
  const v = el('div', `verdict ${L.covered ? 'ok' : 'bad'}`,
    el('div', 'vlabel', 'Latest verdict on chain'),
    el('div', 'vbig', L.covered ? 'COVERED' : 'NOT COVERED'),
    el('div', 'vsub', `at a ${x2(Number(L.requiredRatio) / 1e6)} bar, realisable proceeds against debt · period ${L.attestationCount - 1n}`));
  s.append(v);

  const kv = el('div', 'kv');
  const row = (k, ...v) => kv.append(el('div', 'k', k), el('div', 'v', ...v));
  row('Transaction hash', copyable(tx.hash, short(tx.hash, 12)));
  row('Block', num(tx.block.height), ` · ${new Date(tx.block.timestamp).toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  row('Book commitment', copyable(hex(L.head), short(hex(L.head), 12)), el('span', 'dimtext', ' hiding: the positions and debt are not in it in the clear'));
  row('Attested at', new Date(Number(L.attestedAt) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
  s.append(kv);

  const table = el('table', 'venues');
  table.append(el('thead', null, el('tr', null, ...['Chain', 'Pool', 'Sync block · log', 'Sync tx', 'Ref block', 'Collateral reserve', 'Quote reserve', 'Quote at'].map((t) => el('th', null, t)))));
  const body = el('tbody');
  for (const slot of L.venues) {
    if (isPaddingSlot(slot)) continue;
    body.append(el('tr', null,
      el('td', null, CHAINS[Number(slot.chainId)]?.name ?? String(slot.chainId)),
      el('td', 'mono', short('0x' + hex(slot.pool), 6)),
      el('td', 'mono num', `${num(slot.syncBlock)} · ${slot.logIndex}`),
      el('td', 'mono', short('0x' + hex(slot.syncTx), 6)),
      el('td', 'mono num', num(slot.refBlock)),
      el('td', 'mono num', num(fromMicro(slot.reserveX))),
      el('td', 'mono num', num(fromMicro(slot.reserveY), 2)),
      el('td', 'mono num', '$' + fromMicro(slot.quoteRate).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))));
  }
  table.append(body);
  s.append(el('div', 'tablewrap', table));
  s.append(el('p', 'lede small', 'Published in the clear and bound into the proof by venuesHash, so anyone can re-fetch that Sync log, and the quote’s USD rate at that block, and check them.'));

  if (L.attestationCount > 1n) {
    const hist = el('div', 'history');
    for (let p = 0n; p < L.attestationCount; p++) {
      const r = L.history.lookup(p);
      hist.append(el('div', `hrow ${r.covered ? 'ok' : 'bad'}`, el('span', 'hp', `period ${p}`), el('span', 'hv', r.covered ? 'COVERED' : 'NOT COVERED'), el('span', 'hr', `${x2(Number(r.requiredRatio) / 1e6)} bar`), el('span', 'hc mono', short(hex(r.commitment), 6))));
    }
    s.append(el('h3', null, 'History: each period chained to the one before'), hist);
  }

  // Verify from chain + tamper
  const panel = el('div', 'vpanel');
  const vbtn = el('button', 'btn', 'Verify from chain');
  const tbtn = el('button', 'btn bad', 'Tamper with a copy');
  tbtn.disabled = true;
  const note = el('p', 'lede small');
  vbtn.onclick = async () => {
    vbtn.disabled = true;
    try {
      const fresh = await readContract(net, lib, address).catch(() => ({ L }));
      await verifyPanel(panel, { L: fresh.L, lib, title: 'the published state, re-checked from public sources' });
      tbtn.disabled = false;
    } finally { vbtn.disabled = false; }
  };
  tbtn.onclick = async () => {
    tbtn.disabled = true;
    const first = L.venues.findIndex((v) => !isPaddingSlot(v));
    const copy = tamperedCopy(L.venues, { slot: first });
    note.textContent = `Tampered copy: slot ${first} USD reserve ${num(fromMicro(L.venues[first].reserveY), 6)} → ${num(fromMicro(copy[first].reserveY), 6)} (one millionth of a dollar more). Nothing on chain changes; the same checks run on the copy.`;
    try { await verifyPanel(panel, { L, lib, venues: copy, title: 'a copy with one reserve changed by one unit' }); } finally { tbtn.disabled = false; }
  };
  s.append(el('div', 'row', vbtn, tbtn), note, panel);
  s._verify = () => vbtn.click();
  return s;
};

// ---------------------------------------------------------------------------
// Attest a book
// ---------------------------------------------------------------------------
const STEP_LABEL = {
  queued: 'Queued',
  'reading-base': 'Reading fresh reserves from Base',
  'waking-prover': 'Starting the prover (it sleeps when idle)',
  preparing: 'Preparing the private book',
  proving: 'Proving in zero knowledge',
  'paying-dust': 'Sponsor adds DUST for the fee',
  submitting: 'Submitting to Midnight',
  confirming: 'Waiting for the block',
  landed: 'Landed',
  failed: 'Failed',
};
const SPONSOR_TEXT = {
  starting: ['warn', 'Sponsor starting up'],
  syncing: ['warn', 'Sponsor wallet syncing with Midnight; attesting opens when it finishes'],
  ready: ['ok', 'Sponsor ready'],
  proving: ['busy', 'Sponsor proving another book; yours will queue'],
  'low-dust': ['warn', 'Sponsor DUST is regenerating; try again shortly'],
  down: ['bad', 'Sponsor service is down'],
};

const attestSection = (net, lib, preview, mountDemo) => {
  const s = el('section', 'card attest');
  s.append(el('h2', null, 'Attest a book yourself'));
  s.append(el('p', 'lede', 'Pick a sample book or edit one. The hosted prover builds a fresh venue slot from Base, proves the attestation, and a sponsor wallet pays the Midnight fee in DUST. Then this page verifies the result from chain, with no trust in the service.'));

  const privacy = el('div', 'privacy',
    el('span', 'pchip', 'PRIVACY BOUNDARY'),
    el('span', null, 'This hosted demo prover sees the sample book you submit; it is sample data from a public page. A real lender runs the same prover on their own machine and the book never leaves it. Only the hiding commitment and the one-bit verdict reach the chain.'));
  s.append(privacy);

  const pill = el('div', 'pill warn', el('span', 'pdot'), el('span', 'ptext', 'Checking the sponsor…'));
  s.append(pill);
  let sponsorState = 'unknown';
  const setPill = (st, extra = '') => {
    sponsorState = st;
    const [cls, text] = SPONSOR_TEXT[st] ?? ['bad', 'Sponsor service unreachable. Verify from chain still works.'];
    pill.className = `pill ${cls}`;
    pill.querySelector('.ptext').textContent = text + extra;
    submit.disabled = !(st === 'ready' || st === 'proving') || inFlight;
  };

  // book picker
  const books = [
    { id: 'aero-overlevered', name: 'Overlevered AERO book', aero: 10_000_000, debtUsd: 5_500_000, ratio: 1.2, blurb: 'Clears at the mark, fails at the price the pool would pay.' },
    { id: 'aero-conservative', name: 'Conservative AERO book', aero: 2_000_000, debtUsd: 900_000, ratio: 1.5, blurb: 'Small against the depth: the mark and the exit agree.' },
    { id: 'moonwell-aero', name: 'Moonwell’s AERO collateral (real)', live: true, blurb: 'Read live from Base at a fresh block.' },
    { id: 'custom', name: 'Edit your own', aero: 6_000_000, debtUsd: 3_000_000, ratio: 1.3, blurb: 'AERO against USD debt, at your bar.' },
  ];
  let chosen = books[0];
  const picker = el('div', 'picker');
  const editor = el('div', 'editor');
  const inputs = {};
  for (const [k, label, step] of [['aero', 'AERO held', 100000], ['debtUsd', 'Debt (USD)', 100000], ['ratio', 'Required bar (x)', 0.05]]) {
    const i = el('input', 'num');
    i.type = 'number'; i.step = String(step);
    inputs[k] = i;
    editor.append(el('label', null, el('span', null, label), i));
  }
  const previewBox = el('div', 'preview');
  const paintPreview = () => {
    previewBox.innerHTML = '';
    if (chosen.live) { previewBox.append(el('span', 'dimtext', 'Figures are read from Base when the job runs.')); return; }
    if (!preview) return;
    const q = BigInt(Math.max(0, Math.round(Number(inputs.aero.value) || 0))) * 1_000_000n;
    const debt = BigInt(Math.max(1, Math.round(Number(inputs.debtUsd.value) || 0))) * 1_000_000n;
    const ratio = Number(inputs.ratio.value) || 0;
    const m = fromMicro(marked(preview.reserveX, preview.reserveY, q));
    const r = fromMicro(realisable(preview.reserveX, preview.reserveY, q, preview.feeBps));
    const d = fromMicro(debt);
    const mark = m / d >= ratio;
    const real = r / d >= ratio;
    previewBox.append(
      el('div', 'pv', el('span', 'pvk', 'Balance threshold (mark)'), el('span', `pvv ${mark ? 'ok' : 'bad'}`, `${x2(m / d)} · ${mark ? 'passes' : 'fails'}`)),
      el('div', 'pv', el('span', 'pvk', 'datum (realisable)'), el('span', `pvv ${real ? 'ok' : 'bad'}`, `${x2(r / d)} · ${real ? 'covered' : 'not covered'}`)),
      el('div', 'pvnote', 'Estimate from the reserves last published on chain. The attestation itself reads fresh reserves from Base.'),
    );
  };
  for (const b of books) {
    const card = el('button', `book ${b === chosen ? 'on' : ''}`, el('div', 'bname', b.name), el('div', 'bblurb', b.blurb));
    card.onclick = () => {
      chosen = b;
      picker.querySelectorAll('.book').forEach((c) => c.classList.remove('on'));
      card.classList.add('on');
      for (const k of ['aero', 'debtUsd', 'ratio']) { inputs[k].value = b[k] ?? ''; inputs[k].disabled = b.id !== 'custom'; }
      editor.style.display = b.live ? 'none' : '';
      paintPreview();
    };
    picker.append(card);
  }
  for (const i of Object.values(inputs)) i.oninput = paintPreview;
  s.append(picker, editor, previewBox);

  const submit = el('button', 'btn big', 'Attest this book on Midnight');
  submit.disabled = true;
  const progress = el('div', 'progress');
  const result = el('div', 'result');
  s.append(el('div', 'row', submit), progress, result);

  let inFlight = false;
  const paintJob = (j, t0) => {
    progress.innerHTML = '';
    const steps = j.steps;
    const done = new Set(steps.map((x) => x.step));
    const order = ['queued', 'reading-base', ...(done.has('waking-prover') ? ['waking-prover'] : []), 'preparing', 'proving', 'paying-dust', 'submitting', 'confirming', 'landed'];
    const at = Object.fromEntries(steps.map((x) => [x.step, Date.parse(x.at)]));
    for (const [i, st] of order.entries()) {
      const next = order.slice(i + 1).find((n) => at[n]);
      const isCur = j.status === st && st !== 'landed';
      const secs = at[st] && st !== 'landed' ? (((next ? at[next] : Date.now()) - at[st]) / 1000).toFixed(0) : '';
      progress.append(el('div', `step ${done.has(st) ? (isCur ? 'cur' : 'done') : 'todo'}`,
        el('span', 'smark', done.has(st) ? (isCur ? '' : '✔') : ''),
        el('span', 'slabel', STEP_LABEL[st] + (st === 'queued' && j.position > 0 ? ` (position ${j.position})` : '')),
        el('span', 'stime', secs ? `${secs}s` : '')));
    }
    if (j.status === 'failed') progress.append(el('div', 'step bad', el('span', 'smark', '✘'), el('span', 'slabel', `Failed: ${j.error}`)));
    progress.append(el('div', 'elapsed', `${((Date.now() - t0) / 1000).toFixed(0)} s since you pressed attest`));
  };

  submit.onclick = async () => {
    inFlight = true;
    submit.disabled = true;
    result.innerHTML = '';
    const body = { book: chosen.id };
    if (chosen.id === 'custom') body.custom = { aero: Number(inputs.aero.value), debtUsd: Number(inputs.debtUsd.value), ratio: Number(inputs.ratio.value) };
    const t0 = Date.now();
    try {
      const r = await fetch(`${net.api}/api/attest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const j0 = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j0.error ?? `service returned HTTP ${r.status}`);
      let j = j0;
      const tick = setInterval(() => paintJob(j, t0), 1000);
      while (!['landed', 'failed'].includes(j.status)) {
        paintJob(j, t0);
        await sleep(2000);
        const rr = await fetch(`${net.api}/api/jobs/${j.id}`);
        if (rr.ok) j = await rr.json();
      }
      clearInterval(tick);
      paintJob(j, t0);
      if (j.status === 'failed') throw new Error(j.error);
      const res = j.result;
      result.append(el('div', `verdict ${res.covered ? 'ok' : 'bad'}`,
        el('div', 'vlabel', `${j.book} · period ${res.period} on the demo contract`),
        el('div', 'vbig', res.covered ? 'COVERED' : 'NOT COVERED'),
        el('div', 'vsub', `at the mark ${x2(res.markedUsd / res.debtUsd)} · realisable ${x2(res.realisableUsd / res.debtUsd)} · bar ${x2(res.ratio)} · ${usd(res.markedUsd - res.realisableUsd)} does not exist at exit`)));
      const kv = el('div', 'kv');
      kv.append(el('div', 'k', 'Transaction hash'), el('div', 'v', copyable(res.txHash, short(res.txHash, 12))));
      kv.append(el('div', 'k', 'Block'), el('div', 'v', num(res.block)));
      kv.append(el('div', 'k', 'Base reference block'), el('div', 'v', num(res.baseRefBlock)));
      result.append(kv, el('p', 'lede small', 'Now verifying it from chain, without trusting the service:'));
      // Wait until the indexer serves this transaction, then verify.
      const vbox = el('div', 'vpanel');
      result.append(vbox);
      for (let i = 0; i < 30; i++) {
        const st = await readContract(net, lib, net.demo).catch(() => null);
        if (st && st.tx.hash === res.txHash) { await verifyPanel(vbox, { L: st.L, lib, title: 'your attestation, re-checked from public sources' }); mountDemo(st); break; }
        vbox.textContent = 'Waiting for the indexer to serve the new block…';
        await sleep(2000);
      }
    } catch (e) {
      result.append(el('div', 'errline', e.message));
    } finally {
      inFlight = false;
      setPill(sponsorState);
    }
  };

  // sponsor status
  const poll = async () => {
    if (!net.api) { setPill('none'); pill.querySelector('.ptext').textContent = 'No hosted service on this network.'; return; }
    try {
      const st = await (await fetch(`${net.api}/api/status`)).json();
      const extra = st.state === 'ready' || st.state === 'proving' ? ` · queue ${st.queue} · ${st.limits.perIpPerHour} per visitor per hour` : '';
      setPill(st.state, extra);
    } catch {
      setPill('unreachable');
    }
  };
  poll();
  setInterval(poll, 5000);
  picker.firstChild.click();
  return s;
};

// ---------------------------------------------------------------------------
// the control, and the boundary
// ---------------------------------------------------------------------------
const comparison = (preview) => {
  const s = el('section', 'card');
  s.append(el('h2', null, 'Three checks, one book'));
  let markX = '', realX = '';
  if (preview) {
    const q = 10_000_000n * 1_000_000n, d = 5_500_000;
    markX = x2(fromMicro(marked(preview.reserveX, preview.reserveY, q)) / d);
    realX = x2(fromMicro(realisable(preview.reserveX, preview.reserveY, q, preview.feeBps)) / d);
  }
  s.append(el('p', 'lede', `The overlevered sample: 10,000,000 AERO against $5,500,000 of debt at a 1.20x bar, priced from the reserves last published on chain. The balance-threshold check is a faithful mark-based solvency check written in Compact (contract/src/control.compact) and run on the same private book in test/control.test.mjs.`));
  const t = el('table', 'cmp3');
  const rows = [
    ['', 'Proof of reserves', 'Balance threshold (“proveSolvency”)', 'datum'],
    ['Proves the tokens exist', 'yes', 'yes', 'yes, privately'],
    ['Values collateral at', 'nothing', 'the oracle mark', 'the price the pool would pay'],
    ['Accounts for depth and price impact', 'no', 'no', 'yes, constant-product with fee'],
    ['Positions and debt stay private', 'often not', 'yes', 'yes'],
    ['Venue data provable from the source chain', 'n/a', 'n/a', 'yes: Sync log, block, tx, log index'],
    ['Verdict on this book', 'no verdict', `COVERED ${markX}`, `NOT COVERED ${realX}`],
  ];
  for (const [i, r] of rows.entries()) t.append(el('tr', i === 0 ? 'th' : i === rows.length - 1 ? 'last' : null, ...r.map((c, j) => el(i === 0 ? 'th' : 'td', j === 3 ? 'us' : null, c))));
  s.append(el('div', 'tablewrap', t));
  return s;
};

const boundary = () => {
  const s = el('section', 'card');
  s.append(el('h2', null, 'Where this method is the wrong tool'));
  const ul = el('ul', 'bounds');
  for (const [k, v] of [
    ['Concentrated liquidity (Uniswap v3, Aerodrome Slipstream)', 'Depth depends on tick ranges, not x·y=k. MORPHO on Base exits mainly through a Slipstream pool, so datum does not price it.'],
    ['Aggregators and routers', 'A route across many pools is not one reserve pair, and an aggregator quote is not a Sync log anyone can re-fetch.'],
    ['Assets whose deep pool is quoted in another volatile asset', 'WELL’s depth sits in WELL/WETH; pricing through WETH needs a second hop datum does not model yet.'],
    ['Stable-swap pools', 'Aerodrome stable pools use a different invariant; the verifier rejects them.'],
    ['Off-chain exits', 'CEX order books and OTC desks are not on a public chain, so there is nothing to re-fetch.'],
  ]) ul.append(el('li', null, el('strong', null, k + '. '), v));
  s.append(ul);
  s.append(el('p', 'lede small', 'Where it applies, datum is a lower bound: the book’s main exit really is one constant-product pool per asset, and selling there would fetch at least what was proved.'));
  return s;
};

const footer = (net) => el('footer', 'foot',
  el('a', null, 'Source and judge guide'), ' · ',
  el('span', 'mono', `node scripts/verify.mjs --network ${net.id} --tamper`));

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
const fail = (title, detail) => {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.append(el('div', 'errbox', el('div', 'err-title', title), el('pre', 'err-detail', detail)));
};

const boot = async () => {
  let net;
  try { net = resolveNetwork(); } catch (e) { return fail('Configuration error', e.message); }
  setNetworkId(net.id);
  const lib = await import('../../build/datum-full/contract/index.js');
  const dep = DEPLOYMENTS[`../../deployments/${net.id}.json`];
  if (dep?.demo?.address) net.demo = dep.demo.address;
  const books = Object.entries(dep?.books ?? {}).sort(([x], [y]) => (x === 'WELL' ? -1 : y === 'WELL' ? 1 : 0));

  const app = document.getElementById('app');
  app.innerHTML = '';
  app.append(...hero(net));

  // Previews and the comparison price the sample books against the AERO pool
  // as last published on chain.
  let preview = null;
  for (const [market, rec] of books) {
    app.append(realBook(net, market, rec));
    try {
      const st = await readContract(net, lib, rec.address);
      app.append(attestationCard(net, lib, st, rec.address, `The ${market} book’s attestation on chain`));
      if (market === 'AERO') preview = st.L.venues.find((v) => !isPaddingSlot(v));
    } catch (e) {
      app.append(el('div', 'errbox', el('div', 'err-title', `Could not read the ${market} book contract`), el('pre', 'err-detail', e.message)));
    }
  }

  const demoMount = el('div');
  const mountDemo = (st) => { demoMount.innerHTML = ''; demoMount.append(attestationCard(net, lib, st, net.demo, 'Demo contract: every book attested from this page')); };
  if (net.demo && net.api) app.append(attestSection(net, lib, preview, mountDemo));
  app.append(demoMount);
  if (net.demo) readContract(net, lib, net.demo).then((st) => { if (st.L.attestationCount > 0n) mountDemo(st); }).catch(() => {});

  app.append(comparison(preview), boundary());
  const f = footer(net);
  f.firstChild.href = REPO;
  app.append(f);
};

boot().catch((e) => fail('Something broke', e?.stack ?? String(e)));
