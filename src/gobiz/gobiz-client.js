// High-level GoBiz client facade.
//
// This is the single door used by the Payment_Service and the Shared_Poller.
// The business layer depends on THIS interface, not on HTTP, SQL, or the shape
// of any GoBiz response. Everything HTTP-specific is delegated to the injected
// collaborators:
//
//   - transport  : the pluggable HttpTransport (fetch-based)
//   - auth       : the AuthTokenManager (token load/validate/login/invalidate)
//   - adapter    : the ResponseAdapter (pure GoBiz -> canonical parsers)
//   - endpoints  : the GOBIZ endpoint/header configuration
//
// It exposes a single `getRecentTransactions` that
// returns the canonical Transaction[] from the adapter. The single 401 re-login
// policy is honored here: on a 401 we call `auth.invalidate()`, obtain a fresh
// token, and retry the failed request exactly once.

import crypto from 'node:crypto';
import moment from 'moment-timezone';

import { GOBIZ } from './endpoints.config.js';
import { ResponseAdapter } from './response-adapter.js';

// Transaction statuses and payment types requested from GoBiz for the
// analytics/journal queries.
const ANALYTICS_STATUSES = 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND';
const ANALYTICS_PAYMENT_TYPES =
  'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD';
const JOURNAL_STATUSES = ['settlement', 'capture', 'refund', 'partial_refund'];
const JOURNAL_PAYMENT_TYPES = [
  'qris',
  'gopay',
  'offline_credit_card',
  'offline_debit_card',
  'credit_card',
];

const DEFAULT_TIMEZONE = 'Asia/Jakarta';

/**
 * High-level facade over the GoBiz integration.
 *
 * The business layer should only ever interact with this class, never with the
 * transport, auth manager, or adapter directly.
 */
export class GoBizClient {
  /**
   * @param {object} deps
   * @param {import('./http-transport.js').HttpTransport} deps.transport - the
   *   pluggable HTTP transport.
   * @param {import('./auth-token-manager.js').AuthTokenManager} deps.auth - the
   *   auth/token manager (owns the 401 re-login mechanics).
   * @param {typeof ResponseAdapter} [deps.adapter] - the response adapter.
   *   Defaults to the shared ResponseAdapter.
   * @param {typeof GOBIZ} [deps.endpoints] - endpoint/header configuration.
   *   Defaults to the shared GOBIZ config.
   * @param {object} [options]
   * @param {Pick<Console, 'log' | 'warn' | 'error'>} [options.logger] - logger.
   * @param {number} [options.timeoutMs] - per-request timeout for GoBiz calls.
   * @param {string} [options.timezone] - timezone used to compute the
   *   start/end time window. Defaults to 'Asia/Jakarta'.
   */
  constructor({ transport, auth, config, adapter, endpoints } = {}, options = {}) {
    if (!transport || typeof transport.request !== 'function') {
      throw new TypeError(
        'GoBizClient requires an HttpTransport with a request() method.',
      );
    }
    if (
      !auth ||
      typeof auth.getValidToken !== 'function' ||
      typeof auth.invalidate !== 'function'
    ) {
      throw new TypeError(
        'GoBizClient requires an AuthTokenManager with getValidToken() and invalidate().',
      );
    }

    this.transport = transport;
    this.auth = auth;
    this.config = config ?? null;
    this.adapter = adapter ?? ResponseAdapter;
    this.endpoints = endpoints ?? GOBIZ;
    this.logger = options.logger ?? console;
    this.timeoutMs = options.timeoutMs;
    this.timezone = options.timezone ?? DEFAULT_TIMEZONE;

    this.merchantId = null;
    this.merchantName = null;
    this.merchantProfile = null;
    this._initialized = false;
  }

