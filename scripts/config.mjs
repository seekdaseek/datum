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

export const NETWORKS = {
  // Local docker stack from github.com/midnightntwrk/midnight-local-dev.
  // Genesis wallet is pre-funded and pre-registered for DUST.
  undeployed: {
    id: 'undeployed',
    label: 'local (undeployed)',
    node: 'http://localhost:9944',
    indexerHttp: 'http://localhost:8088/api/v4/graphql',
    indexerWs: 'ws://localhost:8088/api/v4/graphql/ws',
    proofServer: 'http://localhost:6300',
    addressPrefix: 'mn_addr_undeployed',
    faucet: null, // genesis wallet funds directly; no faucet
    explorer: null,
  },

  // Public test network. Ledger 8.
  preview: {
    id: 'preview',
    label: 'Preview',
    node: 'https://rpc.preview.midnight.network',
    indexerHttp: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    proofServer: 'http://localhost:6300', // always local: it handles private data
    addressPrefix: 'mn_addr_preview',
    faucet: 'https://midnight-tmnight-preview.nethermind.dev/',
    explorer: 'https://preview.midnightexplorer.com/',
  },

  // Public test network closest to mainnet. Ledger 8.
  preprod: {
    id: 'preprod',
    label: 'Preprod',
    node: 'https://rpc.preprod.midnight.network',
    indexerHttp: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServer: 'http://localhost:6300',
    addressPrefix: 'mn_addr_preprod',
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev/',
    explorer: 'https://preprod.midnightexplorer.com/',
  },
};

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
  return net;
};
