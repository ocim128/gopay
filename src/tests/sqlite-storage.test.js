// Tests for the SQLite Storage implementation (sqlite-storage.js).
//
// These exercise the storage surface against an in-memory database: pending
// inserts and amount-uniqueness mapping, reads, active listing/pagination,
// atomic settlement with txId idempotency, lazy/overdue expiry, the active
// count, the config key/value store, and the atomic tx(fn) helper.

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

  afterEach(() => {
    storage.close();
  });

  it('satisfies the Storage contract', () => {
    expect(findStorageContractViolations(storage)).toEqual([]);
  });

  describe('payments.insertPending', () => {
    it('inserts a pending payment and returns it with defaults applied', () => {
      const result = storage.payments.insertPending(pending());
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

    it('maps a duplicate pending amount to AMOUNT_IN_USE and stores no row', () => {
      expect(storage.payments.insertPending(pending({ id: 'p1', amount: 5000 })).ok).toBe(true);

      const dup = storage.payments.insertPending(pending({ id: 'p2', amount: 5000 }));
      expect(dup).toEqual({ ok: false, code: 'AMOUNT_IN_USE' });
      // No partial row for the failed insert.
      expect(storage.payments.getById('p2')).toBeNull();
    });

    it('allows reusing an amount once the prior payment leaves pending', () => {
      storage.payments.insertPending(pending({ id: 'p1', amount: 7000 }));
      storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 7000, paidAt: 1500 });

      // The amount is now free again.
      const reuse = storage.payments.insertPending(pending({ id: 'p2', amount: 7000 }));
      expect(reuse.ok).toBe(true);
    });

    it('propagates non-uniqueness errors (e.g. CHECK violations)', () => {
      expect(() => storage.payments.insertPending(pending({ amount: -1 }))).toThrow();
    });
  });

  describe('payments.getById', () => {
    it('returns null for a missing payment', () => {
      expect(storage.payments.getById('nope')).toBeNull();
    });
  });

  describe('payments.listActive', () => {
    beforeEach(() => {
      storage.payments.insertPending(pending({ id: 'a', amount: 50100, expires_at: 3000 }));
      storage.payments.insertPending(pending({ id: 'b', amount: 50200, expires_at: 1000 }));
      storage.payments.insertPending(pending({ id: 'c', amount: 50300, expires_at: 2000 }));
    });

    it('returns only pending payments ordered by expires_at ascending', () => {
      const ids = storage.payments.listActive().map((p) => p.id);
      expect(ids).toEqual(['b', 'c', 'a']);
    });

    it('excludes settled payments', () => {
      storage.payments.markPaid('b', { txId: 'tx-b', paidAmount: 200, paidAt: 1500 });
      const ids = storage.payments.listActive().map((p) => p.id);
      expect(ids).toEqual(['c', 'a']);
    });

    it('honors limit and offset', () => {
      expect(storage.payments.listActive({ limit: 1 }).map((p) => p.id)).toEqual(['b']);
      expect(storage.payments.listActive({ limit: 1, offset: 1 }).map((p) => p.id)).toEqual(['c']);
    });

    it('clamps an out-of-range limit to the 1..100 window', () => {
      expect(storage.payments.listActive({ limit: 0 }).length).toBe(3);
      expect(storage.payments.listActive({ limit: 9999 }).length).toBe(3);
    });
  });

  describe('payments.markPaid', () => {
    beforeEach(() => {
      storage.payments.insertPending(pending({ id: 'p1', amount: 12345 }));
    });

    it('settles a pending payment atomically', () => {
      const res = storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 12345, paidAt: 1800 });
      expect(res.ok).toBe(true);
      expect(res.value).toMatchObject({
        id: 'p1',
        status: 'paid',
        tx_id: 'tx-1',
        paid_amount: 12345,
        paid_at: 1800,
      });
    });

    it('stores and returns the raw transaction string in tx_raw', () => {
      const raw = '{"transaction_id":"tx-1","transaction_status":"settlement"}';
      const res = storage.payments.markPaid('p1', {
        txId: 'tx-1',
        paidAmount: 12345,
        paidAt: 1800,
        raw,
      });
      expect(res.ok).toBe(true);
      expect(res.value.tx_raw).toBe(raw);
      // Re-reading the row returns the persisted tx_raw verbatim.
      expect(storage.payments.getById('p1').tx_raw).toBe(raw);
    });

    it('defaults tx_raw to null when no raw is supplied', () => {
      const res = storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 12345, paidAt: 1800 });
      expect(res.ok).toBe(true);
      expect(res.value.tx_raw).toBeNull();
    });

    it('rejects a re-used txId with TX_ALREADY_SETTLED and leaves the second payment pending', () => {
      storage.payments.insertPending(pending({ id: 'p2', amount: 22222 }));
      storage.payments.markPaid('p1', { txId: 'tx-dup', paidAmount: 12345, paidAt: 1800 });

      const second = storage.payments.markPaid('p2', { txId: 'tx-dup', paidAmount: 22222, paidAt: 1900 });
      expect(second).toEqual({ ok: false, code: 'TX_ALREADY_SETTLED' });
      // Rolled back: p2 is still pending.
      expect(storage.payments.getById('p2').status).toBe('pending');
    });

    it('rejects settling a missing or non-pending payment without recording the tx', () => {
      const missing = storage.payments.markPaid('ghost', { txId: 'tx-x', paidAmount: 1, paidAt: 1 });
      expect(missing).toEqual({ ok: false, code: 'PAYMENT_NOT_PENDING' });

      // The aborted settlement must not have consumed the txId.
      storage.payments.insertPending(pending({ id: 'p3', amount: 33333 }));
      const reuse = storage.payments.markPaid('p3', { txId: 'tx-x', paidAmount: 33333, paidAt: 2 });
      expect(reuse.ok).toBe(true);
    });
  });

  describe('payments.expireOverdue', () => {
    it('expires only pending payments past the given time and returns the count', () => {
      storage.payments.insertPending(pending({ id: 'old', amount: 50001, expires_at: 1000 }));
      storage.payments.insertPending(pending({ id: 'fresh', amount: 50002, expires_at: 5000 }));

      const expired = storage.payments.expireOverdue(2000);
      expect(expired).toBe(1);
      expect(storage.payments.getById('old').status).toBe('expired');
      expect(storage.payments.getById('fresh').status).toBe('pending');
    });

    it('does not expire a payment exactly at expires_at', () => {
      storage.payments.insertPending(pending({ id: 'edge', amount: 50001, expires_at: 2000 }));
      expect(storage.payments.expireOverdue(2000)).toBe(0);
      expect(storage.payments.getById('edge').status).toBe('pending');
    });
  });

  describe('payments.listHistory', () => {
    it('returns only paid/expired payments, most recent first', () => {
      // pending payment must be excluded
      storage.payments.insertPending(pending({ id: 'pend', amount: 50001, expires_at: 9_000_000 }));

      // paid payment (settled latest)
      storage.payments.insertPending(pending({ id: 'paid', amount: 50002, created_at: 1000 }));
      storage.payments.markPaid('paid', { txId: 'tx-paid', paidAmount: 2, paidAt: 8000 });

      // expired payment (created earliest)
      storage.payments.insertPending(pending({ id: 'exp', amount: 50003, created_at: 500, expires_at: 600 }));
      storage.payments.expireOverdue(700);

      const ids = storage.payments.listHistory().map((p) => p.id);
      // 'paid' (paid_at 8000) before 'exp' (created_at 500); 'pend' excluded.
      expect(ids).toEqual(['paid', 'exp']);
    });

    it('honors limit and offset with a default page size of 50', () => {
      for (let i = 0; i < 3; i += 1) {
        storage.payments.insertPending(pending({ id: `e${i}`, amount: 50100 + i, created_at: 1000 + i, expires_at: 1500 + i }));
      }
      storage.payments.expireOverdue(9_999_999);

      expect(storage.payments.listHistory({ limit: 2 }).length).toBe(2);
      expect(storage.payments.listHistory({ limit: 2, offset: 2 }).length).toBe(1);
    });

    it('returns an empty list when there is no history', () => {
      expect(storage.payments.listHistory()).toEqual([]);
    });
  });

  describe('payments.listAll', () => {
    beforeEach(() => {
      // Three payments with distinct created_at; one paid, one expired, one pending.
      storage.payments.insertPending(pending({ id: 'p-old', amount: 50100, created_at: 1000, expires_at: 1100 }));
      storage.payments.insertPending(pending({ id: 'p-mid', amount: 50200, created_at: 2000, expires_at: 9_000_000 }));
      storage.payments.insertPending(pending({ id: 'p-new', amount: 50300, created_at: 3000, expires_at: 9_000_000 }));

      storage.payments.markPaid('p-new', { txId: 'tx-new', paidAmount: 300, paidAt: 3500 });
      storage.payments.expireOverdue(1500); // expires p-old (expires_at 1100 < 1500)
      // p-mid remains pending.
    });

    it('returns all statuses ordered by created_at DESC, id DESC', () => {
      const ids = storage.payments.listAll().map((p) => p.id);
      expect(ids).toEqual(['p-new', 'p-mid', 'p-old']);
    });

    it('filters by a single status', () => {
      expect(storage.payments.listAll({ status: 'paid' }).map((p) => p.id)).toEqual(['p-new']);
      expect(storage.payments.listAll({ status: 'expired' }).map((p) => p.id)).toEqual(['p-old']);
      expect(storage.payments.listAll({ status: 'pending' }).map((p) => p.id)).toEqual(['p-mid']);
    });

    it('returns all statuses when status is omitted or falsy', () => {
      expect(storage.payments.listAll({ status: null }).length).toBe(3);
      expect(storage.payments.listAll({}).length).toBe(3);
    });

    it('honors limit and offset with a default page size of 50', () => {
      expect(storage.payments.listAll({ limit: 2 }).map((p) => p.id)).toEqual(['p-new', 'p-mid']);
      expect(storage.payments.listAll({ limit: 2, offset: 2 }).map((p) => p.id)).toEqual(['p-old']);
    });

    it('clamps an out-of-range limit to the 1..100 window', () => {
      expect(storage.payments.listAll({ limit: 0 }).length).toBe(3);
      expect(storage.payments.listAll({ limit: 9999 }).length).toBe(3);
    });
  });

  describe('payments.countAll', () => {
    beforeEach(() => {
      storage.payments.insertPending(pending({ id: 'c1', amount: 50100, created_at: 1000, expires_at: 1100 }));
      storage.payments.insertPending(pending({ id: 'c2', amount: 50200, created_at: 2000, expires_at: 9_000_000 }));
      storage.payments.insertPending(pending({ id: 'c3', amount: 50300, created_at: 3000, expires_at: 9_000_000 }));
      storage.payments.markPaid('c3', { txId: 'tx-c3', paidAmount: 300, paidAt: 3500 });
      storage.payments.expireOverdue(1500); // expires c1
    });

    it('counts all payments when status is omitted', () => {
      expect(storage.payments.countAll()).toBe(3);
      expect(storage.payments.countAll({})).toBe(3);
    });

    it('counts only the requested status', () => {
      expect(storage.payments.countAll({ status: 'paid' })).toBe(1);
      expect(storage.payments.countAll({ status: 'expired' })).toBe(1);
      expect(storage.payments.countAll({ status: 'pending' })).toBe(1);
    });
  });

  describe('payments.countActive', () => {    it('counts pending payments only', () => {
      expect(storage.payments.countActive()).toBe(0);
      storage.payments.insertPending(pending({ id: 'p1', amount: 50001 }));
      storage.payments.insertPending(pending({ id: 'p2', amount: 50002 }));
      expect(storage.payments.countActive()).toBe(2);

      storage.payments.markPaid('p1', { txId: 'tx-1', paidAmount: 1, paidAt: 1 });
      expect(storage.payments.countActive()).toBe(1);
    });
  });

  describe('config', () => {
    it('returns null for an unset key', () => {
      expect(storage.config.get('poll_interval')).toBeNull();
    });

    it('persists and overwrites values', () => {
      expect(storage.config.set('poll_interval', '3000')).toEqual({ ok: true });
      expect(storage.config.get('poll_interval')).toBe('3000');

      storage.config.set('poll_interval', '5000');
      expect(storage.config.get('poll_interval')).toBe('5000');
    });
  });

  describe('apiKeys', () => {
    /**
     * Insert an active API key directly via the DAL with sensible defaults.
     *
     * @param {Partial<import('../dal/storage-interface.js').ApiKeyCreateInput>} [over]
     * @returns {import('../dal/storage-interface.js').Result<import('../dal/storage-interface.js').ApiKeyRecord>}
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
      it('inserts an active key storing only hash and prefix', () => {
        const res = createKey();
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

      it('maps a duplicate key_hash to KEY_HASH_IN_USE', () => {
        expect(createKey({ id: 'k1', keyHash: 'dup' }).ok).toBe(true);
        const dup = createKey({ id: 'k2', keyHash: 'dup' });
        expect(dup).toEqual({ ok: false, code: 'KEY_HASH_IN_USE' });
      });
    });

    describe('getActiveByHash', () => {
      it('returns the active key matching the hash', () => {
        createKey({ id: 'k1', keyHash: 'hash-x' });
        expect(storage.apiKeys.getActiveByHash('hash-x')).toMatchObject({
          id: 'k1',
          status: 'active',
        });
      });

      it('returns null for an unknown hash', () => {
        expect(storage.apiKeys.getActiveByHash('nope')).toBeNull();
      });

      it('returns null once the key is revoked', () => {
        createKey({ id: 'k1', keyHash: 'hash-r' });
        storage.apiKeys.revoke('k1', 2000);
        expect(storage.apiKeys.getActiveByHash('hash-r')).toBeNull();
      });
    });

    describe('revoke', () => {
      it('revokes an active key and records revoked_at', () => {
        createKey({ id: 'k1' });
        const res = storage.apiKeys.revoke('k1', 2500);
        expect(res.ok).toBe(true);
        expect(res.value).toMatchObject({ id: 'k1', status: 'revoked', revoked_at: 2500 });
      });

      it('rejects a non-existent key without changing any key', () => {
        createKey({ id: 'k1' });
        const res = storage.apiKeys.revoke('ghost', 2500);
        expect(res).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });
        expect(storage.apiKeys.getActiveByHash('hash-1')).toMatchObject({ status: 'active' });
      });

      it('rejects an already-revoked key without changing it', () => {
        createKey({ id: 'k1' });
        storage.apiKeys.revoke('k1', 2500);
        const again = storage.apiKeys.revoke('k1', 9999);
        expect(again).toEqual({ ok: false, code: 'KEY_NOT_REVOCABLE' });
        // revoked_at preserved from the first revocation.
        expect(storage.apiKeys.listMasked()[0]).toMatchObject({ revoked_at: 2500 });
      });
    });

    describe('listMasked', () => {
      it('returns masked rows with no hash or full value, newest first', () => {
        createKey({ id: 'k1', keyHash: 'h1', keyPrefix: 'gpk_one', createdAt: 1000 });
        createKey({ id: 'k2', keyHash: 'h2', keyPrefix: 'gpk_two', createdAt: 2000 });

        const masked = storage.apiKeys.listMasked();
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
      it('records a delivery attempt result', () => {
        expect(storage.webhookLogs.append(logEntry())).toEqual({ ok: true });
      });

      it('coerces a missing last_error to null', () => {
        const entry = logEntry({ id: 'log-2', status: 'success' });
        delete entry.last_error;
        expect(storage.webhookLogs.append(entry)).toEqual({ ok: true });
      });

      it('accepts multiple rows for the same payment (one per attempt)', () => {
        expect(storage.webhookLogs.append(logEntry({ id: 'a1', attempts: 1 })).ok).toBe(true);
        expect(storage.webhookLogs.append(logEntry({ id: 'a2', attempts: 2 })).ok).toBe(true);
      });

      it('rejects a duplicate primary key', () => {
        storage.webhookLogs.append(logEntry({ id: 'dup' }));
        expect(() => storage.webhookLogs.append(logEntry({ id: 'dup' }))).toThrow();
      });
    });

    describe('markPermanentFailure', () => {
      it('flips an existing row to failed_permanent', () => {
        storage.webhookLogs.append(logEntry({ id: 'log-x', status: 'failed' }));
        expect(storage.webhookLogs.markPermanentFailure('log-x')).toEqual({ ok: true });
      });

      it('returns LOG_NOT_FOUND for a missing row', () => {
        expect(storage.webhookLogs.markPermanentFailure('ghost')).toEqual({
          ok: false,
          code: 'LOG_NOT_FOUND',
        });
      });
    });

    describe('listByPayment', () => {
      it('returns every row for a payment, oldest first', () => {
        storage.webhookLogs.append(logEntry({ id: 'w1', payment_id: 'pay-A', attempts: 1 }));
        storage.webhookLogs.append(logEntry({ id: 'w2', payment_id: 'pay-A', attempts: 2 }));
        storage.webhookLogs.append(logEntry({ id: 'w3', payment_id: 'pay-B', attempts: 1 }));

        const rowsA = storage.webhookLogs.listByPayment('pay-A');
        expect(rowsA.map((r) => r.id)).toEqual(['w1', 'w2']);
        const rowsB = storage.webhookLogs.listByPayment('pay-B');
        expect(rowsB.map((r) => r.id)).toEqual(['w3']);
      });

      it('returns an empty list for a payment with no logs', () => {
        expect(storage.webhookLogs.listByPayment('none')).toEqual([]);
      });

      it('round-trips the response_status, response_body, and request_body columns', () => {
        storage.webhookLogs.append(
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

        const [row] = storage.webhookLogs.listByPayment('pay-R');
        expect(row).toMatchObject({
          id: 'wr',
          response_status: 201,
          response_body: 'created body',
          request_body: '{"payment_id":"pay-R"}',
        });
      });

      it('defaults the new columns to null when not provided', () => {
        storage.webhookLogs.append(logEntry({ id: 'wn', payment_id: 'pay-N' }));
        const [row] = storage.webhookLogs.listByPayment('pay-N');
        expect(row.response_status).toBeNull();
        expect(row.response_body).toBeNull();
        expect(row.request_body).toBeNull();
      });
    });
  });

  describe('tx', () => {
    it('commits all writes when the function succeeds', () => {
      const res = storage.tx(() => {
        storage.config.set('a', '1');
        storage.config.set('b', '2');
        return 'done';
      });
      expect(res).toEqual({ ok: true, value: 'done' });
      expect(storage.config.get('a')).toBe('1');
      expect(storage.config.get('b')).toBe('2');
    });

    it('rolls back every write when the function throws', () => {
      const res = storage.tx(() => {
        storage.config.set('a', '1');
        throw new Error('boom');
      });
      expect(res.ok).toBe(false);
      expect(res.error).toBe('boom');
      expect(storage.config.get('a')).toBeNull();
    });
  });
});
