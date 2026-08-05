// Config Service: read/write server-level Config via the DAL, with validation.
//
// Server-level settings are persisted through the
// Data_Access_Layer (the `config` key/value store) so they survive restarts.
// This service owns exactly three settings:
//
//   - `poll_interval` : the Shared_Poller cadence, an integer in milliseconds
//                       constrained to the range 1000..60000.
//   - `webhook_url`   : the default outgoing webhook target, an absolute
//                       http/https URL of at most 2048 characters.
//   - `static_qris`   : the single-merchant Static_QRIS the QRIS_Builder reads
//                       from, validated as a real QRIS payload.
//
// VALIDATION CONTRACT: every setter validates the
// candidate value BEFORE touching storage. When a value is invalid the setter
// throws a `ConfigValidationError` (which callers map to HTTP 400) and, because
// nothing was written, the previously stored value is retained unchanged. A
// valid value is normalized (trimmed / canonical string form) and persisted.
//
// `poll_interval` is a server-level setting only; it is never accepted from
// `POST /payment`. Enforcing that is the route layer's job —
// this module simply provides the single, authoritative Poll_Interval value.

import { assertStorage } from '../dal/storage-interface.js';
import { getErrorDefinition } from '../errors.js';
import { QrisError, validateStaticQris } from '../payment/qris-builder.js';
import { DEFAULT_DISPLAY_TIMEZONE, isValidTimezone } from '../time.js';

/**
 * The Config keys this service manages, mirroring the `config` store keys.
 *
 * @type {Readonly<{ POLL_INTERVAL: string, WEBHOOK_URL: string, STATIC_QRIS: string, DISPLAY_TIMEZONE: string }>}
 */
export const CONFIG_KEYS = Object.freeze({
  POLL_INTERVAL: 'poll_interval',
  WEBHOOK_URL: 'webhook_url',
  STATIC_QRIS: 'static_qris',
  DISPLAY_TIMEZONE: 'display_timezone',
});

/**
 * The default display timezone used to render `_iso` timestamp fields when a
 * Payment carries no per-Payment `tz` and none has been configured. Mirrors
 * {@link DEFAULT_DISPLAY_TIMEZONE} (WIB, `Asia/Jakarta`).
 *
 * @type {string}
 */
export { DEFAULT_DISPLAY_TIMEZONE };

/** Inclusive lower bound for the Poll_Interval in milliseconds. */
export const POLL_INTERVAL_MIN_MS = 1000;
/** Inclusive upper bound for the Poll_Interval in milliseconds. */
export const POLL_INTERVAL_MAX_MS = 60000;
/**
 * The Poll_Interval used when none has been stored yet. It lies within the
 * valid range so an unconfigured System still polls at a sensible cadence.
 *
 * @type {number}
 */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/** Maximum allowed length of a default `webhook_url`. */
export const WEBHOOK_URL_MAX_LENGTH = 2048;

/**
 * Error thrown when a Config value fails validation. It always maps to HTTP 400:
 * the `code` is a stable `error_code` from the central
 * error map and `http` is derived from that map. Callers translate it into the
 * `{ error_code, message }` response body.
 */
export class ConfigValidationError extends Error {
  /**
   * @param {string} errorCode - a key in the central error map whose HTTP
   *   status is 400 (e.g. `INVALID_REQUEST`, `INVALID_WEBHOOK_URL`).
   * @param {string} [message] - optional English detail message; defaults to
   *   the registered message for `errorCode`.
   */
  constructor(errorCode, message) {
    const definition = getErrorDefinition(errorCode);
    super(message ?? definition.message);
    this.name = 'ConfigValidationError';
    /** @type {string} the stable error_code for the response body. */
    this.code = errorCode;
    /** @type {number} the HTTP status callers should respond with (400). */
    this.http = definition.http;
  }
}

/**
 * Normalize and validate a candidate Poll_Interval. Accepts a number or a
 * string that denotes an integer; both must resolve to an integer within
 * {@link POLL_INTERVAL_MIN_MS}..{@link POLL_INTERVAL_MAX_MS}.
 *
 * @param {unknown} value - the candidate Poll_Interval.
 * @returns {number} the validated integer Poll_Interval in milliseconds.
 * @throws {ConfigValidationError} when the value is not an integer in range.
 */
export function validatePollInterval(value) {
  let n;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    n = Number.NaN;
  }

  if (!Number.isInteger(n) || n < POLL_INTERVAL_MIN_MS || n > POLL_INTERVAL_MAX_MS) {
    throw new ConfigValidationError(
      'INVALID_REQUEST',
      `The poll interval is invalid. It must be an integer between ${POLL_INTERVAL_MIN_MS} and ${POLL_INTERVAL_MAX_MS} milliseconds.`,
    );
  }

  return n;
}

/**
 * Validate a candidate default `webhook_url`: it must be a non-empty string,
 * at most {@link WEBHOOK_URL_MAX_LENGTH} characters, and an absolute URL with an
 * http or https scheme.
 *
 * @param {unknown} value - the candidate URL.
 * @returns {string} the validated URL string.
 * @throws {ConfigValidationError} when the value is not a valid webhook URL.
 */
export function validateWebhookUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > WEBHOOK_URL_MAX_LENGTH) {
    throw new ConfigValidationError('INVALID_WEBHOOK_URL');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigValidationError('INVALID_WEBHOOK_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigValidationError('INVALID_WEBHOOK_URL');
  }

  return value;
}

/**
 * Validate a candidate Static_QRIS by reusing the QRIS_Builder's own parser and
 * CRC16 check. Rejects empty, whitespace-only, structurally malformed, or
 * invalid-CRC16 payloads, returning the normalized (trimmed) value.
 *
 * @param {unknown} value - the candidate Static_QRIS.
 * @returns {string} the normalized, validated Static_QRIS string.
 * @throws {ConfigValidationError} when the value is not a valid QRIS payload.
 */
