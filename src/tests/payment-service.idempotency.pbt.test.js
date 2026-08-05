// Property-based test for Payment_Service txId settlement idempotency.
//
// For any incoming transaction `txId`, however many
// times it appears across polling cycles, it SHALL settle at most one
// Active_Payment.
//
// Strategy: create several distinct pending Payments (distinct amounts so they
// can coexist), then feed a small pool of txIds repeatedly — within a single
// batch and across multiple batches, with amounts that may match different
// Payments. After every call we assert that, for each txId value used, the
// total number of settlements carrying that txId never exceeds one. We assert
// this both from the values returned by `handleTransactions` and by reading the
// persisted Payments back from storage.

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { createPaymentService } from '../payment/payment-service.js';

// A real, structurally valid Static_QRIS with a correct trailing CRC16. The
// config stub returns this so the QRIS_Builder can build a Dynamic_QRIS.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

// A minimal Config Service stub: the Payment_Service only reads getStaticQris().
const configStub = { getStaticQris: () => VALID_STATIC_QRIS };

describe('Property 16: Idempotency with respect to txId', () => {
  /** @type {import('../dal/storage-interface.js').Storage | null} */
  let storage = null;

  afterEach(() => {
    if (storage) {
      storage.close();
      storage = null;
    }
  });

  it('a repeated txId settles at most one payment across batches and within a batch', () => {
    fc.assert(
      fc.property(
        // Distinct Payment amounts (Rupiah) so every Payment can be pending at
        // once. tolerance is 0, so a transaction settles a Payment only when its
        // amount equals that Payment's amount exactly.
        fc.uniqueArray(fc.integer({ min: 1000_000, max: 9999000 }), {
          minLength: 1,
          maxLength: 6,
        }),
        // A small pool of non-empty txIds so reuse is frequent (the same txId
        // shows up many times across the generated transactions).
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
          minLength: 1,
          maxLength: 3,
        }),
        // A sequence of polling cycles (batches); each batch is a list of
        // transactions referencing a txId and an amount by index. The same txId
        // may appear several times in one batch and again in later batches.
        fc.array(
          fc.array(fc.record({ t: fc.nat(), a: fc.nat() }), {
            minLength: 1,
            maxLength: 5,
          }),
          { minLength: 1, maxLength: 5 },
        ),
        (amounts, txIdPool, batchSpecs) => {
          // Fresh in-memory storage per run so amounts never collide across runs.
          storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });

          const createdAt = 1_000_000;
          // A fixed settlement clock comfortably inside the default 300000ms
          // timeout so no Payment expires during the run.
          let clock = createdAt;
          const service = createPaymentService({
            storage,
            config: configStub,
            now: () => clock,
          });

          // Create one pending Payment per distinct amount (tolerance 0).
          const paymentIds = amounts.map(
            (amount) =>
              service.createPayment({ mode: 'client', amount, tolerance: 0 }).id,
          );

          // Move the clock just past creation but well within the timeout.
          clock = createdAt + 1_000;

          // Count settlements per txId from the values returned by every call.
          /** @type {Map<string, number>} */
          const settledByTxId = new Map();

          for (const batch of batchSpecs) {
            const transactions = batch.map(({ t, a }) => ({
              txId: txIdPool[t % txIdPool.length],
              amount: amounts[a % amounts.length],
              type: 'payin',
              time: '2024-01-01T00:00:00.000Z',
              raw: {},
            }));

            const settled = service.handleTransactions(transactions);

            for (const payment of settled) {
              settledByTxId.set(
                payment.tx_id,
                (settledByTxId.get(payment.tx_id) ?? 0) + 1,
              );
            }
          }

          // No txId ever settled more than one Payment.
          for (const [, count] of settledByTxId) {
            expect(count).toBeLessThanOrEqual(1);
          }

          // Cross-check against persisted state: count how many stored Payments
          // carry each txId. This must agree with the returned-value tally and
          // likewise never exceed one for any txId.
          /** @type {Map<string, number>} */
          const persistedByTxId = new Map();
          for (const id of paymentIds) {
            const stored = storage.payments.getById(id);
            if (stored.status === 'paid' && typeof stored.tx_id === 'string') {
              persistedByTxId.set(
                stored.tx_id,
                (persistedByTxId.get(stored.tx_id) ?? 0) + 1,
              );
            }
          }

          for (const [, count] of persistedByTxId) {
            expect(count).toBeLessThanOrEqual(1);
          }

          // The two views agree: every txId that settled something in the
          // returned values is reflected exactly once in storage and vice versa.
          expect(persistedByTxId.size).toBe(settledByTxId.size);
          for (const [txId, count] of settledByTxId) {
            expect(persistedByTxId.get(txId)).toBe(count);
          }

          storage.close();
          storage = null;
        },
      ),
      { numRuns: 100 },
    );
  });
});
