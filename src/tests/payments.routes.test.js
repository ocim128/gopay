// Integration tests for the payment REST routes.
//
// These tests exercise the Fastify plugin end-to-end with `fastify.inject()`
// over an in-memory DAL and a real Payment_Service, verifying status codes and
// response shapes against the requirements. The QRIS image renderer is injected
// as a fast stub so the tests stay deterministic and quick.

import { describe, it, expect, beforeEach } from 'vitest';
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
          tz: record.tz ?? null,
          tx_id: null,
          paid_amount: null,
          paid_at: null,
          tx_raw: null,
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
        p.tx_raw = settlement.raw ?? null;
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
 * Build a Fastify app with the payment routes registered. By default a
 * passthrough auth preHandler is injected so tests can focus on the endpoint
 * logic; pass `authPreHandler: undefined` and a storage with `apiKeys` to test
 * real authentication.
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

describe('POST /payment', () => {
  let app;
  beforeEach(async () => {
    ({ app } = await buildApp());
  });

  it('creates a client-managed payment and returns exactly the documented fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 12345 },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(body.status).toBe('pending');
    expect(body.amount).toBe(12345);
    expect(typeof body.qris_string).toBe('string');
    expect(body.qris_url).toBe(`/payment/${encodeURIComponent(body.id)}/qris.png`);
    // With no tz supplied and no Config Service injected, the default display
    // zone (Asia/Jakarta, +07:00) is applied and echoed back.
    expect(body.tz).toBe('Asia/Jakarta');
    // The ISO sibling is an offset-aware Asia/Jakarta (+07:00) timestamp that
    // refers to the same instant as the epoch-ms field.
    expect(body.expires_at_iso).toMatch(/\+07:00$/);
    expect(new Date(body.expires_at_iso).getTime()).toBe(body.expires_at);
    expect(new Date(body.created_at_iso).getTime()).toBe(body.created_at);
  });

  it('renders the _iso fields in an explicit per-payment tz and echoes it back (Asia/Makassar => +08:00)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 22345, tz: 'Asia/Makassar' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.tz).toBe('Asia/Makassar');
    // Asia/Makassar is WITA (+08:00); the rendered ISO sibling carries that
    // offset while still pointing at the same absolute instant.
    expect(body.expires_at_iso).toMatch(/\+08:00$/);
    expect(new Date(body.expires_at_iso).getTime()).toBe(body.expires_at);
    expect(new Date(body.created_at_iso).getTime()).toBe(body.created_at);
  });

  it('rejects an unknown tz with 400 INVALID_REQUEST and creates no payment', async () => {
    const { app: app2, storage } = await buildApp();
    const res = await app2.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 9191, tz: 'Mars/Phobos' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_REQUEST');
    expect(storage._byId.size).toBe(0);
  });

  it('rejects a missing amount with 400 INVALID_AMOUNT', async () => {
    const res = await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_AMOUNT');
  });

  it('rejects an out-of-range amount with 400 INVALID_AMOUNT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 50001_000_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_AMOUNT');
  });

  it('rejects a duplicate active amount with 409 AMOUNT_IN_USE', async () => {
    await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 5000 } });
    const res = await app.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 5000 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe('AMOUNT_IN_USE');
  });

  it('creates a server-managed payment and returns the final amount', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'server_managed', base_amount: 10000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.amount).toBeGreaterThanOrEqual(10000);
    expect(body.amount).toBeLessThanOrEqual(10999);
  });

  it('rejects a missing base_amount with 400 INVALID_BASE_AMOUNT', async () => {
    const res = await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'server_managed' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_BASE_AMOUNT');
  });

  it('rejects an invalid webhook_url with 400 INVALID_WEBHOOK_URL and creates no payment', async () => {
    const { app: app2, storage } = await buildApp();
    const res = await app2.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 7777, webhook_url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_WEBHOOK_URL');
    expect(storage._byId.size).toBe(0);
  });

  it('ignores a poll_interval field in the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 4242, poll_interval: 1234 },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects an out-of-range timeout with 400 INVALID_REQUEST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 50999, timeout: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe('INVALID_REQUEST');
  });

  it('maps an absent/invalid Static_QRIS to 500 QRIS_INVALID', async () => {
    const { app: app2 } = await buildApp({ staticQris: null });
    const res = await app2.inject({
      method: 'POST',
      url: '/payment',
      payload: { mode: 'client_managed', amount: 50333 },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error_code).toBe('QRIS_INVALID');
  });
});

