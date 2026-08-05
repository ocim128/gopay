// Fastify JSON Schemas for the REST_API payment endpoints.
//
// This module exports plain, data-only JSON Schema objects (no Fastify import
// required) that are attached to the route definitions in
// `payments.routes.js`. Fastify validates incoming
// requests against these schemas using its built-in Ajv instance.
//
// ── How schema validation maps to error_code INVALID_REQUEST ───────────────
// Fastify runs schema validation before the route handler executes. When a
// request fails schema validation Fastify produces a validation error BEFORE
// any side effect (no Payment is created). The route layer installs a
// validation error handler (via `setErrorHandler` / `attachValidation`) that
// maps every schema validation failure to HTTP 400 with
// `error_code: "INVALID_REQUEST"` through `src/errors.js`.
//
// The schemas below intentionally enforce ONLY the structural, mode-agnostic
// constraints that always map to INVALID_REQUEST:
//   - `mode` must be one of the two known modes,
//   - `timeout` must be an integer in 10000..86400000,
//   - `tolerance` must be an integer in 0..999,
//   - `webhook_url`, when present, must be a string of at most 2048 chars.
//
// The amount fields (`amount` / `base_amount`) are deliberately NOT range- or
// type-constrained here. Their validation is mode-aware and produces the more
// specific error codes `INVALID_AMOUNT` (client-managed) and
// `INVALID_BASE_AMOUNT` (server-managed) in the route handler.
// Constraining them in the schema would incorrectly collapse those
// cases into INVALID_REQUEST.
//
// `additionalProperties` is left enabled (not set to false) so that unknown
// fields such as `poll_interval` are ignored rather than rejected.

/**
 * Allowed amount-mode values for `POST /payment`.
 *
 * - `client_managed`: the API_Client supplies the full `amount` (Type 1).
 * - `server_managed`: the API_Client supplies a `base_amount` and the System
 *   appends a unique suffix (Type 2).
 *
 * @type {readonly ['client_managed', 'server_managed']}
 */
export const PAYMENT_MODES = Object.freeze(['client_managed', 'server_managed']);

/** Inclusive lower bound for the per-Payment `timeout` in milliseconds. */
export const TIMEOUT_MIN_MS = 10000;
/** Inclusive upper bound for the per-Payment `timeout` in milliseconds. */
export const TIMEOUT_MAX_MS = 86400000;

/** Inclusive lower bound for the per-Payment `tolerance` in Rupiah. */
export const TOLERANCE_MIN = 0;
/** Inclusive upper bound for the per-Payment `tolerance` in Rupiah. */
export const TOLERANCE_MAX = 999;

/** Maximum allowed length for a `webhook_url` string. */
export const WEBHOOK_URL_MAX_LENGTH = 2048;

/** Default and maximum page size for `GET /payments`. */
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MIN = 1;
export const LIST_LIMIT_MAX = 100;
/** Default page offset for `GET /payments`. */
export const LIST_OFFSET_DEFAULT = 0;
export const LIST_OFFSET_MIN = 0;

/**
 * Request body schema for `POST /payment`.
 *
 * Structural validation only — see the module header for why the amount fields
 * are left to mode-aware handler validation. A failure here maps to
 * HTTP 400 / `INVALID_REQUEST`.
 *
 * @type {Readonly<object>}
 */
