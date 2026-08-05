// Property-based test for the GET /payments active-list contract.
//
// No matter how a mix of payments is created and then
// settled or expired, `GET /payments` returns ONLY the Active_Payment (status
// `pending`) and that every returned entry is well-formed: it carries exactly
// the four documented keys {id, amount, status, expires_at} and its status is
// exactly `pending`. Settled (`paid`) and expired payments must never appear.
//
// The test drives the real Fastify plugin end-to-end with `fastify.inject()`
// over an in-memory DAL and a real Payment_Service, reusing the helper patterns
// from `payments.routes.test.js`. A controllable clock is injected into the
// Payment_Service so the test can deterministically expire a subset of payments
// by advancing time past their `expires_at` (the GET /payments handler lazily
// expires overdue pending payments before listing).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Fastify from 'fastify';

import paymentsRoutes from '../routes/payments.routes.js';
import { createPaymentService } from '../payment/payment-service.js';
import { TIMEOUT_MIN_MS, TIMEOUT_MAX_MS } from '../routes/schemas.js';

// A minimal, valid "tag-only" Static_QRIS accepted by the QRIS_Builder: the
// mandatory country-code field (5802ID), the static point-of-initiation marker
// (010211), and the trailing CRC tag (6304).
const STATIC_QRIS = '0002010102115802ID6304';

// Documented shape of a GET /payments entry. Each timestamp
// also has an offset-aware ISO sibling (`*_at_iso`) rendered in WIB.
const EXPECTED_KEYS = [
  'amount',
  'created_at',
  'created_at_iso',
  'expires_at',
  'expires_at_iso',
  'id',
  'status',
  'tz',
];

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
    _byId: byId,
  };
}

/**
 * Build a Fastify app with the payment routes registered over the supplied
 * storage and Payment_Service. Auth is a passthrough preHandler and the QRIS
 * image renderer is a fast stub, so the test stays deterministic.
 */
async function buildApp({ storage, paymentService }) {
  const app = Fastify();
  await app.register(paymentsRoutes, {
    paymentService,
    storage,
    authPreHandler: async () => {},
    generateQrisImage: async () => Buffer.from('PNGDATA'),
  });
  await app.ready();
  return app;
}

// A single generated payment: a distinct amount plus a lifecycle action that
// decides whether it stays pending ("keep"), is settled ("settle"), or is
// expired ("expire") before GET /payments is called.
const paymentArb = fc.record({
  amount: fc.integer({ min: 1000, max: 9999000 }),
  action: fc.constantFrom('keep', 'settle', 'expire'),
});

// A mix of payments with distinct amounts (so every creation succeeds rather
// than colliding on AMOUNT_IN_USE among Active_Payment).
const paymentsArb = fc.uniqueArray(paymentArb, {
  selector: (p) => p.amount,
  minLength: 0,
  maxLength: 12,
});

describe('Property 12: Active_Payment list contains only pending & is well-formed', () => {
  it('GET /payments returns only pending payments, each with exactly {id, amount, status, expires_at}', async () => {
    await fc.assert(
      fc.asyncProperty(paymentsArb, async (specs) => {
        // A controllable clock: keep payments use the maximum timeout, expiring
        // payments the minimum, and we advance the clock between the two so the
        // minimum-timeout payments lapse while the others stay pending.
        const clock = { t: 1_700_000_000_000 };
        const storage = createInMemoryStorage();
        const config = { getStaticQris: () => STATIC_QRIS };
        const paymentService = createPaymentService({
          storage,
          config,
          now: () => clock.t,
        });
        const app = await buildApp({ storage, paymentService });

        try {
          const settledIds = new Set();
          const expiredIds = new Set();
          const pendingIds = new Set();

          for (const spec of specs) {
            const timeout = spec.action === 'expire' ? TIMEOUT_MIN_MS : TIMEOUT_MAX_MS;
            const res = await app.inject({
              method: 'POST',
              url: '/payment',
              payload: { mode: 'client_managed', amount: spec.amount, timeout },
            });
            // Distinct amounts guarantee a successful creation.
            expect(res.statusCode).toBe(201);
            const { id } = res.json();

            if (spec.action === 'settle') {
              const result = storage.payments.markPaid(id, {
                txId: `tx-${id}`,
                paidAmount: spec.amount,
                paidAt: clock.t,
              });
              expect(result.ok).toBe(true);
              settledIds.add(id);
            } else if (spec.action === 'expire') {
              expiredIds.add(id);
            } else {
              pendingIds.add(id);
            }
          }

          // Advance time past the minimum-timeout payments (expiring) but well
          // short of the maximum-timeout payments (keep). The GET /payments
          // handler lazily expires the overdue ones before listing.
          clock.t += TIMEOUT_MIN_MS + 1;

          const res = await app.inject({ method: 'GET', url: '/payments' });
          expect(res.statusCode).toBe(200);
          const list = res.json();
          expect(Array.isArray(list)).toBe(true);

          // Every returned entry is well-formed: exactly the four documented
          // keys and status exactly "pending".
          for (const entry of list) {
            expect(Object.keys(entry).sort()).toEqual([...EXPECTED_KEYS]);
            expect(entry.status).toBe('pending');
          }

          // The list contains exactly the Active_Payment (kept pending) and no
          // settled or expired payments.
          const returnedIds = new Set(list.map((p) => p.id));
          expect(returnedIds).toEqual(pendingIds);
          for (const id of settledIds) {
            expect(returnedIds.has(id)).toBe(false);
          }
          for (const id of expiredIds) {
            expect(returnedIds.has(id)).toBe(false);
          }
        } finally {
          await app.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});
