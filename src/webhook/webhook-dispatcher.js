// Webhook_Dispatcher: send an HMAC-signed notification on a Payment event
// (`paid` or `expired`), with per-attempt timeout, bounded retry/backoff,
// idempotency, and a delivery log for every attempt.
//
// Behaviour:
//  - Triggered when a Payment reaches a terminal state: `paid` (settlement) or
//    `expired` (lifetime elapsed). The two are mutually exclusive, so a Payment
//    fires at most one terminal webhook.
//  - The body carries a stable `payment_id` (idempotency key) and a signed
//    `payment_status` field (`"paid"`|`"expired"`); the `X-Event` header mirrors
//    it for quick routing. For `paid` the raw GoBiz transaction is included; for
//    `expired` the Payment's amount/created_at/expires_at are included.
//  - URL selection: per-Payment `webhook_url` -> Config default -> if neither is
//    present, no notification is sent and it is NOT recorded as a failure.
//  - The payload carries a stable `payment_id` that is identical across every
//    retry, making delivery idempotent for the receiver.
//  - The `X-Signature` header is the HMAC-SHA256 of the exact serialized body,
//    using a key resolved from the injected `hmacKey` or env.
//  - Each attempt has a 10000 ms timeout; a 2xx response is success.
//  - Up to 5 attempts total (1 initial + 4 retries) with backoff in the
//    1000..60000 ms range (exponential 1s, 2s, 4s, 8s, capped at 60s).
//  - Every attempt's result is appended to `webhook_delivery_logs`;
//    after the 5th failure the final log row is marked `failed_permanent` and
//    retrying stops.
//  - `dispatchOnce(payment)` performs a SINGLE attempt (no retry/backoff) for
//    the manual "Resend webhook" action: it records exactly one log row and
//    never escalates to `failed_permanent`.
//
// Every collaborator (transport, config, hmac key, sleep/scheduler, clock, id
// factory) is injectable so the retry/backoff machinery is fully testable with
// fakes and without real timers.

import { randomUUID } from 'node:crypto';

import { HttpTransport } from '../gobiz/http-transport.js';
import { sign, serializeBody } from './hmac.js';
import { toZonedIso, isValidTimezone, DISPLAY_TIMEZONE } from '../time.js';

/** Per-attempt request timeout in milliseconds. */
export const ATTEMPT_TIMEOUT_MS = 10000;

/** Total number of attempts: 1 initial delivery plus 4 retries. */
export const MAX_ATTEMPTS = 5;

/** Inclusive lower/upper bounds for any backoff delay. */
export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60000;

/** The Config key holding the default `webhook_url` fallback. */
const DEFAULT_WEBHOOK_URL_KEY = 'webhook_url';

/** Maximum number of characters of a response body to retain in a log row. */
export const MAX_RESPONSE_BODY_CHARS = 2000;

/** Webhook event types, mirrored in the `payment_status` body field and the
 * `X-Event` header. A Payment fires at most one of these (pending -> paid OR
 * pending -> expired are mutually exclusive terminal transitions). */
export const PAID_EVENT = 'paid';
export const EXPIRED_EVENT = 'expired';

/**
 * Compute the backoff delay, in milliseconds, that precedes the retry following
 * failed attempt number `attempt` (1-based). The schedule is exponential
 * (1s, 2s, 4s, 8s, ...) clamped to the 1000..60000 ms window.
 *
 * @param {number} attempt - the 1-based number of the attempt that just failed.
 * @returns {number} the delay before the next attempt, in milliseconds.
 */
export function backoffDelayMs(attempt) {
  const exponential = MIN_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, exponential));
}

/**
 * Resolve the target URL for a payment: the per-Payment `webhook_url` wins; if
 * absent, fall back to the Config default; if neither is present the delivery
 * is skipped entirely.
 *
 * @param {{ webhook_url?: string|null }} payment
 * @param {{ get: (key: string) => (Awaitable<(string|null)>|string|null) }|null|undefined} config
 * @returns {Promise<string|null>} the selected URL, or `null` when none is available.
 */
export async function selectWebhookUrl(payment, config) {
  const perPayment = payment?.webhook_url;
  if (typeof perPayment === 'string' && perPayment.length > 0) {
    return perPayment;
  }
  if (config && typeof config.get === 'function') {
    const fallback = await config.get(DEFAULT_WEBHOOK_URL_KEY);
    if (typeof fallback === 'string' && fallback.length > 0) {
      return fallback;
    }
  }
  return null;
}

