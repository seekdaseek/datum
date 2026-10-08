// ops/ecosystem.config.cjs — the datum processes on the shared VPS.
//
// datum shares a 2-core, 4 GB host with live services. Every datum process is
// started by PM2 THROUGH `systemd-run --scope`, so each sits in its own cgroup
// with hard limits, and stays visible and restartable in PM2:
//
//   MemoryMax       hard ceiling, sized from measured peaks plus margin
//                   (Mac, 4-slot k=15 circuit: prover 532 MB, service 235 MB)
//   MemorySwapMax=0 datum never pushes live services into swap
//   CPUQuota=100%   at most one core each
//   nice 10         the scheduler favours every other process on the box
//   choom 1000      if the host itself runs out, the kernel kills datum first
//
// The proof server has no bind-address option, so its cgroup only admits
// loopback traffic (IPAddressDeny/Allow). It needs no egress either: its
// public parameters (k=10..15, zswap and dust keys) were fetched once into
// prover-home, and NO_FETCH_PARAMS stops it fetching again.
//
// Prove the limits are real:
//   cat /proc/<pid>/cgroup                       -> a run-*.scope
//   cat /sys/fs/cgroup/<that path>/memory.max    -> the byte limit
//   cat /proc/<pid>/oom_score_adj                -> 1000
//
const SCOPE = (mem) => [
  '--scope', '--quiet', '--collect',
  '-p', `MemoryMax=${mem}`,
  '-p', 'MemorySwapMax=0',
  '-p', 'CPUQuota=100%',
];
const HARDEN = ['/usr/bin/nice', '-n', '10', '/usr/bin/choom', '-n', '1000', '--'];
const PROOF_SERVER = '/nix/store/6naj0x3l5n0b4cx722xwasyp597p6z3h-ledger-8.1.0/bin/midnight-proof-server';

module.exports = {
  apps: [
    {
      name: 'datum-prover',
      script: '/usr/bin/systemd-run',
      interpreter: 'none',
      args: [...SCOPE('768M'), '-p', 'IPAddressDeny=any', '-p', 'IPAddressAllow=localhost', '--', ...HARDEN, PROOF_SERVER],
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
      args: [...SCOPE('512M'), '--', ...HARDEN, '/usr/bin/node', '/opt/datum/service/server.mjs'],
      cwd: '/opt/datum',
      env: {
        SERVICE_ENV: '/opt/datum/service/.env.service',
        STATE_DIR: '/opt/datum/state',
        PROOF_SERVER: 'http://127.0.0.1:6310',
        PORT: '3034',
        // The prover runs only while there is work: the service starts
        // datum-prover through PM2 for a job and stops it after 5 idle minutes.
        PROVER_PM2: 'datum-prover',
        PROVER_IDLE_MIN: '5',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
    },
    {
      // A dedicated tunnel, as for every other app on this host: the shared
      // config.yml is never edited and no running cloudflared is signalled.
      name: 'datum-tunnel',
      script: '/usr/local/bin/cloudflared',
      interpreter: 'none',
      args: ['tunnel', '--config', '/root/.cloudflared/datum.yml', '--no-autoupdate', 'run'],
      cwd: '/root',
      autorestart: true,
    },
  ],
};
