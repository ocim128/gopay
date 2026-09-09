import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MongoClient } from 'mongodb';
import Fastify from 'fastify';
import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { createMongoStorage } from '../dal/mongo/mongo-storage.js';
import { createPaymentService } from '../payment/payment-service.js';
import { createConfigService } from '../config/runtime-config.js';
import { createWebhookDispatcher } from '../webhook/webhook-dispatcher.js';
import { createNotificationWorker } from '../webhook/notification-worker.js';
import { SharedPoller } from '../poller/shared-poller.js';
import { HttpTransport } from '../gobiz/http-transport.js';
import { parseAnalyticsTx, parseJournalTx } from '../gobiz/response-adapter.js';
import paymentsRoutes from '../routes/payments.routes.js';

const START = Date.parse('2026-09-09T03:00:00Z');
const QRIS = '0002010102115802ID6304';
const quiet = { log() {}, warn() {}, error() {} };
const transaction = (id, time = START, amount = 25000) => ({
  txId: id, amount, time: new Date(time).toISOString(), type: 'payin',
  raw: { transaction_time: new Date(time).toISOString(), status: 'settlement', payment_type: 'qris' },
});

describe.each(['sqlite', ...(process.env.MONGODB_URI_TEST ? ['mongodb'] : [])])('%s payment reliability', (backend) => {
  let storage, config, service, clock, directory, dbName, open;
  const workers = [];
  beforeEach(async () => {
    clock = START;
    directory = mkdtempSync(join(tmpdir(), 'gopay-reliability-'));
    dbName = `gopay_test_${randomUUID().replaceAll('-', '')}`;
    open = () => backend === 'sqlite' ? createSqliteStorage({ dbPath: join(directory, 'db.sqlite') })
      : createMongoStorage({ uri: process.env.MONGODB_URI_TEST, dbName });
    storage = await open();
    config = createConfigService(storage);
    await config.setStaticQris(QRIS);
    service = createPaymentService({ storage, config, now: () => clock });
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
    await storage?.close();
    if (backend === 'mongodb') {
      const client = new MongoClient(process.env.MONGODB_URI_TEST);
      try {
        await client.connect();
        if (!/^gopay_test_[a-f0-9]+$/.test(dbName)) throw new Error('Unsafe test database');
        await client.db(dbName).dropDatabase();
      } finally { await client.close(); }
    }
    // Only the directory returned by mkdtempSync for this test is removed.
    rmSync(directory, { recursive: true, force: true });
  });
  const create = (extra = {}) => service.createPayment({ mode: 'server', base_amount: 25000, ...extra });

  it('reserves through reconciliation, then cleans up during allocation without a poll', async () => {
    const p = await create();
    clock = p.expires_at + 1000;
    expect((await service.getPayment(p.id)).status).toBe('pending');
    expect((await create()).amount).toBe(25001);
    clock = p.expires_at + 120001;
    expect((await create()).amount).toBe(25000);
    expect((await storage.payments.getById(p.id)).notification_state).toBe('pending');
    expect((await storage.payments.getById(p.id)).status).toBe('expired');
  });

  it('reuses concurrent requests and survives closing and reopening the database', async () => {
    const input = { idempotency_key: 'checkout-1', client_id: 'store-a' };
    const results = await Promise.all(Array.from({ length: 8 }, () => create(input)));
    expect(new Set(results.map((p) => p.id)).size).toBe(1);
    expect(await storage.payments.countActive()).toBe(1);
    await expect(create({ ...input, base_amount: 26000 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect((await create({ ...input, client_id: 'store-b' })).id).not.toBe(results[0].id);
    await storage.close();
    storage = await open();
    service = createPaymentService({ storage, config: createConfigService(storage), now: () => clock });
    expect((await create(input)).id).toBe(results[0].id);
  });

  it('settles an on-time transfer after the QR deadline, including after a status read', async () => {
    const p = await create();
    clock = START + 301000;
    expect((await service.getPayment(p.id)).status).toBe('pending');
    const paid = await service.handleTransactions([transaction('paid-before-deadline', START + 299000)]);
    expect(paid[0].id).toBe(p.id);
    expect(paid[0].notification_state).toBe('pending');
  });

  it('rejects stale, future, and late transfer timestamps and cannot pay a replacement order', async () => {
    const p = await create();
    clock = START + 301000;
    expect(await service.handleTransactions([
      transaction('before', START - 1), transaction('late', START + 300001), transaction('future', START + 400000),
    ])).toEqual([]);
    clock = START + 420001;
    const replacement = await create();
    expect(replacement.amount).toBe(p.amount);
    expect(await service.handleTransactions([transaction('old-transfer', START + 299000)])).toEqual([]);
    expect((await storage.payments.getById(replacement.id)).status).toBe('pending');
  });

  it('fetches the matching transaction on the second page', async () => {
    const p = await create();
    const all = [...Array.from({ length: 11 }, (_, n) => transaction(`other-${n}`, START, 50000 + n)), transaction('page-two')];
    const fetch = vi.fn(async ({ offset, size }) => Object.assign(all.slice(offset, offset + size), { total: all.length }));
    const poller = new SharedPoller({ getRecentTransactions: fetch }, {
      getActiveCount: () => storage.payments.countActive(), onTransactions: (batch) => service.handleTransactions(batch),
      getStartTime: () => storage.payments.oldestActiveCreation(),
      now: () => clock, logger: quiet,
    });
    await poller.onTick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0].start).toBe(new Date(p.created_at).toISOString());
    expect(fetch.mock.calls[0][0].end).toBe(fetch.mock.calls[1][0].end);
    expect((await service.getPayment(p.id)).status).toBe('paid');
  });

  it('resumes durable webhook retries after restart and keeps the original signed request', async () => {
    await config.setDefaultWebhookUrl('https://store.example/webhook');
    const p = await create();
    await service.handleTransactions([transaction('durable')]);
    const request = vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValue({ status: 200 });
    const makeWorker = () => {
      const dispatcher = createWebhookDispatcher({ storage, webhookLogs: storage.webhookLogs,
        config: storage.config, hmacKey: 'test-key', transport: { request }, now: () => clock });
      const worker = createNotificationWorker({ storage, dispatcher, now: () => clock, logger: quiet });
      workers.push(worker);
      return worker;
    };
    const first = makeWorker();
    await first.start();
    expect(request).toHaveBeenCalledTimes(1);
    await first.stop();
    await storage.close();
    storage = await open();
    await storage.config.set('webhook_url', 'https://changed.example/webhook');
    clock += 2000;
    await makeWorker().start();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toEqual(request.mock.calls[0][0]);
    const stored = await storage.payments.getById(p.id);
    expect(stored.notification_state).toBe('success');
    expect(stored.notification_attempts).toBe(2);
  });

  it('allows only one lease owner and recovers an abandoned lease', async () => {
    const p = await create();
    await service.handleTransactions([transaction('leased')]);
    const jobs = await Promise.all(['one', 'two'].map((token) => storage.notifications.claim(clock, clock + 90000, token)));
    expect(jobs.filter(Boolean)).toHaveLength(1);
    expect(await storage.notifications.claim(clock, clock + 90000, 'three')).toBeNull();
    clock += 90001;
    expect((await storage.notifications.claim(clock, clock + 90000, 'new-owner')).id).toBe(p.id);
    expect(await storage.notifications.finish(p.id, jobs.find(Boolean).notification_lease,
      { state: 'success', attempts: 1, nextAt: clock })).toBe(false);
  });
});

it('keeps monitoring after a transient count read error', async () => {
  let fail = true;
  const count = async () => { if (fail) throw new Error('database down'); return 1; };
  const fetch = vi.fn(async () => []);
  const poller = new SharedPoller({ getRecentTransactions: fetch }, {
    getActiveCount: count, onTransactions: async () => {}, logger: quiet, pollImmediately: true,
    setTimeoutFn: () => 1, clearTimeoutFn: () => {},
  });
  await poller.ensureRunning();
  await poller.onTick();
  expect(poller.running).toBe(true);
  fail = false;
  await poller.onTick();
  expect(fetch).toHaveBeenCalledOnce();
  await poller.stop();
});

it('does not expire payments using an incomplete provider batch', async () => {
  const handle = vi.fn();
  const poller = new SharedPoller({ getRecentTransactions: async () => Object.assign([], { total: 10 }) }, {
    getActiveCount: async () => 1, onTransactions: handle, logger: quiet,
  });
  await poller.onTick();
  expect(handle).not.toHaveBeenCalled();
});

it.each(['refund', 'partial_refund', 'pending', 'unknown', undefined])('does not treat %s as payment', (status) => {
  const raw = { transaction_id: 'bad', gross_amount: 2500000, status, payment_type: 'qris', transaction_time: new Date(START).toISOString() };
  expect(parseAnalyticsTx({ transactions: [raw] })[0].type).toBe('ignored');
  expect(parseJournalTx({ data: [{ metadata: { transaction: raw } }] })[0].type).toBe('ignored');
});

it('accepts successful QRIS but excludes card transactions', () => {
  const raw = { status: 'SETTLEMENT', payment_type: 'QRIS', gross_amount: 2500000 };
  expect(parseAnalyticsTx({ transactions: [raw] })[0].type).toBe('payin');
  expect(parseAnalyticsTx({ transactions: [{ ...raw, payment_type: 'credit_card' }] })[0].type).toBe('ignored');
});

it('times out while a real HTTP response body is stalled', async () => {
  let headersSent = false;
  const server = createServer((_req, res) => {
    res.writeHead(200); res.flushHeaders(); headersSent = true;
    const timer = setTimeout(() => res.end('{}'), 2000);
    res.on('close', () => clearTimeout(timer));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await expect(new HttpTransport().request({ url: `http://127.0.0.1:${server.address().port}`, timeoutMs: 300 }))
      .rejects.toThrow(/timed out/);
    expect(headersSent).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

it('continues delivery retries when diagnostic logging fails', async () => {
  const request = vi.fn().mockResolvedValueOnce({ status: 503 }).mockResolvedValue({ status: 200 });
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    const dispatcher = createWebhookDispatcher({
      webhookLogs: { append: async () => { throw new Error('log unavailable'); }, markPermanentFailure: async () => {} },
      transport: { request }, sleep: async () => {}, hmacKey: 'test-key',
    });
    expect(await dispatcher.dispatch({ id: 'p', created_at: START, paid_at: START, amount: 25000, webhook_url: 'https://store.example' }))
      .toMatchObject({ success: true, attempts: 2 });
    expect(request).toHaveBeenCalledTimes(2);
  } finally { log.mockRestore(); }
});

it('scopes the HTTP idempotency key to the authenticated client and returns reconciliation timing', async () => {
  const storage = createSqliteStorage({ dbPath: ':memory:' });
  const app = Fastify();
  try {
    const config = createConfigService(storage);
    await config.setStaticQris(QRIS);
    await app.register(paymentsRoutes, {
      storage, paymentService: createPaymentService({ storage, config }),
      authPreHandler: async (req) => { req.apiKey = { id: req.headers['x-test-client'] }; },
    });
    const post = (client, amount = 25000) => app.inject({ method: 'POST', url: '/payment',
      headers: { 'idempotency-key': 'one-order', 'x-test-client': client }, payload: { base_amount: amount } });
    const first = await post('a');
    expect(first.statusCode).toBe(201);
    expect((await post('a')).json().id).toBe(first.json().id);
    expect((await post('b')).json().id).not.toBe(first.json().id);
    expect((await post('a', 26000)).statusCode).toBe(409);
    expect(first.json().reconcile_until - first.json().expires_at).toBe(120000);
  } finally { await app.close(); await storage.close(); }
});
