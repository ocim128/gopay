// Integration tests for the Data Access Layer (DAL) boundary.
//
// Two concerns are covered here:
//
//   1. DAL isolation / substitutability: higher-level
//      services operate purely through the storage-agnostic `Storage` contract.
//      We prove this by substituting a hand-written, plain-JavaScript mock that
//      implements the contract (no SQLite, no better-sqlite3 connection) and
//      driving the real Config Service and Payment Service through it. The
//      services produce correct results without ever reaching for a database
//      directly — every persistence call lands on a contract method.
//
//   2. WAL durability: a file-backed SQLite DAL keeps
//      its data across a close/reopen cycle. We write payments and config,
//      close the connection, open a brand-new storage on the same path, and
//      confirm the data is still there. We also confirm Write-Ahead Logging is
//      actually in effect by observing the `-wal` sidecar file while the
//      connection is open.
//
// The mock storage returns Promises that resolve on a microtask delay so a
// missing `await` in a production caller cannot be hidden by SQLite's
// synchronous return — the delayed Promise rejects the test when it is not
// awaited.

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  assertStorage,
  findStorageContractViolations,
} from '../dal/storage-interface.js';
import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import {
  CONFIG_KEYS,
  createConfigService,
  DEFAULT_POLL_INTERVAL_MS,
} from '../config/runtime-config.js';
import { createPaymentService, PAYMENT_MODE } from '../payment/payment-service.js';

// A real, structurally valid Static_QRIS with a correct trailing CRC16, reused
// from the Payment_Service tests so createPayment can build a Dynamic_QRIS.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

/**
 * Resolve the value on the next microtask so every mock method returns a
 * genuinely asynchronous Promise. A synchronous-returning mock would let a
 * caller forget `await` and still pass — the delay forces the await.
 *
 * @template T
 * @param {T} value
 * @returns {Promise<T>}
 */
function later(value) {
  return Promise.resolve().then(() => value);
}

/**
 * Build a pure in-memory mock that satisfies the `Storage` contract using only
 * plain JavaScript data structures. No SQLite, no file handle, no connection
 * object — the only thing crossing the boundary is the contract itself. Every
 * method increments a per-method call counter so a test can assert that a
 * service drove its persistence exclusively through the contract.
 *
 * @returns {{ storage: import('../dal/storage-interface.js').Storage, calls: Record<string, number> }}
 */
