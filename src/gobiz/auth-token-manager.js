// Auth token manager for the GoBiz Integration Layer.
//
// This module owns everything related to authentication against GoBiz:
//   - loading a previously persisted token from the (encrypted) token store
//   - validating that token against the API
//   - logging in to obtain a fresh token (loginRequest + token exchange)
//   - persisting the token through the token store
//   - the SINGLE 401 re-login policy for the whole integration layer
//
// Login is performed through the pluggable `HttpTransport`, and the 401 policy
// lives in exactly one place via `invalidate()` + a fresh `login()`.

import crypto from 'node:crypto';
import { GOBIZ } from './endpoints.config.js';

// Client id used for the GoBiz GoID login/grant flow.
const GRANT_TYPE_PASSWORD = 'password';
const LOGIN_TYPE_PASSWORD = 'password';

/**
 * Manages the GoBiz access token: load, validate, login, and invalidate.
 *
 * The 401 re-login policy is centralized here. Callers that receive a 401 from
 * a downstream GoBiz call should call `invalidate()` and then retry once with a
 * token obtained from `getValidToken()`; this manager is the only place that
 * knows how to discard and re-acquire a token.
 */
export class AuthTokenManager {
  /**
   * @param {import('./http-transport.js').HttpTransport} transport - the
   *   pluggable HTTP transport used for all login requests.
   * @param {import('./token-store.js').TokenStore} tokenStore - the persistent
   *   (encrypted) token store used to cache the token at-rest.
   * @param {object} credentials - the login credentials.
   * @param {string} credentials.email - the GoBiz account email.
   * @param {string} credentials.password - the GoBiz account password.
   * @param {object} [options]
   * @param {typeof GOBIZ} [options.endpoints] - endpoint/header configuration.
   *   Defaults to the shared GOBIZ config.
   * @param {Pick<Console, 'log' | 'warn'>} [options.logger] - logger for
   *   informational and warning messages.
   * @param {number} [options.timeoutMs] - per-request timeout for login calls.
   */
  constructor(transport, tokenStore, credentials = {}, options = {}) {
    if (!transport || typeof transport.request !== 'function') {
      throw new TypeError(
        'AuthTokenManager requires an HttpTransport with a request() method.',
      );
    }
    if (!tokenStore || typeof tokenStore.load !== 'function') {
      throw new TypeError(
        'AuthTokenManager requires a TokenStore with load/save/clear methods.',
      );
    }

    this.transport = transport;
    this.tokenStore = tokenStore;
    this.credentials = credentials;
    this.endpoints = options.endpoints ?? GOBIZ;
    this.logger = options.logger ?? console;
    this.timeoutMs = options.timeoutMs;

    // In-memory cache of the current token, mirroring what is in the store.
    this._token = null;
  }

  /**
   * Return a valid access token.
   *
   * Resolution order:
   *   1. Use the in-memory token if present (and not forced to re-login).
   *   2. Load the token from the store and validate it against the API; if it
   *      is still accepted, cache and return it.
   *   3. Otherwise perform a fresh login.
   *
   * @param {object} [options]
   * @param {boolean} [options.forceLogin=false] - skip the cache/validation and
   *   force a fresh login (used by the 401 re-login policy).
   * @returns {Promise<string>} a usable access token.
   */
  async getValidToken({ forceLogin = false } = {}) {
    if (!forceLogin) {
      if (this._token) {
        return this._token;
      }

      const stored = this.tokenStore.load();
      if (stored && (await this._isTokenValid(stored))) {
        this.logger?.log?.('[AuthTokenManager] Loaded a valid token from the store.');
        this._token = stored;
        return stored;
      }

      if (stored) {
        this.logger?.log?.(
          '[AuthTokenManager] The stored token is invalid or expired. Logging in again.',
        );
      }
    }

    return this.login();
  }

