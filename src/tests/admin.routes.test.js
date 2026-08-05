// Integration tests for the Admin/Panel routes and the server bootstrap.
//
// These drive the fully wired Fastify instance from buildServer() with
// fastify.inject(), against a real DAL-backed temp-file SQLite database (so the
// env-seeded admin user is reachable through a raw connection like the rest of
// the suite). The Shared_Poller is replaced with a fake that records
// setInterval() calls, so the poll-interval propagation is observed
// without any network use.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildServer } from '../server.js';

const SECRET = 'integration-test-signing-secret';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'correct horse battery staple';

// A real, structurally valid Static_QRIS with a correct trailing CRC16.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

/**
 * Extract the `admin_session=<token>` pair from a Set-Cookie header so it can be
 * replayed on a subsequent request's `Cookie` header.
 *
 * @param {string|string[]|undefined} setCookie
 * @returns {string|null}
 */
function extractSessionCookie(setCookie) {
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    if (typeof header === 'string' && header.startsWith('admin_session=')) {
      return header.split(';')[0];
    }
  }
  return null;
}

/** A fake Shared_Poller capturing setInterval() calls. */
function createFakePoller() {
  return {
    intervals: [],
    ensureRunningCount: 0,
    setInterval(ms) {
      this.intervals.push(ms);
    },
    ensureRunning() {
      this.ensureRunningCount += 1;
    },
    stop() {},
  };
}