/**
 * Build the webhook payload for a Payment event. The body always carries the
 * stable idempotency key `payment_id` and a `payment_status` field
 * (`"paid"` | `"expired"`) — and because the signature covers the body, the
 * event type is tamper-proof (the `X-Event` header merely mirrors it).
 *
 * For a `paid` event the RAW GoBiz transaction (persisted as the `tx_raw` JSON
 * string at settlement) is nested within a `provider_transaction` object, so the receiver gets the full
 * transaction detail (amount, time, ids) without polluting the root namespace. When `tx_raw` is absent the body is
 * just the base fields without `provider_transaction`.
 *
 * For an `expired` event there is no transaction; the body carries the Payment's
 * own context: `amount`, `created_at`, and `expires_at` (epoch ms) plus their
 * offset-aware ISO siblings (`created_at_iso`, `expires_at_iso`) rendered in the
 * resolved display `tz`, mirroring the REST API's timestamp representation.
 *
 * @param {Object} payment
 * @param {('paid'|'expired')} [event] - the event type; defaults to `paid`.
 * @param {string} [tz] - IANA display timezone used to render the `_iso` fields
 *   of an `expired` event; defaults to {@link DISPLAY_TIMEZONE}.
 * @returns {Object} the JSON-serializable payload.
 */
export function buildPayload(payment, event = PAID_EVENT, tz = DISPLAY_TIMEZONE) {
  const createdAt = payment?.created_at ?? null;
  const base = {
    payment_id: payment.id,
    payment_status: event,
    amount: payment?.amount ?? null,
    created_at: createdAt,
    created_at_iso: toZonedIso(createdAt, tz),
    tz,
  };

  if (event === EXPIRED_EVENT) {
    const expiresAt = payment?.expires_at ?? null;
    return {
      ...base,
      expires_at: expiresAt,
      expires_at_iso: toZonedIso(expiresAt, tz),
    };
  }

  // PAID_EVENT
  const paidAt = payment?.paid_at ?? null;
  const payload = {
    ...base,
    paid_at: paidAt,
    paid_at_iso: toZonedIso(paidAt, tz),
  };

  const rawObject = parseRawTransaction(payment?.tx_raw);
  if (rawObject !== null) {
    payload.provider_transaction = rawObject.metadata?.transaction ?? rawObject;
  }
  
  return payload;
}

/**
 * Parse a payment's `tx_raw` JSON string into a plain object. Returns `null`
 * when the value is absent, not a string, unparseable, or does not parse to a
 * non-array object — so the caller can fall back to a `{ payment_id }` body.
 *
 * @param {unknown} txRaw
 * @returns {Object|null}
 */
