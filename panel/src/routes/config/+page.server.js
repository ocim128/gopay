import { fail } from '@sveltejs/kit';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader
} from '$lib/server/backend.js';

/**
 * Server load for the Config page. Reads the current
 * server-level settings (default `webhook_url`, `poll_interval`, and the
 * display_timezone) from the admin-session-guarded backend endpoint
 * (`GET /admin/config`), forwarding the httpOnly Admin session cookie (the BFF
 * pattern).
 *
 * @type {import('./$types').PageServerLoad}
 */
export async function load({ cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);

  let response;
  try {
    response = await fetch(`${getApiBase()}/admin/config`, {
      headers: sessionCookieHeader(token)
    });
  } catch {
    return { config: emptyConfig(), loadError: 'Unable to reach the server.' };
  }

  if (!response.ok) {
    return { config: emptyConfig(), loadError: 'Unable to load configuration.' };
  }

  try {
    const body = await response.json();
    return {
      config: {
        poll_interval: body?.poll_interval ?? null,
        webhook_url: body?.webhook_url ?? null,
        display_timezone: body?.display_timezone ?? null
      },
      loadError: null
    };
  } catch {
    return { config: emptyConfig(), loadError: null };
  }
}

/**
 * A blank Config snapshot used when the backend is unreachable.
 *
 * @returns {{ poll_interval: null, webhook_url: null, display_timezone: null }}
 */
function emptyConfig() {
  return { poll_interval: null, webhook_url: null, display_timezone: null };
}

/**
 * Config update action. Submits the changed settings
 * to the admin-session-guarded backend (`PUT /admin/config`), which validates
 * each field server-side and rejects the whole update with HTTP 400 if any
 * value is invalid (for example a non-numeric or out-of-range `poll_interval`).
 * On rejection the previous values are retained by the
 * backend and the submitted values are echoed back so the Admin can correct
 * them.
 *
 * Only non-empty fields are sent: a blank field leaves the stored value
 * unchanged.
 *
 * @type {import('./$types').Actions}
 */
export const actions = {
  default: async ({ request, cookies, fetch }) => {
    const token = cookies.get(SESSION_COOKIE_NAME);
    const form = await request.formData();

    const values = {
      poll_interval: String(form.get('poll_interval') ?? '').trim(),
      webhook_url: String(form.get('webhook_url') ?? '').trim(),
      display_timezone: String(form.get('display_timezone') ?? '').trim()
    };

    /** @type {Record<string, unknown>} */
    const payload = {};
    // Send the poll_interval as given so the backend reports invalid input;
    // a blank field leaves the stored value unchanged.
    if (values.poll_interval.length > 0) {
      payload.poll_interval = /^\d+$/.test(values.poll_interval)
        ? Number(values.poll_interval)
        : values.poll_interval;
    }
    if (values.webhook_url.length > 0) {
      payload.webhook_url = values.webhook_url;
    }
    if (values.display_timezone.length > 0) {
      payload.display_timezone = values.display_timezone;
    }

    if (Object.keys(payload).length === 0) {
      return fail(400, { message: 'Enter at least one value to update.', values });
    }

    let response;
    try {
      response = await fetch(`${getApiBase()}/admin/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', ...sessionCookieHeader(token) },
        body: JSON.stringify(payload)
      });
    } catch {
      return fail(502, { message: 'Unable to reach the server. Please try again.', values });
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
          : 'Unable to save the configuration.';
      return fail(response.status, { message, values });
    }

    return { success: true };
  }
};
