import { fail } from '@sveltejs/kit';

import { getApiBase, apiKeyHeader } from '$lib/server/backend.js';

/**
 * Inclusive bounds mirrored from the REST_API schema so the Panel can give
 * immediate, English feedback before contacting the backend. The backend
 * remains the source of truth and re-validates every value.
 */
const TIMEOUT_MIN_MS = 10000;
const TIMEOUT_MAX_MS = 86400000;
const TOLERANCE_MIN = 0;
const TOLERANCE_MAX = 999;

/**
 * Parse a required positive-integer amount field from the submitted form.
 *
 * @param {FormDataEntryValue|null} raw
 * @returns {{ ok: true, value: number } | { ok: false }}
 */
function parsePositiveInteger(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d+$/.test(text)) {
    return { ok: false };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 9999000) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Parse an optional integer field within an inclusive range. An empty value is
 * accepted (the backend then applies its default).
 *
 * @param {FormDataEntryValue|null} raw
 * @param {number} min
 * @param {number} max
 * @returns {{ ok: true, value: number|undefined } | { ok: false }}
 */
function parseOptionalInteger(raw, min, max) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) {
    return { ok: true, value: undefined };
  }
  if (!/^\d+$/.test(text)) {
    return { ok: false };
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { ok: false };
  }
  return { ok: true, value };
}

/**
 * Create Payment form action. Validates the submitted mode
 * and amount, then creates the Payment through the API-key-protected REST_API
 * (`POST /payment`) using the server-held key. On success it returns the
 * created Payment so the page can show id, amount, qris_string, the QRIS image,
 * and expires_at; the QRIS image is served through the Panel proxy at
 * `/qris/:id` so the browser's Admin session authorizes it.
 *
 * @type {import('./$types').Actions}
 */
export const actions = {
  default: async ({ request, fetch }) => {
    const form = await request.formData();
    const mode = String(form.get('mode') ?? 'client_managed');

    if (mode !== 'client_managed' && mode !== 'server_managed') {
      return fail(400, { message: 'Choose a valid amount mode.', values: { mode } });
    }

    /** @type {Record<string, unknown>} */
    const payload = { mode };

    const values = {
      mode,
      amount: String(form.get('amount') ?? ''),
      base_amount: String(form.get('base_amount') ?? ''),
      timeout: String(form.get('timeout') ?? ''),
      tolerance: String(form.get('tolerance') ?? ''),
      webhook_url: String(form.get('webhook_url') ?? '')
    };

    if (mode === 'client_managed') {
      const amount = parsePositiveInteger(form.get('amount'));
      if (!amount.ok) {
        return fail(400, {
          message: 'Amount must be a whole number between 1000 and 9999000 Rupiah.',
          values
        });
      }
      payload.amount = amount.value;
    } else {
      const baseAmount = parsePositiveInteger(form.get('base_amount'));
      if (!baseAmount.ok) {
        return fail(400, {
          message: 'Base amount must be a whole number between 1000 and 9999000 Rupiah.',
          values
        });
      }
      payload.base_amount = baseAmount.value;
    }

    const timeout = parseOptionalInteger(form.get('timeout'), TIMEOUT_MIN_MS, TIMEOUT_MAX_MS);
    if (!timeout.ok) {
      return fail(400, {
        message: `Timeout must be a whole number between ${TIMEOUT_MIN_MS} and ${TIMEOUT_MAX_MS} milliseconds.`,
        values
      });
    }
    if (timeout.value !== undefined) {
      payload.timeout = timeout.value;
    }

    const tolerance = parseOptionalInteger(form.get('tolerance'), TOLERANCE_MIN, TOLERANCE_MAX);
    if (!tolerance.ok) {
      return fail(400, {
        message: `Tolerance must be a whole number between ${TOLERANCE_MIN} and ${TOLERANCE_MAX} Rupiah.`,
        values
      });
    }
    if (tolerance.value !== undefined) {
      payload.tolerance = tolerance.value;
    }

    // Optional per-payment webhook override. Only forwarded when non-empty so
    // the backend falls back to its configured default otherwise.
    const webhookUrl = String(form.get('webhook_url') ?? '').trim();
    if (webhookUrl.length > 0) {
      payload.webhook_url = webhookUrl;
    }

    let response;
    try {
      response = await fetch(`${getApiBase()}/payment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...apiKeyHeader() },
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
          : 'Unable to create the payment.';
      return fail(response.status, { message, values });
    }

    return { created: body };
  }
};
