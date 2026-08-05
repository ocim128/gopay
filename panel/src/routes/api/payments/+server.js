import { json, error } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader,
  isSessionAuthenticated
} from '$lib/server/backend.js';

/**
 * Allowed status filters mirrored from the backend. Any other value is dropped
 * so the backend treats the request as "all statuses".
 *
 * @type {ReadonlySet<string>}
 */
const ALLOWED_STATUSES = new Set(['all', 'pending', 'paid', 'expired']);

/**
 * JSON endpoint that the unified Payments page polls for auto-refresh while
 * viewing the pending/all filters. It verifies the Admin
 * session, then proxies the admin-session-guarded backend endpoint
 * (`GET /admin/payments?status=&limit=&offset=`), forwarding the httpOnly
 * session cookie, and returns `{ payments, total, limit, offset }`.
 *
 * Returning a 401 here (rather than redirecting) lets the client-side poller
 * detect an expired session and send the user back to the login page.
 *
 * @type {import('./$types').RequestHandler}
 */
export async function GET({ url, cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);
  const authenticated = await isSessionAuthenticated(fetch, token);
  if (!authenticated) {
    throw error(401, 'Not authenticated.');
  }

  const rawStatus = url.searchParams.get('status') ?? 'all';
  const status = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : 'all';

  const rawLimit = Number(url.searchParams.get('limit'));
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? rawLimit : 50;

  const rawOffset = Number(url.searchParams.get('offset'));
  const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const query = new URLSearchParams({
    status,
    limit: String(limit),
    offset: String(offset)
  });

  const id = url.searchParams.get('id');
  if (id) query.set('id', id);

  const date = url.searchParams.get('date');
  if (date) query.set('date', date);

  let response;
  try {
    response = await fetch(`${getApiBase()}/admin/payments?${query.toString()}`, {
      headers: sessionCookieHeader(token)
    });
  } catch {
    throw error(502, 'Unable to reach the server.');
  }

  if (!response.ok) {
    throw error(502, 'Unable to load payments.');
  }

  let payments = [];
  let total = 0;
  try {
    const body = await response.json();
    if (Array.isArray(body.payments)) {
      payments = body.payments;
    }
    if (Number.isInteger(body.total)) {
      total = body.total;
    }
  } catch {
    payments = [];
  }

  return json({ payments, total, limit, offset });
}
