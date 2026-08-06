// Tests for the SQLite Storage implementation (sqlite-storage.js).
//
// These exercise the storage surface against an in-memory database: pending
// inserts and amount-uniqueness mapping, reads, active listing/pagination,
// atomic settlement with txId idempotency, lazy/overdue expiry, the active
// count, the config key/value store, and the ping/close lifecycle. Every
// storage method is awaitable, so every test awaits it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { findStorageContractViolations } from '../dal/storage-interface.js';

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

describe('createSqliteStorage', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;

  beforeEach(() => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('satisfies the Storage contract', () => {
    expect(findStorageContractViolations(storage)).toEqual([]);
  });

  describe('payments.insertPending', () => {
    it('inserts a pending payment and returns it with defaults applied', async () => {
      const result = await storage.payments.insertPending(pending());
      expect(result.ok).toBe(true);
      expect(result.value).toMatchObject({
        id: 'p1',
        amount: 10000,
        status: 'pending',
        qris_string: 'QRIS-PAYLOAD',
        qris_url: null,
        tolerance: 0,
        webhook_url: null,
        tx_id: null,
        paid_amount: null,
        paid_at: null,
      });
    });

    it('maps a duplicate pending amount to AMOUNT_IN_USE and stores no row', async () => {
      expect((await storage.payments.insertPending(pending({ id: 'p1', amount: 5000 }))).ok).toBe(true);

      const dup = await storage.payments.insertPending(pending({ id: 'p2', amount: 5000 }));
      expect(dup).toEqual({ ok: false, code: 'AMOUNT_IN_USE' });
      // No partial row for the failed insert.
      expect(await storage.payments.getById('p2')).toBeNull();
    });

    it('allows reusing an amount once the prior payment leaves pending', async () => {
      await storage.payments.insertPending(pending({ id: 'p1', amount: 7000 }));
      await storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 7000, paidAt: 1500 });

      // The amount is now free again.
      const reuse = await storage.payments.insertPending(pending({ id: 'p2', amount: 7000 }));
      expect(reuse.ok).toBe(true);
    });

    it('propagates non-uniqueness errors (e.g. CHECK violations)', async () => {
      await expect(storage.payments.insertPending(pending({ amount: -1 }))).rejects.toThrow();
    });
  });

  describe('payments.getById', () => {
    it('returns null for a missing payment', async () => {
      expect(await storage.payments.getById('nope')).toBeNull();
    });
  });

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

    it('clamps an out-of-range limit to the 1..100 window', async () => {
      expect((await storage.payments.listActive({ limit: 0 })).length).toBe(3);
      expect((await storage.payments.listActive({ limit: 9999 })).length).toBe(3);
    });
  });

  describe('payments.markPaid', () => {
    beforeEach(async () => {
      await storage.payments.insertPending(pending({ id: 'p1', amount: 12345 }));
    });

    it('settles a pending payment atomically', async () => {
      const res = await storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 12345, paidAt: 1800 });
      expect(res.ok).toBe(true);
      expect(res.value).toMatchObject({
        id: 'p1',
        status: 'paid',
        tx_id: 'tx-1',
        paid_amount: 12345,
        paid_at: 1800,
      });
    });

    it('stores and returns the raw transaction string in tx_raw', async () => {
      const raw = '{"transaction_id":"tx-1","transaction_status":"settlement"}';
      const res = await storage.payments.markPaid('p1', {
        txId: 'tx-1',
        paidAmount: 12345,
        paidAt: 1800,
        raw,
      });
      expect(res.ok).toBe(true);
      expect(res.value.tx_raw).toBe(raw);
      // Re-reading the row returns the persisted tx_raw verbatim.
      expect((await storage.payments.getById('p1')).tx_raw).toBe(raw);
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
      // Rolled back: p2 is still pending.
      expect((await storage.payments.getById('p2')).status).toBe('pending');
    });

    it('rejects settling a missing or non-pending payment without recording the tx', async () => {
      const missing = await storage.payments.markPaid('ghost', { txId: 'tx-x', paidAmount: 1, paidAt: 1 });
      expect(missing).toEqual({ ok: false, code: 'PAYMENT_NOT_PENDING' });

      // The aborted settlement must not have consumed the txId.
      await storage.payments.insertPending(pending({ id: 'p3', amount: 33333 }));
      const reuse = await storage.payments.markPaid('p3', { txId: 'tx-x', paidAmount: 33333, paidAt: 2 });
      expect(reuse.ok).toBe(true);
    });
  });

  describe('payments.expireOverdue', () => {
    it('expires only pending payments past the given time and returns the count', async () => {
      await storage.payments.insertPending(pending({ id: 'old', amount: 50001, expires_at: 1000 }));
      await storage.payments.insertPending(pending({ id: 'fresh', amount: 50002, expires_at: 5000 }));

      const expired = await storage.payments.expireOverdue(2000);
      expect(expired).toBe(1);
      expect((await storage.payments.getById('old')).status).toBe('expired');
      expect((await storage.payments.getById('fresh')).status).toBe('pending');
    });

    it('does not expire a payment exactly at expires_at', async () => {
      await storage.payments.insertPending(pending({ id: 'edge', amount: 50001, expires_at: 2000 }));
      expect(await storage.payments.expireOverdue(2000)).toBe(0);
      expect((await storage.payments.getById('edge')).status).toBe('pending');
    });

    it('expireOverdueReturning returns the rows transitioned by THIS call only', async () => {
      await storage.payments.insertPending(pending({ id: 'old', amount: 50001, expires_at: 1000 }));
      const first = await storage.payments.expireOverdueReturning(2000);
      expect(first.map((p) => p.id)).toEqual(['old']);
      // A second call wins no transitions (the rows are already expired).
      const second = await storage.payments.expireOverdueReturning(2000);
      expect(second).toEqual([]);
    });
  });

  describe('payments.listHistory', () => {
    it('returns only paid/expired payments, most recent first', async () => {
      // pending payment must be excluded
      await storage.payments.insertPending(pending({ id: 'pend', amount: 50001, expires_at: 9_000_000 }));

      // paid payment (settled latest)
      await storage.payments.insertPending(pending({ id: 'paid', amount: 50002, created_at: 1000 }));
      await storage.payments.markPaid('paid', { txId: 'tx-paid', paidAmount: 2, paidAt: 8000 });

      // expired payment (created earliest)
      await storage.payments.insertPending(pending({ id: 'exp', amount: 50003, created_at: 500, expires_at: 600 }));
      await storage.payments.expireOverdue(700);

      const ids = (await storage.payments.listHistory()).map((p) => p.id);
      // 'paid' (paid_at 8000) before 'exp' (created_at 500); 'pend' excluded.
      expect(ids).toEqual(['paid', 'exp']);
    });

    it('honors limit and offset with a default page size of 50', async () => {
      for (let i = 0; i < 3; i += 1) {
        await storage.payments.insertPending(pending({ id: `e${i}`, amount: 50100 + i, created_at: 1000 + i, expires_at: 1500 + i }));
      }
      await storage.payments.expireOverdue(9_999_999);

      expect((await storage.payments.listHistory({ limit: 2 })).length).toBe(2);
      expect((await storage.payments.listHistory({ limit: 2, offset: 2 })).length).toBe(1);
    });

    it('returns an empty list when there is no history', async () => {
      expect(await storage.payments.listHistory()).toEqual([]);
    });
  });

  describe('payments.listAll', () => {
    beforeEach(async () => {
      // Three payments with distinct created_at; one paid, one expired, one pending.
      await storage.payments.insertPending(pending({ id: 'p-old', amount: 50100, created_at: 1000, expires_at: 1100 }));
      await storage.payments.insertPending(pending({ id: 'p-mid', amount: 50200, created_at: 2000, expires_at: 9_000_000 }));
      await storage.payments.insertPending(pending({ id: 'p-new', amount: 50300, created_at: 3000, expires_at: 9_000_000 }));

      await storage.payments.markPaid('p-new', { txId: 'tx-new', paidAmount: 300, paidAt: 3500 });
      await storage.payments.expireOverdue(1500); // expires p-old (expires_at 1100 < 1500)
      // p-mid remains pending.
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

    it('returns all statuses when status is omitted or falsy', async () => {
      expect((await storage.payments.listAll({ status: null })).length).toBe(3);
      expect((await storage.payments.listAll({})).length).toBe(3);
    });

    it('honors limit and offset with a default page size of 50', async () => {
      expect((await storage.payments.listAll({ limit: 2 })).map((p) => p.id)).toEqual(['p-new', 'p-mid']);
      expect((await storage.payments.listAll({ limit: 2, offset: 2 })).map((p) => p.id)).toEqual(['p-old']);
    });

    it('clamps an out-of-range limit to the 1..100 window', async () => {
      expect((await storage.payments.listAll({ limit: 0 })).length).toBe(3);
      expect((await storage.payments.listAll({ limit: 9999 })).length).toBe(3);
    });
  });

  describe('payments.countAll', () => {
    beforeEach(async () => {
      await storage.payments.insertPending(pending({ id: 'c1', amount: 50100, created_at: 1000, expires_at: 1100 }));
      await storage.payments.insertPending(pending({ id: 'c2', amount: 50200, created_at: 2000, expires_at: 9_000_000 }));
      await storage.payments.insertPending(pending({ id: 'c3', amount: 50300, created_at: 3000, expires_at: 9_000_000 }));
      await storage.payments.markPaid('c3', { txId: 'tx-c3', paidAmount: 300, paidAt: 3500 });
      await storage.payments.expireOverdue(1500); // expires c1
    });

    it('counts all payments when status is omitted', async () => {
      expect(await storage.payments.countAll()).toBe(3);
      expect(await storage.payments.countAll({})).toBe(3);
    });

    it('counts only the requested status', async () => {
      expect(await storage.payments.countAll({ status: 'paid' })).toBe(1);
      expect(await storage.payments.countAll({ status: 'expired' })).toBe(1);
      expect(await storage.payments.countAll({ status: 'pending' })).toBe(1);
    });
  });

  describe('payments.countActive', () => {
    it('counts pending payments only', async () => {
      expect(await storage.payments.countActive()).toBe(0);
      await storage.payments.insertPending(pending({ id: 'p1', amount: 50001 }));
      await storage.payments.insertPending(pending({ id: 'p2', amount: 50002 }));
      expect(await storage.payments.countActive()).toBe(2);

      await storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 1, paidAt: 1 });
      expect(await storage.payments.countActive()).toBe(1);
    });
  });

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

  describe('apiKeys', () => {
    /**
     * Insert an active API key directly via the DAL with sensible defaults.
     *
     * @param {Partial<import('../dal/storage-interface.js').ApiKeyCreateInput>} [over]
     * @returns {Promise<import('../dal/storage-interface.js').Result<import('../dal/storage-interface.js').ApiKeyRecord>>}
     */
    function createKey(over = {}) {
      return storage.apiKeys.create({
        id: 'k1',
        keyHash: 'hash-1',
        keyPrefix: 'gpk_aaaa',
        createdAt: 1000,
        ...over,
      });
    }

    describe('create', () => {
      it('inserts an active key storing only hash and prefix', async () => {
        const res = await createKey();
        expect(res.ok).toBe(true);
        expect(res.value).toMatchObject({
          id: 'k1',
          key_hash: 'hash-1',
          key_prefix: 'gpk_aaaa',
          status: 'active',
          created_at: 1000,
          revoked_at: null,
        });
      });

      it('maps a duplicate key_hash to KEY_HASH_IN_USE', async () => {
        expect((await createKey({ id: 'k1', keyHash: 'dup' })).ok).toBe(true);
        const dup = await createKey({ id: 'k2', keyHash: 'dup' });
        expect(dup).toEqual({ ok: false, code: 'KEY_HASH_IN_USE' });
      });
    });

    describe('getActiveByHash', () => {
      it('returns the active key matching the hash', async () => {
        await createKey({ id: 'k1', keyHash: 'hash-x' });
        expect(await storage.apiKeys.getActiveByHash('hash-x')).toMatchObject({
          id: 'k1',
          status: 'active',
        });
      });

      it('returns null for an unknown hash', async () => {
        expect(await storage.apiKeys.getActiveByHash('nope')).toBeNull();
      });

      it('returns null once the key is revoked', async () => {
        await createKey({ id: 'k1', keyHash: 'hash-r' });
        await storage.apiKeys.revoke('k1', 2000);
        expect(await storage.apiKeys.getActiveByHash('hash-r')).toBeNull();
      });
    });

    describe('revoke', () => {
      it('revokes an active key and records revoked_at', async () => {
        await createKey({ id: 'k1' });
        const res = await storage.apiKeys.revoke('k1', 2500);
        expect(res.ok).toBe(true);
        expect(res.value).toMatchObject({ id: 'k1', status: 'revoked', revoked_at: 2500 });
      });

      it('rejects a non-existent key without changing any key', async () => {
        await createKey({ id: 'k1' });
        const res = await storage.apiKeys.revoke('ghost', 2500);
        expect(res).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });
        expect(await storage.apiKeys.getActiveByHash('hash-1')).toMatchObject({ status: 'active' });
      });

      it('rejects an already-revoked key without changing it', async () => {
        await createKey({ id: 'k1' });
        await storage.apiKeys.revoke('k1', 2500);
        const again = await storage.apiKeys.revoke('k1', 9999);
        expect(again).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });
        // revoked_at preserved from the first revocation.
        expect((await storage.apiKeys.listMasked())[0]).toMatchObject({ revoked_at: 2500 });
      });
    });

    describe('listMasked', () => {
      it('returns masked rows with no hash or full value, newest first', async () => {
        await createKey({ id: 'k1', keyHash: 'h1', keyPrefix: 'gpk_one', createdAt: 1000 });
        await createKey({ id: 'k2', keyHash: 'h2', keyPrefix: 'gpk_two', createdAt: 2000 });

        const masked = await storage.apiKeys.listMasked();
        expect(masked.map((k) => k.id)).toEqual(['k2', 'k1']);
        for (const row of masked) {
          expect(row).not.toHaveProperty('key_hash');
          expect(Object.keys(row).sort()).toEqual(
            ['created_at', 'id', 'key_prefix', 'revoked_at', 'status'].sort(),
          );
        }
      });
    });
  });

  describe('webhookLogs', () => {
    /**
     * Build a webhook delivery-log entry with sensible defaults.
     *
     * @param {Partial<import('../dal/storage-interface.js').WebhookLogEntry>} [over]
     * @returns {import('../dal/storage-interface.js').WebhookLogEntry}
     */
    function logEntry(over = {}) {
      return {
        id: 'log-1',
        payment_id: 'pay-1',
        target_url: 'https://example.com/hook',
        status: 'failed',
        attempts: 1,
        last_attempt_at: 1000,
        last_error: 'connection refused',
        ...over,
      };
    }

    describe('append', () => {
      it('records a delivery attempt result', async () => {
        expect(await storage.webhookLogs.append(logEntry())).toEqual({ ok: true });
      });

      it('coerces a missing last_error to null', async () => {
        const entry = logEntry({ id: 'log-2', status: 'success' });
        delete entry.last_error;
        expect(await storage.webhookLogs.append(entry)).toEqual({ ok: true });
      });

      it('accepts multiple rows for the same payment (one per attempt)', async () => {
        expect((await storage.webhookLogs.append(logEntry({ id: 'a1', attempts: 1 }))).ok).toBe(true);
        expect((await storage.webhookLogs.append(logEntry({ id: 'a2', attempts: 2 }))).ok).toBe(true);
      });

      it('rejects a duplicate primary key', async () => {
        await storage.webhookLogs.append(logEntry({ id: 'dup' }));
        await expect(storage.webhookLogs.append(logEntry({ id: 'dup' }))).rejects.toThrow();
      });
    });

    describe('markPermanentFailure', () => {
      it('flips an existing row to failed_permanent', async () => {
        await storage.webhookLogs.append(logEntry({ id: 'log-x', status: 'failed' }));
        expect(await storage.webhookLogs.markPermanentFailure('log-x')).toEqual({ ok: true });
      });

      it('returns LOG_NOT_FOUND for a missing row', async () => {
        expect(await storage.webhookLogs.markPermanentFailure('ghost')).toEqual({
          ok: false,
          code: 'LOG_NOT_FOUND',
        });
      });
    });

    describe('listByPayment', () => {
      it('returns every row for a payment, oldest first', async () => {
        await storage.webhookLogs.append(logEntry({ id: 'w1', payment_id: 'pay-A', attempts: 1 }));
        await storage.webhookLogs.append(logEntry({ id: 'w2', payment_id: 'pay-A', attempts: 2 }));
        await storage.webhookLogs.append(logEntry({ id: 'w3', payment_id: 'pay-B', attempts: 1 }));

        const rowsA = await storage.webhookLogs.listByPayment('pay-A');
        expect(rowsA.map((r) => r.id)).toEqual(['w1', 'w2']);
        const rowsB = await storage.webhookLogs.listByPayment('pay-B');
        expect(rowsB.map((r) => r.id)).toEqual(['w3']);
      });

      it('returns an empty list for a payment with no logs', async () => {
        expect(await storage.webhookLogs.listByPayment('none')).toEqual([]);
      });

      it('round-trips the response_status, response_body, and request_body columns', async () => {
        await storage.webhookLogs.append(
          logEntry({
            id: 'wr',
            payment_id: 'pay-R',
            status: 'success',
            last_error: null,
            response_status: 201,
            response_body: 'created body',
            request_body: '{"payment_id":"pay-R"}',
          }),
        );

        const [row] = await storage.webhookLogs.listByPayment('pay-R');
        expect(row).toMatchObject({
          id: 'wr',
          response_status: 201,
          response_body: 'created body',
          request_body: '{"payment_id":"pay-R"}',
        });
      });

      it('defaults the new columns to null when not provided', async () => {
        await storage.webhookLogs.append(logEntry({ id: 'wn', payment_id: 'pay-N' }));
        const [row] = await storage.webhookLogs.listByPayment('pay-N');
        expect(row.response_status).toBeNull();
        expect(row.response_body).toBeNull();
        expect(row.request_body).toBeNull();
      });
    });

    describe('pruneOld', () => {
      it('deletes rows older than the cutoff and returns the count', async () => {
        await storage.webhookLogs.append(logEntry({ id: 'old', payment_id: 'pay-X', last_attempt_at: 1000 }));
        await storage.webhookLogs.append(logEntry({ id: 'new', payment_id: 'pay-X', last_attempt_at: 5000 }));

        const removed = await storage.webhookLogs.pruneOld(4000);
        expect(removed).toBe(1);
        const remaining = await storage.webhookLogs.listByPayment('pay-X');
        expect(remaining.map((r) => r.id)).toEqual(['new']);
      });
    });
  });

  describe('adminUsers.ensure', () => {
    it('creates a missing admin and reports created:true', async () => {
      const res = await storage.adminUsers.ensure({
        id: 'a1',
        username: 'admin',
        passwordHash: 'scrypt$hash',
      });
      expect(res).toEqual({ ok: true, value: { created: true } });
      expect((await storage.adminUsers.getByUsername('admin')).password_hash).toBe('scrypt$hash');
    });

    it('does NOT overwrite an existing password and reports created:false', async () => {
      await storage.adminUsers.ensure({ id: 'a1', username: 'admin', passwordHash: 'first' });
      const second = await storage.adminUsers.ensure({
        id: 'a2',
        username: 'admin',
        passwordHash: 'second',
      });
      expect(second).toEqual({ ok: true, value: { created: false } });
      // The stored hash is the ORIGINAL, not the second one.
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
      // The old username is gone.
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

  describe('loginAttempts.recordFailure (atomic policy)', () => {
    it('applies the fixed-window policy and persists the new state', async () => {
      const res = await storage.loginAttempts.recordFailure('1.2.3.4', {
        now: 1000,
        windowMs: 15 * 60 * 1000,
        threshold: 5,
        lockoutMs: 15 * 60 * 1000,
      });
      expect(res.ok).toBe(true);
      expect(res.value).toEqual({ failedAttempts: 1, lockoutUntil: 1000 + 15 * 60 * 1000 });

      // The state is persisted and readable through getByIp.
      const stored = await storage.loginAttempts.getByIp('1.2.3.4');
      expect(stored.failedAttempts).toBe(1);
    });

    it('escalates to a hard lockout once the threshold is reached', async () => {
      const policy = {
        now: 0,
        windowMs: 15 * 60 * 1000,
        threshold: 5,
        lockoutMs: 15 * 60 * 1000,
      };
      for (let i = 0; i < 5; i += 1) {
        policy.now = 1000 + i * 1000;
        // eslint-disable-next-line no-await-in-loop
        await storage.loginAttempts.recordFailure('1.2.3.5', policy);
      }
      const stored = await storage.loginAttempts.getByIp('1.2.3.5');
      expect(stored.failedAttempts).toBe(5);
      expect(stored.lockoutUntil).toBeGreaterThan(0);
      // isLockedOut is true before the lockout window elapses.
      expect(await storage.loginAttempts.isLockedOut('1.2.3.5', 2000)).toBe(true);
    });

    it('clearAll wipes every IP and returns the removed count', async () => {
      await storage.loginAttempts.recordFailure('1.1.1.1', {
        now: 1000,
        windowMs: 15 * 60 * 1000,
        threshold: 5,
        lockoutMs: 15 * 60 * 1000,
      });
      await storage.loginAttempts.recordFailure('2.2.2.2', {
        now: 1000,
        windowMs: 15 * 60 * 1000,
        threshold: 5,
        lockoutMs: 15 * 60 * 1000,
      });
      const removed = await storage.loginAttempts.clearAll();
      expect(removed).toBe(2);
      expect(await storage.loginAttempts.getByIp('1.1.1.1')).toBeNull();
      expect(await storage.loginAttempts.getByIp('2.2.2.2')).toBeNull();
    });
  });

  describe('ping / close', () => {
    it('ping resolves while the database is open', async () => {
      await expect(storage.ping()).resolves.toBeUndefined();
    });

    it('close is idempotent and ping rejects after close', async () => {
      await storage.close();
      await expect(storage.close()).resolves.toBeUndefined();
      await expect(storage.ping()).rejects.toThrow();
    });
  });
});
