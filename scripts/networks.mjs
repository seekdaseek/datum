//
// scripts/networks.mjs — every network-dependent value, one object, keyed by network.
//
// Pure data with no Node APIs, so the CLI scripts and the browser frontend can
// share it verbatim. Endpoints are grouped WITH the network id on purpose: the
// classic failure is a `preprod` network id wired to a `preview` indexer, which
// fails later and confusingly rather than at the point of the mistake.
//
// `contract` is the deployed datum BOOK contract on that network (the real
// attested book), `demo` the contract the hosted "Attest a book" flow writes
// to, and `api` that hosted service; null where not deployed. Switching the frontend or the CLI to another network
// is a single key change here and nothing else.
//
export const NETWORKS = {
  // Local docker stack from github.com/midnightntwrk/midnight-local-dev.
  undeployed: {
    id: 'undeployed',
    label: 'Local',
    node: 'http://localhost:9944',
    indexerHttp: 'http://localhost:8088/api/v4/graphql',
    indexerWs: 'ws://localhost:8088/api/v4/graphql/ws',
    proofServer: 'http://localhost:6300',
    addressPrefix: 'mn_addr_undeployed',
    faucet: null,
    explorer: null,
    contract: null, // the real books and the demo come from deployments/undeployed.json
    demo: null,
    api: 'http://localhost:3034',
    public: false,
  },

  // Public test network. Ledger 8. Faucet currently NOT_SERVING.
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
    contract: null,
    demo: null,
    api: null,
    public: true,
  },

  // Public test network closest to mainnet. Ledger 8.
  preprod: {
    id: 'preprod',
    label: 'Preprod',
    // Midnight retired its own Preprod endpoints on 9 Oct 2026; the public
    // indexer and RPC are now Blockfrost's, and every request needs a project
    // token. The token stays on the server. `indexerHttp` is datum-api's
    // READ-ONLY relay, which answers only the contract read the page sends;
    // `blockfrost` holds the real endpoints, used by the service and the wallet
    // scripts through withBlockfrost() with the token from the environment.
    node: 'https://rpc.midnight-preprod.blockfrost.io',
    indexerHttp: 'https://datum-api.ochinimus.app/api/indexer',
    indexerWs: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
    blockfrost: {
      node: 'https://rpc.midnight-preprod.blockfrost.io',
      indexerHttp: 'https://midnight-preprod.blockfrost.io/api/v0',
      indexerWs: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
    },
    proofServer: 'http://localhost:6300',
    addressPrefix: 'mn_addr_preprod',
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev/',
    explorer: 'https://preprod.midnightexplorer.com/',
    // The v2 books and demo come from deployments/preprod.json. The Wave 1
    // contract (8086d2e3…0a05) stays on chain and is recorded in docs/WAVE1.md.
    contract: null,
    demo: null,
    api: 'https://datum-api.ochinimus.app',
    public: true,
  },
};

/**
 * The network with its real endpoints, for code that holds a Blockfrost project
 * token (the service, the wallet scripts). The clients take URLs only, so the
 * token goes in as ?project_id=. A network without a `blockfrost` block is
 * returned unchanged. Never log the result.
 */
export const withBlockfrost = (net, projectId) => {
  if (!net.blockfrost) return net;
  if (!projectId) throw new Error(`${net.id} needs BLOCKFROST_PROJECT_ID`);
  const q = (u) => `${u}?project_id=${encodeURIComponent(projectId)}`;
  return {
    ...net,
    node: q(net.blockfrost.node),
    indexerHttp: q(net.blockfrost.indexerHttp),
    indexerWs: q(net.blockfrost.indexerWs),
  };
};

export const RATIO_SCALE = 1_000_000n;
export const MICRO = 1_000_000n;
export const SLOTS = 4;
