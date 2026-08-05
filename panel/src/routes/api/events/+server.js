import { error } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader,
  isSessionAuthenticated
} from '$lib/server/backend.js';

/**
 * Session-guarded proxy for the backend Server-Sent Events stream
 * (`GET /admin/events`). It verifies the Admin session, then pipes the upstream
 * event stream straight through to the browser's `EventSource` (the BFF
 * pattern).
 *
 * The response body is the upstream `ReadableStream`, so events flush as they
 * arrive. The text/event-stream content type prevents compression/buffering.
 *
 * @type {import('./$types').RequestHandler}
 */
export async function GET({ cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);
  const authenticated = await isSessionAuthenticated(fetch, token);
  if (!authenticated) {
    throw error(401, 'Not authenticated.');
  }

  let upstream;
  try {
    upstream = await fetch(`${getApiBase()}/admin/events`, {
      headers: { ...sessionCookieHeader(token), accept: 'text/event-stream' }
    });
  } catch {
    throw error(502, 'Unable to reach the server.');
  }

  if (!upstream.ok || !upstream.body) {
    throw error(502, 'Event stream is unavailable.');
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    }
  });
}
