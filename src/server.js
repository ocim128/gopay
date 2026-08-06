// Fastify bootstrap — the composition root of the backend.
//
// `buildServer()` wires every component behind its interface and returns a ready
// (but not yet listening) Fastify instance, so it can be exercised with
// `fastify.inject()` in tests without binding a port. `listen()` is only called
// when this file is run directly (see the bottom of the file).
//
// Wiring:
//   1. DAL          - createDal() (better-sqlite3 behind the Storage contract).
//   2. Config       - createConfigService(storage).
//   3. GoBiz layer  - HttpTransport -> TokenStore -> AuthTokenManager ->
//                     GoBizClient (the single door for the poller).
//   4. Webhook      - createWebhookDispatcher(...) wired as the Payment_Service
//                     `onSettled` hook.
//   5. Payment      - createPaymentService({ storage, config, ensureRunning,
//                     onSettled }).
//   6. Poller       - createSharedPoller(gobizClient, { getActiveCount,
//                     onTransactions, getPollInterval }). The Payment_Service /
//                     poller cycle is resolved with a deferred reference so each
//                     can call the other.
//   7. Auth         - createAdminAuth(storage) + createApiKeyManager(storage).
//   8. Routes       - payments.routes (API-key preHandler on /payment*) and
//                     admin.routes (Admin session).
//   9. Errors       - a root error handler that renders the central error map
//                     shape.
//
// Credentials and secrets are read from the environment (.env via dotenv). Every
// constructed collaborator can be overridden through `buildServer(options)` so
// tests can inject fakes (and skip the network/GoBiz entirely).

import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import Fastify from 'fastify';

import { createDal, DEFAULT_DB_PATH } from './dal/index.js';
import { createConfigService } from './config/runtime-config.js';
import { HttpTransport } from './gobiz/http-transport.js';
import { createTokenStore } from './gobiz/token-store.js';
import { createAuthTokenManager } from './gobiz/auth-token-manager.js';
import { createGoBizClient } from './gobiz/gobiz-client.js';
import { createWebhookDispatcher } from './webhook/webhook-dispatcher.js';
import { createPaymentService } from './payment/payment-service.js';
import { createSharedPoller } from './poller/shared-poller.js';
import { createEventBus } from './events/event-bus.js';
import { createAdminAuth } from './auth/admin-auth.js';
import { createApiKeyManager } from './auth/api-key-management.js';
import { hashPasswordSync } from './auth/hashing.js';
import { generateQrisImage } from './payment/qris-builder.js';
import paymentsRoutes from './routes/payments.routes.js';
import adminRoutes from './routes/admin.routes.js';
import { createErrorHandler } from './errors.js';

// Load .env into process.env. dotenv does not override variables that are
// already set, so an injected test environment always wins.
dotenv.config();

/**
 * The default Fastify (pino) logger configuration.
 *
 * Logging was previously disabled (`logger: false`), which silently swallowed
 * every `request.log?.error?.(...)` call in the error handlers. Enabling pino
 * gives structured, request-id-correlated logs — essential for diagnosing
 * payment/webhook failures in production. Sensitive headers and fields are
 * redacted so secrets never reach the log sink.
 *
 * The level is taken from `LOG_LEVEL` (default `info`).
 *
 * @returns {{ level: string, redact: { paths: string[], remove: boolean } }}
 */
function defaultLoggerConfig() {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        'body.webhook_url',
        'body.password',
      ],
      remove: true,
    },
  };
}

/**
 * Default webhook delivery-log retention: 30 days. The prune pass deletes rows
 * whose `last_attempt_at` is older than this. Tunable via
 * `WEBHOOK_LOG_RETENTION_DAYS` (an integer number of days; non-positive values
 * fall back to the default, effectively disabling pruning only when set to 0).
 *
 * @type {number}
 */
const DEFAULT_WEBHOOK_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Upper bound on how long the readiness probe waits for a storage `ping()` to
 * resolve. Keeps `/health/ready` snappy even when the backend is slow to
 * respond, so the supervisor does not time out first.
 *
 * @type {number}
 */