describe('admin routes (via buildServer)', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  let dbPath;
  let poller;
  const savedEnv = {};

  beforeEach(async () => {
    dbPath = join(tmpdir(), `admin-routes-${randomUUID()}.db`);
    poller = createFakePoller();

    for (const key of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']) {
      savedEnv[key] = process.env[key];
    }
    process.env.ADMIN_USERNAME = ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    process.env.ADMIN_SESSION_SECRET = SECRET;

    app = await buildServer({ dbPath, poller });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    for (const key of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  /**
   * Log in and return the session cookie pair.
   * @returns {Promise<string>}
   */
  async function login(password = ADMIN_PASSWORD) {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { username: ADMIN_USERNAME, password },
    });
    expect(res.statusCode).toBe(200);
    const cookie = extractSessionCookie(res.headers['set-cookie']);
    expect(cookie).not.toBeNull();
    return cookie;
  }

  describe('login and session', () => {
    it('logs in with valid credentials and sets an httpOnly session cookie', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/login',
        payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
      });
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(header).toMatch(/admin_session=/);
      expect(header).toMatch(/HttpOnly/);
    });

    it('rejects invalid credentials with a generic 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/login',
        payload: { username: ADMIN_USERNAME, password: 'wrong' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe('Invalid username or password.');
    });

    it('denies a protected route without a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/config' });
      expect(res.statusCode).toBe(401);
      expect(res.json().error_code).toBe('UNAUTHORIZED');
    });

    it('allows a protected route with a valid session cookie', async () => {
      const cookie = await login();
      const res = await app.inject({
        method: 'GET',
        url: '/admin/config',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('poll_interval');
    });

    it('clears the session cookie on logout', async () => {
      const res = await app.inject({ method: 'POST', url: '/admin/logout' });
      expect(res.statusCode).toBe(200);
      const setCookie = res.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(header).toMatch(/admin_session=;/);
      expect(header).toMatch(/Max-Age=0/);
    });
  });

  describe('API key management', () => {
    it('creates a key (revealing the full value once), lists it masked, and revokes it', async () => {
      const cookie = await login();

      // Create: full value revealed once.
      const created = await app.inject({
        method: 'POST',
        url: '/admin/api-keys',
        headers: { cookie },
      });
      expect(created.statusCode).toBe(201);
      const key = created.json();
      expect(typeof key.value).toBe('string');
      expect(key.value.length).toBeGreaterThan(0);
      expect(key.status).toBe('active');

      // List: masked, no full value or hash.
      const listed = await app.inject({
        method: 'GET',
        url: '/admin/api-keys',
        headers: { cookie },
      });
      expect(listed.statusCode).toBe(200);
      const list = listed.json();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe(key.id);
      expect(list[0]).not.toHaveProperty('value');
      expect(list[0]).not.toHaveProperty('key_hash');

      // Revoke.
      const revoked = await app.inject({
        method: 'POST',
        url: `/admin/api-keys/${key.id}/revoke`,
        headers: { cookie },
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().status).toBe('revoked');

      // Revoking again is rejected and modifies nothing.
      const again = await app.inject({
        method: 'POST',
        url: `/admin/api-keys/${key.id}/revoke`,
        headers: { cookie },
      });
      expect(again.statusCode).toBe(404);
    });

    it('requires a session to manage API keys', async () => {
      const res = await app.inject({ method: 'POST', url: '/admin/api-keys' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('config', () => {
    it('updates a valid poll_interval and reschedules the poller within <=5s', async () => {
      const cookie = await login();
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/config',
        headers: { cookie },
        payload: { poll_interval: 3000 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().poll_interval).toBe(3000);
      // The poller was rescheduled with the new cadence.
      expect(poller.intervals).toContain(3000);
    });

    it('rejects an out-of-range poll_interval with HTTP 400 and keeps the old value', async () => {
      const cookie = await login();
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/config',
        headers: { cookie },
        payload: { poll_interval: 50 },
      });
      expect(res.statusCode).toBe(400);

      // The stored value is unchanged and the poller was not rescheduled.
      const after = await app.inject({ method: 'GET', url: '/admin/config', headers: { cookie } });
      expect(after.json().poll_interval).not.toBe(50);
      expect(poller.intervals).not.toContain(50);
    });

    it('rejects an invalid webhook_url with HTTP 400', async () => {
      const cookie = await login();
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/config',
        headers: { cookie },
        payload: { webhook_url: 'not-a-url' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('INVALID_WEBHOOK_URL');
    });

    it('stores a valid static_qris and rejects an invalid one', async () => {
      const cookie = await login();

      const ok = await app.inject({
        method: 'PUT',
        url: '/admin/config',
        headers: { cookie },
        payload: { static_qris: VALID_STATIC_QRIS },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().static_qris).toBe(VALID_STATIC_QRIS);

      const bad = await app.inject({
        method: 'PUT',
        url: '/admin/config',
        headers: { cookie },
        payload: { static_qris: 'not-a-qris' },
      });
      expect(bad.statusCode).toBe(400);

      // The previously stored valid value is retained.
      const after = await app.inject({ method: 'GET', url: '/admin/config', headers: { cookie } });
      expect(after.json().static_qris).toBe(VALID_STATIC_QRIS);
    });

    it('rejects the whole update atomically when one field is invalid', async () => {
      const cookie = await login();
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/config',
        headers: { cookie },
        payload: { poll_interval: 4000, webhook_url: 'not-a-url' },
      });
      expect(res.statusCode).toBe(400);
      // poll_interval must NOT have been applied because the update is atomic.
      expect(poller.intervals).not.toContain(4000);
    });
  });

  describe('payment history', () => {
    it('requires a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/payments/history' });
      expect(res.statusCode).toBe(401);
    });

    it('returns paid/expired payments most recent first, excluding pending', async () => {
      const cookie = await login();

      // Seed directly through the DAL (decorated on the app) so the endpoint
      // has terminal-state payments to return without exercising the poller.
      app.storage.payments.insertPending({
        id: 'pay-1',
        amount: 1001,
        qris_string: 'QRIS-1',
        created_at: 1000,
        expires_at: 2000,
        timeout: 1000,
      });
      app.storage.payments.markPaid('pay-1', { txId: 'tx-1', paidAmount: 1001, paidAt: 5000 });

      app.storage.payments.insertPending({
        id: 'exp-1',
        amount: 1002,
        qris_string: 'QRIS-2',
        created_at: 900,
        expires_at: 950,
        timeout: 50,
      });
      app.storage.payments.expireOverdue(1000);

      app.storage.payments.insertPending({
        id: 'pend-1',
        amount: 1003,
        qris_string: 'QRIS-3',
        created_at: 1100,
        expires_at: 9_999_999,
        timeout: 1000,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/payments/history',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.map((p) => p.id);
      expect(ids).toEqual(['pay-1', 'exp-1']);
      expect(ids).not.toContain('pend-1');
    });

    it('honors limit and offset for pagination', async () => {
      const cookie = await login();
      for (let i = 0; i < 3; i += 1) {
        app.storage.payments.insertPending({
          id: `h${i}`,
          amount: 2000 + i,
          qris_string: `QRIS-${i}`,
          created_at: 1000 + i,
          expires_at: 1100 + i,
          timeout: 100,
        });
      }
      app.storage.payments.expireOverdue(9_999_999);

      const firstPage = await app.inject({
        method: 'GET',
        url: '/admin/payments/history?limit=2&offset=0',
        headers: { cookie },
      });
      expect(firstPage.statusCode).toBe(200);
      expect(firstPage.json()).toHaveLength(2);

      const secondPage = await app.inject({
        method: 'GET',
        url: '/admin/payments/history?limit=2&offset=2',
        headers: { cookie },
      });
      expect(secondPage.statusCode).toBe(200);
      expect(secondPage.json()).toHaveLength(1);
    });
  });
});

describe('admin payments list, detail, webhook resend, and transactions', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  let dbPath;
  let gobizClient;
  let webhookDispatcher;
  const savedEnv = {};

  beforeEach(async () => {
    dbPath = join(tmpdir(), `admin-routes-ext-${randomUUID()}.db`);

    for (const key of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']) {
      savedEnv[key] = process.env[key];
    }
    process.env.ADMIN_USERNAME = ADMIN_USERNAME;
    process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
    process.env.ADMIN_SESSION_SECRET = SECRET;

    // A fake GoBiz client capturing the params and returning canonical txs.
    gobizClient = {
      calls: [],
      result: [
        { txId: 'tx-1', amount: 50000, type: 'payin', time: '2024-01-01T00:00:00.000Z', raw: {} },
      ],
      error: null,
      async getRecentTransactions(params) {
        this.calls.push(params);
        if (this.error) {
          throw this.error;
        }
        return this.result;
      },
      merchantProfile: null,
      getMerchantProfile() {
        return this.merchantProfile;
      },
      async getMerchantId() {
        if (this.error) throw this.error;
        this.merchantProfile = {
          id_name: 'Test Owner',
          id_number: '123456789',
          email: 'test@example.com',
          phone: '08123456789',
          id_address: 'Owner Address',
          merchant_name: 'Test Merchant',
          id: 'test-merchant-id',
          outlet_address: 'Outlet Address',
          outlet_postal_code: '12345',
          aspi: {
            merchant_criteria: 'UMI',
            nmid: 'NMID123',
            mpan: 'MPAN123',
            mcc: '5812'
          },
          pops: [{ gopay: { aspi_terminal_id: 'TERM123' } }],
          bank_account: {
            bank_name: 'BCA',
            account_name: 'Test Owner',
            account_no: '123456'
          }
        };
      }
    };

    // A fake Webhook_Dispatcher recording calls; its return value is
    // configurable per test. The manual resend route prefers `dispatchOnce`
    // (single attempt, no retry); `dispatch` remains for the settlement hook.
    webhookDispatcher = {
      calls: [],
      result: { sent: true, success: true, attempts: 1, status: 200, url: 'https://hook.example' },
      async dispatch(payment) {
        this.calls.push(payment);
        return this.result;
      },
      async dispatchOnce(payment) {
        this.calls.push(payment);
        return this.result;
      },
    };

    app = await buildServer({ dbPath, poller: createFakePoller(), gobizClient, webhookDispatcher });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    for (const key of ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_SESSION_SECRET']) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  /** Log in and return the session cookie pair. */
  async function login() {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const cookie = extractSessionCookie(res.headers['set-cookie']);
    expect(cookie).not.toBeNull();
    return cookie;
  }

  /** Seed a pending payment and optionally settle it. */
  function seedPaid(id, amount, webhookUrl) {
    app.storage.payments.insertPending({
      id,
      amount,
      qris_string: `QRIS-${id}`,
      created_at: 1000,
      expires_at: 9_999_999,
      timeout: 1000,
      webhook_url: webhookUrl ?? null,
    });
    app.storage.payments.markPaid(id, { txId: `tx-${id}`, paidAmount: amount, paidAt: 5000 });
  }

  /** Seed a payment that is already expired (pending with a past expiry, swept). */
  function seedExpired(id, amount, webhookUrl) {
    app.storage.payments.insertPending({
      id,
      amount,
      qris_string: `QRIS-${id}`,
      created_at: 1000,
      expires_at: 2000,
      timeout: 1000,
      webhook_url: webhookUrl ?? null,
    });
    // Flip it to expired by sweeping past its expires_at.
    app.storage.payments.expireOverdue(3000);
  }

  describe('GET /admin/payments', () => {
    it('requires a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/payments' });
      expect(res.statusCode).toBe(401);
    });

    it('returns all payments with total, limit, and offset', async () => {
      const cookie = await login();
      seedPaid('pay-a', 1001);
      app.storage.payments.insertPending({
        id: 'pend-a',
        amount: 1002,
        qris_string: 'QRIS-pend',
        created_at: 2000,
        expires_at: 9_999_999,
        timeout: 1000,
      });

      const res = await app.inject({ method: 'GET', url: '/admin/payments', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.limit).toBe(50);
      expect(body.offset).toBe(0);
      expect(body.payments.map((p) => p.id).sort()).toEqual(['pay-a', 'pend-a']);
    });

    it('filters by a valid status and reports the filtered total', async () => {
      const cookie = await login();
      seedPaid('pay-b', 2001);
      app.storage.payments.insertPending({
        id: 'pend-b',
        amount: 2002,
        qris_string: 'QRIS-pb',
        created_at: 2000,
        expires_at: 9_999_999,
        timeout: 1000,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/payments?status=paid',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      expect(body.payments.map((p) => p.id)).toEqual(['pay-b']);
    });

    it('treats an unknown status as no filter (all statuses)', async () => {
      const cookie = await login();
      seedPaid('pay-c', 3001);
      app.storage.payments.insertPending({
        id: 'pend-c',
        amount: 3002,
        qris_string: 'QRIS-pc',
        created_at: 2000,
        expires_at: 9_999_999,
        timeout: 1000,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/payments?status=bogus',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(2);
    });
  });

  describe('GET /admin/payments/:id', () => {
    it('returns the full payment row plus webhook_logs', async () => {
      const cookie = await login();
      seedPaid('pay-d', 4001);
      app.storage.webhookLogs.append({
        id: 'log-d-1',
        payment_id: 'pay-d',
        target_url: 'https://hook.example',
        status: 'success',
        attempts: 1,
        last_attempt_at: 6000,
        last_error: null,
        response_status: 200,
        response_body: 'ok',
        request_body: '{"payment_id":"pay-d"}',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/admin/payments/pay-d',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe('pay-d');
      expect(body.status).toBe('paid');
      expect(body).toHaveProperty('qris_string');
      expect(body.webhook_logs).toHaveLength(1);
      expect(body.webhook_logs[0]).toMatchObject({
        id: 'log-d-1',
        response_status: 200,
        response_body: 'ok',
        request_body: '{"payment_id":"pay-d"}',
      });
    });

    it('returns 404 PAYMENT_NOT_FOUND when missing', async () => {
      const cookie = await login();
      const res = await app.inject({
        method: 'GET',
        url: '/admin/payments/ghost',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error_code).toBe('PAYMENT_NOT_FOUND');
    });
  });

  describe('POST /admin/payments/:id/webhook/resend', () => {
    it('re-dispatches the webhook for a paid payment and returns the result', async () => {
      const cookie = await login();
      seedPaid('pay-e', 5001, 'https://hook.example');

      const res = await app.inject({
        method: 'POST',
        url: '/admin/payments/pay-e/webhook/resend',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ sent: true, success: true, attempts: 1, status: 200 });
      expect(webhookDispatcher.calls).toHaveLength(1);
      expect(webhookDispatcher.calls[0].id).toBe('pay-e');
    });

    it('re-dispatches the webhook for an expired payment and returns the result', async () => {
      const cookie = await login();
      seedExpired('exp-e', 5050, 'https://hook.example');

      const res = await app.inject({
        method: 'POST',
        url: '/admin/payments/exp-e/webhook/resend',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ sent: true });
      expect(webhookDispatcher.calls).toHaveLength(1);
      expect(webhookDispatcher.calls[0].id).toBe('exp-e');
      expect(webhookDispatcher.calls[0].status).toBe('expired');
    });

    it('rejects a still-pending payment with 400', async () => {
      const cookie = await login();
      app.storage.payments.insertPending({
        id: 'pend-e',
        amount: 5002,
        qris_string: 'QRIS-pe',
        created_at: 2000,
        expires_at: 9_999_999,
        timeout: 1000,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/admin/payments/pend-e/webhook/resend',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('INVALID_REQUEST');
      expect(webhookDispatcher.calls).toHaveLength(0);
    });

    it('returns 404 when the payment does not exist', async () => {
      const cookie = await login();
      const res = await app.inject({
        method: 'POST',
        url: '/admin/payments/ghost/webhook/resend',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error_code).toBe('PAYMENT_NOT_FOUND');
    });

    it('returns 400 INVALID_WEBHOOK_URL when the dispatcher reports no URL', async () => {
      const cookie = await login();
      seedPaid('pay-f', 6001);
      webhookDispatcher.result = { sent: false };

      const res = await app.inject({
        method: 'POST',
        url: '/admin/payments/pay-f/webhook/resend',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error_code).toBe('INVALID_WEBHOOK_URL');
    });
  });

  describe('GET /admin/transactions', () => {
    it('requires a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/transactions' });
      expect(res.statusCode).toBe(401);
    });

    it('returns transactions from the GoBiz client with default days/size', async () => {
      const cookie = await login();
      const res = await app.inject({
        method: 'GET',
        url: '/admin/transactions',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().transactions).toEqual(gobizClient.result);
      expect(gobizClient.calls[0]).toEqual({ days: 7, size: 50 });
    });

    it('clamps days and size to their allowed ranges', async () => {
      const cookie = await login();
      await app.inject({
        method: 'GET',
        url: '/admin/transactions?days=999&size=999',
        headers: { cookie },
      });
      expect(gobizClient.calls[0]).toEqual({ days: 30, size: 100 });
    });

    it('returns 502 INTERNAL_ERROR on a GoBiz error', async () => {
      const cookie = await login();
      gobizClient.error = new Error('gobiz exploded');

      const res = await app.inject({
        method: 'GET',
        url: '/admin/transactions',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error_code).toBe('INTERNAL_ERROR');
    });
  });

  describe('GET /admin/merchant/info', () => {
    it('requires a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/admin/merchant/info' });
      expect(res.statusCode).toBe(401);
    });

    it('returns the cleaned merchant profile when successful', async () => {
      const cookie = await login();
      
      const res = await app.inject({
        method: 'GET',
        url: '/admin/merchant/info',
        headers: { cookie },
      });
      
      expect(res.statusCode).toBe(200);
      const profile = res.json();
      expect(profile.owner_name).toBe('Test Owner');
      expect(profile.merchant_name).toBe('Test Merchant');
      expect(profile.nmid).toBe('NMID123');
      expect(profile.terminal_id).toBe('TERM123');
      expect(profile.bank_name).toBe('BCA');
    });

    it('returns 500 INTERNAL_ERROR on a GoBiz error', async () => {
      const cookie = await login();
      gobizClient.error = new Error('gobiz exploded');

      const res = await app.inject({
        method: 'GET',
        url: '/admin/merchant/info',
        headers: { cookie },
      });
      
      expect(res.statusCode).toBe(500);
      expect(res.json().error_code).toBe('INTERNAL_ERROR');
    });
  });
});