export function validateStaticQrisValue(value) {
  try {
    return validateStaticQris(value);
  } catch (err) {
    if (err instanceof QrisError) {
      throw new ConfigValidationError('INVALID_REQUEST', err.message);
    }
    throw err;
  }
}

/**
 * Validate a candidate display timezone: it must be a recognized IANA zone name
 * (e.g. `Asia/Jakarta`, `Asia/Makassar`, `Asia/Jayapura`, `UTC`). Rejects
 * non-strings and unknown zones with an HTTP 400.
 *
 * @param {unknown} value - the candidate timezone.
 * @returns {string} the validated timezone name.
 * @throws {ConfigValidationError} when the value is not a known IANA zone.
 */
export function validateDisplayTimezone(value) {
  if (!isValidTimezone(value)) {
    throw new ConfigValidationError(
      'INVALID_REQUEST',
      'The display timezone is invalid. It must be a recognized IANA timezone name, for example "Asia/Jakarta", "Asia/Makassar", or "UTC".',
    );
  }
  return value;
}

/**
 * Create the Config Service over a storage instance. The service reads and
 * writes the server-level settings through the DAL `config` store and
 * validates every write.
 *
 * @param {import('../dal/storage-interface.js').Storage} storage - a DAL
 *   storage instance (validated against the Storage contract).
 * @returns {{
 *   getPollInterval: () => number,
 *   setPollInterval: (value: unknown) => number,
 *   getDefaultWebhookUrl: () => (string|null),
 *   setDefaultWebhookUrl: (value: unknown) => string,
 *   getStaticQris: () => (string|null),
 *   setStaticQris: (value: unknown) => string,
 *   getDisplayTimezone: () => string,
 *   setDisplayTimezone: (value: unknown) => string,
 * }}
 */
export function createConfigService(storage) {
  assertStorage(storage);

  /**
   * Read the Poll_Interval, falling back to {@link DEFAULT_POLL_INTERVAL_MS}
   * when it is unset or (defensively) stored in a non-integer form.
   *
   * @returns {number}
   */
  function getPollInterval() {
    const raw = storage.config.get(CONFIG_KEYS.POLL_INTERVAL);
    if (raw === null) {
      return DEFAULT_POLL_INTERVAL_MS;
    }
    const n = Number(raw);
    return Number.isInteger(n) ? n : DEFAULT_POLL_INTERVAL_MS;
  }

  /**
   * Validate and persist a new Poll_Interval. On rejection the stored value is
   * left untouched.
   *
   * @param {unknown} value
   * @returns {number} the stored integer Poll_Interval.
   * @throws {ConfigValidationError} when the value is invalid.
   */
  function setPollInterval(value) {
    const validated = validatePollInterval(value);
    storage.config.set(CONFIG_KEYS.POLL_INTERVAL, String(validated));
    return validated;
  }

  /**
   * Read the default `webhook_url`, or `null` when none is configured.
   *
   * @returns {string|null}
   */
  function getDefaultWebhookUrl() {
    return storage.config.get(CONFIG_KEYS.WEBHOOK_URL);
  }

  /**
   * Validate and persist a new default `webhook_url`. On rejection the stored
   * value is left untouched.
   *
   * @param {unknown} value
   * @returns {string} the stored URL.
   * @throws {ConfigValidationError} when the value is invalid.
   */
  function setDefaultWebhookUrl(value) {
    const validated = validateWebhookUrl(value);
    storage.config.set(CONFIG_KEYS.WEBHOOK_URL, validated);
    return validated;
  }

  /**
   * Read the Static_QRIS, or `null` when none is configured.
   *
   * @returns {string|null}
   */
  function getStaticQris() {
    return storage.config.get(CONFIG_KEYS.STATIC_QRIS);
  }

  /**
   * Validate and persist a new Static_QRIS. On rejection the stored value is
   * left untouched. The QRIS_Builder reads this stored value at
   * payment time.
   *
   * @param {unknown} value
   * @returns {string} the normalized, stored Static_QRIS.
   * @throws {ConfigValidationError} when the value is invalid.
   */
  function setStaticQris(value) {
    const validated = validateStaticQrisValue(value);
    storage.config.set(CONFIG_KEYS.STATIC_QRIS, validated);
    return validated;
  }

  /**
   * Read the configured display timezone, falling back to
   * {@link DEFAULT_DISPLAY_TIMEZONE} when unset or (defensively) stored as a
   * value no longer recognized as a valid IANA zone.
   *
   * @returns {string}
   */
  function getDisplayTimezone() {
    const raw = storage.config.get(CONFIG_KEYS.DISPLAY_TIMEZONE);
    return isValidTimezone(raw) ? raw : DEFAULT_DISPLAY_TIMEZONE;
  }

  /**
   * Validate and persist a new display timezone. On rejection the stored value
   * is left untouched. This zone is the default used to render `_iso` timestamp
   * fields for Payments that carry no per-Payment `tz`.
   *
   * @param {unknown} value
   * @returns {string} the stored timezone name.
   * @throws {ConfigValidationError} when the value is not a valid IANA zone.
   */
  function setDisplayTimezone(value) {
    const validated = validateDisplayTimezone(value);
    storage.config.set(CONFIG_KEYS.DISPLAY_TIMEZONE, validated);
    return validated;
  }

  return {
    getPollInterval,
    setPollInterval,
    getDefaultWebhookUrl,
    setDefaultWebhookUrl,
    getStaticQris,
    setStaticQris,
    getDisplayTimezone,
    setDisplayTimezone,
  };
}
