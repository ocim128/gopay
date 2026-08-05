// Property-based test for the Webhook_Dispatcher permanent-failure behaviour.
//
// *For any* settled payment whose webhook target
// always fails (every attempt returns a non-2xx response or throws), the
// dispatcher SHALL make exactly MAX_ATTEMPTS (5) delivery attempts and then
// stop retrying, the final delivery-log row SHALL be marked `failed_permanent`
// (via markPermanentFailure), and the result SHALL report `permanentlyFailed`.
//
// Every collaborator is faked: an always-failing transport, an in-memory
// webhookLogs store (recording append + markPermanentFailure), a config stub,
// an immediate sleep stub, and a fixed clock. No real timers or network are
// used, so the bounded retry machinery is exercised deterministically.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createWebhookDispatcher, MAX_ATTEMPTS } from '../webhook/webhook-dispatcher.js';

const HMAC_KEY = 'test-secret-key';

/**
 * Build an in-memory webhookLogs store that records appended rows and tracks
 * which row ids were marked permanently failed, mirroring the DAL contract
 * surface the dispatcher relies on.
 */
function makeWebhookLogs() {
  const rows = [];
  const permanentMarks = [];
  return {
    rows,
    permanentMarks,
    append(entry) {
      rows.push({ ...entry });
      return { ok: true };
    },
    markPermanentFailure(id) {
      permanentMarks.push(id);
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
 * Build a transport that always fails. Half the time it returns a non-2xx HTTP
 * status, half the time it throws (network error / timeout) — both are failures
 * from the dispatcher's perspective. Records every request it receives.
 *
 * @param {boolean} viaThrow - when true, throw instead of returning a status.
 * @param {number} failStatus - the non-2xx status to return when not throwing.
 */
function makeAlwaysFailingTransport(viaThrow, failStatus) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      if (viaThrow) {
        throw new Error('connection refused');
      }
      return { status: failStatus, ok: false };
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

describe('createWebhookDispatcher — Property 25: Webhook permanent failure', () => {
  it('makes exactly 5 attempts, then stops and records failed_permanent', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A generated settled payment with a non-empty target URL.
        fc.record({
          id: fc.string({ minLength: 1, maxLength: 24 }),
          amount: fc.integer({ min: 1000, max: 100_000_000 }),
          paid_amount: fc.integer({ min: 1000, max: 100_000_000 }),
          paid_at: fc.integer({ min: 0, max: 2_000_000_000_000 }),
          tx_id: fc.string({ minLength: 1, maxLength: 24 }),
          webhook_url: fc
            .webUrl()
            .filter((u) => typeof u === 'string' && u.length > 0),
        }),
        // The failure mode: a thrown error or a generated non-2xx status.
        fc.boolean(),
        fc.oneof(
          fc.integer({ min: 100, max: 199 }),
          fc.integer({ min: 300, max: 599 }),
        ),
        async (payment, viaThrow, failStatus) => {
          const webhookLogs = makeWebhookLogs();
          const transport = makeAlwaysFailingTransport(viaThrow, failStatus);
          const { sleep, delays } = makeSleep();
          const dispatcher = createWebhookDispatcher({
            webhookLogs,
            transport,
            config: { get: () => null },
            hmacKey: HMAC_KEY,
            sleep,
            now: () => 1_700_000_000_000,
          });

          const result = await dispatcher.dispatch(payment);

          // Exactly MAX_ATTEMPTS attempts were made — then no further attempts.
          expect(transport.calls).toHaveLength(MAX_ATTEMPTS);
          // Backoff slept exactly MAX_ATTEMPTS - 1 times (between attempts).
          expect(delays).toHaveLength(MAX_ATTEMPTS - 1);

          // The result indicates permanent failure.
          expect(result).toMatchObject({
            sent: true,
            success: false,
            attempts: MAX_ATTEMPTS,
            permanentlyFailed: true,
          });

          // One delivery-log row per attempt; the final row is marked
          // failed_permanent via markPermanentFailure.
          expect(webhookLogs.rows).toHaveLength(MAX_ATTEMPTS);
          expect(webhookLogs.permanentMarks).toHaveLength(1);
          const finalRow = webhookLogs.rows[MAX_ATTEMPTS - 1];
          expect(webhookLogs.permanentMarks[0]).toBe(finalRow.id);
          expect(finalRow.status).toBe('failed_permanent');
          // Every preceding row is a plain failure.
          expect(
            webhookLogs.rows.slice(0, MAX_ATTEMPTS - 1).every((r) => r.status === 'failed'),
          ).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
