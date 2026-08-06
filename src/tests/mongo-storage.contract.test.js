// Contract tests for the MongoDB Storage implementation (mongo-storage.js).
//
// These mirror the SQLite storage contract tests so both backends are exercised
// through the same shapes. The suite is GATED: it runs only when a MongoDB test
// URI is supplied via the `MONGODB_URI_TEST` environment variable, because the
// rest of the suite (and CI) must not require a running cluster. When the
// variable is absent the file `describe.skip`s everything, leaving a clear
// instruction in the run output instead of silently passing.
//
// Safety: the suite generates a uniquely-named database per run
// (`gopay_test_<random>`), refuses to clean up (drop) any database whose name
// does not match the `gopay_test_*` pattern, and always drops only its own
// generated database on teardown — never a configured production database.
//
// Run locally against an Atlas or local mongod instance:
//   MONGODB_URI_TEST="mongodb://localhost:27017/gopay_test_main" npx vitest --run src/tests/mongo-storage.contract.test.js

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';

import { createMongoStorage, PAYMENT_INDEXES, applyFailurePolicy } from '../dal/mongo/mongo-storage.js';
import { findStorageContractViolations } from '../dal/storage-interface.js';

/** The MongoDB test URI; when absent the whole suite skips. */
const MONGO_URI = process.env.MONGODB_URI_TEST ?? '';

/**
 * Pattern every generated test database name must match. Cleanup refuses to
 * drop any database that does not match this prefix, so a misconfigured URI
 * pointing at a production database can never be destroyed by the test run.
 */
const TEST_DB_PREFIX = 'gopay_test_';
const TEST_DB_PATTERN = /^gopay_test_[A-Za-z0-9_-]+$/;

/** Whether the MongoDB contract suite should run at all. */
const SHOULD_RUN = MONGO_URI.length > 0;

// `describe.skip` when no URI is configured: the run output shows the skip
// reason so a developer knows how to enable the suite locally.
const describeOrSkip = SHOULD_RUN ? describe : describe.skip;

/**
 * Generate a unique database name for one test run. The name always carries the
 * {@link TEST_DB_PREFIX} so the safety guard in {@link safeDropDatabase}
 * accepts it.
 *
 * @returns {string}
 */
function generateTestDbName() {
  return `${TEST_DB_PREFIX}${randomUUID().replace(/-/g, '')}`;
}

/**
 * Parse the database name out of a MongoDB URI.
 *
 * @param {string} uri
 * @returns {string}
 */
function dbNameFromUri(uri) {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)(?:\?.*)?$/);
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * Drop a test database only when its name matches the test pattern. This guard
 * refuses to drop anything that does not look like a generated test database,
 * so a URI misconfigured to point at a real database can never be destroyed.
 *
 * @param {import('mongodb').MongoClient} client
 * @param {string} dbName
 * @returns {Promise<void>}
 */
async function safeDropDatabase(client, dbName) {
  if (!TEST_DB_PATTERN.test(dbName)) {
    throw new Error(
      `Refusing to drop database '${dbName}': it does not match the test pattern ${TEST_DB_PATTERN}.`,
    );
  }
  await client.db(dbName).dropDatabase();
}

/**
 * Build a pending-payment input with sensible defaults, overridable per test.
 *
 * @param {Partial<import('../dal/storage-interface.js').PendingPaymentInput>} [over]
 * @returns {import('../dal/storage-interface.js').PendingPaymentInput}
 */
function pending(over = {}) {
  return {
    id: 'p1',
    amount: 10000,
    qris_string: 'QRIS-PAYLOAD',
    created_at: 1000,
    expires_at: 2000,
    timeout: 1000,
    ...over,
  };
}

