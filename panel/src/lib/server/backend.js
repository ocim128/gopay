import { env } from '$env/dynamic/private';

/**
 * Server-only helpers for talking to the GoPay Payment Panel REST_API.
 *
 * All calls happen on the Panel server (a backend-for-frontend pattern) so the
 * httpOnly Admin session cookie is read on the server and forwarded to the
 * backend, never exposed to browser scripts.
 */

/**
 * Name of the httpOnly Admin session cookie issued by the backend admin login.
 *
 * @type {string}
 */
export const SESSION_COOKIE_NAME = 'admin_session';

/**
 * Resolve the backend base URL from the environment, defaulting to the local
 * backend on port 3000.
 *
 * @returns {string}
 */
export function getApiBase() {
  const base = env.API_BASE ?? 'http://localhost:3000';
  // Strip a trailing slash so callers can safely concatenate `/path`.
  return base.replace(/\/+$/, '');
}

/**
 * Resolve the server-held REST_API key used by the Panel (BFF) to call the
 * API-key-protected payment endpoints (`POST /payment`, `GET /payments`,
 * `GET /payment/:id`). The Panel itself is authenticated by the Admin session
 * cookie; this key is held only on the Panel server and is never exposed to the
 * browser.
 *
 * @returns {string}
 */
export function getApiKey() {
  return env.PANEL_API_KEY ?? '';
}

/**
 * Build an `Authorization: Bearer <api_key>` header for the REST_API. Returns an
 * empty object when no key is configured so callers can spread it safely; a
 * missing key then surfaces as the backend's own 401.
 *
 * @returns {Record<string, string>}
 */
export function apiKeyHeader() {
  const key = getApiKey();
  if (key.length === 0) {
    return {};
  }
  return { authorization: `Bearer ${key}` };
}

/**
 * Build a `Cookie` header that carries the Admin session token to the backend.
 *
 * @param {string|undefined} token
 * @returns {Record<string, string>}
 */
export function sessionCookieHeader(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return {};
  }
  return { cookie: `${SESSION_COOKIE_NAME}=${token}` };
}

/**
 * Check whether an Admin session token is currently valid by calling a
 * session-guarded backend endpoint (`GET /admin/config`). A 2xx response means
 * the session is authenticated; any other status (including 401) or a network
 * error means it is not.
 *
 * @param {typeof fetch} fetchFn - the request-scoped fetch from SvelteKit.
 * @param {string|undefined} token - the Admin session token, if any.
 * @returns {Promise<boolean>}
 */
export async function isSessionAuthenticated(fetchFn, token) {
  if (typeof token !== 'string' || token.length === 0) {
    return false;
  }
  try {
    const response = await fetchFn(`${getApiBase()}/admin/config`, {
      headers: sessionCookieHeader(token)
    });
    return response.ok;
  } catch {
    // Treat an unreachable backend as unauthenticated so protected pages
    // redirect to login rather than rendering without data.
    return false;
  }
}

/**
 * Extract the Admin session token from a backend `Set-Cookie` header value.
 *
 * @param {string|null|undefined} setCookieHeader
 * @returns {string|null}
 */
export function extractSessionToken(setCookieHeader) {
  if (typeof setCookieHeader !== 'string' || setCookieHeader.length === 0) {
    return null;
  }
  const match = setCookieHeader.match(
    new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`)
  );
  if (match === null) {
    return null;
  }
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}
