// Focused unit tests for the not-found and empty-list behaviours of the
// payment REST routes.
//
// These tests exercise the Fastify plugin end-to-end with `fastify.inject()`
// over an in-memory DAL and a real Payment_Service, asserting two precise
// contracts:
//   * GET /payment/:id for an unknown id -> HTTP 404 / PAYMENT_NOT_FOUND.
//   * GET /payments on a fresh store -> HTTP 200 with an empty array `[]`
//     (not 404, not an error).
//
// The QRIS image renderer is injected as a fast stub so the tests stay
// deterministic and quick. The in-memory storage + createPaymentService wiring
// mirrors `payments.routes.test.js`.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

import paymentsRoutes from '../routes/payments.routes.js';
import { createPaymentService } from '../payment/payment-service.js';

// A minimal, valid "tag-only" Static_QRIS: it contains the mandatory country
// code field (5802ID), the static point-of-initiation marker (010211), and
// ends with the CRC tag (6304), so the QRIS_Builder accepts it.
const STATIC_QRIS = '0002010102115802ID6304';

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
 * Build a Fastify app with the payment routes registered. A passthrough auth
 * preHandler is injected so these tests focus purely on the endpoint logic.
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
    // Passthrough auth unless a test overrides it.
    authPreHandler:
      'authPreHandler' in overrides ? overrides.authPreHandler : async () => {},
    generateQrisImage: async () => Buffer.from('PNGDATA'),
  });
  await app.ready();
  return { app, storage, paymentService };
}

describe('GET /payment/:id not found', () => {
  it('returns 404 PAYMENT_NOT_FOUND for an unknown id', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/payment/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('PAYMENT_NOT_FOUND');
  });
});

describe('GET /payments empty list', () => {
  it('returns 200 with an empty array on a fresh store (not 404, not an error)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/payments' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});
