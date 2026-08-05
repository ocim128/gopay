// Property test for client-managed amount validation.
//
// In client_managed mode, an Amount that
// is missing, not a positive integer, or outside the range 1000..9999000 must
// be rejected with HTTP 400 / `error_code` "INVALID_AMOUNT" and must NOT create
// an Active_Payment. A valid Amount in range yields HTTP 201.
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

describe('Property 5: Amount validation (client-managed)', () => {
  // An arbitrary that generates invalid client-managed amounts spanning every
  // documented rejection case:
  //   - missing (the `amount` field is omitted entirely)
  //   - zero and negative integers (not a positive integer)
  //   - non-integers / floats (not a positive integer)
  //   - above the range (> 999,999,999)
  // Each generated value is `{ omit: true }` (no amount field) or
  // `{ omit: false, amount: <invalid value> }`.
  const invalidAmount = fc.oneof(
    // Missing amount entirely.
    fc.constant({ omit: true }),
    fc.constant({ omit: false, amount: 0 }),
    // Negative integers.
    fc.integer({ min: -1_000_000_000, max: -1 }).map((amount) => ({ omit: false, amount })),
    // Above the maximum.
    fc.integer({ min: MAX_AMOUNT + 1, max: Number.MAX_SAFE_INTEGER }).map((amount) => ({
      omit: false,
      amount,
    })),
    // Non-integer floats inside the numeric range (e.g. 12.34) — not integers.
    fc
      .double({ min: 0, max: MAX_AMOUNT, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n))
      .map((amount) => ({ omit: false, amount })),
  );

  it('rejects missing / non-positive-integer / out-of-range amounts with 400 INVALID_AMOUNT and creates no payment', async () => {
    await fc.assert(
      fc.asyncProperty(invalidAmount, async (spec) => {
        const { app, storage } = await buildApp();
        try {
          const payload = { mode: 'client_managed' };
          if (!spec.omit) {
            payload.amount = spec.amount;
          }

          const res = await app.inject({ method: 'POST', url: '/payment', payload });

          expect(res.statusCode).toBe(400);
          expect(res.json().error_code).toBe('INVALID_AMOUNT');
          // No Active_Payment was created.
          expect(storage._byId.size).toBe(0);
        } finally {
          await app.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('accepts a valid in-range positive-integer amount with 201', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: MIN_AMOUNT, max: MAX_AMOUNT }), async (amount) => {
        const { app, storage } = await buildApp();
        try {
          const res = await app.inject({
            method: 'POST',
            url: '/payment',
            payload: { mode: 'client_managed', amount },
          });

          expect(res.statusCode).toBe(201);
          const body = res.json();
          expect(body.amount).toBe(amount);
          expect(body.status).toBe('pending');
          // Exactly one Active_Payment was created.
          expect(storage._byId.size).toBe(1);
        } finally {
          await app.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});
