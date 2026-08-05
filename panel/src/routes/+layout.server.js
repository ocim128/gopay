import { redirect } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader,
  isSessionAuthenticated
} from '$lib/server/backend.js';

/**
 * Routes that are reachable without an authenticated Admin session. Every other
 * route is protected and redirects to `/login` when unauthenticated.
 *
 * @type {ReadonlySet<string>}
 */
const PUBLIC_PATHS = new Set(['/login']);

/**
 * Root layout guard. Runs on the server for every route so it can read the
 * httpOnly Admin session cookie and verify it against the backend.
 *
 * - Unauthenticated access to a protected page redirects to `/login`.
 * - An authenticated Admin visiting `/login` is redirected to the dashboard.
 *
 * @type {import('./$types').LayoutServerLoad}
 */
export async function load({ url, cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);
  const authenticated = await isSessionAuthenticated(fetch, token);
  const isPublic = PUBLIC_PATHS.has(url.pathname);

  if (!authenticated && !isPublic) {
    throw redirect(303, '/login');
  }
  if (authenticated && isPublic) {
    throw redirect(303, '/');
  }

  // A lightweight summary for the topbar (poll interval, display timezone, and
  // the resolved merchant). Best-effort: failures fall back to nulls so the
  // chrome never breaks if the backend is briefly unreachable.
  const summary = {
    poll_interval: null,
    display_timezone: null,
    merchant_id: null,
    merchant_name: null
  };

  if (authenticated) {
    try {
      const [configRes, merchantRes] = await Promise.all([
        fetch(`${getApiBase()}/admin/config`, { headers: sessionCookieHeader(token) }),
        fetch(`${getApiBase()}/admin/merchant`, { headers: sessionCookieHeader(token) })
      ]);
      if (configRes.ok) {
        const config = await configRes.json();
        summary.poll_interval = config?.poll_interval ?? null;
        summary.display_timezone = config?.display_timezone ?? null;
      }
      if (merchantRes.ok) {
        const merchant = await merchantRes.json();
        summary.merchant_id = merchant?.id ?? null;
        summary.merchant_name = merchant?.name ?? null;
      }
    } catch {
      // Ignore — the topbar simply renders without the summary chips.
    }
  }

  return { authenticated, summary };
}
