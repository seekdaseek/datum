// scripts/diag/well-facts.mjs — WELL on Moonwell (Base), measured live: supply,
// oracle, collateral factor, the WELL/WETH pool, and WETH's own depth.
import { makeRpc, readPool } from '../provenance.mjs';
const rpc = makeRpc(8453);
const ref = BigInt(await rpc.call('eth_blockNumber', [])) - 10n;
const word = (h, i = 0) => BigInt('0x' + h.slice(2 + i * 64, 2 + i * 64 + 64));
const pad = (a) => a.slice(2).toLowerCase().padStart(64, '0');
const COMP = '0xfbb21d0380bee3312b33c4353c8936a0f13ef26c';
const SEL = { totalSupply: '0x18160ddd', exchangeRateStored: '0x182df0f5', markets: '0x8e8f294b', oracle: '0x7dc0d1d0', price: '0xfc57d4df', getAllMarkets: '0xb0772d0b', underlying: '0x6f307dc3', symbol: '0x95d89b41' };
const sym = async (a) => { try { const h = await rpc.ethCall(a, SEL.symbol, ref); const n = Number(word(h, 1)); return Buffer.from(h.slice(130, 130 + n * 2), 'hex').toString(); } catch { return '?'; } };
const oracle = '0x' + (await rpc.ethCall(COMP, SEL.oracle, ref)).slice(-40);
const all = await rpc.ethCall(COMP, SEL.getAllMarkets, ref);
const n = Number(word(all, 1));
const markets = Array.from({ length: n }, (_, i) => '0x' + all.slice(2 + (2 + i) * 64 + 24, 2 + (3 + i) * 64));
const find = async (s) => { for (const m of markets) if ((await sym(m)) === s) return m; };
const mWELL = await find('mWELL'), mWETH = await find('mWETH');
const WELL = '0x' + (await rpc.ethCall(mWELL, SEL.underlying, ref)).slice(-40);
const WETH = '0x' + (await rpc.ethCall(mWETH, SEL.underlying, ref)).slice(-40);
const ts = word(await rpc.ethCall(mWELL, SEL.totalSupply, ref)), er = word(await rpc.ethCall(mWELL, SEL.exchangeRateStored, ref));
const cf = word(await rpc.ethCall(COMP, SEL.markets + pad(mWELL), ref), 1);
const pWELL = word(await rpc.ethCall(oracle, SEL.price + pad(mWELL), ref));
const pWETH = word(await rpc.ethCall(oracle, SEL.price + pad(mWETH), ref));
const supplied = Number((ts * er) / 10n ** 18n) / 1e18;
const wellUsd = Number(pWELL) / 1e18, wethUsd = Number(pWETH) / 1e18;
console.log(`Base block ${ref}  oracle ${oracle}`);
console.log(`mWELL ${mWELL}  WELL ${WELL}   mWETH ${mWETH}  WETH ${WETH}`);
console.log(`WELL supplied ${supplied.toLocaleString('en-US', { maximumFractionDigits: 0 })}  CF ${Number(cf) / 1e16}%  oracle WELL $${wellUsd}  WETH $${wethUsd}`);
console.log(`marked $${(supplied * wellUsd).toLocaleString('en-US', { maximumFractionDigits: 0 })}  debt cap $${(supplied * wellUsd * Number(cf) / 1e18).toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
for (const [name, a] of [['WELL/WETH aero volatile', '0x89D0F320ac73dd7d9513FFC5bc58D1161452a657'], ['WETH/USDC aero volatile', '0xcDAC0d6c6C59727a65F871236188350531885C43']]) {
  const f = await readPool(rpc, a, ref);
  const r = await rpc.ethCall(a, '0x0902f1ac', ref); // getReserves()
  const r0 = word(r, 0), r1 = word(r, 1);
  console.log(`${name} ${a}: ${f.label} vouched=${f.vouched} fee=${f.feeBps}bps token0=${await sym(f.token0)} ${Number(r0) / 10 ** f.dec0} token1=${await sym(f.token1)} ${Number(r1) / 10 ** f.dec1}`);
}
