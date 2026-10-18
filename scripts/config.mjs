//
// scripts/config.mjs — every network-dependent value, in one place, keyed by network.
//
// Moving datum between networks is a single key change here and nothing else.
// The endpoints are grouped WITH the network id on purpose: the classic failure
// is a `preprod` network id wired to a `preview` indexer, which fails later and
// confusingly rather than at the point of the mistake.
//
// setNetworkId() must be called BEFORE any provider, wallet or address helper is
// constructed. getNetworkId() throws until it is set, and a wrong value fails
// downstream rather than at the call, so `applyNetwork()` below is the only
// intended entry point.
//
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

export { NETWORKS } from './networks.mjs';
import { NETWORKS, withBlockfrost } from './networks.mjs';

export const DEFAULT_NETWORK = 'undeployed';

/**
 * Resolve the target network from `--network <id>`, then `$DATUM_NETWORK`, then
 * the default, and apply it globally. Returns the config for that network.
 *
 * This is the ONLY place setNetworkId is called.
 */
export const applyNetwork = (argv = process.argv) => {
  const flagIdx = argv.indexOf('--network');
  const requested =
    (flagIdx >= 0 ? argv[flagIdx + 1] : undefined) ?? process.env.DATUM_NETWORK ?? DEFAULT_NETWORK;

  const net = NETWORKS[requested];
  if (!net) {
    const known = Object.keys(NETWORKS).join(', ');
    console.error(`config: unknown network ${JSON.stringify(requested)} — known: ${known}`);
    process.exit(1);
  }

  setNetworkId(net.id);
  // Preprod's indexer and RPC are Blockfrost's and need a project token (a free
  // account is enough). Without one the CLI cannot read or write that network;
  // the page verifies keylessly through datum-api's read-only relay.
  if (net.blockfrost && !process.env.BLOCKFROST_PROJECT_ID) {
    console.error(`config: ${net.id} needs BLOCKFROST_PROJECT_ID (free Midnight ${net.label} project at blockfrost.io)`);
    process.exit(1);
  }
  return withBlockfrost(net, process.env.BLOCKFROST_PROJECT_ID);
};