  /**
   * Ensure the client is ready: a valid token is available and the merchant id
   * has been resolved and cached. Safe to call repeatedly; the heavy work runs
   * only once.
   *
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialized) return;

    // Make sure a usable token exists (loaded from the store, validated, or a
    // fresh login). The auth manager owns this decision.
    await this.auth.getValidToken();

    // Resolve + cache the merchant id used by the transaction queries.
    await this.getMerchantId();

    this._initialized = true;
  }

  /**
   * Resolve the merchant id, caching it after the first lookup.
   *
   * Queries the merchants search
   * endpoint, normalizes the response through `adapter.parseMerchantList`, and
   * uses the first merchant's `id` (falling back to `merchant_id`).
   *
   * @returns {Promise<string>} the cached merchant id.
   * @throws {Error} when no merchant is associated with the account or the id
   *   cannot be determined.
   */
  async getMerchantId() {
    if (this.merchantId) return this.merchantId;

    this.logger?.log?.('[GoBizClient] Resolving merchant id...');
    const res = await this._requestWithRetry({
      method: 'POST',
      url: this.endpoints.resolveUrl('merchants'),
      body: { from: 0, to: 50 },
    });

    if (!res.ok) {
      const data = await this._safeJson(res);
      const message = data?.errors?.[0]?.message ?? 'authentication failed';
      throw new Error(
        `[GoBizClient] Failed to fetch the merchant list (${res.status}): ${message}`,
      );
    }

    const raw = await this._safeJson(res);
    const merchants = this.adapter.parseMerchantList(raw);
    if (!Array.isArray(merchants) || merchants.length === 0) {
      throw new Error(
        '[GoBizClient] No merchant is associated with this account.',
      );
    }

    const first = merchants[0] ?? {};
    const merchantId = first.id ?? first.merchant_id ?? null;
    if (!merchantId) {
      throw new Error(
        '[GoBizClient] The merchant list did not contain a usable merchant id.',
      );
    }

    this.merchantId = merchantId;
    const merchantName = first.merchant_name ?? 'unknown';
    this.merchantName = merchantName;
    this.merchantProfile = first;
    this.logger?.log?.(
      `[GoBizClient] Using merchant: ${merchantName} (ID: ${merchantId})`,
    );

    // Auto-sync Static QRIS to the global config store if possible.
    const qrisString = first.pops?.[0]?.gopay?.aspi_qr_string;
    if (qrisString && typeof this.config?.setStaticQris === 'function') {
      try {
        this.config.setStaticQris(qrisString);
        this.logger?.log?.('[GoBizClient] Auto-synced Static QRIS to config store.');
      } catch (err) {
        this.logger?.warn?.(`[GoBizClient] Failed to auto-sync Static QRIS: ${err.message}`);
      }
    }

    return this.merchantId;
  }

  /**
   * Get the full merchant profile fetched during initialization.
   * @returns {object|null}
   */
  getMerchantProfile() {
    return this.merchantProfile;
  }

  /**
   * Fetch the most recent transactions as a canonical `Transaction[]`.
   *
   * Strategy: try the analytics endpoint
   * first; if it yields a `transactions` array, normalize and return it. When
   * analytics has no usable transactions array (missing field or a non-OK
   * response), fall back to the journal endpoint. The single 401 re-login is
   * applied per request inside `_requestWithRetry`.
   *
   * @param {object} [params]
   * @param {number} [params.days=1] - how many days back to query (fallback if no start/end).
   * @param {string} [params.start] - exact ISO start time.
   * @param {string} [params.end] - exact ISO end time.
   * @param {string} [params.order_id] - order id to search.
   * @param {number} [params.size=50] - the maximum number of transactions.
   * @param {number} [params.offset=0] - pagination offset.
   * @returns {Promise<Array<{ txId: string|null, amount: number, type: 'payin', time: string|null, raw: object }>>}
   */
  async getRecentTransactions({ days = 1, size = 50, start, end, order_id, offset = 0 } = {}) {
    await this.init();

    const analyticsRaw = await this._fetchAnalytics({ days, size, start, end, order_id, offset });
    if (analyticsRaw && Array.isArray(analyticsRaw.transactions)) {
      return this.adapter.parseAnalyticsTx(analyticsRaw);
    }

    this.logger?.log?.(
      '[GoBizClient] Analytics returned no transactions array; falling back to the journal.',
    );
    const journalRaw = await this._fetchJournal({ days, size, start, end, offset });
    return this.adapter.parseJournalTx(journalRaw);
  }

  /**
   * Fetch the raw analytics response, or `null` when it is unavailable so the
   * caller can fall back to the journal.
   *
   * @param {{ days?: number, size: number, start?: string, end?: string, order_id?: string, offset?: number }} params
   * @returns {Promise<any|null>}
   * @private
   */
  async _fetchAnalytics({ days, size, start, end, order_id, offset }) {
    const url = this._buildAnalyticsUrl({ days, size, start, end, order_id, offset });
    const res = await this._requestWithRetry({ method: 'GET', url });
    if (!res.ok) {
      this.logger?.warn?.(
        `[GoBizClient] Analytics request failed (${res.status}); will try the journal.`,
      );
      return null;
    }
    return this._safeJson(res);
  }

  /**
   * Fetch the raw journal response.
   *
   * @param {{ days?: number, size: number, start?: string, end?: string, offset?: number }} params
   * @returns {Promise<any>}
   * @throws {Error} when the journal request returns a non-OK status.
   * @private
   */
  async _fetchJournal({ days, size, start, end, offset }) {
    const res = await this._requestWithRetry({
      method: 'POST',
      url: this.endpoints.resolveUrl('journalSearch'),
      body: this._buildJournalBody({ days, size, start, end, offset }),
    });
    if (!res.ok) {
      throw new Error(`[GoBizClient] Journal request failed (${res.status}).`);
    }
    return this._safeJson(res);
  }

  /**
   * Perform an authenticated request with the single 401 re-login policy.
   *
   * On a 401 response we invalidate the current token, force a fresh login via
   * the auth manager, and retry the same request exactly once.
   *
   * @param {{ method: string, url: string, body?: any }} req
   * @returns {Promise<import('./http-transport.js').TransportResponse>}
   * @private
   */
  async _requestWithRetry({ method, url, body }) {
    const token = await this.auth.getValidToken();
    let res = await this._send({ method, url, body, token });

    if (res.status === 401) {
      this.logger?.log?.(
        '[GoBizClient] Received 401; invalidating the token and retrying once.',
      );
      await this.auth.invalidate();
      const freshToken = await this.auth.getValidToken({ forceLogin: true });
      res = await this._send({ method, url, body, token: freshToken });
    }

    return res;
  }

