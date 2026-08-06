// Property-based test for the SQLite Storage `payments` store.
//
// For any sequence of Payment creations, at any point
// in time there SHALL NEVER be two Payment with `pending` status that have the
// same Amount; and if an Amount was previously used by a Payment that is now
// `paid`/`expired`, that Amount SHALL be reusable by a new Payment.
//
// Strategy: drive the real SQLite DAL with a generated sequence of operations
// (create / settle / expire) against a fresh in-memory database per run, and
// keep an independent model of which amounts are "in use" by a pending row.
// After every operation we assert:
//   (a) no two pending rows ever share an amount, and
//   (b) the DAL's accept/reject decision for a creation matches the model —
//       i.e. an amount released by a payment that became paid/expired is
//       reusable, and an amount still held by a pending row is rejected.

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';

/**
 * A single generated operation against the payments store.
 *
 * - create: attempt to insert a pending payment for `amount`.
 * - settle: mark the pending payment created at sequence position `target`
 *   (if any) as paid, releasing its amount.
 * - expire: advance the clock so that pending payments whose `expires_at` is
 *   strictly before `now` transition to `expired`, releasing their amounts.
 */
const opArb = fc.oneof(
  fc.record({
    kind: fc.constant('create'),
    // Constrain to a small amount domain so collisions actually occur, while
    // staying within the valid 1000..9999000 range.
    amount: fc.integer({ min: 1, max: 25 }),
    // Lifetime window: chosen so some payments are already overdue relative to
    // future `expire` operations and some survive.
    expiresAt: fc.integer({ min: 1, max: 100 }),
  }),
  fc.record({
    kind: fc.constant('settle'),
    target: fc.nat({ max: 50 }),
  }),
  fc.record({
    kind: fc.constant('expire'),
    now: fc.integer({ min: 1, max: 100 }),
  }),
);

describe('Property 7: pending amount uniqueness & reuse after release', () => {
  /** @type {import('../dal/storage-interface.js').Storage | null} */
  let storage = null;

  afterEach(async () => {
    if (storage) {
      await storage.close();
      storage = null;
    }
  });

  it('never lets two pending rows share an amount and reuses released amounts', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 60 }), async (ops) => {
        storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
        const payments = storage.payments;

        // Model: amount -> the id of the pending payment currently holding it.
        /** @type {Map<number, string>} */
        const pendingByAmount = new Map();
        // Ordered record of every payment created (for settle targeting) with
        // its current model state, so we can keep model and DAL in lockstep.
        /** @type {{ id: string, amount: number, expiresAt: number, status: 'pending'|'paid'|'expired' }[]} */
        const created = [];

        let seq = 0;
        const nextId = () => `p${seq++}`;

        for (const op of ops) {
          if (op.kind === 'create') {
            const id = nextId();
            const result = await payments.insertPending({
              id,
              amount: op.amount,
              qris_string: 'QRIS-PAYLOAD',
              created_at: 0,
              expires_at: op.expiresAt,
              timeout: 1000,
            });

            const amountFree = !pendingByAmount.has(op.amount);
            if (amountFree) {
              // (b) A free amount (never used, or released) must be accepted.
              expect(result.ok).toBe(true);
              pendingByAmount.set(op.amount, id);
              created.push({ id, amount: op.amount, expiresAt: op.expiresAt, status: 'pending' });
            } else {
              // An amount still held by a pending row must be rejected.
              expect(result).toEqual({ ok: false, code: 'AMOUNT_IN_USE' });
              // Rejected insert stores no row.
              expect(await payments.getById(id)).toBeNull();
            }
          } else if (op.kind === 'settle') {
            const pendingRows = created.filter((p) => p.status === 'pending');
            if (pendingRows.length === 0) {
              continue;
            }
            const victim = pendingRows[op.target % pendingRows.length];
            const res = await payments.markPaid(victim.id, {
              txId: `tx-${victim.id}`,
              paidAmount: victim.amount,
              paidAt: 50,
            });
            expect(res.ok).toBe(true);
            victim.status = 'paid';
            // Settlement releases the amount.
            pendingByAmount.delete(victim.amount);
          } else {
            // expire
            await payments.expireOverdue(op.now);
            for (const p of created) {
              if (p.status === 'pending' && p.expiresAt < op.now) {
                p.status = 'expired';
                // Expiration releases the amount, making it reusable.
                pendingByAmount.delete(p.amount);
              }
            }
          }

          // (a) Invariant after every op: no two pending rows share an amount.
          // listActive returns only pending rows; pull all of them.
          const active = await payments.listActive({ limit: 100 });
          const amounts = active.map((p) => p.amount);
          const uniqueAmounts = new Set(amounts);
          expect(uniqueAmounts.size).toBe(amounts.length);

          // The DAL's pending set must match the model's pending set exactly.
          const dalPendingAmounts = new Set(amounts);
          const modelPendingAmounts = new Set(pendingByAmount.keys());
          expect(dalPendingAmounts).toEqual(modelPendingAmounts);
        }

        await storage.close();
        storage = null;
      }),
      { numRuns: 100 },
    );
  });
});
