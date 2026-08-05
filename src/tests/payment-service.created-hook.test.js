// Unit test for the Payment_Service `onCreated` hook (realtime signal source).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { createPaymentService, PAYMENT_MODE } from '../payment/payment-service.js';

const STATIC_QRIS = '0002010102115802ID6304';

describe('Payment_Service onCreated hook', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {Array<import('../dal/storage-interface.js').Payment>} */
  let createdEvents;
  /** @type {ReturnType<typeof createPaymentService>} */
  let service;

  beforeEach(() => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    createdEvents = [];
    service = createPaymentService({
      storage,
      config: { getStaticQris: () => STATIC_QRIS },
      onCreated: (payment) => createdEvents.push(payment)
    });
  });

  afterEach(() => {
    storage.close();
  });

  it('fires once with the stored pending payment after a successful create', () => {
    const payment = service.createPayment({ mode: PAYMENT_MODE.CLIENT, amount: 12345 });

    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0].id).toBe(payment.id);
    expect(createdEvents[0].status).toBe('pending');
  });

  it('does not fire when creation fails (invalid amount)', () => {
    expect(() => service.createPayment({ mode: PAYMENT_MODE.CLIENT, amount: -1 })).toThrow();
    expect(createdEvents).toHaveLength(0);
  });
});
