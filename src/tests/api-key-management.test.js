// Tests for the API Key management facade (api-key-management.js).
//
// These exercise the facade against an in-memory DAL: creation reveals the
// full value exactly once with `active` status and a unique value,
// subsequent listing is masked and never exposes the hash or full value,
// and revocation flips status + records the time while rejecting
// non-existent / already-revoked keys.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { hashApiKey } from '../auth/hashing.js';
import {
  API_KEY_PREFIX,
  createApiKeyManager,
  deriveKeyPrefix,
  generateApiKeyValue,
} from '../auth/api-key-management.js';

describe('createApiKeyManager', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {ReturnType<typeof createApiKeyManager>} */
  let manager;
  let clock;

  beforeEach(() => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    clock = 1000;
    let counter = 0;
    manager = createApiKeyManager(storage, {
      now: () => clock,
      idFactory: () => `id-${(counter += 1)}`,
    });
  });

  afterEach(() => {
    storage.close();
  });

  describe('createApiKey', () => {
    it('returns the full value exactly once with active status', () => {
      const created = manager.createApiKey();
      expect(created.value.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(created.status).toBe('active');
      expect(created.created_at).toBe(1000);
      expect(created.key_prefix).toBe(deriveKeyPrefix(created.value));
    });

    it('persists only the hash and prefix, never the plaintext', () => {
      const created = manager.createApiKey();
      // The stored record is retrievable by the hash of the revealed value.
      const stored = storage.apiKeys.getActiveByHash(hashApiKey(created.value));
      expect(stored).not.toBeNull();
      expect(stored.key_hash).toBe(hashApiKey(created.value));
      // The full value is nowhere in the stored row.
      expect(JSON.stringify(stored)).not.toContain(created.value);
    });

    it('creates unique values across keys', () => {
      const a = manager.createApiKey();
      const b = manager.createApiKey();
      expect(a.value).not.toBe(b.value);
      expect(a.id).not.toBe(b.id);
    });

    it('retries when a generated value collides, then succeeds', () => {
      const values = ['gpk_dupe', 'gpk_dupe', 'gpk_unique'];
      let i = 0;
      const retryingManager = createApiKeyManager(storage, {
        now: () => 1000,
        idFactory: () => `r-${i}`,
        generateValue: () => values[i++],
      });
      expect(retryingManager.createApiKey().value).toBe('gpk_dupe');
      // Second call: first candidate collides on hash, second is unique.
      expect(retryingManager.createApiKey().value).toBe('gpk_unique');
    });
  });

  describe('listApiKeys', () => {
    it('returns only masked forms, never the hash or full value', () => {
      const created = manager.createApiKey();
      const list = manager.listApiKeys();
      expect(list).toHaveLength(1);
      const masked = list[0];
      expect(masked).not.toHaveProperty('key_hash');
      expect(masked.key_prefix).toBe(created.key_prefix);
      expect(JSON.stringify(masked)).not.toContain(created.value);
    });
  });

  describe('revokeApiKey', () => {
    it('revokes an active key and records the time', () => {
      const created = manager.createApiKey();
      clock = 5000;
      const res = manager.revokeApiKey(created.id);
      expect(res.ok).toBe(true);
      expect(res.value).toMatchObject({ id: created.id, status: 'revoked', revoked_at: 5000 });
      // The revoked key no longer authenticates.
      expect(storage.apiKeys.getActiveByHash(hashApiKey(created.value))).toBeNull();
    });

    it('rejects a non-existent key', () => {
      expect(manager.revokeApiKey('does-not-exist')).toEqual({
        ok: false,
        code: 'KEY_NOT_REVOCABLE',
      });
    });

    it('rejects an already-revoked key without changing it', () => {
      const created = manager.createApiKey();
      manager.revokeApiKey(created.id);
      const again = manager.revokeApiKey(created.id);
      expect(again).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });
    });

    it('never leaks the hash in the revoke result', () => {
      const created = manager.createApiKey();
      const res = manager.revokeApiKey(created.id);
      expect(res.value).not.toHaveProperty('key_hash');
    });
  });

  describe('generateApiKeyValue', () => {
    it('produces a prefixed, unique, high-entropy value', () => {
      const a = generateApiKeyValue();
      const b = generateApiKeyValue();
      expect(a.startsWith(API_KEY_PREFIX)).toBe(true);
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThan(API_KEY_PREFIX.length + 20);
    });
  });
});
