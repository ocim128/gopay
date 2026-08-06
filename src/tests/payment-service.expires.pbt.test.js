// Property-based test for the Payment_Service `expires_at` invariant.
//
// For any Payment created with timeout `t`, the stored
// Payment SHALL satisfy `expires_at - created_at === t`. When
// the API_Client omits `timeout`, the default timeout (300000 ms) SHALL hold.
//
// Strategy: drive the real Payment_Service with a controllable `now` clock, an
// in-memory SQLite DAL, and a config stub whose `getStaticQris` returns a valid
// Static_QRIS so the QRIS_Builder succeeds. For each run we generate a valid
// timeout in [10000, 86400000] and an amount, create a payment, and assert that
// `expires_at - created_at` equals the requested timeout (and equals the
// injected `now` plus the timeout). A separate property confirms the default
// timeout holds when `timeout` is omitted.

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { DEFAULT_TIMEOUT_MS, createPaymentService } from '../payment/payment-service.js';

// A real, structurally valid Static_QRIS with a correct trailing CRC16.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

/** A minimal Config Service stub exposing only the method the service reads. */
const configStub = { getStaticQris: async () => VALID_STATIC_QRIS };

describe('Property 3: expires_at invariant', () => {
  /** @type {import('../dal/storage-interface.js').Storage | null} */
  let storage = null;

  afterEach(async () => {
    if (storage) {
      await storage.close();
      storage = null;
    }
  });

  it('sets expires_at - created_at === timeout for any valid timeout', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Valid per-Payment timeout window in ms (10s .. 24h).
        fc.integer({ min: 10000, max: 86400000 }),
        // Valid Amount in 1000..9999000.
        fc.integer({ min: 1000, max: 9999000 }),
        // An arbitrary clock value the injected `now` returns.
        fc.integer({ min: 0, max: 2_000_000_000_000 }),
        async (timeout, amount, nowValue) => {
          storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
          const service = createPaymentService({
            storage,
            config: configStub,
            now: () => nowValue,
          });

          const payment = await service.createPayment({ mode: 'client', amount, timeout });

          // The core invariant.
          expect(payment.expires_at - payment.created_at).toBe(timeout);
          // created_at is the injected clock; expires_at is created_at + timeout.
          expect(payment.created_at).toBe(nowValue);
          expect(payment.expires_at).toBe(nowValue + timeout);
          expect(payment.timeout).toBe(timeout);

          await storage.close();
          storage = null;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('uses the default timeout (300000) when timeout is omitted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 9999000 }),
        fc.integer({ min: 0, max: 2_000_000_000_000 }),
        async (amount, nowValue) => {
          storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
          const service = createPaymentService({
            storage,
            config: configStub,
            now: () => nowValue,
          });

          const payment = await service.createPayment({ mode: 'client', amount });

          expect(payment.timeout).toBe(DEFAULT_TIMEOUT_MS);
          expect(payment.expires_at - payment.created_at).toBe(DEFAULT_TIMEOUT_MS);
          expect(payment.expires_at).toBe(nowValue + DEFAULT_TIMEOUT_MS);

          await storage.close();
          storage = null;
        },
      ),
      { numRuns: 100 },
    );
  });
});