const HEALTH_PING_TIMEOUT_MS = 3000;

/**
 * Resolve with the result of `promise`, but reject with a `TimeoutError` if it
 * does not settle within `ms` milliseconds. Used by the readiness probe so a
 * hung storage backend cannot hang the health check.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return promise;
  }
  let handle;
  const timeout = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new Error('storage ping timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (handle !== undefined) {
      clearTimeout(handle);
    }
  });
}

/**
 * Parse the `WEBHOOK_LOG_RETENTION_DAYS` env var into a retention window in
 * milliseconds. A missing or non-positive value falls back to `defaultMs`.
 *
 * @param {string|undefined} raw
 * @param {number} defaultMs
 * @returns {number}
 */
function parseRetentionMs(raw, defaultMs) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return defaultMs;
  }
  return n * 24 * 60 * 60 * 1000;
}

/**
 * Resolve the Fastify `logger` option for {@link buildServer}.
 *
 * Precedence (highest first):
 *   1. An explicit `logger` key in the caller's `fastifyOptions` (lets tests,
 *      operators, or alternate entry points force-enable or force-disable).
 *   2. `LOG_LEVEL` if set in the environment (explicit opt-in to logging even
 *      under NODE_ENV=test, useful for debugging a single test).
 *   3. `false` when `NODE_ENV === 'test'` (keeps the suite's stdout clean).
 *   4. The {@link defaultLoggerConfig} (production default: redacted pino).
 *
 * @param {{ logger?: unknown }} fastifyOptions
 * @returns {unknown}
 */
function resolveLoggerConfig(fastifyOptions) {
  if ('logger' in fastifyOptions) {
    return fastifyOptions.logger;
  }
  if (process.env.LOG_LEVEL !== undefined) {
    return defaultLoggerConfig();
  }
  if (process.env.NODE_ENV === 'test') {
    return false;
  }
  return defaultLoggerConfig();
}

/**
 * Install the canonical Fastify error handler (see {@link createErrorHandler}).
 *
 * @param {import('fastify').FastifyInstance} app
 */
function installErrorHandler(app) {
  app.setErrorHandler(createErrorHandler());
}

/**
 * Ensure a single Admin user exists so the Panel can be logged into. Seeding is
 * performed through the storage-agnostic `adminUsers.ensure()` operation: an
 * idempotent insert-if-absent that does NOT change the password of an existing
 * user when the environment values change. The password is stored only as a
 * scrypt hash.
 *
 * Seeding runs for every backend (SQLite or MongoDB); there is no longer a
 * direct database connection opened from here, so the in-memory SQLite
 * short-circuit the previous implementation needed is gone.
 *
 * @param {import('./dal/storage-interface.js').Storage} storage
 * @param {{ username?: string, password?: string }} params
 * @param {Pick<Console, 'log' | 'warn'>} [logger]
 * @returns {Promise<boolean>} whether a user was seeded.
 */
export async function seedAdminUser(storage, params, logger = console) {
  const { username, password } = params;
  if (!username || !password) {
    return false;
  }
  const result = await storage.adminUsers.ensure({
    id: randomUUID(),
    username,
    passwordHash: hashPasswordSync(password),
  });
  if (result.ok && result.value?.created) {
    logger?.log?.(`[server] Seeded the initial admin user '${username}'.`);
    return true;
  }
  return false;
}

