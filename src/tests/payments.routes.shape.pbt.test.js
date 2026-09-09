// Property-based test for the creation & read response shape of the payment
// REST routes. It validates that, across many valid inputs:
//
//   * POST /payment returns 201 with a body containing EXACTLY the documented
//     key set {id, status, amount, qris_string, qris_url, expires_at} and a
//     status of 'pending', and
//   * GET /payment/:id returns 200 with a body containing EXACTLY
//     {id, amount, status, expires_at} where status is one of the valid enum
//     values pending|paid|expired.
//
// The routes are exercised end-to-end with `fastify.inject()` over an in-memory
// DAL and a real Payment_Service, using a passthrough auth preHandler, a stub
// QRIS image renderer, and a valid Static_QRIS config. A fresh app/storage is
// built per generated input so amount uniqueness among pending payments
// never causes spurious collisions between iterations.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Fastify from 'fastify';

import paymentsRoutes from '../routes/payments.routes.js';
import { createPaymentService } from '../payment/payment-service.js';
import { MIN_AMOUNT, MAX_AMOUNT } from '../payment/amount-allocator.js';

// A minimal, valid "tag-only" Static_QRIS: it contains the mandatory country
// code field (5802ID), the static point-of-initiation marker (010211), and
// ends with the CRC tag (6304), so the QRIS_Builder accepts it.
const STATIC_QRIS = '0002010102115802ID6304';

// The exact key sets documented for each response. Each timestamp
// field also has an offset-aware ISO sibling (`*_at_iso`) rendered in WIB.
const CREATE_KEYS = [
  'amount',
  'created_at',
  'created_at_iso',
  'expires_at',
  'expires_at_iso',
  'reconcile_until',
  'id',
  'qris_string',
  'qris_url',
  'status',
  'tz',
].sort();
const READ_KEYS = [
  'amount',
  'created_at',
  'created_at_iso',
  'expires_at',
  'expires_at_iso',
  'reconcile_until',
  'id',
  'status',
  'tz',
].sort();
const STATUS_ENUM = ['pending', 'paid', 'expired'];

/**
 * Build an in-memory storage whose `payments` store satisfies the subset of the
 * DAL contract that the Payment_Service uses, including amount-uniqueness among
 * pending payments. Mirrors the helper in payments.routes.test.js.
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
 * Build a Fastify app with the payment routes registered, using passthrough
 * auth, a stub QRIS image renderer, and a valid Static_QRIS config.
 */
async function buildApp() {
  const storage = createInMemoryStorage();
  const config = { getStaticQris: () => STATIC_QRIS };
  const paymentService = createPaymentService({ storage, config });

  const app = Fastify();
  await app.register(paymentsRoutes, {
    paymentService,
    storage,
    authPreHandler: async () => {},
    generateQrisImage: async () => Buffer.from('PNGDATA'),
  });
  await app.ready();
  return { app, storage, paymentService };
}

// Generators constrained to the valid input space:
//   * client_managed: a full Amount in 1000..9999000.
//   * server_managed: a Base_Amount >= 1 small enough that the formed Amount
//     (Base_Amount + suffix 0..999) cannot overflow the maximum Amount.
const clientManagedArb = fc
  .integer({ min: MIN_AMOUNT, max: MAX_AMOUNT })
  .map((amount) => ({ mode: 'client_managed', amount }));

const serverManagedArb = fc
  .integer({ min: MIN_AMOUNT, max: MAX_AMOUNT - 999 })
  .map((base_amount) => ({ mode: 'server_managed', base_amount }));

// Bias toward client_managed (the default Type 1) while still covering some
// server_managed inputs.
const payloadArb = fc.oneof(
  { weight: 3, arbitrary: clientManagedArb },
  { weight: 1, arbitrary: serverManagedArb },
);

describe('Property 4: Creation & read response shape', () => {
  it('returns exactly the documented keys on create and read for valid inputs', async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, async (payload) => {
        const { app } = await buildApp();

        // ── POST /payment ────────────────────────────────────────────────
        const createRes = await app.inject({ method: 'POST', url: '/payment', payload });
        expect(createRes.statusCode).toBe(201);

        const createBody = createRes.json();
        // Exactly the documented key set, no more and no fewer.
        expect(Object.keys(createBody).sort()).toEqual(CREATE_KEYS);
        expect(createBody.status).toBe('pending');
        expect(typeof createBody.id).toBe('string');
        expect(Number.isInteger(createBody.amount)).toBe(true);
        expect(typeof createBody.qris_string).toBe('string');
        expect(createBody.qris_url).toBe(`/payment/${encodeURIComponent(createBody.id)}/qris.png`);
        expect(Number.isInteger(createBody.expires_at)).toBe(true);

        // ── GET /payment/:id ─────────────────────────────────────────────
        const readRes = await app.inject({ method: 'GET', url: `/payment/${createBody.id}` });
        expect(readRes.statusCode).toBe(200);

        const readBody = readRes.json();
        // Exactly {id, amount, status, expires_at} for a pending payment.
        expect(Object.keys(readBody).sort()).toEqual(READ_KEYS);
        expect(STATUS_ENUM).toContain(readBody.status);
        expect(readBody.id).toBe(createBody.id);
        expect(readBody.amount).toBe(createBody.amount);
        expect(readBody.expires_at).toBe(createBody.expires_at);

        await app.close();
      }),
      { numRuns: 100 },
    );
  });
});