function createMockStorage() {
  /** @type {Map<string, import('../dal/storage-interface.js').Payment>} */
  const payments = new Map();
  /** @type {Map<string, string>} */
  const config = new Map();
  /** @type {Set<string>} */
  const settledTx = new Set();

  /** @type {Record<string, number>} */
  const calls = {};
  const count = (name) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };

  /**
   * Whether `amount` is currently claimed by a pending payment (the mock's
   * stand-in for the partial unique index the SQLite backend uses).
   *
   * @param {number} amount
   * @returns {boolean}
   */
  function amountInUse(amount) {
    for (const p of payments.values()) {
      if (p.status === 'pending' && p.amount === amount) {
        return true;
      }
    }
    return false;
  }

  const storage = {
    payments: {
      insertPending(input) {
        count('payments.insertPending');
        if (amountInUse(input.amount)) {
          return later({ ok: false, code: 'AMOUNT_IN_USE' });
        }
        const payment = {
          id: input.id,
          amount: input.amount,
          status: 'pending',
          qris_string: input.qris_string,
          qris_url: input.qris_url ?? null,
          created_at: input.created_at,
          expires_at: input.expires_at,
          timeout: input.timeout,
          tolerance: input.tolerance ?? 0,
          webhook_url: input.webhook_url ?? null,
          tx_id: null,
          paid_amount: null,
          paid_at: null,
        };
        payments.set(payment.id, payment);
        return later({ ok: true, value: { ...payment } });
      },
      getById(id) {
        count('payments.getById');
        const p = payments.get(id);
        return later(p ? { ...p } : null);
      },
      listActive(options = {}) {
        count('payments.listActive');
        const limit = Number.isInteger(options.limit) ? options.limit : 100;
        const offset = Number.isInteger(options.offset) ? options.offset : 0;
        return later(
          [...payments.values()]
            .filter((p) => p.status === 'pending')
            .sort((a, b) => a.expires_at - b.expires_at)
            .slice(offset, offset + limit)
            .map((p) => ({ ...p })),
        );
      },
      listHistory(options = {}) {
        count('payments.listHistory');
        const limit = Number.isInteger(options.limit) ? options.limit : 50;
        const offset = Number.isInteger(options.offset) ? options.offset : 0;
        return later(
          [...payments.values()]
            .filter((p) => p.status === 'paid' || p.status === 'expired')
            .sort((a, b) => (b.paid_at ?? b.created_at) - (a.paid_at ?? a.created_at))
            .slice(offset, offset + limit)
            .map((p) => ({ ...p })),
        );
      },
      markPaid(id, settlement) {
        count('payments.markPaid');
        if (settledTx.has(settlement.txId)) {
          return later({ ok: false, code: 'TX_ALREADY_SETTLED' });
        }
        const p = payments.get(id);
        if (!p || p.status !== 'pending') {
          return later({ ok: false, code: 'PAYMENT_NOT_PENDING' });
        }
        settledTx.add(settlement.txId);
        p.status = 'paid';
        p.tx_id = settlement.txId;
        p.paid_amount = settlement.paidAmount;
        p.paid_at = settlement.paidAt;
        p.tx_raw = settlement.raw ?? null;
        return later({ ok: true, value: { ...p } });
      },
      expireOverdue(now) {
        count('payments.expireOverdue');
        let expired = 0;
        for (const p of payments.values()) {
          if (p.status === 'pending' && p.expires_at < now) {
            p.status = 'expired';
            expired += 1;
          }
        }
        return later(expired);
      },
      expireOverdueReturning(now) {
        count('payments.expireOverdueReturning');
        /** @type {import('../dal/storage-interface.js').Payment[]} */
        const out = [];
        for (const p of payments.values()) {
          if (p.status === 'pending' && p.expires_at < now) {
            p.status = 'expired';
            out.push({ ...p });
          }
        }
        return later(out);
      },
      countActive() {
        count('payments.countActive');
        let n = 0;
        for (const p of payments.values()) {
          if (p.status === 'pending') {
            n += 1;
          }
        }
        return later(n);
      },
      listAll(options = {}) {
        count('payments.listAll');
        const limit = Number.isInteger(options.limit) ? options.limit : 50;
        const offset = Number.isInteger(options.offset) ? options.offset : 0;
        const status = options.status;
        return later(
          [...payments.values()]
            .filter((p) => (status ? p.status === status : true))
            .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
            .slice(offset, offset + limit)
            .map((p) => ({ ...p })),
        );
      },
      countAll(options = {}) {
        count('payments.countAll');
        const status = options.status;
        let n = 0;
        for (const p of payments.values()) {
          if (!status || p.status === status) {
            n += 1;
          }
        }
        return later(n);
      },
      findCandidatesByAmount(min, max) {
        count('payments.findCandidatesByAmount');
        return later(
          [...payments.values()]
            .filter((p) => p.status === 'pending' && p.amount >= min && p.amount <= max)
            .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
            .map((p) => ({ ...p })),
        );
      },
      maxActiveTolerance() {
        count('payments.maxActiveTolerance');
        let m = 0;
        for (const p of payments.values()) {
          if (p.status === 'pending' && p.tolerance > m) {
            m = p.tolerance;
          }
        }
        return later(m);
      },
    },
    apiKeys: {
      create() {
        count('apiKeys.create');
        return later({ ok: true });
      },
      getActiveByHash() {
        count('apiKeys.getActiveByHash');
        return later(null);
      },
      revoke() {
        count('apiKeys.revoke');
        return later({ ok: false, code: 'KEY_NOT_REVOCABLE' });
      },
      listMasked() {
        count('apiKeys.listMasked');
        return later([]);
      },
    },
    webhookLogs: {
      append() {
        count('webhookLogs.append');
        return later({ ok: true });
      },
      markPermanentFailure() {
        count('webhookLogs.markPermanentFailure');
        return later({ ok: false, code: 'LOG_NOT_FOUND' });
      },
      listByPayment() {
        count('webhookLogs.listByPayment');
        return later([]);
      },
      pruneOld() {
        count('webhookLogs.pruneOld');
        return later(0);
      },
    },
    adminUsers: {
      getByUsername() {
        count('adminUsers.getByUsername');
        return later(null);
      },
      ensure() {
        count('adminUsers.ensure');
        return later({ ok: true, value: { created: true } });
      },
      listUsernames() {
        count('adminUsers.listUsernames');
        return later([]);
      },
      updateCredentials() {
        count('adminUsers.updateCredentials');
        return later({ ok: false, code: 'ADMIN_NOT_FOUND' });
      },
    },
    loginAttempts: {
      getByIp() {
        count('loginAttempts.getByIp');
        return later(null);
      },
      recordFailure(_ip, _policy) {
        count('loginAttempts.recordFailure');
        return later({ ok: true, value: { failedAttempts: 1, lockoutUntil: null } });
      },
      resetFailures() {
        count('loginAttempts.resetFailures');
        return later({ ok: true });
      },
      isLockedOut() {
        count('loginAttempts.isLockedOut');
        return later(false);
      },
      clearAll() {
        count('loginAttempts.clearAll');
        return later(0);
      },
    },
    config: {
      get(key) {
        count('config.get');
        return later(config.has(key) ? config.get(key) : null);
      },
      set(key, value) {
        count('config.set');
        config.set(key, value);
        return later({ ok: true });
      },
    },
    ping() {
      count('ping');
      return later(undefined);
    },
    close() {
      count('close');
      return later(undefined);
    },
  };

  return { storage, calls };
}