/**
 * @typedef {Object} BuildServerOptions
 * @property {string} [dbPath] - SQLite path (':memory:' for tests). Defaults to
 *   {@link DEFAULT_DB_PATH}.
 * @property {import('./dal/storage-interface.js').Storage} [storage] - inject a
 *   DAL (skips creating one from `dbPath`).
 * @property {object} [config] - inject a Config Service.
 * @property {object} [gobizClient] - inject a GoBiz client (skips the transport/
 *   auth/token wiring and avoids any network use in tests).
 * @property {object} [paymentService] - inject a Payment_Service.
 * @property {object} [webhookDispatcher] - inject a Webhook_Dispatcher.
 * @property {object} [poller] - inject a Shared_Poller.
 * @property {object} [adminAuth] - inject an Admin_Auth facade.
 * @property {object} [apiKeyManager] - inject an API-key manager.
 * @property {string} [sessionSecret] - HMAC secret for Admin sessions; defaults
 *   to `process.env.ADMIN_SESSION_SECRET`.
 * @property {boolean} [secureCookies] - mark session cookies `Secure`; defaults
 *   to `NODE_ENV === 'production'`.
 * @property {boolean} [seedAdmin] - seed the admin user from env; defaults true.
 * @property {boolean} [startPoller] - call `poller.ensureRunning()` after build;
 *   defaults false (the Payment_Service starts it on the first create).
 * @property {boolean} [prewarmGobiz] - eagerly log in and resolve the merchant
 *   id in the background after build, so the first poll does not pay the cold
 *   init cost. Defaults false; the real `startServer()` sets it true. Kept off
 *   for tests so `buildServer()` never touches the network on its own.
 * @property {object} [fastifyOptions] - extra options passed to Fastify.
 */

/**
 * Build and fully wire the Fastify server without listening.
 *
 * @param {BuildServerOptions} [options]
 * @returns {Promise<import('fastify').FastifyInstance>} the configured instance,
 *   decorated with the constructed collaborators (`storage`, `configService`,
 *   `paymentService`, `poller`) for inspection and graceful shutdown.
 */
