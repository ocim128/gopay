// Tests for the Payment_Service (payment-service.js).
//
// These exercise create / read (lazy-expire) / listActive against a real
// in-memory DAL (no mocks) plus the real Config Service (for the Static_QRIS).
// Settlement/matching is intentionally out of scope here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfigService } from '../config/runtime-config.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { AmountAllocationError } from '../payment/amount-allocator.js';
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOLERANCE,
  PaymentError,
  createPaymentService,
} from '../payment/payment-service.js';
import { QrisError } from '../payment/qris-builder.js';

// A real, structurally valid Static_QRIS with a correct trailing CRC16.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

describe('createPaymentService', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {ReturnType<typeof createConfigService>} */
  let config;
  /** @type {number} */
  let clock;
  /** @type {number} */
  let idSeq;
  /** @type {number} */
  let pollerStarts;

  /** Build a service with a controllable clock, deterministic ids, and poller hook. */
  function makeService(overrides = {}) {
    return createPaymentService({
      storage,
      config,
      now: () => clock,
      idFactory: () => `pay-${idSeq++}`,
      ensureRunning: () => {
        pollerStarts += 1;
      },
      ...overrides,
    });
  }

  /** Build a canonical payin transaction. */
  function payinTx(txId, amount, extra = {}) {
    return { txId, amount, type: 'payin', time: '2024-01-01T00:00:00.000Z', raw: {}, ...extra };
  }

  beforeEach(async () => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    config = createConfigService(storage);
    await config.setStaticQris(VALID_STATIC_QRIS);
    clock = 1_000_000;
    idSeq = 1;
    pollerStarts = 0;
  });

  afterEach(async () => {
    await storage.close();
  });

  // ---- construction --------------------------------------------------------

  it('requires a storage and a config service', () => {
    expect(() => createPaymentService({ config })).toThrow(/storage/);
    expect(() => createPaymentService({ storage })).toThrow(/config/);
  });

  // ---- createPayment: client-managed --------------------------------------

  describe('createPayment (client-managed)', () => {
    it('creates a pending payment with the supplied amount and a built QRIS', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'client', amount: 12345 });

      expect(payment.id).toBe('pay-1');
      expect(payment.amount).toBe(12345);
      expect(payment.status).toBe('pending');
      expect(typeof payment.qris_string).toBe('string');
      expect(payment.qris_string.length).toBeGreaterThan(0);
      expect(payment.created_at).toBe(clock);
      expect(pollerStarts).toBe(1);
    });

    it('applies the default timeout and tolerance', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'client', amount: 5000 });

      expect(payment.timeout).toBe(DEFAULT_TIMEOUT_MS);
      expect(payment.tolerance).toBe(DEFAULT_TOLERANCE);
    });

    it('honours an explicit timeout and tolerance', async () => {
      const service = makeService();
      const payment = await service.createPayment({
        mode: 'client',
        amount: 5000,
        timeout: 60000,
        tolerance: 50,
      });

      expect(payment.timeout).toBe(60000);
      expect(payment.tolerance).toBe(50);
    });

    it('sets expires_at = created_at + timeout', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'client', amount: 7777, timeout: 45000 });
      expect(payment.expires_at - payment.created_at).toBe(45000);
      expect(payment.expires_at).toBe(clock + 45000);
    });

    it('persists a per-payment webhook_url', async () => {
      const service = makeService();
      const payment = await service.createPayment({
        mode: 'client',
        amount: 8888,
        webhook_url: 'https://example.com/hook',
      });
      expect(payment.webhook_url).toBe('https://example.com/hook');
    });

    it('rejects an invalid amount with INVALID_AMOUNT', async () => {
      const service = makeService();
      await expect(service.createPayment({ mode: 'client', amount: -1 })).rejects.toThrow(
        AmountAllocationError,
      );
      try {
        await service.createPayment({ mode: 'client', amount: -5 });
      } catch (err) {
        expect(err.code).toBe('INVALID_AMOUNT');
      }
    });

    it('rejects a duplicate active amount with AMOUNT_IN_USE', async () => {
      const service = makeService();
      await service.createPayment({ mode: 'client', amount: 4242 });
      await expect(service.createPayment({ mode: 'client', amount: 4242 })).rejects.toThrow(PaymentError);
      try {
        await service.createPayment({ mode: 'client', amount: 4242 });
      } catch (err) {
        expect(err.code).toBe('AMOUNT_IN_USE');
        expect(err.http).toBe(409);
      }
    });

    it('reuses an amount after the previous payment expires', async () => {
      const service = makeService();
      const first = await service.createPayment({ mode: 'client', amount: 9001, timeout: 10000 });
      // Advance past expiry and lazily expire via a read.
      clock = first.expires_at + 1;
      expect((await service.getPayment(first.id)).status).toBe('expired');
      // The amount is now free for a new payment.
      const second = await service.createPayment({ mode: 'client', amount: 9001 });
      expect(second.status).toBe('pending');
      expect(second.amount).toBe(9001);
    });
  });

  // ---- createPayment: server-managed --------------------------------------

  describe('createPayment (server-managed)', () => {
    it('allocates base_amount + 0 when the base slot is free', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'server', base_amount: 10000 });
      expect(payment.amount).toBe(10000);
      expect(payment.status).toBe('pending');
    });

    it('retries with the next suffix when the amount is taken', async () => {
      const service = makeService();
      const first = await service.createPayment({ mode: 'server', base_amount: 10000 });
      const second = await service.createPayment({ mode: 'server', base_amount: 10000 });
      expect(first.amount).toBe(10000);
      expect(second.amount).toBe(10001);
    });

    it('rejects a missing/invalid base_amount with INVALID_BASE_AMOUNT', async () => {
      const service = makeService();
      await expect(service.createPayment({ mode: 'server', base_amount: -1 })).rejects.toThrow(
        AmountAllocationError,
      );
      try {
        await service.createPayment({ mode: 'server' });
      } catch (err) {
        expect(err.code).toBe('INVALID_BASE_AMOUNT');
      }
    });

    it('rejects with NO_AVAILABLE_AMOUNT when all suffix slots are taken', async () => {
      // Use a tiny attempt budget by exhausting a base via the real allocator is
      // expensive; instead verify the surfaced code with a small custom service.
      const service = makeService();
      // Occupy the single reachable slot near the max amount so base+0 collides
      // and base+1 would overflow the max amount, leaving no free slot.
      const base = 9999000;
      await service.createPayment({ mode: 'server', base_amount: base }); // amount == max
      await expect(service.createPayment({ mode: 'server', base_amount: base })).rejects.toThrow(
        AmountAllocationError,
      );
      try {
        await service.createPayment({ mode: 'server', base_amount: base });
      } catch (err) {
        expect(err.code).toBe('NO_AVAILABLE_AMOUNT');
      }
    });
  });

  // ---- createPayment: validation & QRIS ------------------------------------

  it('rejects an invalid mode with INVALID_REQUEST', async () => {
    const service = makeService();
    await expect(service.createPayment({ mode: 'nope', amount: 50100 })).rejects.toThrow(PaymentError);
    try {
      await service.createPayment({ amount: 50100 });
    } catch (err) {
      expect(err.code).toBe('INVALID_REQUEST');
      expect(err.http).toBe(400);
    }
  });

  it('surfaces QRIS_INVALID when the Static_QRIS is absent/malformed', async () => {
    // Fresh storage with no Static_QRIS configured.
    const bareStorage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    const bareConfig = createConfigService(bareStorage);
    const service = createPaymentService({ storage: bareStorage, config: bareConfig });
    try {
      await expect(service.createPayment({ mode: 'client', amount: 50100 })).rejects.toThrow(QrisError);
      try {
        await service.createPayment({ mode: 'client', amount: 50100 });
      } catch (err) {
        expect(err.code).toBe('QRIS_INVALID');
      }
    } finally {
      await bareStorage.close();
    }
  });

  // ---- getPayment: lazy-expire ---------------------------------------------

  describe('getPayment', () => {
    it('returns null for an unknown id (mapping)', async () => {
      const service = makeService();
      expect(await service.getPayment('does-not-exist')).toBeNull();
    });

    it('returns a pending payment unchanged before expiry', async () => {
      const service = makeService();
      const created = await service.createPayment({ mode: 'client', amount: 50100, timeout: 10000 });
      clock = created.expires_at; // exactly at expires_at: not yet passed
      const read = await service.getPayment(created.id);
      expect(read.status).toBe('pending');
    });

    it('lazily expires a pending payment once now passes expires_at', async () => {
      const service = makeService();
      const created = await service.createPayment({ mode: 'client', amount: 50200, timeout: 10000 });
      clock = created.expires_at + 1;
      const read = await service.getPayment(created.id);
      expect(read.status).toBe('expired');
      // The transition is persisted, not just computed.
      expect((await storage.payments.getById(created.id)).status).toBe('expired');
    });
  });

  // ---- listActive ----------------------------------------------------------

  describe('listActive', () => {
    it('returns only pending payments ordered by expires_at ascending', async () => {
      const service = makeService();
      const a = await service.createPayment({ mode: 'client', amount: 50001, timeout: 30000 });
      const b = await service.createPayment({ mode: 'client', amount: 50002, timeout: 10000 });
      const c = await service.createPayment({ mode: 'client', amount: 50003, timeout: 20000 });

      const list = await service.listActive();
      expect(list.map((p) => p.id)).toEqual([b.id, c.id, a.id]);
      expect(list.every((p) => p.status === 'pending')).toBe(true);
    });

    it('excludes payments that have lazily expired', async () => {
      const service = makeService();
      const shortLived = await service.createPayment({ mode: 'client', amount: 50010, timeout: 10000 });
      const longLived = await service.createPayment({ mode: 'client', amount: 50020, timeout: 60000 });

      clock = shortLived.expires_at + 1;
      const list = await service.listActive();
      expect(list.map((p) => p.id)).toEqual([longLived.id]);
    });

    it('returns an empty array when there are no active payments', async () => {
      const service = makeService();
      expect(await service.listActive()).toEqual([]);
    });

    it('honours limit and offset pagination', async () => {
      const service = makeService();
      // amounts chosen so expires_at order == creation order
      await service.createPayment({ mode: 'client', amount: 1001, timeout: 10000 });
      await service.createPayment({ mode: 'client', amount: 1002, timeout: 20000 });
      await service.createPayment({ mode: 'client', amount: 1003, timeout: 30000 });

      const page = await service.listActive({ limit: 1, offset: 1 });
      expect(page).toHaveLength(1);
      expect(page[0].amount).toBe(1002);
    });
  });

  // ---- handleTransactions: matching & settlement ----------------

  describe('handleTransactions', () => {
    it('settles a payin transaction that exactly matches an active payment', async () => {
      const settledEvents = [];
      const service = makeService({
        onSettled: (payment, tx) => {
          settledEvents.push({ paymentId: payment.id, txId: tx.txId });
        },
      });
      const payment = await service.createPayment({ mode: 'client', amount: 12345 });

      clock = 1_100_000; // still within the default 300000ms timeout
      const rawTx = { transaction_id: 'tx-1', transaction_status: 'settlement', gross_amount: 1234500 };
      const settled = await service.handleTransactions([payinTx('tx-1', 12345, { raw: rawTx })]);

      expect(settled.map((p) => p.id)).toEqual([payment.id]);
      const stored = await storage.payments.getById(payment.id);
      expect(stored.status).toBe('paid');
      expect(stored.tx_id).toBe('tx-1');
      expect(stored.paid_amount).toBe(12345);
      expect(stored.paid_at).toBe(1_100_000);
      // The raw GoBiz transaction is persisted as a JSON string for later
      // webhook (re)dispatch.
      expect(stored.tx_raw).toBe(JSON.stringify(rawTx));
      expect(JSON.parse(stored.tx_raw)).toEqual(rawTx);
      // The webhook hook fires exactly once on settlement.
      expect(settledEvents).toEqual([{ paymentId: payment.id, txId: 'tx-1' }]);
    });

    it('does not settle a historical transaction reused after a service restart', async () => {
      const service = makeService();
      clock = Date.parse('2026-08-22T11:52:37.714Z');
      const payment = await service.createPayment({ mode: 'client', amount: 410000 });

      const settled = await service.handleTransactions([
        payinTx('historical-tx', 410000, { time: '2026-08-22T03:55:19.000Z' }),
      ]);

      expect(settled).toEqual([]);
      expect((await storage.payments.getById(payment.id)).status).toBe('pending');
    });

    it('does not settle a transaction without a trustworthy timestamp', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'client', amount: 410001 });

      const settled = await service.handleTransactions([
        payinTx('unknown-time-tx', 410001, { time: null }),
      ]);

      expect(settled).toEqual([]);
      expect((await storage.payments.getById(payment.id)).status).toBe('pending');
    });

    it('matches within tolerance and ignores transactions outside it', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'client', amount: 10000, tolerance: 50 });

      // 49 away -> within tolerance.
      const settled = await service.handleTransactions([payinTx('tx-near', 10049)]);
      expect(settled.map((p) => p.id)).toEqual([payment.id]);
      expect((await storage.payments.getById(payment.id)).status).toBe('paid');
    });

    it('ignores a transaction whose amount is just outside tolerance', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'client', amount: 10000, tolerance: 50 });

      const settled = await service.handleTransactions([payinTx('tx-far', 10051)]);
      expect(settled).toEqual([]);
      expect((await storage.payments.getById(payment.id)).status).toBe('pending');
    });

    it('ignores non-payin transactions', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'client', amount: 7000 });

      const settled = await service.handleTransactions([
        { txId: 'tx-out', amount: 7000, type: 'payout', time: '', raw: {} },
      ]);
      expect(settled).toEqual([]);
      expect((await storage.payments.getById(payment.id)).status).toBe('pending');
    });

    it('settles exactly one payment — the earliest-created — when several match', async () => {
      const service = makeService();
      // tolerance lets all three match a single tx amount; created in this order.
      clock = 1_000_000;
      const first = await service.createPayment({ mode: 'client', amount: 10010, tolerance: 999 });
      clock = 1_000_100;
      await service.createPayment({ mode: 'client', amount: 10020, tolerance: 999 });
      clock = 1_000_200;
      await service.createPayment({ mode: 'client', amount: 10030, tolerance: 999 });

      clock = 1_100_000; // within all three payments' lifetimes
      const settled = await service.handleTransactions([payinTx('tx-multi', 10015)]);

      // Exactly one settlement, and it is the earliest-created payment.
      expect(settled).toHaveLength(1);
      expect(settled[0].id).toBe(first.id);
      expect((await storage.payments.getById(first.id)).status).toBe('paid');
      // The other two remain pending.
      const stillPending = await service.listActive();
      expect(stillPending).toHaveLength(2);
    });

    it('uses one txId to settle at most one payment across calls (idempotency)', async () => {
      const service = makeService();
      const a = await service.createPayment({ mode: 'client', amount: 5000 });
      // A second payment with the same amount cannot be pending simultaneously,
      // so create it after the first is settled to test txId idempotency.
      const firstSettled = await service.handleTransactions([payinTx('dup-tx', 5000)]);
      expect(firstSettled.map((p) => p.id)).toEqual([a.id]);

      // Re-create a pending payment at the same amount (now free) and replay the
      // SAME txId: it must NOT settle the new payment.
      const b = await service.createPayment({ mode: 'client', amount: 5000 });
      const replay = await service.handleTransactions([payinTx('dup-tx', 5000)]);
      expect(replay).toEqual([]);
      expect((await storage.payments.getById(b.id)).status).toBe('pending');
    });

    it('does not match an already-settled payment again within a batch', async () => {
      const service = makeService();
      const p1 = await service.createPayment({ mode: 'client', amount: 8000, tolerance: 0 });

      // Two different txIds with the same amount; only the single pending payment
      // can be settled (by the first tx). The second tx finds no pending match.
      const settled = await service.handleTransactions([
        payinTx('tx-a', 8000),
        payinTx('tx-b', 8000),
      ]);
      expect(settled.map((p) => p.id)).toEqual([p1.id]);
      expect((await storage.payments.getById(p1.id)).tx_id).toBe('tx-a');
    });

    it('skips overdue pending payments instead of settling them', async () => {
      const service = makeService();
      const payment = await service.createPayment({ mode: 'client', amount: 6000, timeout: 10000 });

      // Advance past expiry; handleTransactions should lazily expire then ignore.
      clock = payment.expires_at + 1;
      const settled = await service.handleTransactions([payinTx('tx-late', 6000)]);
      expect(settled).toEqual([]);
      expect((await storage.payments.getById(payment.id)).status).toBe('expired');
    });

    it('settles multiple distinct payments from multiple transactions in one batch', async () => {
      const service = makeService();
      const p1 = await service.createPayment({ mode: 'client', amount: 1111 });
      const p2 = await service.createPayment({ mode: 'client', amount: 2222 });

      const settled = await service.handleTransactions([
        payinTx('tx-1', 1111),
        payinTx('tx-2', 2222),
      ]);
      expect(new Set(settled.map((p) => p.id))).toEqual(new Set([p1.id, p2.id]));
      expect((await storage.payments.getById(p1.id)).status).toBe('paid');
      expect((await storage.payments.getById(p2.id)).status).toBe('paid');
    });

    it('returns an empty array for an empty or non-array batch', async () => {
      const service = makeService();
      expect(await service.handleTransactions([])).toEqual([]);
      expect(await service.handleTransactions()).toEqual([]);
      expect(await service.handleTransactions(null)).toEqual([]);
    });

    it('isolates a throwing webhook hook so settlement still succeeds', async () => {
      const service = makeService({
        onSettled: () => {
          throw new Error('webhook boom');
        },
      });
      const payment = await service.createPayment({ mode: 'client', amount: 4321 });

      const settled = await service.handleTransactions([payinTx('tx-x', 4321)]);
      expect(settled.map((p) => p.id)).toEqual([payment.id]);
      expect((await storage.payments.getById(payment.id)).status).toBe('paid');
    });
  });
});
