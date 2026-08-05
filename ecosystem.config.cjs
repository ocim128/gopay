// PM2 process manager configuration.
//
// Runs BOTH services as long-lived, auto-restarting processes:
//   * gopay-api   — the backend REST_API + admin endpoints (src/server.js).
//                   server.js loads its own .env via dotenv, so no extra env
//                   wiring is needed here. Listens on PORT/HOST from .env
//                   (default 3000 / 0.0.0.0).
//   * gopay-panel — the SvelteKit (adapter-node) panel (panel/build/index.js).
//                   adapter-node does NOT auto-load panel/.env, so we load it
//                   with Node's built-in `--env-file` flag (Node >= 20.6).
//                   Listens on PORT/HOST from panel/.env (3001 / 0.0.0.0).
//
// Usage:
//   npx pm2 start ecosystem.config.cjs   # start both
//   npx pm2 status                       # see both processes
//   npx pm2 logs                         # tail logs
//   npx pm2 restart gopay-api            # restart one
//   npx pm2 save                         # persist the process list
//
// NOTE: NODE_ENV is intentionally left unset for the backend so the admin
// session cookie is NOT marked Secure (works over plain http://IP:port). Set it
// to "production" only once you serve the panel over HTTPS.

const path = require('node:path');

const ROOT = __dirname;
const PANEL = path.join(ROOT, 'panel');

module.exports = {
  apps: [
    {
      name: 'gopay-api',
      cwd: ROOT,
      // Use the explicit entry (start.mjs) rather than src/server.js: under
      // PM2's fork wrapper the "run directly" guard in server.js is false, so
      // pointing at it directly would load the module without ever listening.
      script: 'start.mjs',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      // Pin the timezone so timestamp rendering (and any local-time logic) is
      // deterministic regardless of the host's TZ. GoBiz reports in WIB, so we
      // match it. Stored timestamps remain UTC epoch ms; this only affects
      // local-time display/formatting.
      env: {
        TZ: 'Asia/Jakarta',
      },
      // Restart if memory ever balloons (defensive; the app is lightweight).
      max_memory_restart: '300M',
    },
    {
      name: 'gopay-panel',
      cwd: PANEL,
      script: 'build/index.js',
      // Load panel/.env (API_BASE, PORT, HOST, NODE_ENV, PANEL_API_KEY).
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      // Same WIB pin so the panel's toLocaleString() renders Asia/Jakarta.
      env: {
        TZ: 'Asia/Jakarta',
      },
      max_memory_restart: '300M',
    },
  ],
};