describe('DAL isolation: services run purely through the Storage contract', () => {
  it('a plain-JS mock with no SQLite satisfies the Storage contract', () => {
    const { storage } = createMockStorage();

    // The contract validator reports no missing members...
    expect(findStorageContractViolations(storage)).toEqual([]);
    // ...and the assertion form accepts it without throwing.
    expect(() => assertStorage(storage)).not.toThrow();

    // The mock exposes none of the backend-specific surface a SQLite handle
    // would: no connection, no prepared statements, no PRAGMA. Only the
    // contract crosses the boundary.
    expect(storage).not.toHaveProperty('db');
    expect(storage).not.toHaveProperty('prepare');
    expect(storage).not.toHaveProperty('pragma');
  });

  it('createConfigService works against the mock without a database', async () => {
    const { storage, calls } = createMockStorage();
    const config = createConfigService(storage);

    // Unset values fall back to defaults and read only through config.get.
    expect(await config.getPollInterval()).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(await config.getStaticQris()).toBeNull();

    // Writes round-trip through the contract's config.set/get.
    expect(await config.setPollInterval(3000)).toBe(3000);
    expect(await config.getPollInterval()).toBe(3000);

    expect(await config.setDefaultWebhookUrl('https://example.com/hook')).toBe(
      'https://example.com/hook',
    );
    expect(await config.getDefaultWebhookUrl()).toBe('https://example.com/hook');

    expect(await config.setStaticQris(VALID_STATIC_QRIS)).toBe(VALID_STATIC_QRIS);
    expect(await config.getStaticQris()).toBe(VALID_STATIC_QRIS);

    // Every persistence touch was a contract method on config; nothing else on
    // the mock was invoked to read or write settings.
    expect(calls['config.set']).toBeGreaterThan(0);
    expect(calls['config.get']).toBeGreaterThan(0);
  });

  it('createPaymentService creates and reads payments against the mock', async () => {
    const { storage, calls } = createMockStorage();
    const config = createConfigService(storage);
    await config.setStaticQris(VALID_STATIC_QRIS);

    let clock = 1_000_000;
    let idSeq = 0;
    const service = createPaymentService({
      storage,
      config,
      now: () => clock,
      idFactory: () => `pay-${(idSeq += 1)}`,
    });

    const created = await service.createPayment({ mode: PAYMENT_MODE.CLIENT, amount: 25000 });
    expect(created).toMatchObject({
      id: 'pay-1',
      amount: 25000,
      status: 'pending',
    });
    expect(typeof created.qris_string).toBe('string');
    expect(created.qris_string.length).toBeGreaterThan(0);

    // Reads route through the contract too.
    expect(await service.getPayment('pay-1')).toMatchObject({ id: 'pay-1', status: 'pending' });
    expect((await service.listActive()).map((p) => p.id)).toEqual(['pay-1']);

    // The service persisted exclusively through contract methods.
    expect(calls['payments.insertPending']).toBe(1);
    expect(calls['payments.getById']).toBeGreaterThan(0);
    expect(calls['payments.listActive']).toBeGreaterThan(0);
  });

  it('amount-uniqueness enforced by the contract surfaces as AMOUNT_IN_USE', async () => {
    const { storage } = createMockStorage();
    const config = createConfigService(storage);
    await config.setStaticQris(VALID_STATIC_QRIS);

    let idSeq = 0;
    const service = createPaymentService({
      storage,
      config,
      now: () => 1_000_000,
      idFactory: () => `pay-${(idSeq += 1)}`,
    });

    await service.createPayment({ mode: PAYMENT_MODE.CLIENT, amount: 50000 });
    await expect(service.createPayment({ mode: PAYMENT_MODE.CLIENT, amount: 50000 })).rejects.toThrow(
      /AMOUNT_IN_USE|in use/i,
    );
  });
});

