import { fail } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader
} from '$lib/server/backend.js';

/**
 * Server load for the Merchant Profile page. Reads the current
 * merchant info from the admin-session-guarded backend endpoint
 * (`GET /admin/merchant/info`), forwarding the httpOnly Admin session cookie.
 *
 * @type {import('./$types').PageServerLoad}
 */
export async function load({ cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);

  let response;
  try {
    response = await fetch(`${getApiBase()}/admin/merchant/info`, {
      headers: sessionCookieHeader(token)
    });
  } catch {
    return { profile: null, loadError: 'Unable to reach the server.' };
  }

  if (response.status === 404) {
    return { profile: null, loadError: 'Merchant profile not found or not yet fetched.' };
  }

  if (!response.ok) {
    let msg = 'Failed to load merchant profile.';
    try {
      const data = await response.json();
      if (data?.message) msg = data.message;
    } catch {}
    return { profile: null, loadError: msg };
  }

  try {
    const data = await response.json();
    return { profile: data, loadError: null };
  } catch {
    return { profile: null, loadError: 'Invalid response from server.' };
  }
}
