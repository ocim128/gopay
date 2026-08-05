// Property-based tests for the SQLite Storage `tx(fn)` helper
// (sqlite-storage.js). They exercise the atomic multi-write contract against a
// fresh in-memory database on every run:
//
//   - A transaction whose body throws part-way through rolls back *every* write
//     it performed (none persist) and reports `{ ok:false, error }`.
//   - A transaction whose body completes commits *all* of its writes and
//     reports `{ ok:true, value }`.
//
// The observable writes are `config.set` (a key/value upsert) and
// `payments.insertPending` (a row insert), chosen because each leaves a value
// that a follow-up read can confirm present or absent.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';

const NUM_RUNS = 100;

/**
 * Build an observable write descriptor from a kind and a per-transaction unique
 * index. Each descriptor knows how to (a) apply itself against a storage and
 * (b) report whether its effect is currently visible. Index-derived keys, ids,
 * and amounts keep every write within a single generated transaction distinct,
 * so the partial unique index on pending `amount` never collides spuriously.
 *
 * @param {'config'|'payment'} kind
 * @param {number} i - the write's position in the generated transaction.
 * @returns {{
 *   apply: (storage: import('../dal/storage-interface.js').Storage) => void,
 *   persisted: (storage: import('../dal/storage-interface.js').Storage) => boolean,
 * }}
 */
function makeWrite(kind, i) {
  if (kind === 'config') {
    const key = `key_${i}`;
    const value = `value_${i}`;
    return {
      apply: (storage) => {
        storage.config.set(key, value);
      },
      persisted: (storage) => storage.config.get(key) === value,
    };
  }

  const id = `pay_${i}`;
  return {
    apply: (storage) => {
      storage.payments.insertPending({
        id,
        amount: 10000 + i,
        qris_string: `QRIS-${i}`,
        created_at: 1000,
        expires_at: 2000,
        timeout: 1000,
      });
    },
    persisted: (storage) => storage.payments.getById(id) !== null,
  };
}

/**
 * Arbitrary for a non-empty sequence of write kinds. The sequence length bounds
 * how many distinct observable writes a generated transaction performs.
 */
const writeKindsArb = fc.array(fc.constantFrom('config', 'payment'), {
  minLength: 1,
  maxLength: 8,
});

describe('Property 33: DAL write atomicity', () => {
  /**
   * A transaction that performs one or more writes and then throws must leave
   * the store exactly as it found it: none of its writes persist, and `tx`
   * surfaces the failure as `{ ok:false, error }`.
   */
  it('rolls back every write when the transaction body throws', () => {
    fc.assert(
      fc.property(writeKindsArb, fc.nat(), (kinds, throwSeed) => {
        const storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
        try {
          const writes = kinds.map((kind, i) => makeWrite(kind, i));
          // Throw after performing 1..writes.length writes (always at least
          // one write happens before the failure).
          const throwAfter = 1 + (throwSeed % writes.length);

          const result = storage.tx(() => {
            for (let i = 0; i < throwAfter; i += 1) {
              writes[i].apply(storage);
            }
            throw new Error('boom');
          });

          // The failure is reported as a Result, not raised.
          expect(result.ok).toBe(false);
          expect(result.error).toBe('boom');

          // Full rollback: not one of the attempted writes survives.
          for (let i = 0; i < throwAfter; i += 1) {
            expect(writes[i].persisted(storage)).toBe(false);
          }
        } finally {
          storage.close();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  /**
   * A transaction whose body runs to completion commits all of its writes
   * together and returns `{ ok:true, value }` carrying the body's return value.
   */
  it('commits all writes and returns the value when the transaction body succeeds', () => {
    fc.assert(
      fc.property(writeKindsArb, (kinds) => {
        const storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
        try {
          const writes = kinds.map((kind, i) => makeWrite(kind, i));

          const result = storage.tx(() => {
            for (const write of writes) {
              write.apply(storage);
            }
            return 'committed';
          });

          // Success is reported with the body's return value.
          expect(result.ok).toBe(true);
          expect(result.value).toBe('committed');

          // Every write is durably visible after commit.
          for (const write of writes) {
            expect(write.persisted(storage)).toBe(true);
          }
        } finally {
          storage.close();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