function parseRawTransaction(txRaw) {
  if (typeof txRaw !== 'string' || txRaw.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(txRaw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The default sleep used between retries. Tests inject a fake to capture the
 * requested delays without waiting on real time.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Determine whether an HTTP status code is a 2xx success.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isSuccessStatus(status) {
  return Number.isInteger(status) && status >= 200 && status <= 299;
}

/**
 * Read a transport response's body text best-effort, truncated to
 * {@link MAX_RESPONSE_BODY_CHARS} characters. Returns `null` when the transport
 * does not expose `.text()` or reading it throws (so capturing the body never
 * disrupts delivery accounting).
 *
 * @param {{ text?: () => Promise<string> }} res
 * @returns {Promise<string|null>}
 */
async function readResponseBody(res) {
  if (!res || typeof res.text !== 'function') {
    return null;
  }
  try {
    const text = await res.text();
    if (typeof text !== 'string') {
      return null;
    }
    return text.length > MAX_RESPONSE_BODY_CHARS
      ? text.slice(0, MAX_RESPONSE_BODY_CHARS)
      : text;
  } catch {
    return null;
  }
}

/**
 * Create a Webhook_Dispatcher.
 *
 * @param {Object} deps
 * @param {{ append: Function, markPermanentFailure: Function }} deps.webhookLogs
 *   The DAL `webhookLogs` store (typically `storage.webhookLogs`).
 * @param {{ request: Function }} [deps.transport]
 *   An HTTP transport exposing `request({ method, url, headers, body, timeoutMs })`
 *   and resolving to `{ status, ok }`. Defaults to a real {@link HttpTransport}.
 * @param {{ get: (key: string) => (string|null) }} [deps.config]
 *   The Config store, used only to resolve the default `webhook_url`.
 * @param {string|Buffer} [deps.hmacKey]
 *   The HMAC signing key; falls back to `WEBHOOK_HMAC_KEY` via the hmac util.
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 *   The delay function used between retries; injectable for deterministic tests.
 * @param {() => number} [deps.now]
 *   Clock returning epoch ms for log timestamps; defaults to `Date.now`.
 * @param {() => string} [deps.generateId]
 *   Factory for delivery-log row ids; defaults to `crypto.randomUUID`.
 * @returns {{ dispatch: (payment: Object) => Promise<Object>, dispatchOnce: (payment: Object) => Promise<Object> }}
 */
export function createWebhookDispatcher(deps) {
  const {
    webhookLogs,
    transport = new HttpTransport(),
    config = null,
    hmacKey,
    sleep = defaultSleep,
    now = Date.now,
    generateId = randomUUID,
  } = deps ?? {};

  // Delivery obligations live in the payment outbox. A diagnostic log failure
  // must not turn a retriable delivery into a silently abandoned notification.
  async function appendLog(entry) {
    try { await webhookLogs.append(entry); }
    catch (err) { console.error('[WebhookDispatcher] Delivery log write failed:', err.message); }
  }

  if (!webhookLogs || typeof webhookLogs.append !== 'function') {
    throw new Error('createWebhookDispatcher requires a webhookLogs store with append().');
  }
  if (typeof webhookLogs.markPermanentFailure !== 'function') {
    throw new Error(
      'createWebhookDispatcher requires a webhookLogs store with markPermanentFailure().',
    );
  }
  if (!transport || typeof transport.request !== 'function') {
    throw new Error('createWebhookDispatcher requires a transport exposing request().');
  }

  /**
   * Perform a single delivery attempt. Resolves to `{ ok, status, responseBody }`
   * for a real HTTP response, or `{ ok:false, error }` when the request throws
   * (network failure or the 10000 ms timeout elapsing). The response body is
   * captured best-effort and truncated; a transport without `.text()` or a body
   * read that throws yields a `null` body without affecting the outcome.
   *
   * @param {string} url
   * @param {Record<string, string>} headers
   * @param {string} body
   * @returns {Promise<{ ok: boolean, status?: number, responseBody?: string|null, error?: string }>}
   */
  async function attemptDelivery(url, headers, body) {
    try {
      const res = await transport.request({
        method: 'POST',
        url,
        headers,
        body,
        timeoutMs: ATTEMPT_TIMEOUT_MS,
      });
      const ok = isSuccessStatus(res.status) || (res.status === undefined && res.ok === true);
      const responseBody = await readResponseBody(res);
      return { ok, status: res.status, responseBody };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Resolve the IANA display timezone used to render an `expired` event's `_iso`
   * fields: the Payment's own `tz` when valid, otherwise the server Config
   * `display_timezone`, otherwise {@link DISPLAY_TIMEZONE}. Mirrors the REST
   * API's resolution so the webhook and the API render the same wall-clock time.
   *
   * @param {Object} payment
   * @returns {Promise<string>}
   */
  async function resolveDisplayTz(payment) {
    if (isValidTimezone(payment?.tz)) {
      return payment.tz;
    }
    if (config && typeof config.get === 'function') {
      const configured = await config.get('display_timezone');
      if (isValidTimezone(configured)) {
        return configured;
      }
    }
    return DISPLAY_TIMEZONE;
  }

  /**
   * Build the signed request material (URL, serialized body, headers) for a
   * Payment event, or `null` when no target URL is available so the caller can
   * skip the delivery without recording a failure. Shared by both the
   * retrying {@link dispatch} and the single-shot {@link dispatchOnce}.
   *
   * @param {Object} payment
   * @param {('paid'|'expired')} event
   * @returns {Promise<{ url: string, body: string, headers: Record<string, string> }|null>}
   */
  async function prepareRequest(payment, event) {
    const url = await selectWebhookUrl(payment, config);
    if (url === null) {
      return null;
    }
    const payload = buildPayload(payment, event, await resolveDisplayTz(payment));
    const body = serializeBody(payload);
    const signature = sign(body, hmacKey);
    return {
      url,
      body,
      headers: {
        'Content-Type': 'application/json',
        'X-Signature': signature,
        // Mirror the (signed) `payment_status` body field for quick routing.
        'X-Event': event,
      },
    };
  }

  /**
   * Dispatch a webhook for a Payment event, applying URL selection, signing,
   * the per-attempt timeout, retry/backoff, delivery logging, and permanent
   * failure handling.
   *
   * @param {Object} payment - the Payment (must carry a stable `id`).
   * @param {{ event?: ('paid'|'expired') }} [options] - the event type; defaults
   *   to `paid`.
   * @returns {Promise<{ sent: boolean, success?: boolean, attempts?: number,
   *   permanentlyFailed?: boolean, status?: number, url?: string }>}
   */
  async function dispatch(payment, options = {}) {
    const event = options.event ?? PAID_EVENT;
    const prepared = await prepareRequest(payment, event);
    if (prepared === null) {
      // No per-Payment URL and no Config default: do not send, not a failure,
      // and write no delivery log.
      return { sent: false };
    }
    const { url, body, headers } = prepared;

    let lastStatus;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await attemptDelivery(url, headers, body);
      const timestamp = now();
      lastStatus = result.status;

      if (result.ok) {
        await appendLog({
          id: generateId(),
          payment_id: payment.id,
          target_url: url,
          status: 'success',
          attempts: attempt,
          last_attempt_at: timestamp,
          last_error: null,
          response_status: result.status ?? null,
          response_body: result.responseBody ?? null,
          request_body: body,
        });
        return { sent: true, success: true, attempts: attempt, status: result.status, url };
      }

      // Failed attempt: record it.
      const logId = generateId();
      const lastError =
        result.error ?? `Non-2xx response status ${result.status ?? 'unknown'}`;
      await appendLog({
        id: logId,
        payment_id: payment.id,
        target_url: url,
        status: 'failed',
        attempts: attempt,
        last_attempt_at: timestamp,
        last_error: lastError,
        response_status: result.status ?? null,
        response_body: result.responseBody ?? null,
        request_body: body,
      });

      if (attempt === MAX_ATTEMPTS) {
        // All attempts exhausted: mark the final row permanently failed and
        // stop retrying.
        try { await webhookLogs.markPermanentFailure(logId); }
        catch (err) { console.error('[WebhookDispatcher] Failure log write failed:', err.message); }
        return {
          sent: true,
          success: false,
          attempts: attempt,
          permanentlyFailed: true,
          status: lastStatus,
          url,
        };
      }

      // Wait the bounded backoff delay before the next attempt.
      // eslint-disable-next-line no-await-in-loop
      await sleep(backoffDelayMs(attempt));
    }

    // Unreachable: the loop always returns. Present for exhaustiveness.
    return { sent: true, success: false, attempts: MAX_ATTEMPTS, permanentlyFailed: true, url };
  }

  /**
   * Perform a SINGLE webhook delivery attempt with no retry and no backoff,
   * recording exactly one delivery-log row. This backs the manual "Resend
   * webhook" action: an operator wants one fresh attempt, not another full
   * retry storm. Unlike {@link dispatch}, a failure here is recorded as a plain
   * `failed` row and is never escalated to `failed_permanent` (that status is
   * reserved for the automatic 5-attempt cycle exhausting itself).
   *
   * URL selection, signing, the per-attempt timeout, and the idempotent
   * `payment_id` payload are identical to {@link dispatch}.
   *
   * @param {Object} payment - the settled payment (must carry a stable `id`).
   * @param {{ event?: ('paid'|'expired') }} [options] - the event type; defaults
   *   to `paid`.
   * @returns {Promise<{ sent: boolean, success?: boolean, attempts?: number,
   *   status?: number, url?: string }>}
   */
  async function dispatchOnce(payment, options = {}) {
    const event = options.event ?? PAID_EVENT;
    const prepared = options.prepared ?? await prepareRequest(payment, event);
    if (prepared === null) {
      // No per-Payment URL and no Config default: do not send, not a failure,
      // and write no delivery log.
      return { sent: false };
    }
    const { url, body, headers } = prepared;

    const result = await attemptDelivery(url, headers, body);
    const timestamp = now();

    await appendLog({
      id: generateId(),
      payment_id: payment.id,
      target_url: url,
      status: result.ok ? 'success' : 'failed',
      attempts: options.attempt ?? 1,
      last_attempt_at: timestamp,
      last_error: result.ok
        ? null
        : result.error ?? `Non-2xx response status ${result.status ?? 'unknown'}`,
      response_status: result.status ?? null,
      response_body: result.responseBody ?? null,
      request_body: body,
    });

    return {
      sent: true,
      success: result.ok,
      attempts: 1,
      status: result.status,
      url,
    };
  }

  return { dispatch, dispatchOnce, prepareRequest };
}

export default createWebhookDispatcher;
