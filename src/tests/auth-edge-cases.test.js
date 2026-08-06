// Focused edge-case unit tests for the auth facades.
//
// These complement the broader suites in api-key-management.test.js and
// admin-auth.test.js by pinning down three specific behaviors that are easy to
// regress and security-sensitive:
//
//   - Reveal-once: createApiKey returns the full plaintext value
//     exactly once, and the masked listing never carries that value again.
//   - Invalid revoke: revoking a non-existent id or an
//     already-revoked key is rejected with KEY_NOT_REVOCABLE and changes
//     nothing about any stored key.
//   - Empty login fields: an empty/whitespace username or an empty
//     password is rejected with MISSING_CREDENTIALS without recording a
//     failure against the account.
//
// The API key tests run against an in-memory SQLite DAL; the admin-auth tests
// run against an ephemeral temp-file SQLite DAL with an injected clock so the
// behavior is fully deterministic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { hashApiKey, hashPasswordSync } from '../auth/hashing.js';
import { createApiKeyManager } from '../auth/api-key-management.js';
import { ADMIN_AUTH_ERRORS, createAdminAuth } from '../auth/admin-auth.js';

describe('API key reveal-once and invalid revoke', () => {
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

  afterEach(async () => {
    await storage.close();
  });

  describe('reveal-once', () => {
    it('returns the full plaintext value exactly once on creation', async () => {
      const created = await manager.createApiKey();
      // The plaintext is present in the creation response...
      expect(typeof created.value).toBe('string');
      expect(created.value.length).toBeGreaterThan(0);
      // ...and the hash of that plaintext is what was actually persisted, so
      // the response is the only place the plaintext ever appears.
      const stored = await storage.apiKeys.getActiveByHash(hashApiKey(created.value));
      expect(stored).not.toBeNull();
      expect(stored.key_hash).toBe(hashApiKey(created.value));
    });

    it('never exposes the full value through the masked listing afterward', async () => {
      const created = await manager.createApiKey();
      const list = await manager.listApiKeys();
      expect(list).toHaveLength(1);
      const [masked] = list;
      // The masked row carries only the short display prefix, not the secret.
      expect(masked.key_prefix).toBe(created.key_prefix);
      expect(masked).not.toHaveProperty('key_hash');
      expect(JSON.stringify(masked)).not.toContain(created.value);
    });

    it('keeps the full value out of every masked row across multiple keys', async () => {
      const created = [
        await manager.createApiKey(),
        await manager.createApiKey(),
        await manager.createApiKey(),
      ];
      const serialized = JSON.stringify(await manager.listApiKeys());
      for (const key of created) {
        expect(serialized).not.toContain(key.value);
        expect(serialized).not.toContain(hashApiKey(key.value));
      }
    });
  });

  describe('invalid revoke', () => {
    it('rejects revoking a non-existent id with KEY_NOT_REVOCABLE and changes nothing', async () => {
      const created = await manager.createApiKey();
      const before = await manager.listApiKeys();

      const result = await manager.revokeApiKey('no-such-id');
      expect(result).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });

      // The existing key is untouched and still authenticates.
      expect(await manager.listApiKeys()).toEqual(before);
      expect(await storage.apiKeys.getActiveByHash(hashApiKey(created.value))).not.toBeNull();
    });

    it('rejects revoking an already-revoked key with KEY_NOT_REVOCABLE and changes nothing', async () => {
      const created = await manager.createApiKey();
      clock = 5000;
      const first = await manager.revokeApiKey(created.id);
      expect(first.ok).toBe(true);

      const afterFirstRevoke = await manager.listApiKeys();
      clock = 9000; // advancing the clock must not bleed into a second revoke

      const second = await manager.revokeApiKey(created.id);
      expect(second).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });

      // The second (rejected) revoke leaves the key exactly as the first left
      // it: still revoked, with the original revoked_at, not 9000.
      const list = await manager.listApiKeys();
      expect(list).toEqual(afterFirstRevoke);
      expect(list[0]).toMatchObject({ status: 'revoked', revoked_at: 5000 });
    });
  });
});

describe('Admin login empty fields', () => {
  const SECRET = 'edge-case-signing-secret';
  const USERNAME = 'admin';
  const PASSWORD = 'correct horse battery staple';

  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  let dbPath;
  let clock;
  /** @type {ReturnType<typeof createAdminAuth>} */
  let auth;

  /**
   * Seed a single admin user directly through a raw connection that shares the
   * temp-file database used by the Storage under test.
   *
   * @param {string} path
   */
  function seedAdmin(path) {
    const raw = new Database(path);
    raw
      .prepare(
        `INSERT INTO admin_users (id, username, password_hash)
         VALUES (?, ?, ?)`,
      )
      .run(randomUUID(), USERNAME, hashPasswordSync(PASSWORD));
    raw.close();
  }

  beforeEach(() => {
    dbPath = join(tmpdir(), `auth-edge-${randomUUID()}.db`);
    storage = createSqliteStorage({ dbPath });
    seedAdmin(dbPath);
    clock = 1_000_000;
    auth = createAdminAuth(storage, { now: () => clock, secret: SECRET });
  });

  afterEach(async () => {
    await storage.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it('rejects an empty username with MISSING_CREDENTIALS without a session', async () => {
    const result = await auth.login('', PASSWORD, '127.0.0.1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADMIN_AUTH_ERRORS.MISSING_CREDENTIALS);
    expect(result).not.toHaveProperty('token');
  });

  it('rejects a whitespace-only username with MISSING_CREDENTIALS', async () => {
    const result = await auth.login('   \t  ', PASSWORD, '127.0.0.1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADMIN_AUTH_ERRORS.MISSING_CREDENTIALS);
  });

  it('rejects an empty password with MISSING_CREDENTIALS', async () => {
    const result = await auth.login(USERNAME, '', '127.0.0.1');
    expect(result.ok).toBe(false);
    expect(result.code).toBe(ADMIN_AUTH_ERRORS.MISSING_CREDENTIALS);
  });

  it('does not record a failure against the account for any empty submission', async () => {
    await auth.login('', PASSWORD, '127.0.0.1');
    await auth.login('   ', PASSWORD, '127.0.0.1');
    await auth.login(USERNAME, '', '127.0.0.1');

    expect(await storage.loginAttempts.getByIp('127.0.0.1')).toBeNull();
  });

  it('still authenticates with valid credentials after rejected empty attempts', async () => {
    await auth.login(USERNAME, '', '127.0.0.1');
    await auth.login('', PASSWORD, '127.0.0.1');
    const ok = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
    expect(ok.ok).toBe(true);
    expect(ok.token).toMatch(/^[\w-]+\.[\w-]+$/);
  });
});
