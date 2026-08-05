import { json, error } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader,
  isSessionAuthenticated
} from '$lib/server/backend.js';

/**
 * Session-guarded proxy for a single payment's full detail
 * (`GET /admin/payments/:id`), including its `webhook_logs`. The Payments
 * detail drawer fetches this from the browser; the Panel verifies the Admin
 * session and forwards the httpOnly session cookie to the backend (the BFF
 * pattern).
 *
 * The backend's status code is passed through so the drawer can show a 404
 * ("payment not found") distinctly from a transient failure.
 *
 * @type {import('./$types').RequestHandler}
 */
export async function GET({ params, cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);
  const authenticated = await isSessionAuthenticated(fetch, token);
  if (!authenticated) {
    throw error(401, 'Not authenticated.');
  }

  let response;
  try {
    response = await fetch(
      `${getApiBase()}/admin/payments/${encodeURIComponent(params.id)}`,
      { headers: sessionCookieHeader(token) }
    );
  } catch {
    throw error(502, 'Unable to reach the server.');
  }

  if (response.status === 404) {
    throw error(404, 'Payment not found.');
  }

  if (!response.ok) {
    throw error(502, 'Unable to load the payment.');
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    throw error(502, 'Received an unexpected response.');
  }

  return json(body ?? {});
}
