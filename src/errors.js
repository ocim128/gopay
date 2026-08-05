// Central error map: error_code -> { http, message } and response-shape helper.
//
// This module is the single source of truth for REST_API error codes. Every
// error response produced by the API passes through here so that the
// `error_code` values and their HTTP status codes stay consistent across
// routes.

/**
 * Map of error_code -> { http, message }.
 *
 * - http:    the HTTP status code the REST_API responds with.
 * - message: a human-readable English description of the error.
 *
 * @type {Readonly<Record<string, { http: number, message: string }>>}
 */
export const ERROR_DEFINITIONS = Object.freeze({
  // Generic request body validation failure (missing/invalid amount field,
  // timeout/tolerance out of range, malformed body).
  INVALID_REQUEST: {
    http: 400,
    message: 'The request is invalid. Check the request body and try again.',
  },

  // Client-managed mode: the supplied amount is missing, not a positive
  // integer, or outside the range 1000 to 9999000 Rupiah.
  INVALID_AMOUNT: {
    http: 400,
    message: 'The amount is invalid. It must be an integer between 1000 and 9999000.',
  },

  // Server-managed mode: the supplied base amount is missing or not a positive
  // integer (less than 1000).
  INVALID_BASE_AMOUNT: {
    http: 400,
    message: 'The base amount is invalid. It must be a positive integer of at least 1000.',
  },

  // Client-managed mode: the requested amount is already used by another
  // active payment.
  AMOUNT_IN_USE: {
    http: 409,
    message: 'The requested amount is already in use by another active payment.',
  },

  // Server-managed mode: every unique suffix slot for the base amount is
  // already taken by active payments.
  NO_AVAILABLE_AMOUNT: {
    http: 409,
    message: 'No available amount could be allocated for the given base amount.',
  },

  // The configured Static_QRIS is absent or has an invalid format, so a
  // dynamic QRIS cannot be built.
  QRIS_INVALID: {
    http: 500,
    message: 'The configured static QRIS is missing or invalid.',
  },

  // No payment exists for the requested id.
  PAYMENT_NOT_FOUND: {
    http: 404,
    message: 'The requested payment was not found.',
  },

  // The request is missing a valid API key, or the API key is empty,
  // malformed, unknown, or revoked.
  UNAUTHORIZED: {
    http: 401,
    message: 'Authentication failed. A valid API key is required.',
  },

  // The supplied webhook_url is not an absolute http/https URL or exceeds
  // 2048 characters.
  INVALID_WEBHOOK_URL: {
    http: 400,
    message: 'The webhook URL is invalid. It must be an absolute http or https URL of at most 2048 characters.',
  },
});

/**
 * Look up the definition for an error code.
 *
 * @param {string} errorCode - one of the keys in ERROR_DEFINITIONS.
 * @returns {{ http: number, message: string }} the matching definition.
 * @throws {Error} if the error code is not registered.
 */
export function getErrorDefinition(errorCode) {
  const definition = ERROR_DEFINITIONS[errorCode];
  if (!definition) {
    throw new Error(`Unknown error code: ${errorCode}`);
  }
  return definition;
}

/**
 * Build the consistent error response body for a given error code.
 *
 * The response shape is always `{ error_code, message }`. The message defaults
 * to the registered English message for the code, but an explicit override may
 * be supplied for cases that need extra context (still English-only).
 *
 * @param {string} errorCode - one of the keys in ERROR_DEFINITIONS.
 * @param {string} [messageOverride] - optional English message to use instead
 *   of the default registered message.
 * @returns {{ error_code: string, message: string }} the response body.
 * @throws {Error} if the error code is not registered.
 */
export function buildErrorResponse(errorCode, messageOverride) {
  const definition = getErrorDefinition(errorCode);
  return {
    error_code: errorCode,
    message: messageOverride ?? definition.message,
  };
}

/**
 * Convenience helper that returns both the HTTP status code and the response
 * body for a given error code, ready to be sent by a route handler.
 *
 * @param {string} errorCode - one of the keys in ERROR_DEFINITIONS.
 * @param {string} [messageOverride] - optional English message override.
 * @returns {{ http: number, body: { error_code: string, message: string } }}
 * @throws {Error} if the error code is not registered.
 */
export function buildHttpError(errorCode, messageOverride) {
  const definition = getErrorDefinition(errorCode);
  return {
    http: definition.http,
    body: buildErrorResponse(errorCode, messageOverride),
  };
}
