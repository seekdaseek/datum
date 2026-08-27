//
// frontend/src/main.js — datum, read-only.
//
// This page NEVER connects a wallet, never holds key material, and never
// generates a proof. It reads public ledger state through the indexer and
// recomputes what it can from that state alone. Everything on screen is either
// read from chain or derived from values that are on chain.
//
// Deliberately NOT using indexerPublicDataProvider here. It pulls in ledger-v8
// (a 10 MB WASM), Apollo and graphql-ws for capabilities this page never needs —
// transactions, zswap state, subscriptions. A read-only page needs one GraphQL
// query and the runtime's own deserializer, which lives in the 1.4 MB
// onchain-runtime WASM we already require to decode ledger state.
import { ContractState } from '@midnight-ntwrk/compact-runtime';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { resolveNetwork, RATIO_SCALE } from './config.js';
import './style.css';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const short = (s, n = 10) => (s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const MICRO = 1_000_000n;
/** micro-units -> human string with thousands separators */
const fromMicro = (v) => (Number(v) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 });

/** Realisable proceeds of selling q into constant-product reserves, floored. */
const realisable = (X, Y, q) => (q === 0n ? 0n : (Y * q) / (X + q));
/** Oracle-mark valuation of the same size: q * spot, spot = Y/X. */
const marked = (X, Y, q) => (X === 0n ? 0n : (q * Y) / X);

const fail = (title, detail, hint) => {
  const app = document.getElementById('app');
  app.innerHTML = '';
  const box = el('div', 'errbox');
  box.append(el('div', 'err-title', title));
  box.append(el('pre', 'err-detail', detail));
  if (hint) box.append(el('div', 'err-hint', hint));
  app.append(box);
};

