// Property-based test for Payment_Service tolerance matching.
//
// A payin Transaction matches an Active_Payment iff
// `|tx.amount - payment.amount| <= payment.tolerance`. A
// transaction that does not match any Active_Payment is ignored — no Payment
// changes status.
//
// We create one pending Payment with a random tolerance and feed it a single
// payin Transaction. Each run generates ONE of two mutually-exclusive cases:
//   * within tolerance  -> the Payment settles (status becomes `paid`).
//   * outside tolerance -> the transaction is ignored (status stays `pending`).

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

describe('Property 14: Matching within tolerance, otherwise ignored', () => {
  /** @type {import('../dal/storage-interface.js').Storage | null} */
  let storage = null;

  afterEach(async () => {
    if (storage) {
      await storage.close();
      storage = null;
    }
  });

  it('a payin tx settles iff it is within tolerance, otherwise it is ignored', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Base amount kept far from both 1 Rupiah and the allocator max so a
        // delta on either side stays a valid, positive transaction amount.
        fc.integer({ min: 1000_000, max: 9000_000 }),
        // Per-payment tolerance in Rupiah.
        fc.integer({ min: 0, max: 1_000 }),
        // Chooses which mutually-exclusive case this run exercises.
        fc.boolean(),
        // Magnitude used to build the delta (interpreted per-case below).
        fc.nat({ max: 100_000 }),
        // Sign of the delta so we exercise transactions on both sides.
        fc.boolean(),
        // Settlement clock offset (ms) kept inside the default 300000ms timeout.
        fc.integer({ min: 0, max: 250_000 }),
        async (amount, tolerance, within, magnitude, negative, settleOffset) => {
          // Fresh in-memory storage per run so amounts never collide across runs.
          storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });

          const createdAt = 1_000_000;
          let clock = createdAt;
          const service = createPaymentService({
            storage,
            config: configStub,
            now: () => clock,
          });

          const payment = await service.createPayment({ mode: 'client', amount, tolerance });

          // Build the absolute delta for the chosen case:
          //   * within  -> |delta| in [0, tolerance]
          //   * outside -> |delta| in [tolerance + 1, ...]
          const absDelta = within
            ? magnitude % (tolerance + 1)
            : tolerance + 1 + magnitude;
          const delta = negative ? -absDelta : absDelta;
          const txAmount = amount + delta;

          // Sanity-check the generated case matches its intended classification.
          const isWithin = Math.abs(txAmount - amount) <= tolerance;
          expect(isWithin).toBe(within);

          // Settle within the payment's lifetime.
          clock = createdAt + settleOffset;
          const settled = await service.handleTransactions([
            { txId: 'tx-match', amount: txAmount, type: 'payin', time: '2024-01-01T00:00:00.000Z', raw: {} },
          ]);

          const read = await service.getPayment(payment.id);
          expect(read).not.toBeNull();

          if (within) {
            // Within tolerance -> the Payment settles.
            expect(settled.map((p) => p.id)).toEqual([payment.id]);
            expect(read.status).toBe('paid');
            expect(read.tx_id).toBe('tx-match');
            expect(read.paid_amount).toBe(txAmount);
          } else {
            // Outside tolerance -> ignored, no status change.
            expect(settled).toEqual([]);
            expect(read.status).toBe('pending');
            expect(read.tx_id ?? null).toBeNull();
          }

          await storage.close();
          storage = null;
        },
      ),
      { numRuns: 100 },
    );
  });
});
