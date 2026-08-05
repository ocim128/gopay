// Property test for server-managed Base_Amount validation.
//
// In server_managed mode, a Base_Amount
// that is missing or not a positive integer (< 1, including zero, negatives,
// and non-integers) must be rejected with HTTP 400 / `error_code`
// "INVALID_BASE_AMOUNT" and must NOT create an Active_Payment. A valid
// Base_Amount (a positive integer >= 1) yields HTTP 201 with the final Amount
// being Base_Amount + Unique_Suffix, so it lies in [base, base + 999].
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

const MIN_BASE_AMOUNT = 1000;
const MAX_AMOUNT = 9999000;
// The Unique_Suffix range is 0..999, so the final Amount is at most base + 999.
const MAX_SUFFIX = 999;

/**
 * Build an in-memory storage whose `payments` store satisfies the subset of the
 * DAL contract that the Payment_Service uses, including amount-uniqueness among
 * pending payments. Mirrors the helper in `payments.routes.test.js`.
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
 * auth preHandler and a stubbed QRIS image renderer. Mirrors the helper in
 * `payments.routes.test.js`.
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

describe('Property 6: Base_Amount validation (server-managed)', () => {
  // An arbitrary that generates invalid server-managed base amounts spanning
  // every documented rejection case:
  //   - missing (the `base_amount` field is omitted entirely)
  //   - zero (not a positive integer >= 1)
  //   - negative integers (not a positive integer)
  //   - non-integers / floats (not a positive integer)
  // Each generated value is `{ omit: true }` (no base_amount field) or
  // `{ omit: false, base_amount: <invalid value> }`.
  const invalidBaseAmount = fc.oneof(
    // Missing base_amount entirely.
    fc.constant({ omit: true }),
    // Zero (< 1).
    fc.constant({ omit: false, base_amount: 0 }),
    // Negative integers.
    fc.integer({ min: -1_000_000_000, max: -1 }).map((base_amount) => ({ omit: false, base_amount })),
    // Non-integer floats (e.g. 12.34) — not positive integers.
    fc
      .double({ min: 0, max: MAX_AMOUNT, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n))
      .map((base_amount) => ({ omit: false, base_amount })),
  );

  it('rejects missing / non-positive-integer base amounts with 400 INVALID_BASE_AMOUNT and creates no payment', async () => {
    await fc.assert(
      fc.asyncProperty(invalidBaseAmount, async (spec) => {
        const { app, storage } = await buildApp();
        try {
          const payload = { mode: 'server_managed' };
          if (!spec.omit) {
            payload.base_amount = spec.base_amount;
          }

          const res = await app.inject({ method: 'POST', url: '/payment', payload });

          expect(res.statusCode).toBe(400);
          expect(res.json().error_code).toBe('INVALID_BASE_AMOUNT');
          // No Active_Payment was created.
          expect(storage._byId.size).toBe(0);
        } finally {
          await app.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('accepts a valid positive-integer base amount with 201 and a final amount in [base, base + 999]', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: MIN_BASE_AMOUNT, max: MAX_AMOUNT }),
        async (base_amount) => {
          const { app, storage } = await buildApp();
          try {
            const res = await app.inject({
              method: 'POST',
              url: '/payment',
              payload: { mode: 'server_managed', base_amount },
            });

            expect(res.statusCode).toBe(201);
            const body = res.json();
            expect(body.status).toBe('pending');
            // The final Amount is Base_Amount + Unique_Suffix (0..999).
            expect(Number.isInteger(body.amount)).toBe(true);
            expect(body.amount).toBeGreaterThanOrEqual(base_amount);
            expect(body.amount).toBeLessThanOrEqual(base_amount + MAX_SUFFIX);
            // The formed Amount never exceeds the maximum valid Amount.
            expect(body.amount).toBeLessThanOrEqual(MAX_AMOUNT);
            // Exactly one Active_Payment was created.
            expect(storage._byId.size).toBe(1);
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
