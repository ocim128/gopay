// Unit tests for the DAL factory backend selection (dal/index.js).
//
// These verify the plan's selection rules WITHOUT needing a running MongoDB
// cluster: the SQLite path uses an in-memory database, the MongoDB-path error
// cases assert configuration failures, and the invalid-backend case asserts the
// fail-fast behaviour. The one test that would require MongoDB
// (a successful `backend: 'mongodb'` createDal) lives in the gated
// mongo-storage contract suite instead, so this file stays cluster-free.

import { describe, expect, it } from 'vitest';

import { createDal, resolveMongoDatabaseName } from '../dal/index.js';

// Save and restore the env vars the factory reads so each test is hermetic.
const SAVED_BACKEND = process.env.STORAGE_BACKEND;
const SAVED_URI = process.env.MONGODB_URI;
const SAVED_DB_NAME = process.env.MONGODB_DB_NAME;

describe('createDal backend selection', () => {
  /** Restore env vars after every test so they never leak across cases. */
  function restoreEnv() {
    if (SAVED_BACKEND === undefined) {
      delete process.env.STORAGE_BACKEND;
    } else {
      process.env.STORAGE_BACKEND = SAVED_BACKEND;
    }
    if (SAVED_URI === undefined) {
      delete process.env.MONGODB_URI;
    } else {
      process.env.MONGODB_URI = SAVED_URI;
    }
    if (SAVED_DB_NAME === undefined) {
      delete process.env.MONGODB_DB_NAME;
    } else {
      process.env.MONGODB_DB_NAME = SAVED_DB_NAME;
    }
  }

  it('defaults to SQLite when STORAGE_BACKEND is omitted', async () => {
    delete process.env.STORAGE_BACKEND;
    const storage = await createDal({ dbPath: ':memory:' });
    try {
      // A SQLite-backed storage round-trips a config value synchronously inside
      // an awaited Promise; the round-trip itself proves it is the SQLite
      // adapter (MongoDB would need a cluster).
      expect(await storage.config.set('k', 'v')).toEqual({ ok: true });
      expect(await storage.config.get('k')).toBe('v');
    } finally {
      await storage.close();
      restoreEnv();
    }
  });

  it('selects SQLite when STORAGE_BACKEND=sqlite', async () => {
    process.env.STORAGE_BACKEND = 'sqlite';
    const storage = await createDal({ dbPath: ':memory:' });
    try {
      expect(await storage.config.set('k', 'v')).toEqual({ ok: true });
    } finally {
      await storage.close();
      restoreEnv();
    }
  });

  it('throws on an unknown STORAGE_BACKEND value', async () => {
    process.env.STORAGE_BACKEND = 'postgres';
    await expect(createDal({ dbPath: ':memory:' })).rejects.toThrow(/Unknown STORAGE_BACKEND/);
    restoreEnv();
  });

  it('throws when STORAGE_BACKEND=mongodb but MONGODB_URI is unset', async () => {
    process.env.STORAGE_BACKEND = 'mongodb';
    delete process.env.MONGODB_URI;
    await expect(createDal()).rejects.toThrow(/MONGODB_URI is not set/);
    restoreEnv();
  });

  it('throws when the MongoDB URI has no explicit database name', async () => {
    process.env.STORAGE_BACKEND = 'mongodb';
    process.env.MONGODB_URI = 'mongodb+srv://user:pass@cluster.example/';
    await expect(createDal()).rejects.toThrow(/explicit database name/);
    restoreEnv();
  });

  it('accepts a separate database name for a shared-cluster URI', () => {
    expect(
      resolveMongoDatabaseName('mongodb+srv://user:pass@cluster.example/?retryWrites=true', 'gopay'),
    ).toBe('gopay');
  });

  it('rejects an invalid configured database name', () => {
    expect(() => resolveMongoDatabaseName('mongodb+srv://host/', 'auto/beli')).toThrow(
      /invalid characters/,
    );
  });

  it('does NOT fall back to SQLite when MongoDB startup fails', async () => {
    // Point at a non-existent host with a short server-selection timeout baked
    // into the adapter. The factory must surface the failure, never fall back.
    process.env.STORAGE_BACKEND = 'mongodb';
    process.env.MONGODB_URI = 'mongodb+srv://nobody:nobody@nonexistent-cluster-invalid.example/gopay_test';
    await expect(createDal()).rejects.toThrow();
    restoreEnv();
  });

  it('the override option wins over the environment', async () => {
    process.env.STORAGE_BACKEND = 'mongodb';
    process.env.MONGODB_URI = 'mongodb+srv://user:pass@host/should-not-be-used';
    // An explicit `backend: 'sqlite'` override must ignore the env vars.
    const storage = await createDal({ backend: 'sqlite', dbPath: ':memory:' });
    try {
      expect(await storage.config.set('k', 'v')).toEqual({ ok: true });
    } finally {
      await storage.close();
      restoreEnv();
    }
  });
});
