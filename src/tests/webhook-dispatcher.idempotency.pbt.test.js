// Property-based test for Webhook_Dispatcher payload idempotency.
//
// The webhook payload carries a stable
// `payment_id` (equal to `payment.id`) that is identical across every retry, and
// the serialized request body is byte-identical on every attempt. We exercise
// this by injecting a transport that always fails so all MAX_ATTEMPTS retries
// fire, recording each request body/headers, with an in-memory webhookLogs
// store, a Config stub, an immediately-resolving sleep, and a fixed clock.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createWebhookDispatcher, MAX_ATTEMPTS } from '../webhook/webhook-dispatcher.js';

const HMAC_KEY = 'test-secret-key';

/** In-memory webhookLogs store mirroring the DAL contract surface. */
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
 * A transport that always fails (so every retry fires) and records every
 * request it received. Half the generated runs fail via a thrown error and
 * half via a non-2xx status, so idempotency holds across both failure modes.
 */
function makeAlwaysFailingTransport(mode) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      if (mode === 'throw') {
        throw new Error('network failure');
      }
      return { status: 500, ok: false };
    },
  };
}

/** A sleep stub that records requested delays and resolves immediately. */
function makeSleep() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

/** Generator for an arbitrary settled payment with a target webhook URL. */
const paymentArb = fc.record({
  id: fc.string({ minLength: 1, maxLength: 40 }),
  amount: fc.oneof(fc.integer({ min: 0, max: 1_000_000_000 }), fc.constant(null)),
  paid_amount: fc.oneof(fc.integer({ min: 0, max: 1_000_000_000 }), fc.constant(null)),
  paid_at: fc.oneof(fc.integer({ min: 0, max: 4_000_000_000_000 }), fc.constant(null)),
  tx_id: fc.oneof(fc.string({ maxLength: 40 }), fc.constant(null)),
  webhook_url: fc.webUrl(),
});

describe('Property 21: Webhook payload idempotency', () => {
  it('emits a stable payment_id and byte-identical body across all retries', async () => {
    await fc.assert(
      fc.asyncProperty(
        paymentArb,
        fc.constantFrom('throw', 'status'),
        async (payment, mode) => {
          const webhookLogs = makeWebhookLogs();
          const transport = makeAlwaysFailingTransport(mode);
          const { sleep } = makeSleep();
          const dispatcher = createWebhookDispatcher({
            webhookLogs,
            transport,
            config: { get: () => 'https://config.example/fallback' },
            hmacKey: HMAC_KEY,
            sleep,
            now: () => 1700000000000,
          });

          const result = await dispatcher.dispatch(payment);

          // The always-failing transport forces every attempt to fire.
          expect(result.permanentlyFailed).toBe(true);
          expect(transport.calls).toHaveLength(MAX_ATTEMPTS);

          // Every attempt carries the same payment_id, equal to payment.id.
          for (const call of transport.calls) {
            const parsed = JSON.parse(call.body);
            expect(parsed.payment_id).toBe(payment.id);
          }

          // The serialized body is byte-identical across all retries.
          const bodies = new Set(transport.calls.map((c) => c.body));
          expect(bodies.size).toBe(1);

          // The signature derived from the body is likewise stable.
          const signatures = new Set(
            transport.calls.map((c) => c.headers['X-Signature']),
          );
          expect(signatures.size).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
