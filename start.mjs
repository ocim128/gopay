// Explicit entry point for running the backend under a process manager (PM2).
//
// `src/server.js` only auto-starts when it is the directly-executed script
// (`node src/server.js`). Under PM2's fork wrapper that "run directly" check is
// false, so the server would load but never listen. This thin entry calls
// startServer() unconditionally so PM2 (or any supervisor) reliably boots it.

import { startServer } from './src/server.js';

startServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
