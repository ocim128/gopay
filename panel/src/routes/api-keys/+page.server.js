import { fail } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader
} from '$lib/server/backend.js';

/**
 * Server load for the API Keys page. Fetches the
 * masked list of API keys from the admin-session-guarded backend endpoint
 * (`GET /admin/api-keys`), forwarding the httpOnly Admin session cookie (the
 * BFF pattern). The backend never returns the hash or the
 * full key value here — only the display prefix, status, and timestamps.
 *
 * @type {import('./$types').PageServerLoad}
 */
export async function load({ cookies, fetch, url }) {
  const token = cookies.get(SESSION_COOKIE_NAME);
  const statusFilter = url.searchParams.get('status') || 'active';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const pageSize = 20;

  let response;
  try {
    response = await fetch(`${getApiBase()}/admin/api-keys`, {
      headers: sessionCookieHeader(token)
    });
  } catch {
    return { keys: [], loadError: 'Unable to reach the server.' };
  }

  if (!response.ok) {
    return { keys: [], loadError: 'Unable to load API keys.' };
  }

  try {
    const body = await response.json();
    let keys = Array.isArray(body) ? body : [];
    if (statusFilter !== 'all') {
      keys = keys.filter(k => k.status === statusFilter);
    }
    const total = keys.length;
    const startIndex = (page - 1) * pageSize;
    const paginatedKeys = keys.slice(startIndex, startIndex + pageSize);
    const hasPrev = page > 1;
    const hasNext = startIndex + pageSize < total;

    return { 
      keys: paginatedKeys, 
      total,
      page,
      pageSize,
      hasPrev,
      hasNext,
      loadError: null, 
      status: statusFilter 
    };
  } catch {
    return { keys: [], total: 0, page: 1, pageSize: 20, hasPrev: false, hasNext: false, loadError: null, status: statusFilter };
  }
}

/**
 * API Key management actions.
 *
 * - `create`: POST /admin/api-keys. The backend reveals the full key value
 *   exactly once in this response; the action returns it so the page can show
 *   it a single time. It is never persisted or shown again — subsequent loads
 *   only see the masked list.
 * - `revoke`: POST /admin/api-keys/:id/revoke. A missing or already-revoked key
 *   is rejected by the backend and surfaced as an error message.
 *
 * @type {import('./$types').Actions}
 */
export const actions = {
  create: async ({ cookies, fetch }) => {
    const token = cookies.get(SESSION_COOKIE_NAME);

    let response;
    try {
      response = await fetch(`${getApiBase()}/admin/api-keys`, {
        method: 'POST',
        headers: sessionCookieHeader(token)
      });
    } catch {
      return fail(502, { message: 'Unable to reach the server. Please try again.' });
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const message =
        body && typeof body.message === 'string' && body.message.length > 0
          ? body.message
          : 'Unable to create the API key.';
      return fail(response.status, { message });
    }

    // The full value is revealed exactly once, in this response only.
    return { created: body };
  },

  revoke: async ({ request, cookies, fetch }) => {
    const token = cookies.get(SESSION_COOKIE_NAME);
    const form = await request.formData();
    const id = String(form.get('id') ?? '').trim();

    if (id.length === 0) {
      return fail(400, { message: 'A key id is required to revoke.' });
    }

    let response;
    try {
      response = await fetch(
        `${getApiBase()}/admin/api-keys/${encodeURIComponent(id)}/revoke`,
        { method: 'POST', headers: sessionCookieHeader(token) }
      );
    } catch {
      return fail(502, { message: 'Unable to reach the server. Please try again.' });
    }

    if (!response.ok) {
      let message = 'The API key does not exist or is already revoked.';
      try {
        const body = await response.json();
        if (body && typeof body.message === 'string' && body.message.length > 0) {
          message = body.message;
        }
      } catch {
        // Keep the default message.
      }
      return fail(response.status, { message });
    }

    return { revoked: true };
  }
};
