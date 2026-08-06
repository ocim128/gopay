// Admin/Panel routes: login, logout, API-key management, and Config.
//
// This module is a Fastify plugin (`adminRoutes(fastify, opts)`) that registers
// the Panel-facing endpoints of the system. Every collaborator is injected
// through `opts` so the plugin is fully testable in isolation (with real DAL-
// backed services or fakes) and never constructs its own dependencies:
//
//   * `adminAuth`      - the Admin authentication facade (src/auth/admin-auth.js):
//                        `login`, `validateSession`, `isAuthenticated`,
//                        `buildCookie`, `buildClearedCookie`. Owns the 24h
//                        httpOnly session and the login rate-limit.
//   * `apiKeyManager`  - API-key management (src/auth/api-key-management.js):
//                        `createApiKey` (reveal once), `listApiKeys` (masked),
//                        `revokeApiKey`.
//   * `configService`  - the Config Service (src/config/runtime-config.js):
//                        get/set `poll_interval`, default `webhook_url`, and
//                        `static_qris`, validating on set.
//   * `poller`         - the Shared_Poller; when the `poll_interval` is changed
//                        successfully its `setInterval(ms)` is called so the new
//                        cadence applies within <= 5s. Optional.
//   * `paymentService` + `generateQrisImage` - OPTIONAL. When both are provided
//                        an admin-session-guarded `GET /admin/payments/:id/qris.png`
//                        is registered (see the security note below).
//   * `storage`        - OPTIONAL. The DAL. When provided (and it exposes
//                        `payments.listHistory`) the admin-session-guarded
//                        `GET /admin/payments/history?limit=&offset=` endpoint is
//                        registered for the Panel history page.
//   * `cookieName`     - the session cookie name to read; defaults to the
//                        Admin_Auth default.
//
// AUTHENTICATION: the login/logout endpoints are public; all
// other admin endpoints are guarded by an `requireAdmin` preHandler that reads
// the httpOnly session cookie and rejects an absent/invalid/expired session with
// HTTP 401. (For a browser the Panel turns a 401 on a protected page into a
// redirect to /login; the API itself answers 401 so machine callers get a clear
// status.)
//
// SECURITY NOTE — QRIS image embedding: the machine-facing
// `GET /payment/:id/qris.png` (payments.routes.js) is protected by the API key,
// which a browser `<img src>` cannot send. So the Panel cannot embed that URL
// directly. Rather than dropping authentication on the machine endpoint, this
// module optionally exposes the QRIS image under the Admin session at
// `GET /admin/payments/:id/qris.png`: the browser sends the httpOnly session
// cookie automatically with the `<img>` request, so the image stays protected
// (by the Admin session instead of the API key) without weakening the public
// API. The route is only registered when `paymentService` and
// `generateQrisImage` are injected.

import { buildErrorResponse } from '../errors.js';
import { SESSION_COOKIE_NAME } from '../auth/admin-auth.js';
import {
  ConfigValidationError,
  validatePollInterval,
  validateWebhookUrl,
  validateStaticQrisValue,
  validateDisplayTimezone,
} from '../config/runtime-config.js';
import { wallClockToEpochMs } from '../time.js';

/**
 * Map an Admin_Auth login failure code to an HTTP status. Empty fields are a
 * bad request; a generic credential failure is 401; a
 * rate-limit lockout is 429.
 *
 * @param {string} code
 * @returns {number}
 */
function loginFailureStatus(code) {
  switch (code) {
    case 'MISSING_CREDENTIALS':
      return 400;
    case 'ACCOUNT_LOCKED':
      return 429;
    case 'INVALID_CREDENTIALS':
    default:
      return 401;
  }
}

/**
 * Parse a `Cookie` request header into a name -> value map. Returns an empty
 * object when the header is absent or malformed. `@fastify/cookie` is not a
 * project dependency, so the parsing is done here against the raw header.
 *
 * @param {string|undefined} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  /** @type {Record<string, string>} */
  const out = {};
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return out;
  }
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (name.length === 0) {
      continue;
    }
    const value = part.slice(eq + 1).trim();
    // Only record the first occurrence of a given cookie name.
    if (!(name in out)) {
      out[name] = value;
    }
  }
  return out;
}