  /**
   * Send a single authenticated request through the transport.
   *
   * @param {{ method: string, url: string, body?: any, token: string }} req
   * @returns {Promise<import('./http-transport.js').TransportResponse>}
   * @private
   */
  _send({ method, url, body, token }) {
    const uniqueId = this._generateUniqueId();
    const headers = this.endpoints.buildHeaders(uniqueId, token);
    return this.transport.request({
      method,
      url,
      headers,
      body,
      timeoutMs: this.timeoutMs,
    });
  }

  /**
   * Build the analytics request URL with its query parameters.
   *
   * @param {{ days?: number, size: number, start?: string, end?: string, order_id?: string, offset?: number }} params
   * @returns {string}
   * @private
   */
  _buildAnalyticsUrl({ days, size, start, end, order_id, offset }) {
    let startTime, endTime;
    if (start && end) {
      startTime = start;
      endTime = end;
    } else {
      const window = this._timeWindow(days || 1);
      startTime = window.startTime;
      endTime = window.endTime;
    }
    const url = new URL(this.endpoints.resolveUrl('analytics')); console.log("GZ URL:", url.toString());
    url.searchParams.set('from', String(offset || 0));
    url.searchParams.set('size', String(size));
    url.searchParams.set('statuses', ANALYTICS_STATUSES);
    url.searchParams.set('payment_types', ANALYTICS_PAYMENT_TYPES);
    url.searchParams.set('start_time', startTime);
    url.searchParams.set('end_time', endTime);
    url.searchParams.set('merchant_ids', this.merchantId);
    if (order_id) {
      url.searchParams.set('order_id', order_id);
    }
    let str = url.toString();
    str = str.replace(/%2C/g, ',');
    str = str.replace(/%3A/g, ':');
    return str;
  }

  /**
   * Build the journal search request body.
   *
   * @param {{ days?: number, size: number, start?: string, end?: string, offset?: number }} params
   * @returns {object}
   * @private
   */
  _buildJournalBody({ days, size, start, end, offset }) {
    let startTime, endTime;
    if (start && end) {
      startTime = start;
      endTime = end;
    } else {
      const window = this._timeWindow(days || 1);
      startTime = window.startTime;
      endTime = window.endTime;
    }
    return {
      from: offset || 0,
      size,
      sort: { time: { order: 'desc' } },
      included_categories: { incoming: ['transaction_share', 'action'] },
      query: [
        {
          clauses: [
            {
              op: 'not',
              clauses: [
                {
                  clauses: [
                    {
                      field: 'metadata.source',
                      op: 'in',
                      value: ['GOSAVE_ONLINE', 'GoSave', 'GODEALS_ONLINE'],
                    },
                    {
                      field: 'metadata.gopay.source',
                      op: 'in',
                      value: ['GOSAVE_ONLINE', 'GoSave', 'GODEALS_ONLINE'],
                    },
                  ],
                  op: 'or',
                },
              ],
            },
            {
              field: 'metadata.transaction.status',
              op: 'in',
              value: JOURNAL_STATUSES,
            },
            {
              op: 'or',
              clauses: [
                {
                  op: 'or',
                  clauses: [
                    {
                      field: 'metadata.transaction.payment_type',
                      op: 'in',
                      value: JOURNAL_PAYMENT_TYPES,
                    },
                  ],
                },
              ],
            },
            {
              field: 'metadata.transaction.transaction_time',
              op: 'gte',
              value: startTime,
            },
            {
              field: 'metadata.transaction.transaction_time',
              op: 'lte',
              value: endTime,
            },
            {
              field: 'metadata.transaction.merchant_id',
              op: 'equal',
              value: this.merchantId,
            },
          ],
          op: 'and',
        },
      ],
    };
  }

  /**
   * Compute the ISO-8601 start/end time window for the given number of days.
   *
   * @param {number} days
   * @returns {{ startTime: string, endTime: string }}
   * @private
   */
  _timeWindow(days) {
    const startTime = moment().subtract(days, 'days').tz(this.timezone).toISOString();
    const endTime = moment().tz(this.timezone).toISOString();
    return { startTime, endTime };
  }

  /**
   * Parse a transport response as JSON, tolerating empty/invalid bodies.
   *
   * @param {{ json: () => Promise<any> }} response
   * @returns {Promise<any>} the parsed body, or null when it cannot be parsed.
   * @private
   */
  async _safeJson(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /**
   * Generate a per-request unique id (UUID v4).
   * @returns {string}
   * @private
   */
  _generateUniqueId() {
    return crypto.randomUUID();
  }
}

/**
 * Convenience factory for a GoBizClient.
 *
 * @param {ConstructorParameters<typeof GoBizClient>} args
 * @returns {GoBizClient}
 */
export function createGoBizClient(...args) {
  return new GoBizClient(...args);
}

export default GoBizClient;
