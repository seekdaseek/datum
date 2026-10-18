// ops/ecosystem.dedicated.config.cjs — the datum processes on a DEDICATED
// server, nothing else of value on it. Same shape as ops/ecosystem.config.cjs,
// sized for this host. It started on a Hetzner CPX12 (1 vCPU, 1.9 GB RAM,
// 2 GB swapfile) and moved to a CPX32 (4 vCPU, 8 GB RAM) on 2026-10-18, because
// the sponsor wallet's first sync from genesis is CPU-bound (the dust stream
// replays about 1.7 million events). The limits below are the CPX32 ones.
//
//   datum-api   CPUQuota=400% (all four cores for the wallet sync), MemoryMax=3G,
//               MemorySwapMax=512M
//   datum-prover unchanged: MemoryMax=768M, no swap, one core
//
// What differs from the shared 4 GB VPS, and why:
//   PROVER_FLOOR_MB=250  the memory kept free for sshd, pm2, cloudflared and
//                        the kernel, not 500 for other live services. With the
//                        454 MB prover peak that makes the capacity gate
//                        NEED_MB = 700 (service/capacity.mjs, was 950). At rest
//                        the box has about 1.1 GB available with datum-api up.
//   datum-api swap       MemorySwapMax=512M. Restoring the sponsor wallet from
//                        a checkpoint peaks near 803 MB; the 1G cap still holds
//                        and a spike swaps instead of being killed.
//   datum-prover swap    still 0: a swapped prover only times the proof out.
//   prover MemoryMax     still 768M: the attest circuit is k=15 (454 MB peak).
//
// Everything else is unchanged: on-demand prover (started per job, stopped
// after 5 idle minutes), loopback-only cgroup for the prover, nice 10, choom
// 1000 (if the host runs dry the kernel kills datum, not sshd or pm2).
//
const SCOPE = (mem, swap, cpu = '100%') => [
  '--scope', '--quiet', '--collect',
  '-p', `MemoryMax=${mem}`,
  '-p', `MemorySwapMax=${swap}`,
  '-p', `CPUQuota=${cpu}`,
];
const HARDEN = ['/usr/bin/nice', '-n', '10', '/usr/bin/choom', '-n', '1000', '--'];
const PROOF_SERVER = '/nix/store/6naj0x3l5n0b4cx722xwasyp597p6z3h-ledger-8.1.0/bin/midnight-proof-server';

module.exports = {
  apps: [
    {
      name: 'datum-prover',
      script: '/usr/bin/systemd-run',
      interpreter: 'none',
      args: [...SCOPE('768M', '0'), '-p', 'IPAddressDeny=any', '-p', 'IPAddressAllow=localhost', '--', ...HARDEN, PROOF_SERVER],
      cwd: '/opt/datum',
      env: {
        HOME: '/opt/datum/prover-home',
        MIDNIGHT_PROOF_SERVER_PORT: '6310',
        MIDNIGHT_PROOF_SERVER_NUM_WORKERS: '1',
        MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS: 'true',
        RAYON_NUM_THREADS: '1',
      },
      // Not autorestarted: datum-api starts and stops it on demand.
      autorestart: false,
    },
    {
      name: 'datum-api',
      script: '/usr/bin/systemd-run',
      interpreter: 'none',
      args: [...SCOPE('3G', '512M', '400%'), '--', ...HARDEN, '/usr/bin/node', '/opt/datum/service/server.mjs'],
      cwd: '/opt/datum',
      env: {
        SERVICE_ENV: '/opt/datum/service/.env.service,/opt/datum/service/.env.blockfrost',
        STATE_DIR: '/opt/datum/state',
        PROOF_SERVER: 'http://127.0.0.1:6310',
        PORT: '3034',
        PROVER_PM2: 'datum-prover',
        PROVER_IDLE_MIN: '5',
        PROVER_FLOOR_MB: '250',
        // per-socket log of the sponsor sync: cursor against the indexer tip
        WS_PROBE: '1',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
    },
    {
      // The ONE running connector of the dedicated `datum` tunnel
      // (datum-api.ochinimus.app). The main VPS runs no datum tunnel.
      name: 'datum-tunnel',
      script: '/usr/local/bin/cloudflared',
      interpreter: 'none',
      args: ['tunnel', '--config', '/root/.cloudflared/datum.yml', '--no-autoupdate', 'run'],
      cwd: '/root',
      autorestart: true,
    },
  ],
};