export async function buildServer(options = {}) {
  const dbPath = options.dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;

  // 1) DAL. `createDal` is awaitable so backend startup (MongoDB index creation,
  // connection establishment) completes before the server accepts traffic.
  const ownsStorage = !options.storage;
  const storage = options.storage ?? (await createDal({ dbPath }));

  // 2) Config Service.
  const config = options.config ?? createConfigService(storage);

  // 3) GoBiz Integration Layer (only built when not injected, so tests that
  //    inject a poller/gobizClient never touch the network).
  const ownsGobiz = !options.gobizClient;
  let gobizClient = options.gobizClient ?? null;
  if (!gobizClient) {
    const transport = new HttpTransport();
    const tokenStore = createTokenStore({
      filePath: process.env.TOKEN_FILE_PATH,
    });
    const auth = createAuthTokenManager(transport, tokenStore, {
      email: process.env.GOPAY_EMAIL,
      password: process.env.GOPAY_PASSWORD,
    });
    gobizClient = createGoBizClient({ transport, auth, config });
  }

  // 4) Webhook_Dispatcher (wired as the Payment_Service onSettled hook).
  const webhookDispatcher =
    options.webhookDispatcher ??
    createWebhookDispatcher({
      webhookLogs: storage.webhookLogs,
      config: storage.config,
      hmacKey: process.env.WEBHOOK_HMAC_KEY,
    });

  // 4b) Realtime event bus (in-process pub/sub) for the panel's SSE stream.
  //     Publishing is fire-and-forget and never blocks the settlement pipeline.
  const events = options.events ?? createEventBus();

  // 5) + 6) Payment_Service and Shared_Poller form a cycle (each references the
  //    other). Resolve it with a deferred `poller` reference.
  /** @type {{ ensureRunning?: () => void, setInterval?: (ms: number) => void, stop?: () => void }|null} */
  let poller = options.poller ?? null;

  const paymentService =
    options.paymentService ??
    createPaymentService({
      storage,
      config,
      ensureRunning: () => {
        // `ensureRunning` now returns a Promise (the active-count read is
        // async). The Payment_Service calls this hook fire-and-forget, so the
        // Promise must never float an unhandled rejection: attach a catch.
        if (poller && typeof poller.ensureRunning === 'function') {
          Promise.resolve(poller.ensureRunning()).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn(`[server] Poller failed to start: ${err?.message ?? err}`);
          });
        }
      },
      onSettled: (payment) => {
        events.emitPayment('paid', payment);
        return webhookDispatcher.dispatch(payment, { event: 'paid' });
      },
      onExpired: (payment) => {
        events.emitPayment('expired', payment);
        return webhookDispatcher.dispatch(payment, { event: 'expired' });
      },
      onCreated: (payment) => events.emitPayment('created', payment),
    });

  if (!poller) {
    poller = createSharedPoller(gobizClient, {
      getActiveCount: () => storage.payments.countActive(),
      onTransactions: (transactions) => paymentService.handleTransactions(transactions),
      getPollInterval: () => config.getPollInterval(),
      // Fire the first poll right after a payment is created instead of waiting
      // a full Poll_Interval, so the gap between create and the first fetch is
      // minimized (mitigates the poller "warm-up" window).
      pollImmediately: true,
      // Once-daily housekeeping: prune webhook delivery-log rows older than the
      // retention window so the table cannot grow without bound. Rides the poll
      // tick (no extra timer) and is best-effort; a throw is logged by the
      // poller, not fatal. The callback is async and awaits the (async) prune
      // so the removal count is logged and a MongoDB write failure is caught by
      // the poller's maintenance guard instead of becoming an unhandled
      // rejection.
      onMaintenance: async () => {
        const retentionMs = parseRetentionMs(
          process.env.WEBHOOK_LOG_RETENTION_DAYS,
          DEFAULT_WEBHOOK_LOG_RETENTION_MS,
        );
        if (typeof storage.webhookLogs?.pruneOld === 'function') {
          const cutoff = Date.now() - retentionMs;
          const removed = await storage.webhookLogs.pruneOld(cutoff);
          if (removed > 0) {
            // eslint-disable-next-line no-console
            console.log(`[server] Pruned ${removed} webhook delivery-log rows older than ${Math.round(retentionMs / (24 * 60 * 60 * 1000))} day(s).`);
          }
        }
      },
    });
  }

  // 7) Auth.
  const secureCookies = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const adminAuth =
    options.adminAuth ??
    createAdminAuth(storage, {
      secret: options.sessionSecret ?? process.env.ADMIN_SESSION_SECRET,
      secure: secureCookies,
    });
  const apiKeyManager = options.apiKeyManager ?? createApiKeyManager(storage);

  // Seed the initial admin user from the environment. Idempotent: an existing
  // user is left untouched (the password is NOT overwritten by env changes).
  if (options.seedAdmin !== false) {
    await seedAdminUser(storage, {
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD,
    });
  }

  // 8) Build Fastify and register routes. The default logger is enabled in
  //    production; under NODE_ENV=test it is disabled by default so test output
  //    stays clean. Either path can be overridden via fastifyOptions.logger.
  const fastifyOptions = options.fastifyOptions ?? {};
  const loggerConfig = resolveLoggerConfig(fastifyOptions);
  const app = Fastify({ logger: loggerConfig, trustProxy: true, ...fastifyOptions });

  installErrorHandler(app);

  // Health endpoints for liveness and readiness probes.
  //
  //   /health/live  — process liveness. Always 200 while the event loop turns.
  //                   Never touches storage so a backend hiccup cannot make the
  //                   process look dead to the supervisor.
  //   /health/ready — storage readiness. Calls `storage.ping()` with a bounded
  //                   timeout and reports 503 when the backend is unreachable,
  //                   so a deploying or unhealthy instance stops receiving
  //                   traffic until it recovers.
  //   /health       — kept as a back-compat alias of /health/ready for existing
  //                   supervisors configured before /health/ready was added.
  //
  // None of these endpoints depend on GoBiz authentication or payment state.
  app.get('/health/live', async (_req, reply) => {
    return reply.code(200).send({ status: 'ok' });
  });

  /**
   * Bound a storage `ping()` call so a stuck backend cannot hang the readiness
   * probe indefinitely. Resolves `{ ok: true }` on success and
   * `{ ok: false, error }` on failure or timeout.
   *
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function boundedPing() {
    if (!storage || typeof storage.ping !== 'function') {
      return { ok: true };
    }
    try {
      await withTimeout(storage.ping(), HEALTH_PING_TIMEOUT_MS);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const readinessHandler = async (_req, reply) => {
    const probe = await boundedPing();
    if (probe.ok) {
      return reply.code(200).send({ status: 'ok' });
    }
    // 503 with no credentials/connection details — just a generic message.
    return reply.code(503).send({ status: 'unavailable' });
  };
  app.get('/health/ready', readinessHandler);
  app.get('/health', readinessHandler);

  // Machine-facing payment routes; the plugin attaches the API-key preHandler
  // on its own scope, so every /payment* route is API-key protected.
  await app.register(paymentsRoutes, { paymentService, storage, configService: config, generateQrisImage });

  // Panel-facing admin routes guarded by the Admin session.
  await app.register(adminRoutes, {
    adminAuth,
    apiKeyManager,
    configService: config,
    poller,
    paymentService,
    generateQrisImage,
    storage,
    gobizClient,
    webhookDispatcher,
    events,
  });

  // Expose collaborators for inspection and graceful shutdown.
  app.decorate('storage', storage);
  app.decorate('configService', config);
  app.decorate('paymentService', paymentService);
  app.decorate('poller', poller);

  // Stop the poller and (when we created it) close the DAL on shutdown.
  // `storage.close()` is awaitable and idempotent, so a second shutdown signal
  // (e.g. SIGINT right after SIGTERM) is a safe no-op.
  app.addHook('onClose', async () => {
    if (poller && typeof poller.stop === 'function') {
      // `stop()` is async: it drains any in-flight reschedule so a concurrent
      // schedule cannot resurrect a timer after shutdown.
      await poller.stop();
    }
    if (ownsStorage && typeof storage.close === 'function') {
      await storage.close();
    }
  });

  if (options.startPoller && poller && typeof poller.ensureRunning === 'function') {
    await poller.ensureRunning();
  }

  // Pre-warm the GoBiz Integration Layer in the background (only when explicitly
  // requested via `prewarmGobiz` AND we built the client ourselves, so tests that
  // call buildServer() never touch the network). This logs in and resolves the
  // merchant id up front so the FIRST poll after a payment is created does not
  // pay the cold login + merchant-resolution cost (3-5s). It is fire-and-forget
  // and non-blocking: buildServer returns immediately, and if the warm-up fails
  // the first real poll simply performs init() as before.
  if (options.prewarmGobiz && ownsGobiz && gobizClient && typeof gobizClient.init === 'function') {
    Promise.resolve()
      .then(() => gobizClient.init())
      .then(() => {
        // eslint-disable-next-line no-console
        console.log('[server] GoBiz client pre-warmed (token and merchant ready).');
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[server] GoBiz pre-warm failed (will retry on the first poll): ${err?.message ?? err}`,
        );
      });
  }

  return app;
}

/**
 * Start the server: build it, begin polling, and listen on the configured host
 * and port. Installs `SIGTERM` and `SIGINT` handlers that call and await
 * `app.close()` so shutdown stops the poller and closes owned storage safely.
 * Used only when this file is run directly.
 *
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function startServer() {
  const app = await buildServer({ startPoller: true, prewarmGobiz: true });
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  await app.listen({ port, host });
  // eslint-disable-next-line no-console
  console.log(`[server] Listening on http://${host}:${port}`);

  /** Track shutdown so a second signal is a hard exit, not a second graceful drain. */
  let shuttingDown = false;
  const gracefulShutdown = (signal) => {
    if (shuttingDown) {
      // eslint-disable-next-line no-console
      console.log(`[server] Received ${signal} again; forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[server] Received ${signal}; shutting down gracefully.`);
    app.close().then(
      () => {
        // eslint-disable-next-line no-console
        console.log('[server] Closed.');
        process.exit(0);
      },
      (err) => {
        // eslint-disable-next-line no-console
        console.error('[server] Error during shutdown:', err);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return app;
}

// Only listen when executed directly (so importing buildServer in tests does
// not bind a port).
const isRunDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isRunDirectly) {
  startServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[server] Failed to start:', err);
    process.exitCode = 1;
  });
}

export default buildServer;
