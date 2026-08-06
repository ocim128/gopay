// Regression test for the async display-timezone resolution in the payment
// routes. The Config Service `getDisplayTimezone()` is async (it reads through
// the DAL), so `resolveDisplayTz` is async and MUST be awaited before the
// response is serialized. A missing await previously produced a literal
// `"[object Promise]"` string in the `tz` field and silently fell back to the
// Jakarta offset for the `_iso` timestamps. This test drives the real route
// plugin with a real Config Service backed by an in-memory DAL, configures a
// non-default display timezone, and asserts the rendered `tz` is the configured
// value and that the `_iso` offsets reflect it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { createConfigService } from '../config/runtime-config.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import paymentsRoutes from '../routes/payments.routes.js';

const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

describe('payments.routes — async display timezone resolution', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  let storage;

  beforeEach(async () => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    app = Fastify();
  });

  afterEach(async () => {
    if (app) await app.close();
    if (storage) await storage.close();
  });

  it('renders the configured tz (not [object Promise]) and matching _iso offsets on POST /payment', async () => {
    const config = createConfigService(storage);
    await config.setStaticQris(VALID_STATIC_QRIS);
    // Configure a non-default display timezone so a missing await would show.
    await config.setDisplayTimezone('Asia/Makassar');

    // Inject a fake payment service so the route's createPayment path runs
    // through the real resolveDisplayTz + serialization code.
    const created = {
      id: 'p1',
      status: 'pending',
      amount: 5000,
      qris_string: 'q',
      qris_url: null,
      created_at: 1_700_000_000_000,
      expires_at: 1_700_000_300_000,
      timeout: 300_000,
      tolerance: 0,
      webhook_url: null,
      tx_id: null,
      paid_amount: null,
      paid_at: null,
      tx_raw: null,
      tz: null,
    };
    await app.register(paymentsRoutes, {
      paymentService: {
        createPayment: async () => created,
        getPayment: async () => null,
        listActive: async () => [],
      },
      configService: config,
      // Bypass API-key auth so the create handler runs.
      authPreHandler: async (_req, _reply) => {},
      storage,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/payment',
      body: { mode: 'client_managed', amount: 5000 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();

    // The tz field is the configured value, never a Promise string.
    expect(body.tz).toBe('Asia/Makassar');
    expect(body.tz).not.toBe('[object Promise]');

    // The created_at_iso offset reflects Asia/Makassar (UTC+8), not the
    // Jakarta (UTC+7) fallback the bug silently produced.
    expect(body.created_at_iso).toContain('+08:00');
  });

  it('renders the configured tz on GET /payment/:id and GET /payments', async () => {
    const config = createConfigService(storage);
    await config.setDisplayTimezone('Asia/Jayapura'); // UTC+9
    const payment = {
      id: 'p1',
      status: 'pending',
      amount: 5000,
      qris_string: 'q',
      qris_url: null,
      created_at: 1_700_000_000_000,
      expires_at: 1_700_000_300_000,
      timeout: 300_000,
      tolerance: 0,
      webhook_url: null,
      tx_id: null,
      paid_amount: null,
      paid_at: null,
      tx_raw: null,
      tz: null,
    };
    await app.register(paymentsRoutes, {
      paymentService: {
        createPayment: async () => payment,
        getPayment: async () => payment,
        listActive: async () => [payment],
      },
      configService: config,
      authPreHandler: async (_req, _reply) => {},
      storage,
    });

    const one = await app.inject({ method: 'GET', url: '/payment/p1' });
    expect(one.json().tz).toBe('Asia/Jayapura');
    expect(one.json().created_at_iso).toContain('+09:00');

    const list = await app.inject({ method: 'GET', url: '/payments' });
    const listBody = list.json();
    expect(listBody[0].tz).toBe('Asia/Jayapura');
    expect(listBody[0].created_at_iso).toContain('+09:00');
  });
});
