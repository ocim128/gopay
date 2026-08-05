// Property-based test for the Webhook_Dispatcher backoff schedule.
//
// On persistent delivery failure the dispatcher must make exactly 5 attempts
// (1 initial + 4 retries) and wait between each pair of attempts with a backoff
// delay bounded to the inclusive 1000..60000 ms window. We inject a transport
// that always fails, an in-memory webhookLogs store, a Config stub, a `sleep`
// stub that records each requested delay (resolving immediately), and a clock.
// We then dispatch a generated settled payment and assert the schedule shape.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  createWebhookDispatcher,
  MAX_ATTEMPTS,
  MIN_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from '../webhook/webhook-dispatcher.js';

const HMAC_KEY = 'pbt-secret-key';

/** In-memory webhookLogs store mirroring the DAL contract used by dispatch. */
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

/**
 * A transport that always fails. Half the time it returns a non-2xx status and
 * half the time it throws (network error / timeout). Either way every attempt
 * is a failure, forcing the dispatcher to exhaust all retries. Records calls.
 */
function makeAlwaysFailTransport(failMode) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      if (failMode === 'throw') {
        throw new Error('simulated network failure');
      }
      return { status: failMode, ok: false };
    },
  };
}

/** A sleep stub that records every requested delay and resolves immediately. */
function makeSleep() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

describe('Property 23: Webhook backoff schedule', () => {
  it('makes exactly 5 attempts with 4 in-range backoff delays on persistent failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A settled payment with a non-empty target webhook_url.
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 24 }),
          amount: fc.integer({ min: 1000, max: 100_000_000 }),
          paid_amount: fc.integer({ min: 1000, max: 100_000_000 }),
          paid_at: fc.integer({ min: 0, max: 4_102_444_800_000 }),
          tx_id: fc.string({ maxLength: 24 }),
          urlPath: fc.string({ minLength: 1, maxLength: 32 }),
        }),
        // The mode of failure: a specific non-2xx status, or a thrown error.
        fc.oneof(
          fc.constantFrom(400, 401, 403, 404, 429, 500, 502, 503),
          fc.constant('throw'),
        ),
        // Whether a Config default URL is present (the per-Payment URL still wins).
        fc.boolean(),
        // The clock value returned for log timestamps.
        fc.integer({ min: 0, max: 4_102_444_800_000 }),
        async (paymentSeed, failMode, hasConfigDefault, clockSeed) => {
          const webhookLogs = makeWebhookLogs();
          const transport = makeAlwaysFailTransport(failMode);
          const { sleep, delays } = makeSleep();
          const config = {
            get: () => (hasConfigDefault ? 'https://config.example/hook' : null),
          };
          const dispatcher = createWebhookDispatcher({
            webhookLogs,
            transport,
            config,
            hmacKey: HMAC_KEY,
            sleep,
            now: () => clockSeed,
          });

          const payment = {
            id: paymentSeed.id,
            amount: paymentSeed.amount,
            paid_amount: paymentSeed.paid_amount,
            paid_at: paymentSeed.paid_at,
            tx_id: paymentSeed.tx_id,
            webhook_url: `https://pay.example/${encodeURIComponent(paymentSeed.urlPath)}`,
          };

          const result = await dispatcher.dispatch(payment);

          // The transport is called exactly MAX_ATTEMPTS (5) times.
          expect(transport.calls).toHaveLength(MAX_ATTEMPTS);

          // sleep is called exactly MAX_ATTEMPTS - 1 (4) times, between attempts.
          expect(delays).toHaveLength(MAX_ATTEMPTS - 1);

          // Every recorded backoff delay is within the [1000, 60000] window.
          for (const delay of delays) {
            expect(delay).toBeGreaterThanOrEqual(MIN_BACKOFF_MS);
            expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
          }

          // The dispatch ends as a permanent failure after exhausting retries.
          expect(result).toMatchObject({
            sent: true,
            success: false,
            attempts: MAX_ATTEMPTS,
            permanentlyFailed: true,
          });
        },
      ),
      { numRuns: 100 },
    );
  });
});
