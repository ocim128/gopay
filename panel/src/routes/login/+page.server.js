import { fail, redirect } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

import {
  SESSION_COOKIE_NAME,
  getApiBase,
  extractSessionToken
} from '$lib/server/backend.js';

/**
 * Session cookie lifetime in seconds, matching the backend's 24-hour session
 * validity.
 *
 * @type {number}
 */
const SESSION_MAX_AGE_SECONDS = 86400;

/**
 * Login form action. Submits the username/password to the backend admin login,
 * and on success re-issues the httpOnly Admin session cookie on the Panel
 * origin so the browser sends it back on subsequent requests. The cookie value
 * is the backend-issued session token; it is never readable by browser scripts.
 *
 * @type {import('./$types').Actions}
 */
export const actions = {
  default: async ({ request, cookies, fetch, getClientAddress }) => {
    const form = await request.formData();
    const username = String(form.get('username') ?? '');
    const password = String(form.get('password') ?? '');

    // Reject empty fields before contacting the backend.
    if (username.trim().length === 0 || password.length === 0) {
      return fail(400, {
        username,
        message: 'Username and password are required.'
      });
    }

    let response;
    try {
      const cfConnectingIp = request.headers.get('cf-connecting-ip');
      const forwardedFor = request.headers.get('x-forwarded-for');
      const realIp = request.headers.get('x-real-ip');
      const clientIp = getClientAddress();
      
      const headers = { 'content-type': 'application/json' };
      if (cfConnectingIp) {
        headers['x-forwarded-for'] = cfConnectingIp;
      } else if (forwardedFor) {
        headers['x-forwarded-for'] = forwardedFor;
      } else if (realIp) {
        headers['x-forwarded-for'] = realIp;
      } else {
        headers['x-forwarded-for'] = clientIp;
      }

      response = await fetch(`${getApiBase()}/admin/login`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ username, password })
      });
    } catch {
      return fail(502, {
        username,
        message: 'Unable to reach the server. Please try again.'
      });
    }

    if (!response.ok) {
      // Surface the backend's generic message so the response never reveals
      // whether the username or the password was wrong.
      let message = 'Invalid username or password.';
      try {
        const body = await response.json();
        if (body && typeof body.message === 'string' && body.message.length > 0) {
          message = body.message;
        }
      } catch {
        // Keep the default generic message.
      }
      return fail(response.status, { username, message });
    }

    const token = extractSessionToken(response.headers.get('set-cookie'));
    if (token === null) {
      return fail(502, {
        username,
        message: 'Login succeeded but no session was issued. Please try again.'
      });
    }

    cookies.set(SESSION_COOKIE_NAME, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: env.NODE_ENV === 'production',
      maxAge: SESSION_MAX_AGE_SECONDS
    });

    throw redirect(303, '/');
  }
};
