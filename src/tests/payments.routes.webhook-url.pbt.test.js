// Property-based tests for per-Payment `webhook_url` validation on
// POST /payment.
//
// The property under test:
//   A per-Payment `webhook_url` that is NOT an absolute http/https URL is
//   rejected with HTTP 400 / INVALID_WEBHOOK_URL and creates no Payment, while
//   a valid http/https URL of at most 2048 characters is accepted (HTTP 201).
//
// Mapping note (verified against the implementation):
//   * `src/routes/schemas.js` constrains `webhook_url` with
//     `maxLength: WEBHOOK_URL_MAX_LENGTH` (2048). A value longer than 2048
//     characters therefore fails Fastify schema validation BEFORE the handler
//     runs and maps to HTTP 400 / INVALID_REQUEST, not
//     INVALID_WEBHOOK_URL.
//   * `src/routes/payments.routes.js` (`isValidWebhookUrl`) handles values that
//     pass the schema (length <= 2048): relative paths, non-http/https schemes,
//     and unparseable garbage map to HTTP 400 / INVALID_WEBHOOK_URL.
// The tests below assert the actual mapped code for each case accordingly.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Fastify from 'fastify';

import paymentsRoutes from '../routes/payments.routes.js';
import { createPaymentService } from '../payment/payment-service.js';
import { WEBHOOK_URL_MAX_LENGTH } from '../routes/schemas.js';

// A minimal, valid "tag-only" Static_QRIS accepted by the QRIS_Builder: it
// carries the mandatory country code (5802ID), the static point-of-initiation
// marker (010211), and ends with the CRC tag (6304).
const STATIC_QRIS = '0002010102115802ID6304';

// A fixed, in-range client-managed amount. Each property iteration builds a
// fresh app/storage, so a constant amount never collides.
const VALID_AMOUNT = 12345;

/**
 * Build an in-memory storage implementing the subset of the DAL contract the
 * Payment_Service relies on, including amount-uniqueness among pending
 * payments. `_byId` is exposed so tests can assert that no Payment was created.
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
 * Build a ready Fastify app with the payment routes registered over a fresh
 * in-memory storage and a real Payment_Service. Auth is a passthrough so the
 * property focuses on webhook_url validation.
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
  return { app, storage };
}

// ── Generators ──────────────────────────────────────────────────────────────

const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A short, non-empty token of URL-safe alphanumerics. */
const token = fc.string({ unit: fc.constantFrom(...ALNUM.split('')), minLength: 1, maxLength: 20 });

/**
 * Invalid webhook_url values that pass the schema (length <= 2048) but are NOT
 * absolute http/https URLs. These must map to INVALID_WEBHOOK_URL in the
 * handler. Three families: relative paths, non-http/https schemes, and
 * unparseable garbage (no scheme separator, so `new URL` throws).
 */
const invalidWebhookUrlArb = fc.oneof(
  // Relative paths (no scheme): `new URL` throws without a base.
  token.map((t) => `/${t}`),
  token.chain((a) => token.map((b) => `${a}/${b}`)),
  token.map((t) => `../${t}`),
  // Non-http/https schemes.
  fc
    .constantFrom('ftp', 'file', 'ws', 'wss', 'gopher', 'telnet', 'ssh')
    .chain((scheme) => token.map((host) => `${scheme}://${host}.example`)),
  fc.constantFrom('mailto', 'data', 'urn').chain((scheme) => token.map((rest) => `${scheme}:${rest}`)),
  // Unparseable garbage: a bare token with no scheme separator.
  token,
);

/**
 * Valid http/https URLs of at most WEBHOOK_URL_MAX_LENGTH characters. `fc.webUrl`
 * yields parseable http/https URLs; the filter guards the length bound.
 */
const validWebhookUrlArb = fc
  .webUrl({ validSchemes: ['http', 'https'] })
  .filter((u) => u.length <= WEBHOOK_URL_MAX_LENGTH);

/**
 * Over-length webhook_url values (> 2048 chars) that are otherwise valid
 * http/https URLs. These are rejected by the schema's maxLength, mapping to
 * INVALID_REQUEST rather than INVALID_WEBHOOK_URL.
 */
const overLengthWebhookUrlArb = fc
  .integer({ min: 1, max: 256 })
  .map((extra) => `https://example.com/${'a'.repeat(WEBHOOK_URL_MAX_LENGTH + extra)}`);

// ── webhook_url validation ────────────────────────────────────────────────────

describe('Property 24: webhook_url validation', () => {
  it('rejects a non-absolute / non-http(s) webhook_url with 400 INVALID_WEBHOOK_URL and creates no Payment', async () => {
    await fc.assert(
      fc.asyncProperty(invalidWebhookUrlArb, async (webhook_url) => {
        const { app, storage } = await buildApp();
        try {
          const res = await app.inject({
            method: 'POST',
            url: '/payment',
            payload: { mode: 'client_managed', amount: VALID_AMOUNT, webhook_url },
          });
          expect(res.statusCode).toBe(400);
          expect(res.json().error_code).toBe('INVALID_WEBHOOK_URL');
          // No Payment must be created when the webhook_url is invalid.
          expect(storage._byId.size).toBe(0);
        } finally {
          await app.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('accepts a valid http/https webhook_url (<= 2048 chars) with 201 and creates the Payment', async () => {
    await fc.assert(
      fc.asyncProperty(validWebhookUrlArb, async (webhook_url) => {
        const { app, storage } = await buildApp();
        try {
          const res = await app.inject({
            method: 'POST',
            url: '/payment',
            payload: { mode: 'client_managed', amount: VALID_AMOUNT, webhook_url },
          });
          expect(res.statusCode).toBe(201);
          expect(storage._byId.size).toBe(1);
        } finally {
          await app.close();
        }
      }),
      { numRuns: 100 },
    );
  });

  it('rejects an over-length webhook_url (> 2048 chars) with 400 INVALID_REQUEST via the schema and creates no Payment', async () => {
    await fc.assert(
      fc.asyncProperty(overLengthWebhookUrlArb, async (webhook_url) => {
        const { app, storage } = await buildApp();
        try {
          const res = await app.inject({
            method: 'POST',
            url: '/payment',
            payload: { mode: 'client_managed', amount: VALID_AMOUNT, webhook_url },
          });
          expect(res.statusCode).toBe(400);
          // The schema maxLength bound rejects this before the handler runs.
          expect(res.json().error_code).toBe('INVALID_REQUEST');
          expect(storage._byId.size).toBe(0);
        } finally {
          await app.close();
        }
      }),
      { numRuns: 100 },
    );
  });
});