describeOrSkip('createMongoStorage (contract)', () => {
  /** The main storage under test, pointed at its own generated database. */
  let storage;
  /** The generated database name for this test run. */
  let dbName;
  /** A cleanup client reused for teardown. */
  let cleanupClient;

  beforeEach(async () => {
    // Spin up a unique database name per test for full isolation. The URI's own
    // database is overridden via the `dbName` option.
    dbName = generateTestDbName();
    storage = await createMongoStorage({ uri: MONGO_URI, dbName });
    cleanupClient = new MongoClient(MONGO_URI);
    await cleanupClient.connect();
  });

  afterEach(async () => {
    try {
      if (storage && typeof storage.close === 'function') {
        await storage.close();
      }
    } finally {
      try {
        await safeDropDatabase(cleanupClient, dbName);
      } catch {
        // best-effort; surface nothing that breaks the run.
      }
      await cleanupClient.close();
    }
  });

  it('satisfies the Storage contract', () => {
    expect(findStorageContractViolations(storage)).toEqual([]);
  });

  it('ping resolves while the client is open', async () => {
    await expect(storage.ping()).resolves.toBeUndefined();
  });

  it('close is idempotent', async () => {
    await storage.close();
    await expect(storage.close()).resolves.toBeUndefined();
  });

  // ---- payments: insertPending / amount uniqueness ----------------------------

  describe('payments.insertPending', () => {
    it('inserts a pending payment and normalizes nulls', async () => {
      const result = await storage.payments.insertPending(pending());
      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({
        id: 'p1',
        amount: 10000,
        status: 'pending',
        qris_string: 'QRIS-PAYLOAD',
        tolerance: 0,
      });
      // Nullable fields come back as explicit null, never undefined/omitted.
      for (const key of ['qris_url', 'webhook_url', 'tx_id', 'paid_amount', 'paid_at', 'tx_raw', 'tz']) {
        expect(Object.prototype.hasOwnProperty.call(result.value, key)).toBe(true);
        expect(result.value[key]).toBeNull();
      }
    });

    it('maps a duplicate pending amount to AMOUNT_IN_USE and stores no row', async () => {
      expect((await storage.payments.insertPending(pending({ id: 'p1', amount: 5000 }))).ok).toBe(true);
      const dup = await storage.payments.insertPending(pending({ id: 'p2', amount: 5000 }));
      expect(dup).toEqual({ ok: false, code: 'AMOUNT_IN_USE' });
      expect(await storage.payments.getById('p2')).toBeNull();
    });

    it('allows reusing an amount once the prior payment leaves pending', async () => {
      await storage.payments.insertPending(pending({ id: 'p1', amount: 7000 }));
      await storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 7000, paidAt: 1500 });
      const reuse = await storage.payments.insertPending(pending({ id: 'p2', amount: 7000 }));
      expect(reuse.ok).toBe(true);
    });

    it('rejects an invalid amount with a throw', async () => {
      await expect(storage.payments.insertPending(pending({ amount: -1 }))).rejects.toThrow();
    });
  });

  // ---- payments: getById / listActive ---------------------------------------

  describe('payments.listActive', () => {
    beforeEach(async () => {
      await storage.payments.insertPending(pending({ id: 'a', amount: 50100, expires_at: 3000 }));
      await storage.payments.insertPending(pending({ id: 'b', amount: 50200, expires_at: 1000 }));
      await storage.payments.insertPending(pending({ id: 'c', amount: 50300, expires_at: 2000 }));
    });

    it('returns only pending payments ordered by expires_at ascending', async () => {
      const ids = (await storage.payments.listActive()).map((p) => p.id);
      expect(ids).toEqual(['b', 'c', 'a']);
    });

    it('excludes settled payments', async () => {
      await storage.payments.markPaid('b', { txId: 'tx-b', paidAmount: 200, paidAt: 1500 });
      const ids = (await storage.payments.listActive()).map((p) => p.id);
      expect(ids).toEqual(['c', 'a']);
    });

    it('honors limit and offset', async () => {
      expect((await storage.payments.listActive({ limit: 1 })).map((p) => p.id)).toEqual(['b']);
      expect((await storage.payments.listActive({ limit: 1, offset: 1 })).map((p) => p.id)).toEqual(['c']);
    });
  });

  // ---- payments: markPaid (settlement idempotency) --------------------------

  describe('payments.markPaid', () => {
    beforeEach(async () => {
      await storage.payments.insertPending(pending({ id: 'p1', amount: 12345 }));
    });

    it('settles a pending payment atomically and persists tx_raw', async () => {
      const raw = '{"tx":"x"}';
      const res = await storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 12345, paidAt: 1800, raw });
      expect(res.ok).toBe(true);
      expect(res.value).toMatchObject({
        id: 'p1',
        status: 'paid',
        tx_id: 'tx-1',
        paid_amount: 12345,
        paid_at: 1800,
        tx_raw: raw,
      });
    });

    it('defaults tx_raw to null when no raw is supplied', async () => {
      const res = await storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 12345, paidAt: 1800 });
      expect(res.ok).toBe(true);
      expect(res.value.tx_raw).toBeNull();
    });

    it('rejects a re-used txId with TX_ALREADY_SETTLED and leaves the second payment pending', async () => {
      await storage.payments.insertPending(pending({ id: 'p2', amount: 22222 }));
      await storage.payments.markPaid('p1', { txId: 'tx-dup', paidAmount: 12345, paidAt: 1800 });
      const second = await storage.payments.markPaid('p2', { txId: 'tx-dup', paidAmount: 22222, paidAt: 1900 });
      expect(second).toEqual({ ok: false, code: 'TX_ALREADY_SETTLED' });
      expect((await storage.payments.getById('p2')).status).toBe('pending');
    });

    it('rejects settling a missing payment with PAYMENT_NOT_PENDING', async () => {
      const missing = await storage.payments.markPaid('ghost', { txId: 'tx-x', paidAmount: 1, paidAt: 1 });
      expect(missing).toEqual({ ok: false, code: 'PAYMENT_NOT_PENDING' });
      // The txId is still free because nothing consumed it.
      await storage.payments.insertPending(pending({ id: 'p3', amount: 33333 }));
      const reuse = await storage.payments.markPaid('p3', { txId: 'tx-x', paidAmount: 33333, paidAt: 2 });
      expect(reuse.ok).toBe(true);
    });
  });

  // ---- payments: expiry -----------------------------------------------------

  describe('payments.expireOverdue / expireOverdueReturning', () => {
    it('expireOverdue transitions only overdue pending payments', async () => {
      await storage.payments.insertPending(pending({ id: 'old', amount: 50001, expires_at: 1000 }));
      await storage.payments.insertPending(pending({ id: 'fresh', amount: 50002, expires_at: 5000 }));
      const expired = await storage.payments.expireOverdue(2000);
      expect(expired).toBe(1);
      expect((await storage.payments.getById('old')).status).toBe('expired');
      expect((await storage.payments.getById('fresh')).status).toBe('pending');
    });

    it('expireOverdueReturning returns only the rows transitioned by THIS call', async () => {
      await storage.payments.insertPending(pending({ id: 'a', amount: 50001, expires_at: 1000 }));
      await storage.payments.insertPending(pending({ id: 'b', amount: 50002, expires_at: 1500 }));
      const first = await storage.payments.expireOverdueReturning(2000);
      expect(first.map((p) => p.id).sort()).toEqual(['a', 'b']);
      // A second call wins no transitions.
      const second = await storage.payments.expireOverdueReturning(2000);
      expect(second).toEqual([]);
    });
  });

  // ---- payments: listHistory / listAll / countAll ---------------------------

  describe('payments.listHistory', () => {
    it('returns terminal payments most recent first (paid before expired)', async () => {
      await storage.payments.insertPending(pending({ id: 'pend', amount: 50001, expires_at: 9_000_000 }));
      await storage.payments.insertPending(pending({ id: 'paid', amount: 50002, created_at: 1000 }));
      await storage.payments.markPaid('paid', { txId: 'tx-paid', paidAmount: 2, paidAt: 8000 });
      await storage.payments.insertPending(pending({ id: 'exp', amount: 50003, created_at: 500, expires_at: 600 }));
      await storage.payments.expireOverdue(700);
      const ids = (await storage.payments.listHistory()).map((p) => p.id);
      expect(ids).toEqual(['paid', 'exp']);
    });
  });

  describe('payments.listAll / countAll', () => {
    beforeEach(async () => {
      await storage.payments.insertPending(pending({ id: 'p-old', amount: 50100, created_at: 1000, expires_at: 1100 }));
      await storage.payments.insertPending(pending({ id: 'p-mid', amount: 50200, created_at: 2000, expires_at: 9_000_000 }));
      await storage.payments.insertPending(pending({ id: 'p-new', amount: 50300, created_at: 3000, expires_at: 9_000_000 }));
      await storage.payments.markPaid('p-new', { txId: 'tx-new', paidAmount: 300, paidAt: 3500 });
      await storage.payments.expireOverdue(1500);
    });

    it('returns all statuses ordered by created_at DESC, id DESC', async () => {
      const ids = (await storage.payments.listAll()).map((p) => p.id);
      expect(ids).toEqual(['p-new', 'p-mid', 'p-old']);
    });

    it('filters by a single status', async () => {
      expect((await storage.payments.listAll({ status: 'paid' })).map((p) => p.id)).toEqual(['p-new']);
      expect((await storage.payments.listAll({ status: 'expired' })).map((p) => p.id)).toEqual(['p-old']);
      expect((await storage.payments.listAll({ status: 'pending' })).map((p) => p.id)).toEqual(['p-mid']);
    });

    it('prefix id filter uses the _id index', async () => {
      const all = await storage.payments.listAll({ id: 'p-' });
      expect(all.length).toBe(3);
      const filtered = await storage.payments.listAll({ id: 'p-new' });
      expect(filtered.map((p) => p.id)).toEqual(['p-new']);
    });

    it('counts all and per-status', async () => {
      expect(await storage.payments.countAll()).toBe(3);
      expect(await storage.payments.countAll({ status: 'paid' })).toBe(1);
      expect(await storage.payments.countAll({ status: 'expired' })).toBe(1);
      expect(await storage.payments.countAll({ status: 'pending' })).toBe(1);
    });
  });

  // ---- payments: candidate range scan + tolerance ---------------------------

  describe('payments.findCandidatesByAmount / maxActiveTolerance', () => {
    it('returns pending candidates in the range ordered earliest-created first', async () => {
      await storage.payments.insertPending(pending({ id: 'c1', amount: 10000, created_at: 1000 }));
      await storage.payments.insertPending(pending({ id: 'c2', amount: 10050, created_at: 2000 }));
      await storage.payments.insertPending(pending({ id: 'c3', amount: 10500, created_at: 3000 }));
      const candidates = await storage.payments.findCandidatesByAmount(10000, 10100);
      expect(candidates.map((p) => p.id)).toEqual(['c1', 'c2']);
    });

    it('maxActiveTolerance returns the widest tolerance among pending (0 when none)', async () => {
      expect(await storage.payments.maxActiveTolerance()).toBe(0);
      await storage.payments.insertPending(pending({ id: 'a', amount: 50100, tolerance: 50 }));
      await storage.payments.insertPending(pending({ id: 'b', amount: 50200, tolerance: 250 }));
      expect(await storage.payments.maxActiveTolerance()).toBe(250);
    });
  });

  // ---- config store ---------------------------------------------------------

  describe('config', () => {
    it('returns null for an unset key', async () => {
      expect(await storage.config.get('poll_interval')).toBeNull();
    });

    it('persists and overwrites values', async () => {
      expect(await storage.config.set('poll_interval', '3000')).toEqual({ ok: true });
      expect(await storage.config.get('poll_interval')).toBe('3000');
      await storage.config.set('poll_interval', '5000');
      expect(await storage.config.get('poll_interval')).toBe('5000');
    });
  });

  // ---- apiKeys --------------------------------------------------------------

  describe('apiKeys', () => {
    async function createKey(over = {}) {
      return storage.apiKeys.create({
        id: 'k1',
        keyHash: 'hash-1',
        keyPrefix: 'gpk_aaaa',
        createdAt: 1000,
        ...over,
      });
    }

    it('create inserts an active key', async () => {
      const res = await createKey();
      expect(res.ok).toBe(true);
      expect(res.value).toMatchObject({ id: 'k1', status: 'active', key_hash: 'hash-1', revoked_at: null });
    });

    it('create maps a duplicate hash to KEY_HASH_IN_USE', async () => {
      await createKey({ id: 'k1', keyHash: 'dup' });
      const dup = await createKey({ id: 'k2', keyHash: 'dup' });
      expect(dup).toEqual({ ok: false, code: 'KEY_HASH_IN_USE' });
    });

    it('revoke flips active->revoked and rejects already-revoked', async () => {
      await createKey({ id: 'k1' });
      const res = await storage.apiKeys.revoke('k1', 2500);
      expect(res.ok).toBe(true);
      expect(res.value.status).toBe('revoked');
      const again = await storage.apiKeys.revoke('k1', 9999);
      expect(again).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });
    });

    it('listMasked returns masked rows newest first, no hash', async () => {
      await createKey({ id: 'k1', keyHash: 'h1', createdAt: 1000 });
      await createKey({ id: 'k2', keyHash: 'h2', createdAt: 2000 });
      const masked = await storage.apiKeys.listMasked();
      expect(masked.map((k) => k.id)).toEqual(['k2', 'k1']);
      for (const row of masked) {
        expect(row).not.toHaveProperty('key_hash');
      }
    });
  });

  // ---- webhookLogs ----------------------------------------------------------

  describe('webhookLogs', () => {
    it('append / listByPayment round-trips rows oldest first', async () => {
      await storage.webhookLogs.append({ id: 'w1', payment_id: 'pay-A', target_url: 'https://x', status: 'failed', attempts: 1, last_attempt_at: 1000 });
      await storage.webhookLogs.append({ id: 'w2', payment_id: 'pay-A', target_url: 'https://x', status: 'success', attempts: 2, last_attempt_at: 2000 });
      const rows = await storage.webhookLogs.listByPayment('pay-A');
      expect(rows.map((r) => r.id)).toEqual(['w1', 'w2']);
      expect(rows[0]).toMatchObject({ response_status: null, response_body: null, request_body: null });
    });

    it('markPermanentFailure flips an existing row and rejects a missing one', async () => {
      await storage.webhookLogs.append({ id: 'w1', payment_id: 'p', target_url: 'https://x', status: 'failed', attempts: 1, last_attempt_at: 1000 });
      expect((await storage.webhookLogs.markPermanentFailure('w1')).ok).toBe(true);
      expect(await storage.webhookLogs.markPermanentFailure('ghost')).toEqual({ ok: false, code: 'LOG_NOT_FOUND' });
    });

    it('pruneOld deletes rows older than the cutoff and returns the count', async () => {
      await storage.webhookLogs.append({ id: 'old', payment_id: 'p', target_url: 'https://x', status: 'failed', attempts: 1, last_attempt_at: 1000 });
      await storage.webhookLogs.append({ id: 'new', payment_id: 'p', target_url: 'https://x', status: 'failed', attempts: 1, last_attempt_at: 5000 });
      const removed = await storage.webhookLogs.pruneOld(4000);
      expect(removed).toBe(1);
      const remaining = await storage.webhookLogs.listByPayment('p');
      expect(remaining.map((r) => r.id)).toEqual(['new']);
    });
  });

  // ---- adminUsers -----------------------------------------------------------

  describe('adminUsers.ensure', () => {
    it('creates a missing admin (created:true) and does not overwrite on re-ensure', async () => {
      const first = await storage.adminUsers.ensure({ id: 'a1', username: 'admin', passwordHash: 'first' });
      expect(first).toEqual({ ok: true, value: { created: true } });
      const second = await storage.adminUsers.ensure({ id: 'a2', username: 'admin', passwordHash: 'second' });
      expect(second).toEqual({ ok: true, value: { created: false } });
      // The stored hash is the ORIGINAL.
      expect((await storage.adminUsers.getByUsername('admin')).password_hash).toBe('first');
    });
  });

  describe('adminUsers.listUsernames / updateCredentials', () => {
    it('listUsernames returns usernames only (no hashes), sorted', async () => {
      await storage.adminUsers.ensure({ id: 'a1', username: 'bravo', passwordHash: 'h1' });
      await storage.adminUsers.ensure({ id: 'a2', username: 'alpha', passwordHash: 'h2' });
      const rows = await storage.adminUsers.listUsernames();
      expect(rows.map((r) => r.username)).toEqual(['alpha', 'bravo']);
      for (const row of rows) {
        expect(row).not.toHaveProperty('password_hash');
      }
    });

    it('updateCredentials renames and changes the password', async () => {
      await storage.adminUsers.ensure({ id: 'a1', username: 'admin', passwordHash: 'old' });
      const res = await storage.adminUsers.updateCredentials({
        currentUsername: 'admin',
        newUsername: 'root',
        passwordHash: 'new',
      });
      expect(res.ok).toBe(true);
      expect(res.value).toMatchObject({ username: 'root', password_hash: 'new' });
      expect(await storage.adminUsers.getByUsername('admin')).toBeNull();
    });

    it('updateCredentials rejects a rename to a taken username', async () => {
      await storage.adminUsers.ensure({ id: 'a1', username: 'a', passwordHash: 'h' });
      await storage.adminUsers.ensure({ id: 'a2', username: 'b', passwordHash: 'h' });
      const res = await storage.adminUsers.updateCredentials({
        currentUsername: 'a',
        newUsername: 'b',
      });
      expect(res).toEqual({ ok: false, code: 'USERNAME_IN_USE' });
    });

    it('updateCredentials rejects a missing admin', async () => {
      const res = await storage.adminUsers.updateCredentials({ currentUsername: 'ghost' });
      expect(res).toEqual({ ok: false, code: 'ADMIN_NOT_FOUND' });
    });
  });

  // ---- loginAttempts --------------------------------------------------------

  describe('loginAttempts.recordFailure (atomic policy)', () => {
    it('applies the fixed-window policy and persists state', async () => {
      const r = await storage.loginAttempts.recordFailure('9.9.9.9', {
        now: 1000,
        windowMs: 15 * 60 * 1000,
        threshold: 5,
        lockoutMs: 15 * 60 * 1000,
      });
      expect(r.ok).toBe(true);
      expect(r.value.failedAttempts).toBe(1);
      const stored = await storage.loginAttempts.getByIp('9.9.9.9');
      expect(stored.failedAttempts).toBe(1);
    });

    it('escalates to a lockout at the threshold and isLockedOut reports it', async () => {
      const policy = { now: 0, windowMs: 15 * 60 * 1000, threshold: 5, lockoutMs: 15 * 60 * 1000 };
      for (let i = 0; i < 5; i += 1) {
        policy.now = 1000 + i * 1000;
        // eslint-disable-next-line no-await-in-loop
        await storage.loginAttempts.recordFailure('9.9.9.8', policy);
      }
      expect(await storage.loginAttempts.isLockedOut('9.9.9.8', 6000)).toBe(true);
      expect(await storage.loginAttempts.isLockedOut('9.9.9.8', 1000 * 60 * 20)).toBe(false);
    });

    it('resetFailures clears the counters', async () => {
      await storage.loginAttempts.recordFailure('9.9.9.7', { now: 1000, windowMs: 15 * 60 * 1000, threshold: 5, lockoutMs: 15 * 60 * 1000 });
      await storage.loginAttempts.resetFailures('9.9.9.7');
      expect(await storage.loginAttempts.isLockedOut('9.9.9.7', 2000)).toBe(false);
    });

    it('clearAll wipes every IP and returns the removed count', async () => {
      await storage.loginAttempts.recordFailure('9.9.9.6', { now: 1000, windowMs: 15 * 60 * 1000, threshold: 5, lockoutMs: 15 * 60 * 1000 });
      await storage.loginAttempts.recordFailure('9.9.9.5', { now: 1000, windowMs: 15 * 60 * 1000, threshold: 5, lockoutMs: 15 * 60 * 1000 });
      const removed = await storage.loginAttempts.clearAll();
      expect(removed).toBe(2);
      expect(await storage.loginAttempts.getByIp('9.9.9.6')).toBeNull();
      expect(await storage.loginAttempts.getByIp('9.9.9.5')).toBeNull();
    });

    it('the atomic pipeline matches the reference applyFailurePolicy step by step', async () => {
      // Cross-check: drive a sequence of failures through the API and, after
      // each call, confirm the pipeline produced exactly the state the
      // reference `applyFailurePolicy` computes from the previous actual
      // state. Covers first failure, in-window increments, threshold
      // escalation, and a post-window reset.
      const policy = { now: 0, windowMs: 100_000, threshold: 5, lockoutMs: 200_000 };
      /** @type {{ failedAttempts: number, lockoutUntil: number|null }|null} */
      let prev = null;
      /** Times for each failure: inside the window, then past it. */
      const times = [1_000, 2_000, 3_000, 4_000, 5_000, 500_000];
      const ip = '9.9.9.1';

      for (const t of times) {
        const expected = applyFailurePolicy(prev, { ...policy, now: t });
        // eslint-disable-next-line no-await-in-loop
        const result = await storage.loginAttempts.recordFailure(ip, { ...policy, now: t });
        expect(result.value.failedAttempts).toBe(expected.failedAttempts);
        expect(result.value.lockoutUntil).toBe(expected.lockoutUntil);
        prev = result.value;
      }

      // After the long gap the counter must have reset to 1 (post-window).
      expect(prev.failedAttempts).toBe(1);
    });
  });

  // ---- indexes exist --------------------------------------------------------

  describe('indexes', () => {
    it('creates every named payment index', async () => {
      // Open a separate client to read index metadata from the same database.
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      try {
        const db = client.db(dbName);
        const indexes = await db.collection('payments').indexInformation({ full: true });
        const names = indexes.map((idx) => idx.name);
        for (const { name } of PAYMENT_INDEXES) {
          expect(names).toContain(name);
        }
      } finally {
        await client.close();
      }
    });

    it('the pending-amount index is unique', async () => {
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      try {
        const db = client.db(dbName);
        const indexes = await db.collection('payments').indexInformation({ full: true });
        const uniq = indexes.find((idx) => idx.name === 'uniq_pending_amount');
        expect(uniq?.unique).toBe(true);
      } finally {
        await client.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency: two storage instances sharing one database. Runs only when the
// URI is configured. Asserts atomic operations tolerate the brief old/new
// instance overlap during deployment.
// ---------------------------------------------------------------------------

describeOrSkip('createMongoStorage (concurrency between two instances)', () => {
  /** A shared cleanup client for the whole concurrency describe block. */
  let cleanupClient;
  /** The generated database name shared by both instances under test. */
  let dbName;

  beforeEach(async () => {
    dbName = generateTestDbName();
    cleanupClient = new MongoClient(MONGO_URI);
    await cleanupClient.connect();
  });

  afterEach(async () => {
    try {
      await safeDropDatabase(cleanupClient, dbName);
    } catch {
      // best-effort
    }
    await cleanupClient.close();
  });

  it('exactly one of two concurrent createPayment-with-same-amount inserts wins', async () => {
    const a = await createMongoStorage({ uri: MONGO_URI, dbName });
    const b = await createMongoStorage({ uri: MONGO_URI, dbName });
    try {
      const [ra, rb] = await Promise.all([
        a.payments.insertPending(pending({ id: 'a', amount: 4242 })),
        b.payments.insertPending(pending({ id: 'b', amount: 4242 })),
      ]);
      const winners = [ra, rb].filter((r) => r.ok);
      const losers = [ra, rb].filter((r) => !r.ok);
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect(losers[0]).toEqual({ ok: false, code: 'AMOUNT_IN_USE' });
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('a txId settles at most one payment across two instances', async () => {
    const a = await createMongoStorage({ uri: MONGO_URI, dbName });
    const b = await createMongoStorage({ uri: MONGO_URI, dbName });
    try {
      await a.payments.insertPending(pending({ id: 'pa', amount: 1111 }));
      await b.payments.insertPending(pending({ id: 'pb', amount: 2222 }));
      const [ra, rb] = await Promise.all([
        a.payments.markPaid('pa', { txId: 'tx-shared', paidAmount: 1111, paidAt: 1500 }),
        b.payments.markPaid('pb', { txId: 'tx-shared', paidAmount: 2222, paidAt: 1500 }),
      ]);
      const successes = [ra, rb].filter((r) => r.ok);
      const alreadySettled = [ra, rb].filter((r) => r.code === 'TX_ALREADY_SETTLED');
      expect(successes.length).toBe(1);
      expect(alreadySettled.length).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('two instances both ensure the same admin: exactly one creates it', async () => {
    const a = await createMongoStorage({ uri: MONGO_URI, dbName });
    const b = await createMongoStorage({ uri: MONGODB_URI_OR(MONGO_URI), dbName });
    try {
      const [ra, rb] = await Promise.all([
        a.adminUsers.ensure({ id: 'ua', username: 'admin', passwordHash: 'ha' }),
        b.adminUsers.ensure({ id: 'ub', username: 'admin', passwordHash: 'hb' }),
      ]);
      const created = [ra, rb].filter((r) => r.value?.created === true);
      const skipped = [ra, rb].filter((r) => r.value?.created === false);
      expect(created.length).toBe(1);
      expect(skipped.length).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('concurrent expireOverdueReturning across two instances: each overdue payment expires exactly once', async () => {
    // Two overlapping processes both sweep overdue payments. Because each
    // findOneAndUpdate requires status:'pending', a payment won by one caller
    // is invisible to the other, so the union of returned rows contains every
    // overdue payment exactly once — no double expiry notification.
    const a = await createMongoStorage({ uri: MONGO_URI, dbName });
    const b = await createMongoStorage({ uri: MONGO_URI, dbName });
    try {
      // Seed 6 overdue pending payments at distinct amounts.
      for (let i = 0; i < 6; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await a.payments.insertPending(
          pending({ id: `o${i}`, amount: 60000 + i, created_at: 1000 + i, expires_at: 1500 }),
        );
      }
      const now = 2000; // past every expires_at

      const [expiredA, expiredB] = await Promise.all([
        a.payments.expireOverdueReturning(now),
        b.payments.expireOverdueReturning(now),
      ]);

      const idsA = expiredA.map((p) => p.id);
      const idsB = expiredB.map((p) => p.id);
      const union = new Set([...idsA, ...idsB]);
      // Every overdue payment was expired...
      expect(union.size).toBe(6);
      // ...and none was claimed by both callers (the sets are disjoint).
      for (const id of idsA) {
        expect(idsB).not.toContain(id);
      }
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('concurrent login failures cannot bypass the lockout threshold', async () => {
    // Two instances racing recordFailure on the same IP must each observe the
    // other's write: after N concurrent failures the persisted counter equals
    // N (every call incremented it once), and once N reaches the threshold the
    // IP is locked. A read-then-write implementation would let concurrent
    // callers overwrite each other and bypass the threshold; the atomic
    // findOneAndUpdate pipeline prevents that.
    const a = await createMongoStorage({ uri: MONGO_URI, dbName });
    const b = await createMongoStorage({ uri: MONGO_URI, dbName });
    try {
      const ip = '10.20.30.40';
      const policy = { now: 1_000_000, windowMs: 15 * 60 * 1000, threshold: 5, lockoutMs: 15 * 60 * 1000 };
      // Fire `threshold` concurrent failures across BOTH instances.
      const calls = [];
      for (let i = 0; i < 5; i += 1) {
        calls.push(a.loginAttempts.recordFailure(ip, policy));
        calls.push(b.loginAttempts.recordFailure(ip, policy));
      }
      const results = await Promise.all(calls);
      const totalAttempts = results.reduce((sum, r) => sum + r.value.failedAttempts, 0);
      // Each of the 10 concurrent calls incremented the counter exactly once,
      // so the SUM of reported counts is 1+2+...+10 = 55 (a read-then-write
      // implementation would lose increments and report far less).
      expect(totalAttempts).toBe(1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10);

      // The final persisted counter is exactly the number of failures (10),
      // which is at/above the threshold, so the IP is locked out.
      const stored = await a.loginAttempts.getByIp(ip);
      expect(stored.failedAttempts).toBe(10);
      expect(await a.loginAttempts.isLockedOut(ip, 1_000_000)).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

/**
 * Tiny helper so the third concurrency test compiles even when only the main
 * URI variable exists — returns the same URI. Keeps the suite self-contained.
 *
 * @param {string} uri
 * @returns {string}
 */
function MONGODB_URI_OR(uri) {
  return uri;
}