  /**
   * Perform a fresh login and persist the resulting token:
   *   1. POST `loginRequest` to validate the email (errors here are warnings).
   *   2. POST `token` to exchange the password for an access token.
   *
   * @returns {Promise<string>} the freshly issued access token.
   * @throws {Error} when credentials are missing or the token exchange fails.
   */
  async login() {
    const { email, password } = this.credentials ?? {};
    if (!email || !password) {
      throw new Error(
        '[AuthTokenManager] Missing credentials: both email and password are required.',
      );
    }

    const uniqueId = this._generateUniqueId();
    const headers = this.endpoints.buildHeaders(uniqueId);

    // Step 1: validate the email. Errors here are non-fatal warnings;
    // the token exchange below is the authoritative step.
    this.logger?.log?.(`[AuthTokenManager] Validating email: ${email}`);
    const requestRes = await this.transport.request({
      method: 'POST',
      url: this.endpoints.resolveUrl('loginRequest'),
      headers,
      body: {
        email,
        login_type: LOGIN_TYPE_PASSWORD,
        client_id: this.endpoints.clientId,
      },
      timeoutMs: this.timeoutMs,
    });

    const requestData = await this._safeJson(requestRes);
    if (requestData?.errors?.length > 0) {
      this.logger?.warn?.(
        `[AuthTokenManager] Email validation warning: ${requestData.errors[0].message}`,
      );
    }

    // Step 2: exchange the password for an access token.
    this.logger?.log?.('[AuthTokenManager] Submitting login credentials...');
    const tokenRes = await this.transport.request({
      method: 'POST',
      url: this.endpoints.resolveUrl('token'),
      headers,
      body: {
        client_id: this.endpoints.clientId,
        grant_type: GRANT_TYPE_PASSWORD,
        data: { email, password },
      },
      timeoutMs: this.timeoutMs,
    });

    const tokenData = await this._safeJson(tokenRes);
    if (tokenData?.errors?.length > 0) {
      const message =
        tokenData.errors[0].message ||
        'Incorrect password or the account has a problem.';
      throw new Error(`[AuthTokenManager] Login failed: ${message}`);
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      throw new Error(
        '[AuthTokenManager] Login failed: the token response did not contain an access_token.',
      );
    }

    this._token = accessToken;
    this.tokenStore.save(accessToken);
    this.logger?.log?.('[AuthTokenManager] Login succeeded; token persisted to the store.');

    return accessToken;
  }

  /**
   * Discard the current token (in-memory and on-disk).
   *
   * This is the entry point of the single 401 re-login policy: when a
   * downstream GoBiz call returns 401, the caller invalidates the token here
   * and then retries with a token from `getValidToken()`, which will perform a
   * fresh login because the store has been cleared.
   *
   * @returns {Promise<void>}
   */
  async invalidate() {
    this._token = null;
    this.tokenStore.clear();
    this.logger?.log?.('[AuthTokenManager] Token invalidated and removed from the store.');
  }

  /**
   * Probe whether a token is still accepted by the API.
   *
   * Uses a lightweight authenticated request to the merchants endpoint and
   * treats any non-401 status as "still valid". Network failures are treated as
   * "not valid" so the caller falls back to a fresh login.
   *
   * @param {string} token - the access token to validate.
   * @returns {Promise<boolean>}
   * @private
   */
  async _isTokenValid(token) {
    try {
      const uniqueId = this._generateUniqueId();
      const res = await this.transport.request({
        method: 'POST',
        url: this.endpoints.resolveUrl('merchants'),
        headers: this.endpoints.buildHeaders(uniqueId, token),
        body: { from: 0, to: 1, _source: ['id'] },
        timeoutMs: this.timeoutMs,
      });
      return res.status !== 401;
    } catch {
      return false;
    }
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
 * Convenience factory for an AuthTokenManager.
 *
 * @param {ConstructorParameters<typeof AuthTokenManager>} args
 * @returns {AuthTokenManager}
 */
export function createAuthTokenManager(...args) {
  return new AuthTokenManager(...args);
}

export default AuthTokenManager;
