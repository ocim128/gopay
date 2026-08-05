// Property-based tests for general request validation on POST /payment.
//
// These tests exercise the payment REST routes through a real Fastify instance
// via `fastify.inject()`, backed by the same in-memory DAL + real
// Payment_Service pattern used by `payments.routes.test.js`. A passthrough auth
// preHandler and a stub QRIS image renderer keep the tests deterministic.
//
// The properties focus on the schema-level `timeout` and `tolerance` ranges
// and on basic acceptance of in-range requests:
//   * `timeout` outside 10000..86400000 -> HTTP 400 / INVALID_REQUEST, no Payment.
//   * `tolerance` outside 0..999        -> HTTP 400 / INVALID_REQUEST, no Payment.
//   * a valid client-managed request with in-range values -> HTTP 201.
//
// (Amount type/range errors map to INVALID_AMOUNT in the handler, not
// INVALID_REQUEST, so they are out of scope for this property.)

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Fastify from 'fastify';

import paymentsRoutes from '../routes/payments.routes.js';
import { createPaymentService } from '../payment/payment-service.js';
import { TIMEOUT_MIN_MS, TIMEOUT_MAX_MS, TOLERANCE_MIN, TOLERANCE_MAX } from '../routes/schemas.js';

// A minimal, valid "tag-only" Static_QRIS accepted by the QRIS_Builder.
const STATIC_QRIS = '0002010102115802ID6304';

const NUM_RUNS = 100;

/**
 * Build an in-memory storage whose `payments` store satisfies the subset of the
 * DAL contract that the Payment_Service uses, including amount-uniqueness among
 * pending payments. Mirrors the helper in
 * `payments.routes.test.js`.
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
 * auth preHandler and a stub QRIS image renderer. Mirrors the helper in
 * `payments.routes.test.js`.
 */
async function buildApp(overrides = {}) {
  const storage = overrides.storage ?? createInMemoryStorage();
  const staticQris = 'staticQris' in overrides ? overrides.staticQris : STATIC_QRIS;
  const config = { getStaticQris: () => staticQris };
  const paymentService = overrides.paymentService ?? createPaymentService({ storage, config });

  const app = Fastify();
  await app.register(paymentsRoutes, {
    paymentService,
    storage,
    authPreHandler: 'authPreHandler' in overrides ? overrides.authPreHandler : async () => {},
    generateQrisImage: async () => Buffer.from('PNGDATA'),
  });
  await app.ready();
  return { app, storage, paymentService };
}

// A valid client-managed amount in 1000..9999000. Kept in
// range so any rejection is attributable to timeout/tolerance, not the amount.
const validAmount = fc.integer({ min: 1000, max: 9999000 });

// In-range timeout / tolerance generators.
const inRangeTimeout = fc.integer({ min: TIMEOUT_MIN_MS, max: TIMEOUT_MAX_MS });
const inRangeTolerance = fc.integer({ min: TOLERANCE_MIN, max: TOLERANCE_MAX });

// Out-of-range timeout / tolerance generators (below or above the bounds).
const outOfRangeTimeout = fc.oneof(
  fc.integer({ min: -1_000_000, max: TIMEOUT_MIN_MS - 1 }),
  fc.integer({ min: TIMEOUT_MAX_MS + 1, max: 300_000_000 }),
);
const outOfRangeTolerance = fc.oneof(
  fc.integer({ min: -100_000, max: TOLERANCE_MIN - 1 }),
  fc.integer({ min: TOLERANCE_MAX + 1, max: 1_000_000 }),
);

describe('POST /payment general request validation (Property 2: timeout & tolerance)', () => {
  it('rejects out-of-range timeout/tolerance with 400 INVALID_REQUEST and creates no Payment', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          amount: validAmount,
          // Which field(s) carry an out-of-range value; at least one always does.
          kind: fc.constantFrom('timeout', 'tolerance', 'both'),
          badTimeout: outOfRangeTimeout,
          badTolerance: outOfRangeTolerance,
          goodTimeout: inRangeTimeout,
          goodTolerance: inRangeTolerance,
        }),
        async ({ amount, kind, badTimeout, badTolerance, goodTimeout, goodTolerance }) => {
          const payload = { mode: 'client_managed', amount };
          if (kind === 'timeout' || kind === 'both') {
            payload.timeout = badTimeout;
          } else {
            payload.timeout = goodTimeout;
          }
          if (kind === 'tolerance' || kind === 'both') {
            payload.tolerance = badTolerance;
          } else {
            payload.tolerance = goodTolerance;
          }

          const { app, storage } = await buildApp();
          try {
            const res = await app.inject({ method: 'POST', url: '/payment', payload });
            expect(res.statusCode).toBe(400);
            expect(res.json().error_code).toBe('INVALID_REQUEST');
            // No Payment is created on an invalid request.
            expect(storage._byId.size).toBe(0);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('accepts a valid client-managed request with in-range timeout/tolerance', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          amount: validAmount,
          timeout: inRangeTimeout,
          tolerance: inRangeTolerance,
        }),
        async ({ amount, timeout, tolerance }) => {
          const { app, storage } = await buildApp();
          try {
            const res = await app.inject({
              method: 'POST',
              url: '/payment',
              payload: { mode: 'client_managed', amount, timeout, tolerance },
            });
            expect(res.statusCode).toBe(201);
            const body = res.json();
            expect(body.status).toBe('pending');
            expect(body.amount).toBe(amount);
            // The valid request created exactly one Payment.
            expect(storage._byId.size).toBe(1);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
