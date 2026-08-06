// Property-based test for Payment_Service settlement data shape.
//
// For any Payment that becomes `paid`, the system
// SHALL store and return `txId`, `paid_amount` (Rupiah), and `paid_at`
// (timestamp). We create a pending Payment, feed a matching `payin`
// Transaction through `handleTransactions`, then read the Payment back via
// `getPayment` and assert the settlement triple is present and correct: the
// returned status is `paid`, `tx_id` equals the transaction's `txId`,
// `paid_amount` equals the transaction's `amount` (which is within the
// Payment's tolerance), and `paid_at` is set to the settlement clock.

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
const configStub = { getStaticQris: async () => VALID_STATIC_QRIS };

describe('Property 11: Settlement data shape', () => {
  /** @type {import('../dal/storage-interface.js').Storage | null} */
  let storage = null;

  afterEach(async () => {
    if (storage) {
      await storage.close();
      storage = null;
    }
  });

  it('a paid payment stores and returns txId, paid_amount, and paid_at', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Base amount kept comfortably above the max tolerance so a negative
        // delta can never push the transaction amount below 1 Rupiah.
        fc.integer({ min: 1000_000, max: 9999000 }),
        // Per-payment tolerance in Rupiah.
        fc.integer({ min: 0, max: 500 }),
        // A non-empty txId (settlement idempotency key).
        fc.string({ minLength: 1, maxLength: 40 }),
        // Settlement clock offset (ms) kept inside the default 300000ms timeout.
        fc.integer({ min: 0, max: 250_000 }),
        async (amount, tolerance, txId, settleOffset) => {
          // Fresh in-memory storage per run so amounts never collide across runs.
          storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });

          const createdAt = 1_000_000;
          let clock = createdAt;
          const service = createPaymentService({
            storage,
            config: configStub,
            now: () => clock,
          });

          const payment = await service.createPayment({
            mode: 'client',
            amount,
            tolerance,
          });

          // A transaction amount within tolerance of the payment's amount so it
          // matches. delta in [-tolerance, tolerance].
          const delta = (txId.length % (2 * tolerance + 1)) - tolerance;
          const txAmount = amount + delta;
          expect(Math.abs(txAmount - amount)).toBeLessThanOrEqual(tolerance);

          // Settle within the payment's lifetime.
          clock = createdAt + settleOffset;
          const settled = await service.handleTransactions([
            { txId, amount: txAmount, type: 'payin', time: '2024-01-01T00:00:00.000Z', raw: {} },
          ]);

          expect(settled.map((p) => p.id)).toEqual([payment.id]);

          // The returned Payment carries the full settlement triple.
          const read = await service.getPayment(payment.id);
          expect(read).not.toBeNull();
          expect(read.status).toBe('paid');
          expect(read.tx_id).toBe(txId);
          expect(read.paid_amount).toBe(txAmount);
          expect(read.paid_at).toBe(clock);

          await storage.close();
          storage = null;
        },
      ),
      { numRuns: 100 },
    );
  });
});
