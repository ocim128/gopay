import { redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader
} from '$lib/server/backend.js';

/**
 * Logout form action. Clears the Panel's Admin session cookie and best-effort
 * notifies the backend to clear its session, then redirects to the login page.
 *
 * @type {import('./$types').Actions}
 */
export const actions = {
  default: async ({ cookies, fetch }) => {
    const token = cookies.get(SESSION_COOKIE_NAME);

    if (token) {
      try {
        await fetch(`${getApiBase()}/admin/logout`, {
          method: 'POST',
          headers: sessionCookieHeader(token)
        });
      } catch {
        // Clearing the local cookie below is sufficient even if the backend
        // call fails.
      }
    }

    // Delete with the SAME attributes the cookie was set with at login
    // (login/+page.server.js). SvelteKit's `cookies.delete` defaults to
    // `secure: true` + `sameSite: 'lax'`, and over plain http:// the browser
    // rejects a `Secure` Set-Cookie outright — so the deletion would be ignored
    // and the user would stay logged in. Mirroring the original options keeps
    // the clear working whether served over http or https.
    cookies.delete(SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: env.NODE_ENV === 'production'
    });
    throw redirect(303, '/login');
  }
};
