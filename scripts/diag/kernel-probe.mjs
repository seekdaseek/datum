// Deploy a one-circuit probe contract and call it, to isolate which construct
// the proof server rejects. Uses the main wallet's checkpoint, so it is fast.
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { resolve } from 'node:path';
import { applyNetwork } from '../config.mjs';
import { ensureEnvSecret, ensureStorePassword, ROOT } from '../seed.mjs';
import { openWallet, waitSynced, walletProviderFor, closeWallet } from '../wallet-lib.mjs';
const NET = applyNetwork();
const dir = resolve(ROOT, process.argv[process.argv.indexOf('--dir') + 1]);
const circuit = process.argv[process.argv.indexOf('--circuit') + 1];
const { Contract } = await import(`${dir}/contract/index.js`);
const { value: seedHex } = ensureEnvSecret('WALLET_SEED', () => { throw new Error('no seed'); });
const ctx = await openWallet({ net: NET, seedHex, statePath: resolve(ROOT, `state/${NET.id}-wallet_seed.json`) });
await waitSynced(ctx, { quiet: true });
const zk = new NodeZkConfigProvider(dir), wm = walletProviderFor(ctx);
const providers = { privateStateProvider: levelPrivateStateProvider({ privateStateStoreName: 'probe-ps', signingKeyStoreName: 'probe-sk', privateStoragePasswordProvider: () => ensureStorePassword().value, accountId: ctx.address }),
  publicDataProvider: indexerPublicDataProvider(NET.indexerHttp, NET.indexerWs), zkConfigProvider: zk, proofProvider: httpClientProofProvider(NET.proofServer, zk), walletProvider: wm, midnightProvider: wm };
const c = await deployContract(providers, { compiledContract: CompiledContract.make('p', Contract).pipe(CompiledContract.withVacantWitnesses, CompiledContract.withCompiledFileAssets(dir)) });
console.log(`deployed ${c.deployTxData.public.contractAddress}`);
try {
  const args = circuit === 'fresh' ? [BigInt(Math.floor(Date.now() / 1000) - 120)] : [];
  const r = await c.callTx[circuit](...args);
  console.log(`CALL ${circuit}: OK ${r.public.status} block ${r.public.blockHeight}`);
} catch (e) { console.log(`CALL ${circuit}: FAILED — ${e.message.slice(0, 200)}`); }
await closeWallet(ctx); process.exit(0);
