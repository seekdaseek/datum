//
// scripts/networks.mjs — every network-dependent value, one object, keyed by network.
//
// Pure data with no Node APIs, so the CLI scripts and the browser frontend can
// share it verbatim. Endpoints are grouped WITH the network id on purpose: the
// classic failure is a `preprod` network id wired to a `preview` indexer, which
// fails later and confusingly rather than at the point of the mistake.
//
// `contract` is the deployed datum address on that network, or null if datum is
// not deployed there yet. Switching the frontend or the CLI to another network
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
    contract: '64a99b83376d198af51cfb6fad7bfee9a963fb07623cb624682a49ca7ba5d5c0',
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
    contract: '8086d2e3db45c9eb2a45b58796202d8e076e04c49e03142db36a98815bb30a05',
    public: true,
  },
};

export const RATIO_SCALE = 1_000_000n;
export const MICRO = 1_000_000n;
export const SLOTS = 8;
