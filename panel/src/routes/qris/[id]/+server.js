import { error } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader
} from '$lib/server/backend.js';

/**
 * Panel proxy for a Payment's QRIS image. The backend serves
 * the PNG under the Admin session at `GET /admin/payments/:id/qris.png`, so the
 * Panel server forwards the httpOnly session cookie and streams the image back
 * to the browser. This lets an `<img>` tag display the code without exposing
 * the REST_API key, and without the browser needing to talk to the backend
 * directly.
 *
 * @type {import('./$types').RequestHandler}
 */
export async function GET({ params, cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);
  if (!token) {
    throw error(401, 'Not authenticated.');
  }

  let response;
  try {
    response = await fetch(
      `${getApiBase()}/admin/payments/${encodeURIComponent(params.id)}/qris.png`,
      { headers: sessionCookieHeader(token) }
    );
  } catch {
    throw error(502, 'Unable to reach the server.');
  }

  if (!response.ok) {
    throw error(response.status === 404 ? 404 : 502, 'QRIS image is unavailable.');
  }

  const body = Buffer.from(await response.arrayBuffer());
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'image/png',
      'cache-control': 'no-store'
    }
  });
}
