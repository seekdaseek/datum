import { createUnprovenDeployTx } from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
setNetworkId('undeployed');
const which = process.argv[2], dir = process.argv[3];
const { Contract } = await import(`${dir}/contract/index.js`);
const z = (n) => new Uint8Array(n);
const ps = { attestorSecret: z(32), positions: Array(8).fill(0n), proceeds: Array(8).fill(0n), debt: 0n, nonce: z(32), prev: { positions: Array(8).fill(0n), debt: 0n, nonce: z(32) } };
const w = new Proxy({}, { get: (_, k) => ({ privateState }) => [privateState, ({ positionSizes: ps.positions, claimedProceeds: ps.proceeds, debtAmount: 0n, commitmentNonce: z(32), attestorSecret: z(32), previousOpening: ps.prev })[k]] });
const compiled = CompiledContract.make('datum', Contract).pipe(CompiledContract.withWitnesses(w), CompiledContract.withCompiledFileAssets(dir));
const keys = ledger.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(3));
const wp = { getCoinPublicKey: () => keys.coinPublicKey, getEncryptionPublicKey: () => keys.encryptionPublicKey };
const opts = which === 'v2' ? { compiledContract: compiled, privateStateId: 'x', initialPrivateState: ps, args: [21600n] } : { compiledContract: compiled, privateStateId: 'x', initialPrivateState: ps };
const d = await createUnprovenDeployTx({ zkConfigProvider: new NodeZkConfigProvider(dir), walletProvider: wp }, opts);
const tx = d.private.unprovenTx;
const params = ledger.LedgerParameters.initialParameters();
const c = tx.cost(params, process.argv[4] === "dismiss");
console.log(`${which}: readTime ${c.readTime} computeTime ${c.computeTime} blockUsage ${c.blockUsage} bytesWritten ${c.bytesWritten} bytesChurned ${c.bytesChurned}`);
try { const n = params.normalizeFullness(c); console.log(`   fraction of a block: read ${n.readTime.toFixed(3)} compute ${n.computeTime.toFixed(3)} usage ${n.blockUsage.toFixed(3)} written ${n.bytesWritten.toFixed(3)} churned ${n.bytesChurned.toFixed(3)}`); }
catch (e) { console.log(`   EXCEEDS A BLOCK: ${e.message ?? e}`); }
const raw = tx.serialize();
console.log(`   serialized unproven tx: ${raw.length.toLocaleString('en')} bytes`);
const st = d.public.initialContractState;
const ops = st.operations ? [...st.operations()] : [];
console.log(`   contract operations: ${ops.length ? ops.map((o) => String(o)).join(', ') : '(n/a)'}`);
for (const name of ['attest']) { const op = st.operation?.(name); if (op) console.log(`   op '${name}': verifierKey ${op.verifierKey?.length ?? '?'} bytes, serialized ${op.serialize?.().length ?? '?'} bytes`); }
console.log(`   initial contract state serialized: ${st.serialize().length.toLocaleString('en')} bytes`);