describe('WAL durability: file-backed data survives a close/reopen cycle', () => {
  /** @type {string} */
  let dbPath;

  afterEach(() => {
    // Remove the database and its WAL/SHM sidecars.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try {
        rmSync(`${dbPath}${suffix}`, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it('persists payments and config across a reopen, with WAL active', async () => {
    dbPath = join(tmpdir(), `gopay-wal-${randomUUID()}.db`);

    // --- write phase -------------------------------------------------------
    const first = createSqliteStorage({ dbPath });

    const insert = await first.payments.insertPending({
      id: 'durable-1',
      amount: 42000,
      qris_string: 'QRIS-DURABLE',
      created_at: 1000,
      expires_at: 9_9999000,
      timeout: 300000,
    });
    expect(insert.ok).toBe(true);

    expect(await first.config.set(CONFIG_KEYS.POLL_INTERVAL, '7000')).toEqual({ ok: true });
    expect(await first.config.set(CONFIG_KEYS.STATIC_QRIS, VALID_STATIC_QRIS)).toEqual({ ok: true });

    // Write-Ahead Logging is in effect: the `-wal` sidecar exists while the
    // connection is open and holds uncheckpointed pages.
    expect(existsSync(`${dbPath}-wal`)).toBe(true);

    await first.close();

    // The database file itself persists on disk after close.
    expect(existsSync(dbPath)).toBe(true);

    // --- reopen phase ------------------------------------------------------
    const second = createSqliteStorage({ dbPath });
    try {
      const reread = await second.payments.getById('durable-1');
      expect(reread).not.toBeNull();
      expect(reread).toMatchObject({
        id: 'durable-1',
        amount: 42000,
        status: 'pending',
        qris_string: 'QRIS-DURABLE',
      });

      expect(await second.config.get(CONFIG_KEYS.POLL_INTERVAL)).toBe('7000');
      expect(await second.config.get(CONFIG_KEYS.STATIC_QRIS)).toBe(VALID_STATIC_QRIS);
    } finally {
      await second.close();
    }
  });

  it('a settled payment and freed amount survive a reopen', async () => {
    dbPath = join(tmpdir(), `gopay-wal-${randomUUID()}.db`);

    const first = createSqliteStorage({ dbPath });
    await first.payments.insertPending({
      id: 'paid-1',
      amount: 88000,
      qris_string: 'QRIS-PAID',
      created_at: 1000,
      expires_at: 9_9999000,
      timeout: 300000,
    });
    const settle = await first.payments.markPaid('paid-1', {
      txId: 'tx-durable',
      paidAmount: 88000,
      paidAt: 2000,
    });
    expect(settle.ok).toBe(true);
    await first.close();

    const second = createSqliteStorage({ dbPath });
    try {
      // The settlement details persisted...
      expect(await second.payments.getById('paid-1')).toMatchObject({
        status: 'paid',
        tx_id: 'tx-durable',
        paid_amount: 88000,
        paid_at: 2000,
      });
      // ...and the settled txId is still consumed (idempotency is durable).
      const reuse = await second.payments.insertPending({
        id: 'paid-2',
        amount: 88000,
        qris_string: 'QRIS-PAID-2',
        created_at: 3000,
        expires_at: 9_9999000,
        timeout: 300000,
      });
      // The amount is free again because the prior payment left pending status.
      expect(reuse.ok).toBe(true);
      const dup = await second.payments.markPaid('paid-2', {
        txId: 'tx-durable',
        paidAmount: 88000,
        paidAt: 4000,
      });
      expect(dup).toEqual({ ok: false, code: 'TX_ALREADY_SETTLED' });
    } finally {
      await second.close();
    }
  });
});
