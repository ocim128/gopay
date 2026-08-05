import { json, error } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader,
  isSessionAuthenticated
} from '$lib/server/backend.js';

/** Clamp bounds mirrored from the backend's `/admin/transactions` handler. */
const DEFAULT_DAYS = 30;
const MIN_DAYS = 1;
const MAX_DAYS = 30;
const DEFAULT_SIZE = 100;
const MIN_SIZE = 1;
const MAX_SIZE = 100;

/**
 * @param {string|null} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) return fallback;
  return n > max ? max : n;
}

/**
 * Session-guarded proxy for recent provider transactions
 * (`GET /admin/transactions?days=&size=`). Used by the Payments detail drawer to
 * render the SAME live Transaction Detail as the Transactions page (matched by
 * txId), so the two views are identical rather than relying on the leaner
 * settlement-time snapshot. BFF pattern.
 *
 * @type {import('./$types').RequestHandler}
 */
export async function GET({ url, cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);
  const authenticated = await isSessionAuthenticated(fetch, token);
  if (!authenticated) {
    throw error(401, 'Not authenticated.');
  }

  const query = new URLSearchParams({
    days: String(clampInt(url.searchParams.get('days'), DEFAULT_DAYS, MIN_DAYS, MAX_DAYS)),
    size: String(clampInt(url.searchParams.get('size'), DEFAULT_SIZE, MIN_SIZE, MAX_SIZE))
  });

  let response;
  try {
    response = await fetch(`${getApiBase()}/admin/transactions?${query.toString()}`, {
      headers: sessionCookieHeader(token)
    });
  } catch {
    throw error(502, 'Unable to reach the server.');
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return json(body ?? { transactions: [] }, { status: response.status });
}
