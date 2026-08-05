// Property-based test for the API Key management facade (api-key-management.js).
//
// For any sequence of create/revoke operations on the
// API key manager:
//   - every created key value is unique and starts life with `active` status;
//   - createApiKey reveals the FULL value exactly once, while only a hash and a
//     display prefix are persisted — the plaintext is never stored;
//   - listMasked entries never expose the hash or the full value; they carry
//     only id/prefix/status/timestamps;
//   - revoke transitions an active key to `revoked` and records `revoked_at`,
//     while revoking a non-existent or already-revoked key is rejected and
//     changes nothing.
//
// Strategy: drive the real manager (backed by a fresh in-memory SQLite DAL per
// run) with a generated sequence of create/revoke operations, and keep an
// independent model of every key's expected status and revoked_at. After every
// operation we assert the masked listing shape/secrecy invariants and that the
// DAL's accept/reject decisions match the model. We also confirm the stored
// row holds a hash (not the plaintext) by looking the key up via
// getActiveByHash(hashApiKey(revealedValue)) immediately after creation.

import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { hashApiKey } from '../auth/hashing.js';
import { API_KEY_PREFIX, createApiKeyManager, deriveKeyPrefix } from '../auth/api-key-management.js';

/** The exact set of fields a masked listing entry may expose (no hash/value). */
const MASKED_KEYS = ['created_at', 'id', 'key_prefix', 'revoked_at', 'status'];

/**
 * A single generated operation against the API key manager.
 *
 * - create: generate a brand-new API key.
 * - revoke: attempt to revoke a key chosen by `target`. The target may resolve
 *   to an active key, an already-revoked key, or (via `bogus`) an id that was
 *   never created, so the rejection paths are exercised too.
 */
const opArb = fc.oneof(
  fc.record({ kind: fc.constant('create') }),
  fc.record({
    kind: fc.constant('revoke'),
    target: fc.nat({ max: 50 }),
    // Occasionally aim at an id that does not exist to exercise rejection.
    bogus: fc.boolean(),
  }),
);

describe('Property 28: API_Key invariants', () => {
  /** @type {import('../dal/storage-interface.js').Storage | null} */
  let storage = null;

  afterEach(() => {
    if (storage) {
      storage.close();
      storage = null;
    }
  });

  it('creates unique active keys, reveals value once, stores only a hash, and revokes correctly', () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });

        // A clock we advance once per operation so revoked_at is deterministic
        // and strictly distinguishable from created_at.
        let clock = 1000;
        const manager = createApiKeyManager(storage, { now: () => clock });

        // Model: ordered record of every created key and its expected state.
        /** @type {{ id: string, value: string, hash: string, status: 'active'|'revoked', createdAt: number, revokedAt: number|null }[]} */
        const model = [];
        const seenValues = new Set();
        const seenIds = new Set();
        let bogusCounter = 0;

        for (const op of ops) {
          clock += 1;

          if (op.kind === 'create') {
            const created = manager.createApiKey();

            // Initial status is active and the value is a fresh,
            // prefixed secret unique across all keys created so far.
            expect(created.status).toBe('active');
            expect(created.value.startsWith(API_KEY_PREFIX)).toBe(true);
            expect(seenValues.has(created.value)).toBe(false);
            expect(seenIds.has(created.id)).toBe(false);
            expect(created.key_prefix).toBe(deriveKeyPrefix(created.value));
            expect(created.created_at).toBe(clock);
            seenValues.add(created.value);
            seenIds.add(created.id);

            // The persisted row is found by the hash of the revealed
            // value — proving a hash (not the plaintext) was stored. The full
            // value must not appear anywhere in the stored row.
            const hash = hashApiKey(created.value);
            const stored = storage.apiKeys.getActiveByHash(hash);
            expect(stored).not.toBeNull();
            expect(stored.key_hash).toBe(hash);
            expect(JSON.stringify(stored)).not.toContain(created.value);

            model.push({
              id: created.id,
              value: created.value,
              hash,
              status: 'active',
              createdAt: created.created_at,
              revokedAt: null,
            });
          } else {
            // revoke
            if (op.bogus || model.length === 0) {
              // Revoking an id that was never created is rejected
              // and leaves every key untouched.
              const ghostId = `ghost-${bogusCounter++}`;
              const res = manager.revokeApiKey(ghostId);
              expect(res).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });
            } else {
              const victim = model[op.target % model.length];
              const res = manager.revokeApiKey(victim.id);

              if (victim.status === 'active') {
                // active -> revoked, recording revoked_at = now.
                expect(res.ok).toBe(true);
                expect(res.value).toMatchObject({
                  id: victim.id,
                  status: 'revoked',
                  revoked_at: clock,
                });
                expect(res.value).not.toHaveProperty('key_hash');
                expect(JSON.stringify(res.value)).not.toContain(victim.value);
                // A revoked key no longer authenticates by hash.
                expect(storage.apiKeys.getActiveByHash(victim.hash)).toBeNull();
                victim.status = 'revoked';
                victim.revokedAt = clock;
              } else {
                // Already-revoked keys are rejected, unchanged.
                expect(res).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });
              }
            }
          }

          // After every op: the masked listing exposes only safe fields and
          // never the hash or any full value, and reflects the
          // model's status/revoked_at exactly.
          const masked = manager.listApiKeys();
          expect(masked.length).toBe(model.length);

          const serialized = JSON.stringify(masked);
          for (const value of seenValues) {
            expect(serialized).not.toContain(value);
          }

          const byId = new Map(masked.map((m) => [m.id, m]));
          for (const row of masked) {
            expect(row).not.toHaveProperty('key_hash');
            expect(Object.keys(row).sort()).toEqual([...MASKED_KEYS].sort());
          }
          for (const expected of model) {
            const row = byId.get(expected.id);
            expect(row).toBeDefined();
            expect(row.status).toBe(expected.status);
            expect(row.created_at).toBe(expected.createdAt);
            expect(row.revoked_at).toBe(expected.revokedAt);
            expect(row.key_prefix).toBe(deriveKeyPrefix(expected.value));
          }
        }

        storage.close();
        storage = null;
      }),
      { numRuns: 100 },
    );
  });
});
