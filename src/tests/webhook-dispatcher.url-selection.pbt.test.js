// Property-based test for Webhook_Dispatcher URL selection.
//
// For any combination of the presence of a per-Payment
// `webhook_url` and the Config default, the selected URL SHALL follow the order:
// per-Payment if present, otherwise the Config default; and if neither is
// present, no delivery is performed.
//
// This test drives the public dispatch(payment) API of createWebhookDispatcher
// with a recording transport, an in-memory webhookLogs store, a Config stub, and
// injected clock/sleep, so the URL-selection precedence is exercised end to end
// without real timers or network access.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createWebhookDispatcher } from '../webhook/webhook-dispatcher.js';

const HMAC_KEY = 'test-secret-key';

/** In-memory webhookLogs store recording appended rows and permanent marks. */
function makeWebhookLogs() {
  const rows = [];
  return {
    rows,
    append(entry) {
      rows.push({ ...entry });
      return { ok: true };
    },
    markPermanentFailure(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) {
        return { ok: false, code: 'LOG_NOT_FOUND' };
      }
      row.status = 'failed_permanent';
      return { ok: true };
    },
  };
}

/** A transport that always returns 2xx and records the requests it received. */
function makeTransport() {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      return { status: 200, ok: true };
    },
  };
}

// A URL value, or null/empty/undefined "absent" markers. An empty string is an
// absent per-Payment URL per selectWebhookUrl (only non-empty strings count).
const urlOrAbsentArb = fc.oneof(
  fc.webUrl(),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(''),
);

function isPresent(value) {
  return typeof value === 'string' && value.length > 0;
}

describe('Property 20: webhook_url selection', () => {
  it('targets per-Payment URL, else Config default, else does not send', async () => {
    await fc.assert(
      fc.asyncProperty(urlOrAbsentArb, urlOrAbsentArb, async (paymentUrl, configUrl) => {
        const webhookLogs = makeWebhookLogs();
        const transport = makeTransport();
        const config = { get: () => (isPresent(configUrl) ? configUrl : null) };
        const dispatcher = createWebhookDispatcher({
          webhookLogs,
          transport,
          config,
          hmacKey: HMAC_KEY,
          sleep: async () => {},
          now: () => 1700000000000,
          generateId: () => 'log-id',
        });

        const payment = { id: 'pay-1', amount: 1000, webhook_url: paymentUrl };
        const result = await dispatcher.dispatch(payment);

        const expectedUrl = isPresent(paymentUrl)
          ? paymentUrl
          : isPresent(configUrl)
            ? configUrl
            : null;

        if (expectedUrl === null) {
          // Neither source provides a URL: no send, no log, not a failure.
          expect(result).toEqual({ sent: false });
          expect(transport.calls).toHaveLength(0);
          expect(webhookLogs.rows).toHaveLength(0);
        } else {
          // The dispatcher must target exactly the selected URL.
          expect(result.sent).toBe(true);
          expect(result.url).toBe(expectedUrl);
          expect(transport.calls).toHaveLength(1);
          expect(transport.calls[0].url).toBe(expectedUrl);
        }
      }),
      { numRuns: 100 },
    );
  });
});
