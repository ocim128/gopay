// Admin Panel login, session, and rate-limiting.
//
// This module owns the Admin authentication policy that sits on top of the DAL
// `adminUsers` store and the `hashing` primitives:
//
//   - login(username, password) verifies the password against the stored scrypt
//     hash and, on success, mints a session token valid for 24 hours
//     (86,400,000 ms). On failure it returns a single generic error
//     that never reveals whether the username or the password was wrong.
//     Empty username/password are rejected up front.
//   - A consecutive-failure rate limiter blocks login for 15 minutes once 5
//     failures accumulate inside a 15-minute window. The counters are
//     persisted through the DAL so the limit survives restarts.
//   - validateSession(token, now) re-checks the signed token and rejects it once
//     its 24-hour validity has elapsed. Helpers are provided to build
//     the httpOnly session cookie and to recognize unauthenticated requests so
//     the Panel can deny protected access and redirect to login.
//
// No JWT library is a project dependency, so the session token is a compact,
// self-contained, HMAC-SHA256-signed value (`<payloadBase64Url>.<sigBase64Url>`)
// built from Node's core `crypto`. The clock and the signing secret are
// injectable so the behavior is fully deterministic under test.

import { createHmac } from 'node:crypto';

import { verifyPassword, constantTimeEqual } from './hashing.js';

/**
 * Session validity period: 24 hours in milliseconds.
 *
 * @type {number}
 */
export const SESSION_TTL_MS = 86400000;

/**
 * Number of consecutive failed logins, within {@link LOGIN_FAILURE_WINDOW_MS},
 * that triggers a lockout.
 *
 * @type {number}
 */
export const MAX_FAILED_LOGIN_ATTEMPTS = 5;

/**
 * The window within which failures are counted toward a lockout: 15 minutes.
 *
 * @type {number}
 */
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * How long login is blocked once the failure threshold is reached: 15 minutes.
 *
 * @type {number}
 */
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Default name of the httpOnly session cookie the Panel sets after login.
 *
 * @type {string}
 */
export const SESSION_COOKIE_NAME = 'admin_session';

/**
 * Stable, English error codes returned by {@link createAdminAuth}'s `login`.
 *
 * - `MISSING_CREDENTIALS` — the username or password was empty.
 * - `INVALID_CREDENTIALS` — a generic wrong username/password result that does
 *   not reveal which field was incorrect.
 * - `ACCOUNT_LOCKED` — too many recent failures; login is blocked.
 *
 * @type {Readonly<Record<string, string>>}
 */
export const ADMIN_AUTH_ERRORS = Object.freeze({
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
});

/**
 * A generic, English login-failure message that intentionally does not say
 * whether the username or the password was wrong.
 *
 * @type {string}
 */
const GENERIC_LOGIN_ERROR_MESSAGE = 'Invalid username or password.';

/**
 * Encode a Buffer or UTF-8 string as URL-safe base64 without padding.
 *
 * @param {Buffer|string} input
 * @returns {string}
 */
function toBase64Url(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return buffer.toString('base64url');
}

/**
 * Compute the HMAC-SHA256 signature of `data` under `secret`, URL-safe encoded.
 *
 * @param {string} data
 * @param {string} secret
 * @returns {string}
 */
function sign(data, secret) {
  return createHmac('sha256', secret).update(data, 'utf8').digest('base64url');
}

/**
 * Determine whether a value is a non-empty, non-whitespace-only string.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isNonBlankString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Build a signed session token for `username` valid for `ttlMs` from `issuedAt`.
 *
 * The token is `<payloadBase64Url>.<signatureBase64Url>`, where the payload is
 * JSON `{ username, iat, exp }`. It is stateless: validation needs only the
 * secret, not server-side storage.
 *
 * @param {string} username
 * @param {number} issuedAt - epoch ms.
 * @param {number} ttlMs - validity in ms.
 * @param {string} secret
 * @returns {{ token: string, session: { username: string, issuedAt: number, expiresAt: number } }}
 */
function createSessionToken(username, issuedAt, ttlMs, secret) {
  const expiresAt = issuedAt + ttlMs;
  const payload = { username, iat: issuedAt, exp: expiresAt };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(encodedPayload, secret);
  return {
    token: `${encodedPayload}.${signature}`,
    session: { username, issuedAt, expiresAt },
  };
}