// ---------------------------------------------------------------------------
// chain reads
// ---------------------------------------------------------------------------
const gql = async (net, query, variables) => {
  const res = await fetch(net.indexerHttp, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Indexer returned HTTP ${res.status} ${res.statusText}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Indexer GraphQL error: ${body.errors[0].message}`);
  return body.data;
};

const ACTION_QUERY = `query Datum($addr: HexEncoded!) {
  contractAction(address: $addr) {
    __typename
    address
    state
    ... on ContractCall { entryPoint }
    transaction { hash block { height timestamp } }
  }
}`;

const fromHexStr = (h) => {
  const clean = h.startsWith('0x') ? h.slice(2) : h;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
};

const readChain = async (net, contractLib) => {
  const action = (await gql(net, ACTION_QUERY, { addr: net.contract })).contractAction;
  if (!action) {
    throw new Error(`No contract found at ${net.contract} on network "${net.id}".`);
  }
  // The indexer returns the serialized ContractState as hex; the runtime
  // deserializes it and the generated contract decodes the ledger fields.
  const contractState = ContractState.deserialize(fromHexStr(action.state));
  const L = contractLib.ledger(contractState.data);
  return { ledgerState: L, action };
};

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
const render = (net, data, contractLib) => {
  const { ledgerState: L, action } = data;
  const app = document.getElementById('app');
  app.innerHTML = '';

  const activeSlots = L.venues.filter((v) => v.reserveX > 1n || v.reserveY > 1n);
  const pool = activeSlots[0] ?? L.venues[0];

  // ---- header -------------------------------------------------------------
  const head = el('header', 'head');
  const brand = el('div', 'brand');
  brand.append(el('h1', null, 'datum'));
  brand.append(el('p', 'tag', 'Solvency proved at realisable exit prices — not oracle marks.'));
  head.append(brand);

  const netBadge = el('div', `netbadge ${net.public ? 'pub' : 'local'}`);
  netBadge.append(el('span', 'netdot'));
  netBadge.append(el('span', null, net.public ? `${net.label} — public network` : `${net.label} network`));
  head.append(netBadge);
  app.append(head);

  // ---- the gap ------------------------------------------------------------
  const gapCard = el('section', 'card gapcard');
  gapCard.append(el('h2', null, 'Why marks lie'));
  gapCard.append(
    el(
      'p',
      'lede',
      'Selling into a pool moves the price against you. These figures come only from the venue reserves published on chain below — drag to see the gap at any exit size.',
    ),
  );

  const slider = el('input', 'slider');
  slider.type = 'range';
  slider.min = '1';
  slider.max = '90';
  slider.value = '50';
  slider.setAttribute('aria-label', 'Exit size as a percentage of pool reserves');

  const cmp = el('div', 'cmp');
  const leftCol = el('div', 'col mark');
  const rightCol = el('div', 'col real');
  const gapCol = el('div', 'col gap');
  cmp.append(leftCol, gapCol, rightCol);

  const sizeLine = el('p', 'sizeline');

  const paint = () => {
    const pct = BigInt(slider.value);
    const q = (pool.reserveX * pct) / 100n;
    const m = marked(pool.reserveX, pool.reserveY, q);
    const r = realisable(pool.reserveX, pool.reserveY, q);
    const gap = m - r;
    const gapPct = m === 0n ? 0 : (Number(gap) / Number(m)) * 100;

    leftCol.innerHTML = '';
    leftCol.append(el('div', 'collabel', 'At oracle marks'));
    leftCol.append(el('div', 'bignum', fromMicro(m)));
    leftCol.append(el('div', 'colsub', 'size × spot price'));

    rightCol.innerHTML = '';
    rightCol.append(el('div', 'collabel', 'Realisable'));
    rightCol.append(el('div', 'bignum', fromMicro(r)));
    rightCol.append(el('div', 'colsub', 'sold into published depth'));

    gapCol.innerHTML = '';
    gapCol.append(el('div', 'collabel', 'Overstatement'));
    gapCol.append(el('div', 'bignum neg', `−${fromMicro(gap)}`));
    gapCol.append(el('div', 'colsub', `${gapPct.toFixed(1)}% of the marked value is not there`));

    sizeLine.textContent = `Exit size: ${pct}% of pool reserves (${fromMicro(q)} units)`;
  };
  slider.addEventListener('input', paint);

  gapCard.append(sizeLine, slider, cmp);
  gapCard.append(
    el(
      'p',
      'privacy-note',
      'The attested book’s actual position sizes, its debt, and its claimed proceeds are private. They are not in public state and are not shown here — that is the point of the contract. The curve above is the published venue depth, not the book.',
    ),
  );
  app.append(gapCard);

  // ---- verdict ------------------------------------------------------------
  const ratio = L.requiredRatio;
  const subColl = ratio < RATIO_SCALE;
  const vCard = el('section', `card verdict ${L.covered ? 'ok' : 'bad'}`);
  const vLeft = el('div', 'vleft');
  vLeft.append(el('div', 'vlabel', 'On-chain verdict'));
  vLeft.append(el('div', 'vbig', L.covered ? 'COVERED' : 'NOT COVERED'));
  vLeft.append(
    el(
      'div',
      'vsub',
      L.covered
        ? 'Realisable proceeds cleared the required ratio.'
        : 'Realisable proceeds did not clear the required ratio.',
    ),
  );
  const vRight = el('div', 'vright');
  vRight.append(el('div', 'vlabel', 'Required ratio'));
  vRight.append(el('div', 'vbig ratio', `${(Number(ratio) / 1e6).toFixed(2)}×`));
  vRight.append(el('div', 'vsub', `requiredRatio = ${ratio} (scaled by ${RATIO_SCALE})`));
  if (subColl) {
    const warn = el('div', 'subcoll', 'SUB-COLLATERALISED');
    warn.title = 'This attestation declares a bar below 1.00×, so "covered" means the book is deliberately short.';
    vRight.append(warn);
  }
  vCard.append(vLeft, vRight);
  app.append(vCard);
  app.append(
    el(
      'p',
      'ratio-note',
      subColl
        ? 'This attestation clears a bar below 1.00×. A verdict of COVERED here means the book truthfully attests to being short of its debt. Read the ratio, not the flag.'
        : 'The verdict is meaningless without the ratio beside it: it means “cleared the bar this attestation declared”, not “solvent”.',
    ),
  );

  // ---- venue array --------------------------------------------------------
  const venueCard = el('section', 'card');
  venueCard.append(el('h2', null, 'Venue state used by the proof'));
  venueCard.append(
    el('p', 'lede', 'Published in the clear so anyone can refetch these pools at these heights and recompute.'),
  );
  const table = el('table', 'venues');
  const thead = el('thead');
  const hr = el('tr');
  ['#', 'venue id', 'reserve X', 'reserve Y', 'block'].forEach((h) => hr.append(el('th', null, h)));
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');
  L.venues.forEach((v, i) => {
    const isPad = v.reserveX <= 1n && v.reserveY <= 1n;
    const tr = el('tr', isPad ? 'pad' : 'active');
    tr.append(el('td', null, String(i)));
    tr.append(el('td', 'mono', `${hex(v.venueId).slice(0, 12)}…`));
    tr.append(el('td', 'mono num', v.reserveX.toString()));
    tr.append(el('td', 'mono num', v.reserveY.toString()));
    tr.append(el('td', 'mono num', v.blockHeight.toString()));
    tbody.append(tr);
  });
  table.append(tbody);
  venueCard.append(table);
  venueCard.append(el('p', 'lede small', 'Slots with reserves of 1 are padding. The circuit asserts X > 0 and Y > 0 on every slot including padding, which is what stops an unused slot claiming proceeds.'));
  app.append(venueCard);

  // ---- proof / provenance -------------------------------------------------
  const pCard = el('section', 'card');
  pCard.append(el('h2', null, 'Provenance'));
  const dl = el('dl', 'kv');
  const row = (k, v, mono = true) => {
    dl.append(el('dt', null, k));
    dl.append(el('dd', mono ? 'mono' : null, v));
  };
  row('Contract address', net.contract);
  if (action?.transaction) {
    row('Attest tx hash', action.transaction.hash);
    row('Block height', String(action.transaction.block.height));
    if (action.entryPoint) row('Entry point', action.entryPoint);
  }
  row('Attestations', String(L.attestationCount), false);
  row('Attested at', `${L.attestedAt} — ${new Date(Number(L.attestedAt) * 1000).toISOString()}`);
  row('Book commitment', hex(L.bookCommitment));
  row('venuesHash', hex(L.venuesHash));
  pCard.append(dl);

  // recompute indicator
  const verifyRow = el('div', 'verifyrow');
  const btn = el('button', 'verifybtn', 'Verify from chain');
  const status = el('div', 'vstatus');
  const setStatus = (cls, text) => {
    status.className = `vstatus ${cls}`;
    status.textContent = text;
  };

  const runVerify = async (initial = false) => {
    btn.disabled = true;
    setStatus('pending', initial ? 'Recomputing venuesHash…' : 'Refetching from the indexer…');
    try {
      const fresh = await readChain(net, contractLib);
      const recomputed = contractLib.pureCircuits.venueDigest(fresh.ledgerState.venues);
      const published = hex(fresh.ledgerState.venuesHash);
      const ok = hex(recomputed) === published;
      setStatus(
        ok ? 'match' : 'mismatch',
        ok
          ? `MATCHES — venuesHash recomputed from the published venue array equals ${short(published, 8)}`
          : `MISMATCH — recomputed ${short(hex(recomputed), 8)} ≠ published ${short(published, 8)}`,
      );
    } catch (e) {
      setStatus('mismatch', `Verification failed: ${e.message}`);
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', () => runVerify(false));
  verifyRow.append(btn, status);
  pCard.append(verifyRow);
  pCard.append(
    el(
      'p',
      'lede small',
      'Verify refetches the contract state from the indexer, recomputes the digest over the published venue array with the contract’s own pure circuit, and compares. It uses public data only — no wallet, no key, no proof generation in this page.',
    ),
  );
  app.append(pCard);

  // ---- footer -------------------------------------------------------------
  const foot = el('footer', 'foot');
  foot.append(
    el(
      'p',
      null,
      `Read live from ${net.indexerHttp} · network “${net.id}” · read-only, no wallet connected`,
    ),
  );
  app.append(foot);

  paint();
  runVerify(true);
};

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
const boot = async () => {
  let net;
  try {
    net = resolveNetwork();
  } catch (e) {
    return fail('Configuration error', e.message, 'Add ?network=undeployed to the URL, or fix DEFAULT_NETWORK.');
  }

  // setNetworkId must run before any provider is constructed.
  setNetworkId(net.id);

  if (!net.contract) {
    return fail(
      `datum is not deployed on “${net.id}” yet`,
      `NETWORKS.${net.id}.contract is null in scripts/networks.mjs.`,
      net.faucet
        ? `Deploy there first, then set the contract address. Faucet: ${net.faucet}`
        : 'Deploy there first, then set the contract address.',
    );
  }

  let contractLib;
  try {
    contractLib = await import('../../build/datum-full/contract/index.js');
  } catch (e) {
    return fail(
      'Compiled contract not found',
      e.message,
      'Run: compact compile contract/src/datum.compact build/datum-full',
    );
  }

  try {
    const data = await readChain(net, contractLib);
    render(net, data, contractLib);
  } catch (e) {
    return fail(
      'Could not read the attestation',
      `${e.message}`,
      `Indexer: ${net.indexerHttp} — check it is reachable and that a datum contract exists at ${net.contract}.`,
    );
  }
};

boot();
