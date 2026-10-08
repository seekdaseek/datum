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
    contract: '9c60fe0699ca183009462ab88009640d54f631dee9c0485caa4189e2f3888649',
    demo: '93aba7d12e4370ea12c1af8ea9a0e17d17d086adf20a1cc92f86d2aa3287eb36',
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
    node: 'https://rpc.preprod.midnight.network',
    indexerHttp: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    proofServer: 'http://localhost:6300',
    addressPrefix: 'mn_addr_preprod',
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev/',
    explorer: 'https://preprod.midnightexplorer.com/',
    // v1 (Wave 1) book contract; replaced by the v2 deploy.
    contract: '8086d2e3db45c9eb2a45b58796202d8e076e04c49e03142db36a98815bb30a05',
    demo: null,
    api: 'https://datum-api.ochinimus.app',
    public: true,
  },
};

export const RATIO_SCALE = 1_000_000n;
export const MICRO = 1_000_000n;
export const SLOTS = 4;
