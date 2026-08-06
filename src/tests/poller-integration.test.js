// Integration tests for the Shared_Poller singleton wiring and Config
// `poll_interval` propagation.
//
// Two properties are exercised:
//   1. SINGLETON: the System uses a SINGLE Shared_Poller for
//      every Active_Payment. Creating many payments never creates a new poller;
//      the Payment_Service's `ensureRunning` hook always reaches the one shared
//      instance wired by `buildServer()`.
//   2. POLL_INTERVAL PROPAGATION: a Config `poll_interval` change is
//      applied to the poller within <= 5 seconds. This is shown end-to-end
//      through the admin Config route (which calls `poller.setInterval`) and at
//      the timer level on a real SharedPoller driven by fake timers (the pending
//      cycle is rescheduled immediately rather than after the old interval).
//
// No network is touched: a fake GoBiz client is injected so the poller has no
// real dependency.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildServer } from '../server.js';
import { SESSION_COOKIE_NAME } from '../auth/admin-auth.js';
import { SharedPoller } from '../poller/shared-poller.js';

// A real, structurally valid Static_QRIS with a correct trailing CRC16, so
// `createPayment` can build the Dynamic_QRIS without a network dependency.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

/** A GoBiz client stub that never hits the network. */
function makeFakeGoBizClient() {
  return {
    getRecentTransactions: vi.fn().mockResolvedValue([]),
  };
}

/** A Shared_Poller stub that records how its lifecycle hooks are invoked. */
function makeFakePoller() {
  return {
    ensureRunningCount: 0,
    setIntervalCalls: [],
    stopCount: 0,
    ensureRunning() {
      this.ensureRunningCount += 1;
    },
    setInterval(ms) {
      this.setIntervalCalls.push(ms);
    },
    stop() {
      this.stopCount += 1;
    },
  };
}

/** An Admin_Auth stub that accepts any session token (auth is out of scope here). */
function makeFakeAdminAuth() {
  return {
    login: async () => ({ ok: true, cookie: `${SESSION_COOKIE_NAME}=t; Path=/`, session: { expiresAt: Number.MAX_SAFE_INTEGER } }),
    isAuthenticated: () => true,
    buildCookie: () => `${SESSION_COOKIE_NAME}=t; Path=/`,
    buildClearedCookie: () => `${SESSION_COOKIE_NAME}=; Max-Age=0`,
  };
}

describe('Shared_Poller singleton wiring', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it('routes every payment through the one injected poller instance', async () => {
    const fakePoller = makeFakePoller();
    app = await buildServer({
      dbPath: ':memory:',
      gobizClient: makeFakeGoBizClient(),
      poller: fakePoller,
      sessionSecret: 'test-secret',
      seedAdmin: false,
    });
    await app.configService.setStaticQris(VALID_STATIC_QRIS);

    // The single injected poller is the one exposed by the server.
    expect(app.poller).toBe(fakePoller);

    // Many payments -> ensureRunning is called on the SAME instance each time;
    // no new poller is ever constructed.
    await app.paymentService.createPayment({ mode: 'client', amount: 1000 });
    await app.paymentService.createPayment({ mode: 'client', amount: 2000 });
    await app.paymentService.createPayment({ mode: 'client', amount: 3000 });

    expect(fakePoller.ensureRunningCount).toBe(3);
    expect(app.poller).toBe(fakePoller);
  });

  it('reuses the single real poller created by buildServer across many payments', async () => {
    app = await buildServer({
      dbPath: ':memory:',
      gobizClient: makeFakeGoBizClient(),
      sessionSecret: 'test-secret',
      seedAdmin: false,
    });
    await app.configService.setStaticQris(VALID_STATIC_QRIS);

    // buildServer constructs exactly one Shared_Poller.
    expect(app.poller).toBeInstanceOf(SharedPoller);
    const theOnlyPoller = app.poller;

    // The Payment_Service ensureRunning hook reaches that one instance.
    const ensureRunningSpy = vi.spyOn(theOnlyPoller, 'ensureRunning');

    await app.paymentService.createPayment({ mode: 'client', amount: 4000 });
    await app.paymentService.createPayment({ mode: 'client', amount: 5000 });

    expect(ensureRunningSpy).toHaveBeenCalledTimes(2);
    // The poller reference never changes: it is a singleton.
    expect(app.poller).toBe(theOnlyPoller);

    ensureRunningSpy.mockRestore();
  });
});

describe('Config poll_interval propagation', () => {
  describe('through the admin Config route', () => {
    /** @type {import('fastify').FastifyInstance} */
    let app;
    /** @type {ReturnType<typeof makeFakePoller>} */
    let fakePoller;

    beforeEach(async () => {
      fakePoller = makeFakePoller();
      app = await buildServer({
        dbPath: ':memory:',
        gobizClient: makeFakeGoBizClient(),
        poller: fakePoller,
        adminAuth: makeFakeAdminAuth(),
        seedAdmin: false,
      });
    });

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it('calls poller.setInterval with the new interval on a successful update', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/config',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=token`,
          'content-type': 'application/json',
        },
        payload: { poll_interval: 3000 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().poll_interval).toBe(3000);
      // The new cadence is pushed to the single poller.
      expect(fakePoller.setIntervalCalls).toContain(3000);
    });

    it('does not touch the poller when the update is rejected', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/config',
        headers: {
          cookie: `${SESSION_COOKIE_NAME}=token`,
          'content-type': 'application/json',
        },
        // 250ms is below the 1000ms minimum -> rejected, nothing propagates.
        payload: { poll_interval: 250 },
      });

      expect(response.statusCode).toBe(400);
      expect(fakePoller.setIntervalCalls).toEqual([]);
    });
  });

  describe('at the timer level on a real SharedPoller', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('applies a new interval within <= 5s by rescheduling the pending cycle', async () => {
      const gobiz = makeFakeGoBizClient();
      const poller = new SharedPoller(gobiz, {
        getActiveCount: () => 1,
        onTransactions: () => {},
        // A long configured interval so a poll is far in the future...
        getPollInterval: () => 60000,
      });

      poller.ensureRunning();

      // ...so after 5s nothing has polled yet under the old cadence.
      await vi.advanceTimersByTimeAsync(5000);
      expect(gobiz.getRecentTransactions).not.toHaveBeenCalled();

      // A Config change drops the interval; it must take effect within <= 5s
      // rather than waiting out the old 60s.
      poller.setInterval(3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(gobiz.getRecentTransactions).toHaveBeenCalledTimes(1);

      poller.stop();
    });
  });
});
