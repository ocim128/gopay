// Property test for an ignored `poll_interval` field in the request body.
//
// `poll_interval` is a global
// Config setting, not a per-payment parameter. A `poll_interval` field included
// in a POST /payment body must be ignored — it is neither an error nor applied.
// A valid client-managed payload that additionally carries a `poll_interval`
// field (of any type/value) must still succeed with HTTP 201, the payment must
// be created normally, and `poll_interval` must not appear in the response or
// in the stored record (there is no per-payment poll_interval).
//
// The test drives the real Fastify payment routes via `fastify.inject()` over an
// in-memory DAL and a real Payment_Service, mirroring the helpers in
// `payments.routes.test.js` (passthrough auth, stubbed QRIS image renderer, and
// a minimal valid Static_QRIS).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Fastify from 'fastify';

import paymentsRoutes from '../routes/payments.routes.js';
import { createPaymentService } from '../payment/payment-service.js';

// A minimal, valid "tag-only" Static_QRIS accepted by the QRIS_Builder: it
// contains the mandatory country code field (5802ID), the static
// point-of-initiation marker (010211), and ends with the CRC tag (6304).
const STATIC_QRIS = '0002010102115802ID6304';

const MIN_AMOUNT = 1000;
const MAX_AMOUNT = 9999000;

// Exactly the fields documented for a 201 client-managed creation response.
const EXPECTED_RESPONSE_KEYS = [
  'amount',
  'created_at',
  'created_at_iso',
  'expires_at',
  'expires_at_iso',
  'id',
  'qris_string',
  'qris_url',
  'status',
  'tz',
].sort();

/**
 * Build an in-memory storage whose `payments` store satisfies the subset of the
 * DAL contract that the Payment_Service uses, including amount-uniqueness among
 * pending payments.
 */
function createInMemoryStorage() {
  /** @type {Map<string, any>} */
  const byId = new Map();

  function activeAmounts() {
    const amounts = new Set();
    for (const p of byId.values()) {
      if (p.status === 'pending') {
        amounts.add(p.amount);
      }
    }
    return amounts;
  }

  return {
    payments: {
      insertPending(record) {
        if (activeAmounts().has(record.amount)) {
          return { ok: false, code: 'AMOUNT_IN_USE' };
        }
        const payment = {
          id: record.id,
          amount: record.amount,
          status: 'pending',
          qris_string: record.qris_string,
          qris_url: record.qris_url ?? null,
          created_at: record.created_at,
          expires_at: record.expires_at,
          timeout: record.timeout,
          tolerance: record.tolerance ?? 0,
          webhook_url: record.webhook_url ?? null,
          tx_id: null,
          paid_amount: null,
          paid_at: null,
        };
        byId.set(payment.id, payment);
        return { ok: true, value: { ...payment } };
      },
      getById(id) {
        const p = byId.get(id);
        return p ? { ...p } : null;
      },
      listActive(options = {}) {
        const limit = options.limit ?? 100;
        const offset = options.offset ?? 0;
        const pending = [...byId.values()]
          .filter((p) => p.status === 'pending')
          .sort((a, b) => a.expires_at - b.expires_at)
          .slice(offset, offset + limit);
        return pending.map((p) => ({ ...p }));
      },
      markPaid(id, settlement) {
        const p = byId.get(id);
        if (!p || p.status !== 'pending') {
          return { ok: false, code: 'PAYMENT_NOT_PENDING' };
        }
        p.status = 'paid';
        p.tx_id = settlement.txId;
        p.paid_amount = settlement.paidAmount;
        p.paid_at = settlement.paidAt;
        return { ok: true, value: { ...p } };
      },
      expireOverdue(now) {
        let count = 0;
        for (const p of byId.values()) {
          if (p.status === 'pending' && now > p.expires_at) {
            p.status = 'expired';
            count += 1;
          }
        }
        return count;
      },
      countActive() {
        return [...byId.values()].filter((p) => p.status === 'pending').length;
      },
    },
    // Expose the raw map so tests can seed/inspect state directly.
    _byId: byId,
  };
}

/**
 * Build a Fastify app with the payment routes registered, using a passthrough
 * auth preHandler and a stubbed QRIS image renderer.
 */
