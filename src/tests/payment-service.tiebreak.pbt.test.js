// Property-based test for Payment_Service settlement tie-break.
//
// When a single incoming `payin` Transaction matches
// several Active_Payment (their Amounts all fall within their own tolerance of
// the Transaction Amount), the System SHALL settle exactly ONE Payment — the
// earliest-created one — and leave the rest pending. The
// Payment_Service breaks ties deterministically by `created_at` ascending, then
// by `id` ascending (string comparison), mirroring the comparator used inside
// `handleTransactions`.
//
// To assemble several payments that all match one Transaction we exploit a
// shared tolerance window: every payment is given a distinct Amount within
// `tolerance` of a common centre Amount, and that centre is fed as the single
// Transaction Amount. Distinct Amounts are required because `createPayment`
// enforces amount-uniqueness among pending payments. Their `created_at` times
// are drawn from a tiny range so equal-time collisions occur often, exercising
// the `id` tie-break.

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

// The exact tie-break comparator used by handleTransactions: created_at
// ascending, then id ascending (string comparison).
const tieBreak = (a, b) =>
  a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

describe('Property 15: Settlement tie-break — earliest created', () => {
  /** @type {import('../dal/storage-interface.js').Storage | null} */
  let storage = null;

  afterEach(() => {
    if (storage) {
      storage.close();
      storage = null;
    }
  });

  it('settles exactly one matching payment — the earliest-created — and leaves the rest pending', () => {
    fc.assert(
      fc.property(
        // Centre Amount (also the incoming Transaction Amount). Kept well inside
        // the valid range so centre +/- delta never leaves 1000..9999000.
        fc.integer({ min: 2000_000, max: 9000_000 }),
        // Distinct per-payment deltas from the centre. Distinct deltas yield
        // distinct Amounts (required by the pending amount-uniqueness rule), and
        // every Amount lands within the shared tolerance window below.
        fc.uniqueArray(fc.integer({ min: -2_000, max: 2_000 }), {
          minLength: 2,
          maxLength: 6,
        }),
        // Distinct ids so the id tie-break is well-defined and observable.
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
          minLength: 2,
          maxLength: 6,
        }),
        // created_at offsets drawn from a tiny range so equal-time ties are
        // frequent, exercising the deterministic id tie-break.
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 2, maxLength: 6 }),
        // The settling Transaction id (idempotency key).
        fc.string({ minLength: 1, maxLength: 40 }),
        (centre, deltas, ids, timeOffsets, txId) => {
          // Use a common count across the three correlated arrays.
          const count = Math.min(deltas.length, ids.length, timeOffsets.length);
          fc.pre(count >= 2);

          const useDeltas = deltas.slice(0, count);
          const useIds = ids.slice(0, count);
          const useOffsets = timeOffsets.slice(0, count);

          // Tolerance covers the widest delta so every payment matches the centre
          // Transaction Amount: |centre - (centre + delta)| = |delta| <= tolerance.
          const tolerance = Math.max(...useDeltas.map((d) => Math.abs(d)));

          const base = 1_000_000;
          // Per-payment plan: id, created_at, amount.
          const plan = useDeltas.map((delta, i) => ({
            id: useIds[i],
            created_at: base + useOffsets[i],
            amount: centre + delta,
          }));

          // Fresh storage per run so amounts never collide across runs.
          storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });

          let clock = base;
          let idCursor = 0;
          const service = createPaymentService({
            storage,
            config: configStub,
            now: () => clock,
            idFactory: () => plan[idCursor++].id,
          });

          // Create each payment at its planned created_at with its planned id.
          for (const entry of plan) {
            clock = entry.created_at;
            const created = service.createPayment({
              mode: 'client',
              amount: entry.amount,
              tolerance,
              // Default 300000ms timeout keeps all payments active at settle time.
            });
            expect(created.id).toBe(entry.id);
            expect(created.created_at).toBe(entry.created_at);
          }

          // Every payment Amount is within tolerance of the centre Transaction.
          for (const entry of plan) {
            expect(Math.abs(centre - entry.amount)).toBeLessThanOrEqual(tolerance);
          }

          // The earliest-created (created_at asc, then id asc) is the expected winner.
          const expectedWinner = [...plan].sort(tieBreak)[0];

          // Settle after every created_at but well within every lifetime.
          clock = base + 100;
          const settled = service.handleTransactions([
            { txId, amount: centre, type: 'payin', time: '2024-01-01T00:00:00.000Z', raw: {} },
          ]);

          // Exactly one Payment is settled, and it is the earliest-created one.
          expect(settled).toHaveLength(1);
          expect(settled[0].id).toBe(expectedWinner.id);

          // The winner is durably paid with the transaction's details.
          const winnerStored = storage.payments.getById(expectedWinner.id);
          expect(winnerStored.status).toBe('paid');
          expect(winnerStored.tx_id).toBe(txId);

          // Every other matching Payment remains pending.
          for (const entry of plan) {
            if (entry.id === expectedWinner.id) {
              continue;
            }
            expect(storage.payments.getById(entry.id).status).toBe('pending');
          }

          // The active list contains exactly the losers (count - 1 payments).
          const active = service.listActive({ limit: 100, offset: 0 });
          expect(active).toHaveLength(count - 1);
          expect(active.some((p) => p.id === expectedWinner.id)).toBe(false);

          storage.close();
          storage = null;
        },
      ),
      { numRuns: 100 },
    );
  });
});