export const createPaymentBodySchema = Object.freeze({
  $id: 'gopay.createPaymentBody',
  type: 'object',
  // Unknown fields (e.g. poll_interval) are ignored, not rejected.
  additionalProperties: true,
  properties: {
    // Amount mode selector. Optional at the schema level so the handler can
    // apply a sensible default and emit mode-specific amount errors.
    mode: {
      type: 'string',
      enum: [...PAYMENT_MODES],
      description:
        'Amount mode: "client_managed" (client supplies full amount) or ' +
        '"server_managed" (system appends a unique suffix to base_amount).',
    },
    // Full amount for client-managed mode. Range/type validation is performed
    // in the route handler so it maps to INVALID_AMOUNT, not here.
    amount: {
      description:
        'Full payment amount in Rupiah (client-managed mode, 1000..9999000). ' +
        'Validated by the handler; out-of-range/non-integer values map to ' +
        'INVALID_AMOUNT.',
    },
    // Base amount for server-managed mode. Validated in the handler so it maps
    // to INVALID_BASE_AMOUNT, not here.
    base_amount: {
      description:
        'Base payment amount in Rupiah (server-managed mode, 1000..9999000). ' +
        'Validated by the handler; out-of-range/non-integer values map to ' +
        'INVALID_BASE_AMOUNT.',
    },
    // Optional per-Payment expiry in milliseconds. Out-of-range or
    // non-integer values fail schema validation -> INVALID_REQUEST.
    timeout: {
      type: 'integer',
      minimum: TIMEOUT_MIN_MS,
      maximum: TIMEOUT_MAX_MS,
      description: 'Optional payment timeout in milliseconds (10000..86400000).',
    },
    // Optional per-Payment amount-match tolerance in Rupiah.
    tolerance: {
      type: 'integer',
      minimum: TOLERANCE_MIN,
      maximum: TOLERANCE_MAX,
      description: 'Optional amount-match tolerance in Rupiah (0..999).',
    },
    // Optional per-Payment webhook URL. Length is bounded here; absolute
    // http/https URL validation maps to INVALID_WEBHOOK_URL in the handler.
    webhook_url: {
      type: 'string',
      maxLength: WEBHOOK_URL_MAX_LENGTH,
      description: 'Optional webhook URL (absolute http/https, <= 2048 chars).',
    },
    // Optional per-Payment display timezone (an IANA zone name) used to render
    // the response `_iso` timestamp fields. Length is bounded here; the handler
    // validates it as a real IANA zone and maps an unknown zone to
    // INVALID_REQUEST. When omitted the server-configured default zone is used.
    tz: {
      type: 'string',
      maxLength: 64,
      description:
        'Optional IANA display timezone for the response _iso fields (e.g. ' +
        '"Asia/Jakarta", "Asia/Makassar", "UTC"). Defaults to the server setting.',
    },
  },
});

/**
 * Route params schema for `GET /payment/:id`.
 *
 * @type {Readonly<object>}
 */
export const getPaymentParamsSchema = Object.freeze({
  $id: 'gopay.getPaymentParams',
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      description: 'The payment identifier.',
    },
  },
});

/**
 * Query string schema for `GET /payments` pagination.
 *
 * `limit` defaults to 100 (range 1..100) and `offset` defaults to 0 (>= 0).
 * Fastify coerces query string values to integers and applies the defaults.
 * Out-of-range values fail validation -> INVALID_REQUEST.
 *
 * @type {Readonly<object>}
 */
export const listPaymentsQuerySchema = Object.freeze({
  $id: 'gopay.listPaymentsQuery',
  type: 'object',
  additionalProperties: true,
  properties: {
    limit: {
      type: 'integer',
      minimum: LIST_LIMIT_MIN,
      maximum: LIST_LIMIT_MAX,
      default: LIST_LIMIT_DEFAULT,
      description: 'Maximum number of active payments to return (1..100, default 100).',
    },
    offset: {
      type: 'integer',
      minimum: LIST_OFFSET_MIN,
      default: LIST_OFFSET_DEFAULT,
      description: 'Number of active payments to skip (>= 0, default 0).',
    },
  },
});

// ── Response schemas (used by the route definitions) ──────────
// These document and serialize the response shapes. They are optional for
// validation but keep the contract explicit and consistent.

/**
 * Response body schema for a successfully created Payment (HTTP 201).
 * Contains exactly: id, status, amount, qris_string, qris_url, expires_at.
 *
 * @type {Readonly<object>}
 */
