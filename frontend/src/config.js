//
// frontend/src/config.js
//
// The frontend reads the SAME network object the CLI reads — scripts/networks.mjs
// is the single source of truth. Nothing here is hardcoded: switching the page to
// another network is one key change in that file, or ?network=<id> in the URL.
//
import { NETWORKS, RATIO_SCALE, SLOTS } from '../../scripts/networks.mjs';

// Which network the deployed page targets by default. Flip this one string to
// repoint the whole app.
export const DEFAULT_NETWORK = 'undeployed';

export const resolveNetwork = () => {
  const requested =
    new URLSearchParams(window.location.search).get('network') ?? DEFAULT_NETWORK;
  const net = NETWORKS[requested];
  if (!net) {
    throw new Error(
      `Unknown network "${requested}". Known: ${Object.keys(NETWORKS).join(', ')}`,
    );
  }
  return net;
};

export { NETWORKS, RATIO_SCALE, SLOTS };
