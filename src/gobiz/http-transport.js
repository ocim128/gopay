// Pluggable HTTP transport for the GoBiz Integration Layer.
//
// This module unifies all outbound HTTP into a single `fetch`-based interface,
// so the integration layer has no dependency on an external `curl` binary.
//
// The transport is intentionally pluggable: the GoBizClient facade receives a
// transport instance through its constructor. That makes it trivial to swap in
// a different implementation (undici, a proxy-aware client, HTTP/2) or a mock
// during testing without touching any business logic.
//
// The transport only sends a request and returns the response; it does not
// implement retry or re-login policies. The single 401 re-login policy lives in
// the AuthTokenManager so there is exactly one place that owns it.

/**
 * The normalized response returned by HttpTransport.request.
 *
 * The body is read and buffered exactly once, so `json()` and `text()` can be
 * called in any order and any number of times without throwing the "body
 * already consumed" error that a raw fetch Response would.
 *
 * @typedef {Object} TransportResponse
 * @property {number} status - the HTTP status code (0 is never used here).
 * @property {boolean} ok - true when the status is in the 200..299 range.
 * @property {() => Promise<any>} json - parse the buffered body as JSON.
 * @property {() => Promise<string>} text - return the buffered body as text.
 */

/** Default per-request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * A thin, pluggable HTTP transport built on the global `fetch` API.
 *
 * Usage:
 *   const transport = new HttpTransport();
 *   const res = await transport.request({
 *     method: 'POST',
 *     url: 'https://api.gobiz.co.id/goid/token',
 *     headers: { 'Content-Type': 'application/json' },
 *     body: { client_id: 'go-biz-web-new' },
 *     timeoutMs: 15000,
 *   });
 *   if (res.ok) { const data = await res.json(); }
 */
export class HttpTransport {
  /**
   * @param {Object} [options]
   * @param {typeof fetch} [options.fetchImpl] - a custom fetch implementation,
   *   primarily for testing. Defaults to the global `fetch`.
   * @param {number} [options.defaultTimeoutMs] - the default timeout applied
   *   when a request does not specify one. Defaults to 30000ms.
   */
  constructor(options = {}) {
    const { fetchImpl, defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = options;

    // Bind to the global fetch when no implementation is injected. Binding to
    // `globalThis` avoids "Illegal invocation" errors in some runtimes.
    this._fetch =
      fetchImpl ??
      (typeof fetch === 'function' ? fetch.bind(globalThis) : undefined);

    if (typeof this._fetch !== 'function') {
      throw new Error(
        'HttpTransport requires a global fetch implementation (Node.js >= 18) or an injected fetchImpl.',
      );
    }

    this._defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Send an HTTP request and return a normalized response.
   *
   * @param {Object} req
   * @param {string} [req.method='GET'] - the HTTP method.
   * @param {string} req.url - the absolute request URL.
   * @param {Record<string, string>} [req.headers] - request headers.
   * @param {string|object|null} [req.body] - the request body. Plain objects
   *   are serialized to JSON automatically; strings are sent as-is.
   * @param {number} [req.timeoutMs] - per-request timeout in milliseconds.
   *   Falls back to the transport's default when omitted.
   * @returns {Promise<TransportResponse>}
   * @throws {Error} when the URL is missing, the request fails at the network
   *   level, or the timeout elapses before a response is received.
   */
  async request({ method = 'GET', url, headers = {}, body, timeoutMs } = {}) {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('HttpTransport.request requires a non-empty url.');
    }

    const effectiveTimeout =
      typeof timeoutMs === 'number' && timeoutMs > 0
        ? timeoutMs
        : this._defaultTimeoutMs;

    // AbortController enforces the timeout: when the timer fires we abort the
    // in-flight request, which rejects the fetch promise.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    const init = {
      method,
      headers,
      signal: controller.signal,
    };

    // Serialize plain-object bodies to JSON; pass strings (or other
    // BodyInit values) through untouched. GET/HEAD must not carry a body.
    if (body !== undefined && body !== null && method !== 'GET' && method !== 'HEAD') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    let response;
    let rawText;
    try {
      response = await this._fetch(url, init);
      rawText = await response.text();
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error(
          `HttpTransport request to ${url} timed out after ${effectiveTimeout}ms.`,
        );
      }
      throw new Error(`HttpTransport request to ${url} failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    // Buffer the body exactly once so json()/text() are safe to call repeatedly
    // and in any order. A raw fetch Response body can only be consumed once.
    return {
      status: response.status,
      ok: response.ok,
      text: async () => rawText,
      json: async () => {
        try {
          return JSON.parse(rawText);
        } catch (error) {
          throw new Error(
            `HttpTransport failed to parse JSON response from ${url}: ${error.message}`,
          );
        }
      },
    };
  }
}

export default HttpTransport;
