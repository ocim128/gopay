// REST routes: POST /payment, GET /payment/:id, GET /payments, qris.png.
//
// This module is a Fastify plugin (an async `(fastify, opts)` function) that
// registers the machine-facing payment endpoints of the REST_API and wires them
// to the storage-agnostic collaborators that are injected through `opts`:
//
//   * `paymentService`     - the Payment_Service (createPayment / getPayment /
//                            listActive), the single owner of the Payment
//                            lifecycle.
//   * `storage`            - the DAL, used here only to build the API-key
//                            auth preHandler when one is not injected directly.
//   * `authPreHandler`     - an optional Fastify preHandler used to authenticate
//                            requests. When omitted it is built
//                            from `storage` via `createApiKeyAuthPreHandler`.
//                            Injecting it keeps the routes testable in isolation.
//   * `generateQrisImage`  - the QRIS PNG renderer; injectable for tests.
//
// Error handling contract: every error response is the
// `{ error_code, message }` shape produced by `src/errors.js`. Schema validation
// failures map to HTTP 400 / `INVALID_REQUEST`. Domain
// failures raised by the Payment_Service, the AmountAllocator, and the
// QRIS_Builder all carry a stable `.code` matching the central error map, so the
// route layer translates them uniformly without knowing their origin:
//   * INVALID_AMOUNT / AMOUNT_IN_USE              (client-managed)
//   * INVALID_BASE_AMOUNT / NO_AVAILABLE_AMOUNT   (server-managed)
//   * INVALID_WEBHOOK_URL
//   * QRIS_INVALID
//   * PAYMENT_NOT_FOUND
//
// A `poll_interval` field in the body is silently ignored: it is a server-level
// Config setting only and must never be taken from `POST /payment`.
// The request schema leaves `additionalProperties`
// enabled and the handler simply never reads it.

import { buildHttpError, getErrorDefinition, createErrorHandler } from '../errors.js';
import { createApiKeyAuthPreHandler } from '../auth/api-key-auth.js';
import { generateQrisImage as defaultGenerateQrisImage } from '../payment/qris-builder.js';
import { paymentRouteSchemas, getPaymentParamsSchema, WEBHOOK_URL_MAX_LENGTH } from './schemas.js';
import { isValidTimezone, toZonedIso, DISPLAY_TIMEZONE } from '../time.js';