async function buildApp(overrides = {}) {
  const storage = overrides.storage ?? createInMemoryStorage();
  const staticQris = 'staticQris' in overrides ? overrides.staticQris : STATIC_QRIS;
  const config = { getStaticQris: () => staticQris };
  const paymentService =
    overrides.paymentService ?? createPaymentService({ storage, config });

  const app = Fastify();
  await app.register(paymentsRoutes, {
    paymentService,
    storage,
    authPreHandler:
      'authPreHandler' in overrides ? overrides.authPreHandler : async () => {},
    generateQrisImage: async () => Buffer.from('PNGDATA'),
  });
  await app.ready();
  return { app, storage, paymentService };
}

describe('Property 35: poll_interval in the body is ignored', () => {
  // A `poll_interval` value of an arbitrary type and magnitude. None of these
  // should change the outcome: not in-range integers, not out-of-range integers,
  // not strings, booleans, null, floats, or nested objects/arrays.
  const arbitraryPollInterval = fc.oneof(
    // Integers inside the Config-valid range (1000..60000).
    fc.integer({ min: 1000, max: 60000 }),
    // Integers outside the Config-valid range (would be invalid for Config).
    fc.integer({ min: -1_000_000, max: 999 }),
    fc.integer({ min: 60001, max: 1_000_000 }),
    // Floats.
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    // Strings.
    fc.string(),
    // Booleans and null.
    fc.boolean(),
    fc.constant(null),
    // Nested structures.
    fc.record({ nested: fc.integer() }),
    fc.array(fc.integer(), { maxLength: 4 }),
  );

  it('accepts a valid client-managed payload that also carries a poll_interval and creates the payment normally', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MIN_AMOUNT, max: MAX_AMOUNT }),
        arbitraryPollInterval,
        async (amount, pollInterval) => {
          const { app, storage } = await buildApp();
          try {
            const res = await app.inject({
              method: 'POST',
              url: '/payment',
              payload: { mode: 'client_managed', amount, poll_interval: pollInterval },
            });

            // The request still succeeds: poll_interval is neither an error...
            expect(res.statusCode).toBe(201);

            const body = res.json();
            // ...nor reflected back: the response carries exactly the documented
            // fields, with no per-payment `poll_interval`.
            expect(Object.keys(body).sort()).toEqual(EXPECTED_RESPONSE_KEYS);
            expect(body).not.toHaveProperty('poll_interval');
            expect(body.status).toBe('pending');
            expect(body.amount).toBe(amount);

            // The payment is created normally and stored without a
            // `poll_interval`, i.e. it is not applied to the record.
            expect(storage._byId.size).toBe(1);
            const stored = storage._byId.get(body.id);
            expect(stored).toBeTruthy();
            expect(stored).not.toHaveProperty('poll_interval');
            expect(stored.amount).toBe(amount);
            expect(stored.status).toBe('pending');
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('creates an identical payment whether or not poll_interval is present (it has no effect)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MIN_AMOUNT, max: MAX_AMOUNT }),
        arbitraryPollInterval,
        async (amount, pollInterval) => {
          // Baseline: no poll_interval field.
          const baseline = await buildApp();
          // With an arbitrary poll_interval field added.
          const withField = await buildApp();
          try {
            const baseRes = await baseline.app.inject({
              method: 'POST',
              url: '/payment',
              payload: { mode: 'client_managed', amount },
            });
            const fieldRes = await withField.app.inject({
              method: 'POST',
              url: '/payment',
              payload: { mode: 'client_managed', amount, poll_interval: pollInterval },
            });

            expect(baseRes.statusCode).toBe(201);
            expect(fieldRes.statusCode).toBe(201);

            const baseBody = baseRes.json();
            const fieldBody = fieldRes.json();

            // The same set of fields is returned regardless of poll_interval.
            expect(Object.keys(fieldBody).sort()).toEqual(Object.keys(baseBody).sort());
            // The payment-defining fields are identical (only the random `id`
            // and the QRIS payload that embeds it may differ).
            expect(fieldBody.amount).toBe(baseBody.amount);
            expect(fieldBody.status).toBe(baseBody.status);
          } finally {
            await baseline.app.close();
            await withField.app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