/**
 * Default and maximum page sizes for the admin payment history endpoint. The
 * Panel history page paginates 50 entries per page; the
 * maximum bounds how much a caller can request in one page.
 *
 * @type {number}
 */
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 100;

/**
 * Parse and clamp `limit`/`offset` query parameters for the history endpoint.
 * An absent/invalid `limit` falls back to {@link HISTORY_DEFAULT_LIMIT} and is
 * clamped to 1..{@link HISTORY_MAX_LIMIT}; an absent/invalid `offset` falls back
 * to 0.
 *
 * @param {Record<string, unknown>|undefined} query
 * @returns {{ limit: number, offset: number }}
 */
function parseHistoryPagination(query) {
  const rawLimit = Number(query?.limit);
  let limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? rawLimit : HISTORY_DEFAULT_LIMIT;
  if (limit > HISTORY_MAX_LIMIT) {
    limit = HISTORY_MAX_LIMIT;
  }

  const rawOffset = Number(query?.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  return { limit, offset };
}

/**
 * The payment statuses a caller may filter by on the admin payments list. Any
 * other value is treated as "no filter" (all statuses).
 *
 * @type {ReadonlySet<string>}
 */
const ALLOWED_PAYMENT_STATUSES = new Set(['pending', 'paid', 'expired']);

/**
 * Default and maximum page sizes for the admin payments list endpoint.
 *
 * @type {number}
 */
const PAYMENTS_DEFAULT_LIMIT = 50;
const PAYMENTS_MAX_LIMIT = 100;

/**
 * Default and clamp bounds for the admin transactions endpoint `days`/`size`.
 *
 * @type {number}
 */
const TRANSACTIONS_DEFAULT_DAYS = 7;
const TRANSACTIONS_MIN_DAYS = 1;
const TRANSACTIONS_MAX_DAYS = 30;
const TRANSACTIONS_DEFAULT_SIZE = 50;
const TRANSACTIONS_MIN_SIZE = 1;
const TRANSACTIONS_MAX_SIZE = 100;

/**
 * Clamp an integer-ish value into `[min, max]`, falling back to `fallback` when
 * the value is not a positive integer.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    return n > max ? max : fallback;
  }
  return n > max ? max : n;
}

/**
 * Parse and clamp `limit`/`offset` query parameters for the payments list
 * endpoint. An absent/invalid `limit` falls back to {@link PAYMENTS_DEFAULT_LIMIT}
 * clamped to 1..{@link PAYMENTS_MAX_LIMIT}; an absent/invalid `offset` falls back
 * to 0.
 *
 * @param {Record<string, unknown>|undefined} query
 * @returns {{ limit: number, offset: number }}
 */
function parsePaymentsPagination(query) {
  const rawLimit = Number(query?.limit);
  let limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? rawLimit : PAYMENTS_DEFAULT_LIMIT;
  if (limit > PAYMENTS_MAX_LIMIT) {
    limit = PAYMENTS_MAX_LIMIT;
  }

  const rawOffset = Number(query?.offset);
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  return { limit, offset };
}

/**
 * Fastify plugin registering the Admin/Panel endpoints.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{
 *   adminAuth: {
 *     login: (username: string, password: string, ipAddress: string) => Promise<{ ok: true, cookie: string, session: { expiresAt: number } } | { ok: false, code: string, message: string }>,
 *     isAuthenticated: (token: string, now?: number) => boolean,
 *     buildClearedCookie: () => string,
 *   },
 *   apiKeyManager: {
 *     createApiKey: () => object,
 *     listApiKeys: () => object[],
 *     revokeApiKey: (id: string) => { ok: boolean, value?: object, code?: string },
 *   },
 *   configService: {
 *     getPollInterval: () => Promise<number>,
 *     setPollInterval: (value: unknown) => Promise<number>,
 *     getDefaultWebhookUrl: () => Promise<(string|null)>,
 *     setDefaultWebhookUrl: (value: unknown) => Promise<string>,
 *     getStaticQris: () => Promise<(string|null)>,
 *     setStaticQris: (value: unknown) => Promise<string>,
 *     getDisplayTimezone: () => Promise<string>,
 *     setDisplayTimezone: (value: unknown) => Promise<string>,
 *   },
 *   poller?: { setInterval?: (ms: number) => void },
 *   paymentService?: { getPayment: (id: string) => Promise<(object|null)> },
 *   generateQrisImage?: (qrisString: string) => Promise<Buffer>,
 *   storage?: import('../dal/storage-interface.js').Storage,
 *   gobizClient?: { getRecentTransactions: (params: { days: number, size: number }) => Promise<object[]> },
 *   webhookDispatcher?: { dispatch: (payment: object) => Promise<object>, dispatchOnce?: (payment: object) => Promise<object> },
 *   events?: { subscribe: (listener: (event: object) => void) => (() => void) },
 *   cookieName?: string,
 * }} opts
 * @returns {Promise<void>}
 */
export default async function adminRoutes(fastify, opts = {}) {
  const {
    adminAuth,
    apiKeyManager,
    configService,
    poller,
    paymentService,
    storage,
    gobizClient,
    webhookDispatcher,
    events,
  } = opts;

  if (!adminAuth || typeof adminAuth.login !== 'function' || typeof adminAuth.isAuthenticated !== 'function') {
    throw new TypeError('adminRoutes requires an adminAuth instance.');
  }
  if (!apiKeyManager || typeof apiKeyManager.createApiKey !== 'function') {
    throw new TypeError('adminRoutes requires an apiKeyManager instance.');
  }
  if (!configService || typeof configService.getPollInterval !== 'function') {
    throw new TypeError('adminRoutes requires a configService instance.');
  }

  const cookieName = opts.cookieName ?? SESSION_COOKIE_NAME;
  const generateQrisImage =
    typeof opts.generateQrisImage === 'function' ? opts.generateQrisImage : null;

  /**
   * Read the Admin session token from the httpOnly session cookie.
   *
   * @param {import('fastify').FastifyRequest} request
   * @returns {string|null}
   */
  function readSessionToken(request) {
    const cookies = parseCookies(request.headers?.cookie);
    const token = cookies[cookieName];
    return typeof token === 'string' && token.length > 0 ? token : null;
  }

  /**
   * Snapshot the current Config as the response body shared by `GET` and the
   * update handler.
   *
   * @returns {Promise<{ poll_interval: number, webhook_url: (string|null), static_qris: (string|null), display_timezone: string }>}
   */
  async function currentConfig() {
    return {
      poll_interval: await configService.getPollInterval(),
      webhook_url: await configService.getDefaultWebhookUrl(),
      static_qris: await configService.getStaticQris(),
      display_timezone: await configService.getDisplayTimezone(),
    };
  }

  // ── Public: POST /admin/login ──────────────────────────────────────────────
  // Authenticate and, on success, set the httpOnly session cookie.
  fastify.post('/admin/login', async (request, reply) => {
    const body = request.body ?? {};
    const ipAddress = request.ip || '0.0.0.0';
    const result = await adminAuth.login(body.username, body.password, ipAddress);

    if (!result.ok) {
      // A generic message is preserved for credential failures.
      return reply
        .code(loginFailureStatus(result.code))
        .send({ error_code: result.code, message: result.message });
    }

    return reply
      .header('set-cookie', result.cookie)
      .code(200)
      .send({ ok: true, expires_at: result.session.expiresAt });
  });

  // ── Public: POST /admin/logout ─────────────────────────────────────────────
  // Clear the session cookie. Always succeeds (idempotent).
  fastify.post('/admin/logout', async (_request, reply) => {
    return reply.header('set-cookie', adminAuth.buildClearedCookie()).code(200).send({ ok: true });
  });

  // ── Protected scope: everything below requires a valid Admin session ───────
  await fastify.register(async (protectedScope) => {
    // Deny unauthenticated/expired requests with HTTP 401.
    protectedScope.addHook('preHandler', async (request, reply) => {
      const token = readSessionToken(request);
      if (token === null || !adminAuth.isAuthenticated(token)) {
        return reply.code(401).send(buildErrorResponse('UNAUTHORIZED'));
      }
    });

    // ── POST /admin/api-keys ────────────────────────────────────────────────
    // Create a key; the full value is revealed exactly once.
    protectedScope.post('/admin/api-keys', async (_request, reply) => {
      const created = await apiKeyManager.createApiKey();
      return reply.code(201).send(created);
    });

    // ── GET /admin/api-keys ─────────────────────────────────────────────────
    // List keys in masked form only — never the hash or full value.
    protectedScope.get('/admin/api-keys', async (_request, reply) => {
      return reply.code(200).send(await apiKeyManager.listApiKeys());
    });

    // ── POST /admin/api-keys/:id/revoke ─────────────────────────────────────
    // Revoke an active key; a missing/already-revoked key is rejected
    // and nothing is modified.
    protectedScope.post('/admin/api-keys/:id/revoke', async (request, reply) => {
      const { id } = request.params;
      const result = await apiKeyManager.revokeApiKey(id);
      if (!result.ok) {
        return reply.code(404).send({
          error_code: result.code ?? 'KEY_NOT_REVOCABLE',
          message: 'The API key does not exist or is already revoked.',
        });
      }
      return reply.code(200).send(result.value);
    });

    // ── GET /admin/config ───────────────────────────────────────────────────
    protectedScope.get('/admin/config', async (_request, reply) => {
      return reply.code(200).send(await currentConfig());
    });

    // ── PUT/POST /admin/config ──────────────────────────────────────────────
    // Update any subset of poll_interval / webhook_url / static_qris. Every
    // supplied field is validated up front; if ANY is invalid the whole update
    // is rejected with HTTP 400 and nothing is written, so the previous values
    // are retained. On a successful poll_interval change
    // the poller is rescheduled so the new cadence applies within <= 5s.
    const updateConfig = async (request, reply) => {
      const body = request.body ?? {};

      /** @type {{ poll_interval?: number, webhook_url?: string, static_qris?: string, display_timezone?: string }} */
      const validated = {};
      try {
        if (body.poll_interval !== undefined) {
          validated.poll_interval = validatePollInterval(body.poll_interval);
        }
        if (body.webhook_url !== undefined) {
          validated.webhook_url = validateWebhookUrl(body.webhook_url);
        }
        if (body.static_qris !== undefined) {
          validated.static_qris = validateStaticQrisValue(body.static_qris);
        }
        if (body.display_timezone !== undefined) {
          validated.display_timezone = validateDisplayTimezone(body.display_timezone);
        }
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          return reply.code(err.http).send({ error_code: err.code, message: err.message });
        }
        throw err;
      }

      // All supplied values are valid: persist them.
      if (validated.poll_interval !== undefined) {
        const stored = await configService.setPollInterval(validated.poll_interval);
        // Apply the new cadence immediately.
        if (poller && typeof poller.setInterval === 'function') {
          poller.setInterval(stored);
        }
      }
      if (validated.webhook_url !== undefined) {
        await configService.setDefaultWebhookUrl(validated.webhook_url);
      }
      if (validated.static_qris !== undefined) {
        await configService.setStaticQris(validated.static_qris);
      }
      if (validated.display_timezone !== undefined) {
        await configService.setDisplayTimezone(validated.display_timezone);
      }

      return reply.code(200).send(await currentConfig());
    };

    protectedScope.put('/admin/config', updateConfig);
    protectedScope.post('/admin/config', updateConfig);

    // ── GET /admin/merchant/info ────────────────────────────────────────────
    if (gobizClient && typeof gobizClient.getMerchantProfile === 'function') {
      protectedScope.get('/admin/merchant/info', async (request, reply) => {
        let profile = gobizClient.getMerchantProfile();
        if (!profile && typeof gobizClient.getMerchantId === 'function') {
          try {
            await gobizClient.getMerchantId();
            profile = gobizClient.getMerchantProfile();
          } catch (err) {
            return reply.code(500).send({ error_code: 'INTERNAL_ERROR', message: err.message });
          }
        }
        if (!profile) {
          return reply.code(404).send({ error_code: 'NOT_FOUND', message: 'Merchant profile not found' });
        }
        
        const cleanProfile = {
          // Owner Info
          owner_name: profile.id_name || profile.director_name,
          id_number: profile.id_number,
          email: profile.email,
          phone: profile.phone,
          address: profile.id_address,
          
          // Outlet/Merchant Info
          merchant_name: profile.merchant_name,
          id: profile.id,
          outlet_address: profile.outlet_address,
          postal_code: profile.outlet_postal_code,

          // QRIS & ASPI Info
          category: profile.aspi?.merchant_criteria,
          nmid: profile.aspi?.nmid,
          mpan: profile.aspi?.mpan,
          mcc: profile.aspi?.mcc,
          terminal_id: profile.pops?.[0]?.gopay?.aspi_terminal_id,
          qris_string: profile.pops?.[0]?.gopay?.aspi_qr_string,

          // Bank Account
          bank_name: profile.bank_account?.bank_name,
          account_name: profile.bank_account?.account_name,
          account_no: profile.bank_account?.account_no,
          settlement_time: profile.settlement_time,
        };
        
        return reply.code(200).send(cleanProfile);
      });
    }

    // ── GET /admin/payments/history ─────────────────────────────────────────
    // Paginated list of terminal-state payments (paid/expired), most recent
    // first, for the Panel history page. The page size
    // defaults to 50 and is bounded to a sane maximum; the data comes from the
    // DAL's `payments.listHistory`. Registered only when a storage with a
    // `listHistory` method is injected.
    if (storage && storage.payments && typeof storage.payments.listHistory === 'function') {
      protectedScope.get('/admin/payments/history', async (request, reply) => {
        const { limit, offset } = parseHistoryPagination(request.query);
        const payments = await storage.payments.listHistory({ limit, offset });
        return reply.code(200).send(payments);
      });
    }

    // ── GET /admin/payments?status=&limit=&offset= ──────────────────────────
    // Paginated list of payments across every status (or a single status when
    // a valid `status` filter is supplied). Returns the full payment rows plus
    // the total count for the active filter so the Panel can paginate. An
    // unrecognized `status` is ignored and treated as "all statuses".
    if (
      storage &&
      storage.payments &&
      typeof storage.payments.listAll === 'function' &&
      typeof storage.payments.countAll === 'function'
    ) {
      protectedScope.get('/admin/payments', async (request, reply) => {
        const { limit, offset } = parsePaymentsPagination(request.query);
        const rawStatus = request.query?.status;
        const status = ALLOWED_PAYMENT_STATUSES.has(rawStatus) ? rawStatus : undefined;
        
        const id = request.query?.id || undefined;
        let date = undefined;
        const dateStr = request.query?.date;
        if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
          // Parse the YYYY-MM-DD wall-clock in the display timezone and produce
          // a [start-of-day, start-of-next-day) epoch-ms range, honouring the
          // zone's offset (and DST) for that date.
          const tz = await configService.getDisplayTimezone();
          const [yStr, mStr, dStr] = dateStr.split('-');
          const y = Number(yStr);
          const mo = Number(mStr);
          const d = Number(dStr);
          const start = wallClockToEpochMs(y, mo, d, 0, 0, 0, tz);
          const end = wallClockToEpochMs(y, mo, d + 1, 0, 0, 0, tz);
          date = { start, end };
        }

        const payments = await storage.payments.listAll({ status, limit, offset, id, date });
        const total = await storage.payments.countAll({ status, id, date });
        return reply.code(200).send({ payments, total, limit, offset });
      });
    }

    // ── GET /admin/payments/:id ─────────────────────────────────────────────
    // The full payment row plus its webhook delivery logs. 404 when missing.
    if (
      storage &&
      storage.payments &&
      typeof storage.payments.getById === 'function' &&
      storage.webhookLogs &&
      typeof storage.webhookLogs.listByPayment === 'function'
    ) {
      protectedScope.get('/admin/payments/:id', async (request, reply) => {
        const payment = await storage.payments.getById(request.params.id);
        if (!payment) {
          return reply.code(404).send(buildErrorResponse('PAYMENT_NOT_FOUND'));
        }
        const webhookLogs = await storage.webhookLogs.listByPayment(request.params.id);
        return reply.code(200).send({ ...payment, webhook_logs: webhookLogs });
      });
    }

    // ── POST /admin/payments/:id/webhook/resend ─────────────────────────────
    // Re-dispatch the webhook for a terminal payment as a SINGLE attempt (no
    // retry, no backoff): one fresh hit, recording exactly one delivery-log row.
    // Allowed for `paid` and `expired` (the two terminal states); the resend
    // carries the matching event. 404 when missing; 400 when still pending; 400
    // when no webhook URL is configured.
    if (
      storage &&
      storage.payments &&
      typeof storage.payments.getById === 'function' &&
      webhookDispatcher &&
      (typeof webhookDispatcher.dispatchOnce === 'function' ||
        typeof webhookDispatcher.dispatch === 'function')
    ) {
      protectedScope.post('/admin/payments/:id/webhook/resend', async (request, reply) => {
        const payment = await storage.payments.getById(request.params.id);
        if (!payment) {
          return reply.code(404).send(buildErrorResponse('PAYMENT_NOT_FOUND'));
        }
        if (payment.status !== 'paid' && payment.status !== 'expired') {
          return reply
            .code(400)
            .send(
              buildErrorResponse(
                'INVALID_REQUEST',
                'Only paid or expired payments can resend a webhook.',
              ),
            );
        }

        // Carry the event that matches the payment's terminal state.
        const event = payment.status === 'expired' ? 'expired' : 'paid';

        // Prefer the single-attempt path; fall back to dispatch only if a
        // dispatcher without dispatchOnce was injected.
        const resendOnce =
          typeof webhookDispatcher.dispatchOnce === 'function'
            ? webhookDispatcher.dispatchOnce.bind(webhookDispatcher)
            : webhookDispatcher.dispatch.bind(webhookDispatcher);
        const result = await resendOnce(payment, { event });
        if (result && result.sent === false) {
          return reply
            .code(400)
            .send(
              buildErrorResponse(
                'INVALID_WEBHOOK_URL',
                'No webhook URL is configured for this payment.',
              ),
            );
        }
        return reply.code(200).send(result);
      });
    }

    // ── GET /admin/events ───────────────────────────────────────────────────
    // Server-Sent Events stream of payment lifecycle signals (created/paid/
    // expired). The panel subscribes and refreshes instantly instead of waiting
    // for its polling tick. Each signal is a small JSON line; the panel re-fetches
    // through the normal endpoints, so a missed event never causes stale data.
    if (events && typeof events.subscribe === 'function') {
      protectedScope.get('/admin/events', (request, reply) => {
        // Take over the raw socket; Fastify will not manage this response.
        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          // Disable proxy buffering (nginx) so events flush immediately.
          'X-Accel-Buffering': 'no',
        });
        // Advise the client's reconnect backoff and open the stream.
        reply.raw.write('retry: 3000\n\n');

        const send = (event) => {
          try {
            reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
          } catch {
            // Socket already closed; cleanup runs on the close event.
          }
        };
        const unsubscribe = events.subscribe(send);

        // Heartbeat comment keeps intermediaries from closing an idle stream.
        const heartbeat = setInterval(() => {
          try {
            reply.raw.write(': ping\n\n');
          } catch {
            // ignored
          }
        }, 25000);
        if (typeof heartbeat.unref === 'function') {
          heartbeat.unref();
        }

        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            reply.raw.end();
          } catch {
            // ignored
          }
        };
        // Sockets can emit both 'close' and 'error' on abort; guard the cleanup
        // so the second invocation is a no-op rather than re-clearing,
        // unsubscribing, and calling .end() on a finished response.
        let cleanedUp = false;
        const cleanupOnce = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          cleanup();
        };
        request.raw.on('close', cleanupOnce);
        request.raw.on('error', cleanupOnce);
      });
    }

    // ── GET /admin/merchant ─────────────────────────────────────────────────
    // The resolved merchant id/name, read from the GoBiz client's in-memory
    // cache (populated at boot pre-warm). Pure read — never triggers a network
    // call — so it is cheap to call on every page navigation for the topbar
    // summary. Returns nulls until the client has resolved the merchant.
    if (gobizClient && typeof gobizClient.getMerchantId === 'function') {
      protectedScope.get('/admin/merchant', async (_request, reply) => {
        return reply.code(200).send({
          id: gobizClient.merchantId ?? null,
          name: gobizClient.merchantName ?? null,
        });
      });
    }

    // ── GET /admin/transactions?days=&size= ─────────────────────────────────
    // Recent canonical transactions from GoBiz. A GoBiz error becomes a 502
    // rather than crashing the request.
    if (gobizClient && typeof gobizClient.getRecentTransactions === 'function') {
      protectedScope.get('/admin/transactions', async (request, reply) => {
        const days = clampInt(
          request.query?.days,
          TRANSACTIONS_DEFAULT_DAYS,
          TRANSACTIONS_MIN_DAYS,
          TRANSACTIONS_MAX_DAYS,
        );
        const size = clampInt(
          request.query?.size,
          TRANSACTIONS_DEFAULT_SIZE,
          TRANSACTIONS_MIN_SIZE,
          TRANSACTIONS_MAX_SIZE,
        );
        const offset = Math.max(0, parseInt(request.query?.offset, 10) || 0);
        const start = request.query?.start || null;
        const end = request.query?.end || null;
        const order_id = request.query?.order_id || null;
        
        const params = { days, size };
        if (start) params.start = start;
        if (end) params.end = end;
        if (order_id) params.order_id = order_id;
        if (offset > 0) params.offset = offset;

        try {
          const transactions = await gobizClient.getRecentTransactions(params);
          // The adapter attaches the upstream `total` to the returned array as a
          // side-channel property (asserted by the adapter contract tests). Read
          // it defensively: it is useful for "Page X of Y" display but is not a
          // reliable paging signal on its own (GoBiz's total can be approximate
          // or filtered), so the authoritative `hasNext` is derived from whether
          // a full page was returned.
          const total =
            Array.isArray(transactions) && typeof transactions.total === 'number'
              ? transactions.total
              : Array.isArray(transactions)
                ? transactions.length
                : 0;
          const page = Array.isArray(transactions) ? transactions : [];
          const hasNext = page.length >= size;
          return reply.code(200).send({
            transactions: page,
            total,
            size,
            hasNext,
          });
        } catch (err) {
          request.log?.error?.(err);
          return reply.code(502).send({
            error_code: 'INTERNAL_ERROR',
            message: 'Failed to fetch recent transactions from the payment provider.',
          });
        }
      });
    }

    // ── OPTIONAL: GET /admin/payments/:id/qris.png ──────────────────────────
    // Serve the QRIS image under the Admin session so the Panel can embed it via
    // <img> (the browser sends the httpOnly cookie automatically). See the
    // security note at the top of this file.
    if (paymentService && typeof paymentService.getPayment === 'function' && generateQrisImage) {
      protectedScope.get('/admin/payments/:id/qris.png', async (request, reply) => {
        const payment = await paymentService.getPayment(request.params.id);
        if (!payment) {
          return reply.code(404).send(buildErrorResponse('PAYMENT_NOT_FOUND'));
        }
        const png = await generateQrisImage(payment.qris_string);
        // Same immutability rationale as the public route; cache under the
        // Admin session (private — never shared across users by a shared cache).
        reply.header('Cache-Control', 'private, max-age=300, immutable');
        return reply.code(200).type('image/png').send(png);
      });
    }
  });
}