describe('GET /payment/:id', () => {
  it('returns 200 with the documented fields for an existing payment', async () => {
    const { app } = await buildApp();
    const created = (
      await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 8888 } })
    ).json();

    const res = await app.inject({ method: 'GET', url: `/payment/${created.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['amount', 'created_at', 'created_at_iso', 'expires_at', 'expires_at_iso', 'id', 'status', 'tz'].sort(),
    );
    expect(body.status).toBe('pending');
    expect(body.tz).toBe('Asia/Jakarta');
    expect(body.expires_at_iso).toMatch(/\+07:00$/);
    expect(new Date(body.expires_at_iso).getTime()).toBe(body.expires_at);
  });

  it('returns 404 PAYMENT_NOT_FOUND for an unknown id', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/payment/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('PAYMENT_NOT_FOUND');
  });

  it('includes settlement details when the payment is paid', async () => {
    const { app, storage } = await buildApp();
    const created = (
      await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 6543 } })
    ).json();
    const rawTransaction = {
      transaction_id: 'tx-1',
      transaction_time: '2026-08-22T13:08:42.000Z',
      gross_amount: 654300,
    };
    storage.payments.markPaid(created.id, {
      txId: 'tx-1',
      paidAmount: 6543,
      paidAt: 1700000000000,
      raw: JSON.stringify(rawTransaction),
    });

    const res = await app.inject({ method: 'GET', url: `/payment/${created.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('paid');
    expect(body.txId).toBe('tx-1');
    expect(body.paid_amount).toBe(6543);
    expect(body.paid_at).toBe(1700000000000);
    expect(body.paid_at_iso).toMatch(/\+07:00$/);
    expect(new Date(body.paid_at_iso).getTime()).toBe(1700000000000);
    expect(body.provider_transaction).toEqual({
      transaction_time: rawTransaction.transaction_time,
    });
  });
});

describe('GET /payments', () => {
  it('returns 200 with an empty list when there are no active payments', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/payments' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns only pending payments sorted by expires_at ascending', async () => {
    const { app, storage } = await buildApp();
    await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 50100, timeout: 20000 } });
    const second = (
      await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 50200, timeout: 10000 } })
    ).json();
    const paid = (
      await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 50300, timeout: 30000 } })
    ).json();
    storage.payments.markPaid(paid.id, { txId: 'tx-x', paidAmount: 300, paidAt: 1 });

    const res = await app.inject({ method: 'GET', url: '/payments' });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    // The paid payment is excluded; the shorter-timeout payment expires first.
    expect(list.map((p) => p.amount)).toEqual([50200, 50100]);
    expect(list[0].id).toBe(second.id);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(
        ['amount', 'created_at', 'created_at_iso', 'expires_at', 'expires_at_iso', 'id', 'status', 'tz'].sort(),
      );
      expect(entry.status).toBe('pending');
      expect(entry.expires_at_iso).toMatch(/\+07:00$/);
    }
  });
});

describe('GET /payment/:id/qris.png', () => {
  it('serves the QRIS image as PNG (design section 4)', async () => {
    const { app } = await buildApp();
    const created = (
      await app.inject({ method: 'POST', url: '/payment', payload: { mode: 'client_managed', amount: 1212 } })
    ).json();

    const res = await app.inject({ method: 'GET', url: `/payment/${created.id}/qris.png` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.length).toBeGreaterThan(0);
  });

  it('returns 404 PAYMENT_NOT_FOUND for an unknown id', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/payment/missing/qris.png' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error_code).toBe('PAYMENT_NOT_FOUND');
  });
});

describe('API key authentication', () => {
  function storageWithApiKey(validHash) {
    const storage = createInMemoryStorage();
    storage.apiKeys = {
      getActiveByHash(hash) {
        return hash === validHash ? { id: 'k1', key_hash: validHash, key_prefix: 'gp_', status: 'active' } : null;
      },
    };
    return storage;
  }

  it('rejects an unauthenticated request with 401 UNAUTHORIZED', async () => {
    const storage = storageWithApiKey('unused');
    // Do not inject authPreHandler so the real API-key preHandler is built.
    const { app } = await buildApp({ storage, authPreHandler: undefined });
    const res = await app.inject({ method: 'GET', url: '/payments' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
  });

  it('accepts a request bearing a valid API key', async () => {
    const { hashApiKey } = await import('../auth/hashing.js');
    const apiKey = 'secret-test-key';
    const storage = storageWithApiKey(hashApiKey(apiKey));
    const { app } = await buildApp({ storage, authPreHandler: undefined });
    const res = await app.inject({
      method: 'GET',
      url: '/payments',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(res.statusCode).toBe(200);
  });
});