/**
 * Verify a session token's signature and decode its payload. Returns `null`
 * when the token is malformed or the signature does not match (so a tampered or
 * foreign token is indistinguishable from an absent one).
 *
 * @param {unknown} token
 * @param {string} secret
 * @returns {{ username: string, iat: number, exp: number }|null}
 */
function decodeSessionToken(token, secret) {
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }
  const separatorIndex = token.indexOf('.');
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    return null;
  }
  const encodedPayload = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);

  const expected = sign(encodedPayload, secret);
  if (!constantTimeEqual(signature, expected)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof payload.username !== 'string' ||
    typeof payload.iat !== 'number' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  return payload;
}

/**
 * Build the `Set-Cookie` header value carrying a session token. The cookie is
 * `HttpOnly` (not script-readable), `SameSite=Strict`, scoped to the whole
 * site, and given a `Max-Age` matching the session TTL. `Secure` is
 * added unless explicitly disabled (e.g. for local HTTP development).
 *
 * @param {string} token
 * @param {Object} [options]
 * @param {string} [options.cookieName]
 * @param {number} [options.ttlMs]
 * @param {boolean} [options.secure]
 * @returns {string}
 */
export function buildSessionCookie(token, options = {}) {
  const cookieName = options.cookieName ?? SESSION_COOKIE_NAME;
  const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  const secure = options.secure ?? true;
  const maxAgeSeconds = Math.floor(ttlMs / 1000);

  const attributes = [
    `${cookieName}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/**
 * Build a `Set-Cookie` header value that immediately clears the session cookie
 * (used on logout or when an expired session is detected).
 *
 * @param {Object} [options]
 * @param {string} [options.cookieName]
 * @param {boolean} [options.secure]
 * @returns {string}
 */
export function buildClearedSessionCookie(options = {}) {
  const cookieName = options.cookieName ?? SESSION_COOKIE_NAME;
  const secure = options.secure ?? true;
  const attributes = [`${cookieName}=`, 'HttpOnly', 'Path=/', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) {
    attributes.push('Secure');
  }
  return attributes.join('; ');
}

/**
 * Create the Admin authentication facade bound to a DAL storage instance.
 *
 * Dependencies are injectable for deterministic testing:
 *   - `now`    : clock; defaults to `Date.now`.
 *   - `secret` : HMAC signing secret for session tokens; defaults to
 *                `process.env.ADMIN_SESSION_SECRET`. Required (throws if absent)
 *                so tokens are never signed with an empty/guessable key.
 *   - `sessionTtlMs` : session validity; defaults to {@link SESSION_TTL_MS}.
 *   - `cookieName`, `secure` : passed through to the cookie builders.
 *
 * @param {import('../dal/storage-interface.js').Storage} storage
 * @param {Object} [deps]
 * @param {() => number} [deps.now]
 * @param {string} [deps.secret]
 * @param {number} [deps.sessionTtlMs]
 * @param {string} [deps.cookieName]
 * @param {boolean} [deps.secure]
 * @returns {{
 *   login: (username: string, password: string, ipAddress: string) => Promise<
 *     { ok: true, token: string, cookie: string, session: { username: string, issuedAt: number, expiresAt: number } } |
 *     { ok: false, code: string, message: string }
 *   >,
 *   validateSession: (token: string, now?: number) => { valid: true, session: { username: string, issuedAt: number, expiresAt: number } } | { valid: false, reason: 'INVALID'|'EXPIRED' },
 *   isAuthenticated: (token: string, now?: number) => boolean,
 *   buildCookie: (token: string) => string,
 *   buildClearedCookie: () => string
 * }}
 */
export function createAdminAuth(storage, deps = {}) {
  if (
    storage === null ||
    typeof storage !== 'object' ||
    typeof storage.adminUsers !== 'object' ||
    typeof storage.loginAttempts !== 'object'
  ) {
    throw new TypeError('createAdminAuth requires a Storage instance with adminUsers and loginAttempts stores.');
  }

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const secret = deps.secret ?? process.env.ADMIN_SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError(
      'createAdminAuth requires a non-empty signing secret (deps.secret or ADMIN_SESSION_SECRET).',
    );
  }
  const sessionTtlMs =
    typeof deps.sessionTtlMs === 'number' && deps.sessionTtlMs > 0
      ? deps.sessionTtlMs
      : SESSION_TTL_MS;
  const cookieName = deps.cookieName ?? SESSION_COOKIE_NAME;
  const secure = deps.secure ?? true;

  /**
   * Authenticate an admin with a username and password.
   *
   * On success a session token + httpOnly cookie are returned. On
   * any credential failure a single generic error is returned that does not
   * reveal which field was wrong. Empty fields are rejected before
   * any lookup, and repeated failures lead to a temporary lock.
   *
   * @param {string} username
   * @param {string} password
   * @param {string} ipAddress
   * @returns {Promise<
   *   { ok: true, token: string, cookie: string, session: { username: string, issuedAt: number, expiresAt: number } } |
   *   { ok: false, code: string, message: string }
   * >}
   */
  async function login(username, password, ipAddress) {
    // Reject empty/whitespace username or empty password without a lookup.
    if (!isNonBlankString(username) || typeof password !== 'string' || password.length === 0) {
      return {
        ok: false,
        code: ADMIN_AUTH_ERRORS.MISSING_CREDENTIALS,
        message: 'Username and password are required.',
      };
    }

    const at = now();

    // Refuse before verifying when the IP is already blocked.
    if (await storage.loginAttempts.isLockedOut(ipAddress, at)) {
      return {
        ok: false,
        code: ADMIN_AUTH_ERRORS.ACCOUNT_LOCKED,
        message: 'Too many failed login attempts. Try again later.',
      };
    }

    const user = await storage.adminUsers.getByUsername(username);

    // Verify the password. When the user is unknown there is no stored hash;
    // verifyPassword returns false for a null/invalid hash, so both the
    // unknown-user and wrong-password paths converge on the same generic error
    // and neither reveals which field was wrong.
    const passwordOk =
      user !== null && (await verifyPassword(password, user.password_hash));

    if (!passwordOk) {
      // Track the failure for the IP Address. We track failures for the IP regardless
      // of whether the username is valid or not, preventing an attacker from
      // probing unknown usernames without penalty. The fixed-window policy is
      // applied atomically inside the DAL so concurrent login attempts cannot
      // race past the threshold.
      await storage.loginAttempts.recordFailure(ipAddress, {
        now: at,
        windowMs: LOGIN_FAILURE_WINDOW_MS,
        threshold: MAX_FAILED_LOGIN_ATTEMPTS,
        lockoutMs: LOGIN_LOCKOUT_MS,
      });

      return {
        ok: false,
        code: ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS,
        message: GENERIC_LOGIN_ERROR_MESSAGE,
      };
    }

    // Success: clear the failure counters for the IP and mint a 24h session.
    await storage.loginAttempts.resetFailures(ipAddress);
    const { token, session } = createSessionToken(username, at, sessionTtlMs, secret);
    return {
      ok: true,
      token,
      cookie: buildSessionCookie(token, { cookieName, ttlMs: sessionTtlMs, secure }),
      session,
    };
  }

  /**
   * Validate a session token. A token with a bad/absent signature or malformed
   * payload is `INVALID`; a well-formed token whose 24-hour validity has elapsed
   * is `EXPIRED`. Only a valid, unexpired token authenticates.
   *
   * @param {string} token
   * @param {number} [at] - epoch ms; defaults to the injected clock.
   * @returns {{ valid: true, session: { username: string, issuedAt: number, expiresAt: number } } | { valid: false, reason: 'INVALID'|'EXPIRED' }}
   */
  function validateSession(token, at = now()) {
    const payload = decodeSessionToken(token, secret);
    if (payload === null) {
      return { valid: false, reason: 'INVALID' };
    }
    if (at >= payload.exp) {
      return { valid: false, reason: 'EXPIRED' };
    }
    return {
      valid: true,
      session: { username: payload.username, issuedAt: payload.iat, expiresAt: payload.exp },
    };
  }

  /**
   * Convenience predicate the Panel uses to gate protected pages: returns true
   * only for a valid, unexpired session, so an unauthenticated or expired
   * request is denied and can be redirected to login.
   *
   * @param {string} token
   * @param {number} [at]
   * @returns {boolean}
   */
  function isAuthenticated(token, at = now()) {
    return validateSession(token, at).valid === true;
  }

  return {
    login,
    validateSession,
    isAuthenticated,
    buildCookie: (token) => buildSessionCookie(token, { cookieName, ttlMs: sessionTtlMs, secure }),
    buildClearedCookie: () => buildClearedSessionCookie({ cookieName, secure }),
  };
}
