// Property-based test for `GET /payments` ordering and pagination.
//
// The list of Active_Payment is sorted by `expires_at` in
// ascending order (the Payment that expires soonest first).
// The response is paginated with `limit` (range 1..100,
// default 100) and `offset` (>= 0, default 0). Out-of-range `limit`/`offset`
// values fail schema validation and are rejected as HTTP 400 / INVALID_REQUEST
// (see `src/routes/schemas.js`: `limit` enforces minimum 1 / maximum 100 and
// `offset` enforces minimum 0).
//
// The test exercises the routes end-to-end with `fastify.inject()` over an
// in-memory DAL and a real Payment_Service (the same pattern used by
// `payments.routes.test.js`). A fixed clock is injected so every Payment shares
// the same `created_at`; combined with distinct `timeout` values this gives
// each Payment a distinct, deterministic `expires_at` (= created_at + timeout),
// which makes the expected ascending order unambiguous.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Fastify from 'fastify';

import paymentsRoutes from '../routes/payments.routes.js';
import { createPaymentService } from '../payment/payment-service.js';
import {
  LIST_LIMIT_MIN,
  LIST_LIMIT_MAX,
  TIMEOUT_MIN_MS,
  TIMEOUT_MAX_MS,
} from '../routes/schemas.js';

// A minimal, valid "tag-only" Static_QRIS accepted by the QRIS_Builder.
const STATIC_QRIS = '0002010102115802ID6304';

// A fixed clock value so all Payment created in one app share `created_at`.
const FIXED_NOW = 1_700_000_000_000;

/**
 * Build an in-memory storage whose `payments` store satisfies the subset of the
 * DAL contract that the Payment_Service uses, including amount-uniqueness among
 * pending payments and the ascending-by-`expires_at` slice for `listActive`.
 * (Mirrors the helper in `payments.routes.test.js`.)
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
 * Build a Fastify app with the payment routes registered over a real
 * Payment_Service and an injected fixed clock. A passthrough auth preHandler is
 * used so the test focuses on the list endpoint's ordering/pagination logic.
 */
async function buildApp() {
  const storage = createInMemoryStorage();
  const config = { getStaticQris: () => STATIC_QRIS };
  const paymentService = createPaymentService({ storage, config, now: () => FIXED_NOW });

  const app = Fastify();
  await app.register(paymentsRoutes, {
    paymentService,
    storage,
    authPreHandler: async () => {},
    generateQrisImage: async () => Buffer.from('PNGDATA'),
  });
  await app.ready();
  return { app, storage };
}

describe('Property 13: GET /payments list ordering & pagination', () => {
  it('returns the expected ascending-by-expires_at slice for any valid limit/offset', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Each pending Payment is described by a distinct amount (so no
        // AMOUNT_IN_USE collision) and a distinct timeout (so every expires_at
        // is distinct, making the ascending order unambiguous).
        fc
          .uniqueArray(
            fc.record({
              amount: fc.integer({ min: 1000, max: 9999000 }),
              timeout: fc.integer({ min: TIMEOUT_MIN_MS, max: TIMEOUT_MAX_MS }),
            }),
            { minLength: 0, maxLength: 12, selector: (p) => p.amount },
          )
          // Enforce distinct timeouts too, so expires_at values never tie.
          .filter((arr) => new Set(arr.map((p) => p.timeout)).size === arr.length),
        fc.integer({ min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX }),
        fc.nat({ max: 20 }),
        async (specs, limit, offset) => {
          const { app } = await buildApp();
          try {
            // Create every pending Payment (client-managed mode).
            for (const spec of specs) {
              const res = await app.inject({
                method: 'POST',
                url: '/payment',
                payload: { mode: 'client_managed', amount: spec.amount, timeout: spec.timeout },
              });
              expect(res.statusCode).toBe(201);
            }

            // The expected full ordering: ascending by expires_at, which here
            // equals FIXED_NOW + timeout, so equivalently ascending by timeout.
            const expectedFull = [...specs]
              .map((spec) => ({ amount: spec.amount, expires_at: FIXED_NOW + spec.timeout }))
              .sort((a, b) => a.expires_at - b.expires_at);
            const expectedPage = expectedFull.slice(offset, offset + limit);

            const res = await app.inject({
              method: 'GET',
              url: `/payments?limit=${limit}&offset=${offset}`,
            });
            expect(res.statusCode).toBe(200);
            const page = res.json();

            // The page is the expected slice (same length, same order).
            expect(page.length).toBe(expectedPage.length);
            expect(page.map((p) => p.expires_at)).toEqual(expectedPage.map((p) => p.expires_at));
            expect(page.map((p) => p.amount)).toEqual(expectedPage.map((p) => p.amount));

            // The returned page is itself sorted ascending by expires_at.
            for (let i = 1; i < page.length; i += 1) {
              expect(page[i].expires_at).toBeGreaterThanOrEqual(page[i - 1].expires_at);
            }

            // Every returned entry is a pending Active_Payment with exactly the
            // documented fields.
            for (const entry of page) {
              expect(entry.status).toBe('pending');
              expect(Object.keys(entry).sort()).toEqual(
                ['amount', 'created_at', 'created_at_iso', 'expires_at', 'expires_at_iso', 'id', 'status', 'tz'].sort(),
              );
            }
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects out-of-range limit/offset with 400 INVALID_REQUEST per the schema', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate a query that violates at least one schema bound:
        //   limit < 1, limit > 100, or offset < 0.
        fc.oneof(
          fc.record({ limit: fc.integer({ max: LIST_LIMIT_MIN - 1 }), offset: fc.nat({ max: 50 }) }),
          fc.record({ limit: fc.integer({ min: LIST_LIMIT_MAX + 1, max: 10_000 }), offset: fc.nat({ max: 50 }) }),
          fc.record({ limit: fc.integer({ min: LIST_LIMIT_MIN, max: LIST_LIMIT_MAX }), offset: fc.integer({ min: -10_000, max: -1 }) }),
        ),
        async ({ limit, offset }) => {
          const { app } = await buildApp();
          try {
            const res = await app.inject({
              method: 'GET',
              url: `/payments?limit=${limit}&offset=${offset}`,
            });
            expect(res.statusCode).toBe(400);
            expect(res.json().error_code).toBe('INVALID_REQUEST');
          } finally {
            await app.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
