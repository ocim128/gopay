// Property-based test for atomic insertion of pending payments sharing an
// identical Amount. The partial unique index `uniq_pending_amount` is the only
// gatekeeper: for any batch of N insertions with the same Amount, exactly one
// must succeed (`ok:true`) and every other insertion must fail with the stable
// code `AMOUNT_IN_USE`, leaving no partial row behind.
//
// Exactly one insertion succeeds; the rest are rejected by the unique
// constraint, and a failed insertion stores no partial Active_Payment row.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';

/**
 * Build a pending-payment input for a given id sharing a fixed amount. Each
 * insertion gets a distinct id (and distinct qris payload) so we can prove that
 * the failed ones leave nothing behind, while the amount is held constant to
 * force contention on the partial unique index.
 *
 * @param {string} id
 * @param {number} amount
 * @returns {import('../dal/storage-interface.js').PendingPaymentInput}
 */
function pendingFor(id, amount) {
  return {
    id,
    amount,
    qris_string: `QRIS-${id}`,
    created_at: 1000,
    expires_at: 2000,
    timeout: 1000,
  };
}

describe('Property 8: atomic insertion — exactly one wins', () => {
  it('allows exactly one of N identical-amount insertions and stores no partial row for the rest', async () => {
    await fc.assert(
      fc.asyncProperty(
        // N insertions (2..20) competing for one identical amount.
        fc.integer({ min: 2, max: 20 }),
        fc.integer({ min: 1000, max: 9999000 }),
        async (n, amount) => {
          // Fresh in-memory storage per run for full isolation.
          const storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
          try {
            const ids = Array.from({ length: n }, (_, i) => `p-${i}`);

            const results = await Promise.all(
              ids.map((id) => storage.payments.insertPending(pendingFor(id, amount))),
            );

            const winners = ids.filter((_, i) => results[i].ok === true);
            const losers = ids.filter((_, i) => results[i].ok === false);

            // Exactly one insertion succeeds.
            expect(winners.length).toBe(1);

            // Every other insertion is rejected with the unique-constraint code.
            for (let i = 0; i < n; i += 1) {
              if (!results[i].ok) {
                expect(results[i]).toEqual({ ok: false, code: 'AMOUNT_IN_USE' });
              }
            }

            // No partial row is stored for any failed insertion:
            // getById of every loser id returns null.
            for (const id of losers) {
              expect(await storage.payments.getById(id)).toBeNull();
            }

            // The single winner is persisted as a pending row with that amount.
            const winner = await storage.payments.getById(winners[0]);
            expect(winner).not.toBeNull();
            expect(winner.status).toBe('pending');
            expect(winner.amount).toBe(amount);

            // Exactly one pending row exists for that amount overall.
            const pendingWithAmount = (await storage.payments.listActive({ limit: 100 })).filter(
              (p) => p.amount === amount,
            );
            expect(pendingWithAmount.length).toBe(1);
            expect(pendingWithAmount[0].id).toBe(winners[0]);

            // And the active count reflects only the single survivor.
            expect(await storage.payments.countActive()).toBe(1);
          } finally {
            await storage.close();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
