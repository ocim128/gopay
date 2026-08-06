// Unit tests for the Payment_Service expiry-notification path.
//
// When a pending Payment passes its `expires_at`, the service must transition it
// to `expired` AND fire the injected `onExpired` hook exactly once (so the
// Webhook_Dispatcher can send an "expired" notification). This must hold across
// every expiry trigger — a read (`getPayment`), a list (`listActive`), and a
// poll tick (`handleTransactions`, including an empty batch) — and must never
// double-fire for the same Payment.
//
// A real in-memory SQLite DAL is used (it implements `expireOverdueReturning`),
// with an injected clock so expiry is deterministic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { createPaymentService, PAYMENT_MODE } from '../payment/payment-service.js';

// A minimal, valid "tag-only" Static_QRIS accepted by the QRIS_Builder.
const STATIC_QRIS = '0002010102115802ID6304';

describe('Payment_Service expiry notification', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {number} */
  let clock;
  /** @type {Array<import('../dal/storage-interface.js').Payment>} */
  let expiredEvents;
  /** @type {ReturnType<typeof createPaymentService>} */
  let service;

  beforeEach(() => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    clock = 1_000_000;
    expiredEvents = [];
    service = createPaymentService({
      storage,
      config: { getStaticQris: async () => STATIC_QRIS },
      onExpired: (payment) => {
        expiredEvents.push(payment);
      },
      now: () => clock,
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  /**
   * Create a pending payment with a fixed timeout and return it.
   * @param {number} amount
   * @param {number} [timeout]
   */
  function createPending(amount, timeout = 10000) {
    return service.createPayment({ mode: PAYMENT_MODE.CLIENT, amount, timeout });
  }

  it('fires onExpired exactly once when a pending payment is read after expiry (getPayment)', async () => {
    const payment = await createPending(25000, 10000);
    expect(expiredEvents).toHaveLength(0);

    // Move past expires_at and read it back.
    clock = payment.expires_at + 1;
    const read = await service.getPayment(payment.id);

    expect(read.status).toBe('expired');
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0].id).toBe(payment.id);
    expect(expiredEvents[0].status).toBe('expired');

    // A second read must NOT fire the hook again (exactly-once).
    await service.getPayment(payment.id);
    expect(expiredEvents).toHaveLength(1);
  });

  it('fires onExpired via listActive when a payment is overdue', async () => {
    const payment = await createPending(26000, 10000);
    clock = payment.expires_at + 1;

    const active = await service.listActive();
    // The expired payment is no longer active...
    expect(active.find((p) => p.id === payment.id)).toBeUndefined();
    // ...and its expiry fired exactly once.
    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0].id).toBe(payment.id);
  });

  it('fires onExpired on a poll tick even with an empty transaction batch (handleTransactions)', async () => {
    const payment = await createPending(27000, 10000);
    clock = payment.expires_at + 1;

    // An empty batch still runs the expiry sweep (this is what the poller passes
    // when GoBiz returns no transactions).
    await service.handleTransactions([]);

    expect(expiredEvents).toHaveLength(1);
    expect(expiredEvents[0].id).toBe(payment.id);
    expect((await service.getPayment(payment.id)).status).toBe('expired');
  });

  it('fires onExpired once per payment for several overdue payments, and not for still-pending ones', async () => {
    const a = await createPending(1001, 10000);
    const b = await createPending(1002, 10000);
    const c = await createPending(1003, 60000); // longer timeout — still pending

    clock = a.expires_at + 1; // past a and b (10s) but not c (60s)
    await service.handleTransactions([]);

    const ids = expiredEvents.map((p) => p.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
    expect(expiredEvents.every((p) => p.status === 'expired')).toBe(true);
    // c is untouched.
    expect((await service.getPayment(c.id)).status).toBe('pending');
    // Re-running the sweep does not re-fire for a or b.
    await service.handleTransactions([]);
    expect(expiredEvents).toHaveLength(2);
  });

  it('does not fire onExpired for a payment that was paid before expiry', async () => {
    const payment = await createPending(28000, 10000);
    await storage.payments.markPaid(payment.id, {
      txId: 'tx-paid',
      paidAmount: 28000,
      paidAt: clock,
    });

    clock = payment.expires_at + 1;
    await service.handleTransactions([]);

    expect(expiredEvents).toHaveLength(0);
    expect((await service.getPayment(payment.id)).status).toBe('paid');
  });
});
