import { json, error } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader,
  isSessionAuthenticated
} from '$lib/server/backend.js';

/**
 * Session-guarded proxy for re-dispatching a payment's webhook
 * (`POST /admin/payments/:id/webhook/resend`). The Payments detail drawer calls
 * this from the browser; the Panel verifies the Admin session and forwards the
 * httpOnly session cookie to the backend (the BFF pattern).
 *
 * The backend's status code and body are passed through so the drawer can show
 * the delivery result (a 400 when the payment is not paid or has no webhook
 * URL, a 404 when the payment is missing).
 *
 * @type {import('./$types').RequestHandler}
 */
export async function POST({ params, cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);
  const authenticated = await isSessionAuthenticated(fetch, token);
  if (!authenticated) {
    throw error(401, 'Not authenticated.');
  }

  let response;
  try {
    response = await fetch(
      `${getApiBase()}/admin/payments/${encodeURIComponent(params.id)}/webhook/resend`,
      { method: 'POST', headers: sessionCookieHeader(token) }
    );
  } catch {
    throw error(502, 'Unable to reach the server.');
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return json(body ?? {}, { status: response.status });
}
