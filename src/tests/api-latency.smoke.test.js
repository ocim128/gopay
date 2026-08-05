// API latency smoke tests.
//
// These tests assert the documented response-time budgets for the machine-facing
// payment endpoints by measuring wall-clock time around `fastify.inject()`:
//   * POST /payment       must respond within 2000 ms
//   * GET  /payment/:id   must respond within 1000 ms
//
// The endpoints are exercised end-to-end over an in-memory DAL and a real
// Payment_Service (the same setup as `payments.routes.test.js`), with a
// passthrough auth preHandler and a fast stub for the QRIS PNG renderer so QR
// image generation is never the bottleneck. Each budget is sampled across a few
// repetitions and we assert both the median and the maximum stay within budget,
// keeping the test deterministic and quick.

import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import Fastify from 'fastify';

import paymentsRoutes from '../routes/payments.routes.js';
import { createPaymentService } from '../payment/payment-service.js';

// A minimal, valid "tag-only" Static_QRIS: it contains the mandatory country
// code field (5802ID), the static point-of-initiation marker (010211), and
// ends with the CRC tag (6304), so the QRIS_Builder accepts it.
const STATIC_QRIS = '0002010102115802ID6304';

// Response-time budgets from the requirements.
const POST_BUDGET_MS = 2000;
const GET_BUDGET_MS = 1000;

// Number of measured repetitions per endpoint. A handful is enough to be
// representative while keeping the test fast and deterministic.
const REPETITIONS = 10;

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
 * Build a Fastify app with the payment routes registered. Auth is a passthrough
 * preHandler and the QRIS PNG renderer is a fast stub so that neither auth nor
 * image generation skews the measured latency.
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
    authPreHandler: async () => {},
    // Stub the QRIS image renderer so QR generation is never the bottleneck.
    generateQrisImage: async () => Buffer.from('PNGDATA'),
  });
  await app.ready();
  return { app, storage, paymentService };
}

/** Return the median of a numeric array (does not mutate the input). */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

describe('API latency smoke tests', () => {
  it('responds to POST /payment within 2000 ms', async () => {
    const { app } = await buildApp();

    // Warm-up request so JIT/first-call costs do not pollute the measurements.
    await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 50001 } });

    const samples = [];
    for (let i = 0; i < REPETITIONS; i += 1) {
      // Use a unique amount per iteration to avoid AMOUNT_IN_USE collisions.
      const amount = 100000 + i;
      const start = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: '/payment',
        payload: { mode: 'client_managed', amount },
      });
      const elapsed = performance.now() - start;
      expect(res.statusCode).toBe(201);
      samples.push(elapsed);
    }

    const maxMs = Math.max(...samples);
    const medianMs = median(samples);
    expect(medianMs).toBeLessThan(POST_BUDGET_MS);
    expect(maxMs).toBeLessThan(POST_BUDGET_MS);
  });

  it('responds to GET /payment/:id within 1000 ms', async () => {
    const { app } = await buildApp();

    // Create a payment to read back.
    const created = (
      await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 200000 } })
    ).json();

    // Warm-up read.
    await app.inject({ method: 'GET', url: `/payment/${created.id}` });

    const samples = [];
    for (let i = 0; i < REPETITIONS; i += 1) {
      const start = performance.now();
      const res = await app.inject({ method: 'GET', url: `/payment/${created.id}` });
      const elapsed = performance.now() - start;
      expect(res.statusCode).toBe(200);
      samples.push(elapsed);
    }

    const maxMs = Math.max(...samples);
    const medianMs = median(samples);
    expect(medianMs).toBeLessThan(GET_BUDGET_MS);
    expect(maxMs).toBeLessThan(GET_BUDGET_MS);
  });
});