export const createPaymentResponseSchema = Object.freeze({
  $id: 'gopay.createPaymentResponse',
  type: 'object',
  required: ['id', 'status', 'amount', 'qris_string', 'qris_url', 'expires_at'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'paid', 'expired'] },
    amount: { type: 'integer' },
    qris_string: { type: 'string' },
    // qris_url may be a data URL or an internal endpoint URL; allow null.
    qris_url: { type: ['string', 'null'] },
    // Epoch milliseconds (UTC) — the absolute instant; kept for back-compat.
    expires_at: { type: 'integer' },
    created_at: { type: 'integer' },
    // Offset-aware ISO-8601 siblings rendered in the resolved display timezone.
    expires_at_iso: { type: 'string' },
    created_at_iso: { type: 'string' },
    // The IANA timezone actually applied to the _iso fields above.
    tz: { type: 'string' },
  },
});

/**
 * Response body schema for `GET /payment/:id` (HTTP 200).
 * Always contains id, amount, status, expires_at; when paid it additionally
 * carries txId, paid_amount, paid_at.
 *
 * @type {Readonly<object>}
 */
export const getPaymentResponseSchema = Object.freeze({
  $id: 'gopay.getPaymentResponse',
  type: 'object',
  required: ['id', 'amount', 'status', 'expires_at'],
  properties: {
    id: { type: 'string' },
    amount: { type: 'integer' },
    status: { type: 'string', enum: ['pending', 'paid', 'expired'] },
    // Epoch milliseconds (UTC); ISO siblings rendered in Asia/Jakarta (+07:00).
    expires_at: { type: 'integer' },
    created_at: { type: 'integer' },
    expires_at_iso: { type: 'string' },
    created_at_iso: { type: 'string' },
    // Settlement details, present only when status is "paid".
    txId: { type: 'string' },
    paid_amount: { type: 'integer' },
    paid_at: { type: 'integer' },
    paid_at_iso: { type: 'string' },
    // The IANA timezone actually applied to the _iso fields.
    tz: { type: 'string' },
  },
});

/**
 * Response body schema for `GET /payments` (HTTP 200): an array of active
 * payments, each containing exactly id, amount, status, expires_at.
 *
 * @type {Readonly<object>}
 */
export const listPaymentsResponseSchema = Object.freeze({
  $id: 'gopay.listPaymentsResponse',
  type: 'array',
  items: {
    type: 'object',
    required: ['id', 'amount', 'status', 'expires_at'],
    properties: {
      id: { type: 'string' },
      amount: { type: 'integer' },
      status: { type: 'string', enum: ['pending', 'paid', 'expired'] },
      expires_at: { type: 'integer' },
      created_at: { type: 'integer' },
      expires_at_iso: { type: 'string' },
      created_at_iso: { type: 'string' },
      tz: { type: 'string' },
    },
  },
});

/**
 * Shared error response body schema ({ error_code, message }). Matches the
 * shape produced by `src/errors.js`.
 *
 * @type {Readonly<object>}
 */
export const errorResponseSchema = Object.freeze({
  $id: 'gopay.errorResponse',
  type: 'object',
  required: ['error_code', 'message'],
  properties: {
    error_code: { type: 'string' },
    message: { type: 'string' },
  },
});

/**
 * Convenience bundle grouping the schemas per endpoint, ready to spread into a
 * Fastify route definition's `schema` option.
 */
export const paymentRouteSchemas = Object.freeze({
  createPayment: Object.freeze({
    body: createPaymentBodySchema,
    response: Object.freeze({
      201: createPaymentResponseSchema,
    }),
  }),
  getPayment: Object.freeze({
    params: getPaymentParamsSchema,
    response: Object.freeze({
      200: getPaymentResponseSchema,
    }),
  }),
  listPayments: Object.freeze({
    querystring: listPaymentsQuerySchema,
    response: Object.freeze({
      200: listPaymentsResponseSchema,
    }),
  }),
});