function parseProviderTransaction(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Map the public amount-mode values accepted on the wire
 * (`client_managed` / `server_managed`) to the Payment_Service's internal mode
 * tokens (`client` / `server`). When `mode` is omitted the mode is inferred
 * from which amount field is present: a lone `base_amount` selects
 * server-managed, otherwise client-managed is assumed (Type 1 is the default).
 *
 * @param {Record<string, unknown>} body - the parsed request body.
 * @returns {'client'|'server'} the internal Payment_Service mode token.
 */
function resolveMode(body) {
  const raw = body?.mode;
  if (raw === 'server_managed') {
    return 'server';
  }
  if (raw === 'client_managed') {
    return 'client';
  }
  // `mode` omitted (the schema rejects any other value): infer from the fields.
  if (raw === undefined || raw === null) {
    if (body?.base_amount !== undefined && body?.amount === undefined) {
      return 'server';
    }
  }
  return 'client';
}

/**
 * Validate an optional per-Payment `webhook_url`. The value
 * must be an absolute http/https URL of at most {@link WEBHOOK_URL_MAX_LENGTH}
 * characters. Validation happens before the Payment_Service is invoked so an
 * invalid URL never creates a Payment.
 *
 * @param {unknown} value - the candidate webhook URL (may be undefined/null).
 * @returns {boolean} true when the value is absent or a valid http/https URL.
 */
function isValidWebhookUrl(value) {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > WEBHOOK_URL_MAX_LENGTH) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Send a domain error response from an error that carries a stable `.code`
 * matching the central error map. When the code is unknown the original error
 * is re-thrown so the Fastify error handler can turn it into a generic 500.
 *
 * @param {import('fastify').FastifyReply} reply
 * @param {{ code?: string, message?: string }} err
 * @returns {import('fastify').FastifyReply}
 */
function sendDomainError(reply, err) {
  const code = err?.code;
  if (typeof code === 'string') {
    try {
      getErrorDefinition(code);
    } catch {
      throw err;
    }
    const { http, body } = buildHttpError(code, err.message);
    return reply.code(http).send(body);
  }
  throw err;
}

/**
 * Build the internal endpoint URL that serves a Payment's QRIS PNG. The image
 * is rendered by an internal route (`GET /payment/:id/qris.png`) instead of
 * being uploaded to an external host.
 *
 * @param {string} id - the Payment id.
 * @returns {string} the relative URL of the QRIS image endpoint.
 */
function qrisImageUrl(id) {
  return `/payment/${encodeURIComponent(id)}/qris.png`;
}

/**
 * Return a shallow-mutable copy of a frozen route schema bundle. Fastify's
 * schema normalizer reassigns the `body`/`querystring`/`params`/`response`
 * members in place, so the frozen objects exported by `schemas.js` cannot be
 * passed directly; this hands Fastify a writable wrapper while keeping the
 * underlying schema definitions shared and unchanged.
 *
 * @param {object} schema - a frozen schema bundle from `paymentRouteSchemas`.
 * @returns {object} a writable shallow copy.
 */
function mutableSchema(schema) {
  const copy = { ...schema };
  if (copy.response) {
    copy.response = { ...copy.response };
  }
  return copy;
}

/**
 * Fastify plugin registering the machine-facing payment endpoints.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{
 *   paymentService: {
 *     createPayment: (input?: object) => Promise<import('../dal/storage-interface.js').Payment>,
 *     getPayment: (id: string) => Promise<(import('../dal/storage-interface.js').Payment|null)>,
 *     listActive: (options?: import('../dal/storage-interface.js').ListOptions) => Promise<import('../dal/storage-interface.js').Payment[]>,
 *   },
 *   storage?: import('../dal/storage-interface.js').Storage,
 *   authPreHandler?: (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => unknown,
 *   generateQrisImage?: (qrisString: string) => Promise<Buffer>,
 * }} opts
 * @returns {Promise<void>}
 */
export default async function paymentsRoutes(fastify, opts = {}) {
  const { paymentService, storage } = opts;

  if (!paymentService || typeof paymentService.createPayment !== 'function') {
    throw new TypeError('paymentsRoutes requires a paymentService instance.');
  }

  const generateImage =
    typeof opts.generateQrisImage === 'function' ? opts.generateQrisImage : defaultGenerateQrisImage;

  // The Config Service supplies the server-level default display timezone used
  // to render `_iso` fields for Payments that carry no per-Payment `tz`. It is
  // optional so the routes stay testable in isolation; when absent the
  // hard-coded {@link DISPLAY_TIMEZONE} is used as the fallback.
  const configService =
    opts.configService && typeof opts.configService.getDisplayTimezone === 'function'
      ? opts.configService
      : null;

  /**
   * Resolve the IANA timezone used to render a Payment's `_iso` fields: the
   * Payment's own `tz` when set, otherwise the server-configured default,
   * otherwise {@link DISPLAY_TIMEZONE}.
   *
   * The Config Service reads through the (async) DAL, so this is awaited.
   *
   * @param {{ tz?: string|null }} payment
   * @returns {Promise<string>}
   */
  async function resolveDisplayTz(payment) {
    if (isValidTimezone(payment?.tz)) {
      return payment.tz;
    }
    if (configService) {
      return configService.getDisplayTimezone();
    }
    return DISPLAY_TIMEZONE;
  }

  // Authenticate every request in this plugin scope with the API key. The
  // preHandler may be injected directly (tests) or built
  // from the storage's apiKeys store.
  const authPreHandler =
    typeof opts.authPreHandler === 'function'
      ? opts.authPreHandler
      : storage
        ? createApiKeyAuthPreHandler({ storage })
        : null;

  if (authPreHandler) {
    fastify.addHook('preHandler', authPreHandler);
  }

  // Translate Fastify schema-validation failures into the consistent
  // INVALID_REQUEST response. Any other error that bubbles up here is treated as
  // an internal error. Shares the canonical handler with the root server and the
  // admin routes (see errors.js).
  fastify.setErrorHandler(createErrorHandler());

  // ── POST /payment ────────────────────────────────────────────────────────
  // Create a Payment. Responds 201 with exactly
  // id, status, amount, qris_string, qris_url, expires_at; in
  // server-managed mode `amount` is the final Base_Amount + Unique_Suffix.
  fastify.post('/payment', { schema: mutableSchema(paymentRouteSchemas.createPayment) }, async (request, reply) => {
    const body = request.body ?? {};

    // Validate the per-Payment webhook URL before creating anything.
    if (!isValidWebhookUrl(body.webhook_url)) {
      const { http, body: errorBody } = buildHttpError('INVALID_WEBHOOK_URL');
      return reply.code(http).send(errorBody);
    }

    // Validate the optional per-Payment display timezone before creating
    // anything: an unknown IANA zone maps to INVALID_REQUEST (no Payment is
    // created). An absent `tz` falls back to the server default at render time.
    if (body.tz !== undefined && body.tz !== null && !isValidTimezone(body.tz)) {
      const { http, body: errorBody } = buildHttpError(
        'INVALID_REQUEST',
        'The tz field is invalid. It must be a recognized IANA timezone name, for example "Asia/Jakarta", "Asia/Makassar", or "UTC".',
      );
      return reply.code(http).send(errorBody);
    }

    const mode = resolveMode(body);
    const input = {
      mode,
      amount: body.amount,
      base_amount: body.base_amount,
      timeout: body.timeout,
      tolerance: body.tolerance,
      webhook_url: body.webhook_url ?? null,
      tz: body.tz ?? null,
      // `poll_interval` is intentionally NOT forwarded.
    };

    let payment;
    try {
      payment = await paymentService.createPayment(input);
    } catch (err) {
      return sendDomainError(reply, err);
    }

    const tz = await resolveDisplayTz(payment);
    return reply.code(201).send({
      id: payment.id,
      status: payment.status,
      amount: payment.amount,
      qris_string: payment.qris_string,
      qris_url: qrisImageUrl(payment.id),
      // Epoch milliseconds (UTC) plus an offset-aware ISO sibling rendered in
      // the resolved display timezone, so consumers can use whichever
      // representation they prefer.
      expires_at: payment.expires_at,
      created_at: payment.created_at,
      expires_at_iso: toZonedIso(payment.expires_at, tz),
      created_at_iso: toZonedIso(payment.created_at, tz),
      tz,
    });
  });

  // ── GET /payment/:id ───────────────────────────────────────────────────────
  // Read a Payment. 200 with id, amount, status, expires_at;
  // settlement details (txId, paid_amount, paid_at) when paid;
  // PAYMENT_NOT_FOUND on a miss.
  fastify.get('/payment/:id', { schema: mutableSchema(paymentRouteSchemas.getPayment) }, async (request, reply) => {
    const { id } = request.params;
    const payment = await paymentService.getPayment(id);

    if (!payment) {
      const { http, body } = buildHttpError('PAYMENT_NOT_FOUND');
      return reply.code(http).send(body);
    }

    const tz = await resolveDisplayTz(payment);
    const responseBody = {
      id: payment.id,
      amount: payment.amount,
      status: payment.status,
      expires_at: payment.expires_at,
      created_at: payment.created_at,
      expires_at_iso: toZonedIso(payment.expires_at, tz),
      created_at_iso: toZonedIso(payment.created_at, tz),
      tz,
    };

    if (payment.status === 'paid') {
      responseBody.txId = payment.tx_id;
      responseBody.paid_amount = payment.paid_amount;
      responseBody.paid_at = payment.paid_at;
      responseBody.paid_at_iso = toZonedIso(payment.paid_at, tz);
      const providerTransaction = parseProviderTransaction(payment.tx_raw);
      if (
        providerTransaction !== null &&
        (typeof providerTransaction.transaction_time === 'string' ||
          typeof providerTransaction.transaction_time === 'number')
      ) {
        responseBody.provider_transaction = {
          transaction_time: providerTransaction.transaction_time,
        };
      }
    }

    return reply.code(200).send(responseBody);
  });

  // ── GET /payments ──────────────────────────────────────────────────────────
  // List Active_Payment (pending only), ascending by expires_at, paginated.
  // An empty result is HTTP 200 with [].
  fastify.get('/payments', { schema: mutableSchema(paymentRouteSchemas.listPayments) }, async (request, reply) => {
    const { limit, offset } = request.query ?? {};
    const payments = await paymentService.listActive({ limit, offset });

    const list = await Promise.all(
      payments.map(async (payment) => {
        const tz = await resolveDisplayTz(payment);
        return {
          id: payment.id,
          amount: payment.amount,
          status: payment.status,
          expires_at: payment.expires_at,
          created_at: payment.created_at,
          expires_at_iso: toZonedIso(payment.expires_at, tz),
          created_at_iso: toZonedIso(payment.created_at, tz),
          tz,
        };
      }),
    );

    return reply.code(200).send(list);
  });

  // ── GET /payment/:id/qris.png ────────────────────────────────────────────
  // Serve the Payment's QRIS as a PNG image rendered internally (no external
  // upload). PAYMENT_NOT_FOUND on a miss.
  fastify.get('/payment/:id/qris.png', { schema: { params: { ...getPaymentParamsSchema } } }, async (request, reply) => {
    const { id } = request.params;
    const payment = await paymentService.getPayment(id);

    if (!payment) {
      const { http, body } = buildHttpError('PAYMENT_NOT_FOUND');
      return reply.code(http).send(body);
    }

    const png = await generateImage(payment.qris_string);
    // The QRIS string (and thus the PNG) is immutable for the life of the
    // payment, so the image can be cached aggressively by every layer. Browsers
    // and CDNs that re-request it get a 304 / cache hit instead of re-rendering.
    reply.header('Cache-Control', 'private, max-age=300, immutable');
    return reply.code(200).type('image/png').send(png);
  });
}
