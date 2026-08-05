import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoBizClient } from '../gobiz/gobiz-client.js';

// High-level GoBiz client facade.

/**
 * Build a normalized TransportResponse-like object from a status and JSON body.
 * @param {{ status?: number, body?: any }} opts
 */
function makeResponse({ status = 200, body = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

/**
 * Build a stub AuthTokenManager that hands out tokens and tracks invalidation.
 */
function makeAuth({ token = 'token-1' } = {}) {
  return {
    invalidateCount: 0,
    forceLoginCount: 0,
    _seq: 0,
    async getValidToken({ forceLogin = false } = {}) {
      if (forceLogin) {
        this.forceLoginCount += 1;
        return `fresh-${this.forceLoginCount}`;
      }
      return token;
    },
    async invalidate() {
      this.invalidateCount += 1;
    },
  };
}

const MERCHANTS_BODY = { hits: { hits: [{ _source: { id: 'M-123', merchant_name: 'Shop' } }] } };

describe('GoBizClient', () => {
  let transport;
  let auth;
  let adapter;

  beforeEach(() => {
    transport = { request: vi.fn() };
    auth = makeAuth();
    adapter = {
      parseMerchantList: vi.fn((raw) =>
        raw?.hits?.hits ? raw.hits.hits.map((h) => h._source || h) : [],
      ),
      parseAnalyticsTx: vi.fn((raw) =>
        (raw?.transactions ?? []).map((tx) => ({
          txId: tx.transaction_id ?? tx.id ?? tx.order_id ?? null,
          amount: typeof tx.gross_amount === 'number' ? tx.gross_amount / 100 : 0,
          type: 'payin',
          time: tx.transaction_time ?? null,
          raw: tx,
        })),
      ),
      parseJournalTx: vi.fn((raw) =>
        (raw?.data ?? [])
          .filter((item) => item?.metadata?.transaction)
          .map((item) => {
            const tx = item.metadata.transaction;
            return {
              txId: tx.transaction_id ?? tx.id ?? tx.order_id ?? null,
              amount: typeof tx.gross_amount === 'number' ? tx.gross_amount / 100 : 0,
              type: 'payin',
              time: tx.transaction_time ?? null,
              raw: item,
            };
          }),
      ),
    };
  });

  it('throws when constructed without a transport', () => {
    expect(() => new GoBizClient({ auth, adapter })).toThrow(/transport/i);
  });

  it('throws when constructed without an auth manager', () => {
    expect(() => new GoBizClient({ transport, adapter })).toThrow(/AuthTokenManager/);
  });

  describe('getMerchantId', () => {
    it('resolves and caches the merchant id via the adapter', async () => {
      transport.request.mockResolvedValueOnce(makeResponse({ body: MERCHANTS_BODY }));
      const client = new GoBizClient({ transport, auth, adapter });

      const id = await client.getMerchantId();
      expect(id).toBe('M-123');
      expect(adapter.parseMerchantList).toHaveBeenCalledOnce();

      // Second call must be served from cache (no extra request).
      const id2 = await client.getMerchantId();
      expect(id2).toBe('M-123');
      expect(transport.request).toHaveBeenCalledTimes(1);
    });

    it('throws when no merchant is associated with the account', async () => {
      transport.request.mockResolvedValueOnce(makeResponse({ body: { hits: { hits: [] } } }));
      const client = new GoBizClient({ transport, auth, adapter });

      await expect(client.getMerchantId()).rejects.toThrow(/No merchant/);
    });

    it('throws on a non-OK merchants response', async () => {
      transport.request.mockResolvedValueOnce(
        makeResponse({ status: 500, body: { errors: [{ message: 'boom' }] } }),
      );
      const client = new GoBizClient({ transport, auth, adapter });

      await expect(client.getMerchantId()).rejects.toThrow(/boom/);
    });
  });

  describe('getRecentTransactions', () => {
    it('returns canonical analytics transactions when present', async () => {
      transport.request
        // init -> getMerchantId
        .mockResolvedValueOnce(makeResponse({ body: MERCHANTS_BODY }))
        // analytics
        .mockResolvedValueOnce(
          makeResponse({
            body: {
              transactions: [
                { transaction_id: 'tx-1', gross_amount: 1500000, transaction_time: '2024-01-01T00:00:00Z' },
              ],
            },
          }),
        );

      const client = new GoBizClient({ transport, auth, adapter });
      const txs = await client.getRecentTransactions({ days: 1, size: 10 });

      expect(adapter.parseAnalyticsTx).toHaveBeenCalledOnce();
      expect(adapter.parseJournalTx).not.toHaveBeenCalled();
      expect(txs).toEqual([
        { txId: 'tx-1', amount: 15000, type: 'payin', time: '2024-01-01T00:00:00Z', raw: expect.any(Object) },
      ]);
    });

    it('falls back to the journal when analytics has no transactions array', async () => {
      transport.request
        .mockResolvedValueOnce(makeResponse({ body: MERCHANTS_BODY })) // merchants
        .mockResolvedValueOnce(makeResponse({ body: { not_transactions: true } })) // analytics
        .mockResolvedValueOnce(
          makeResponse({
            body: {
              data: [
                { metadata: { transaction: { id: 'jtx-1', gross_amount: 5000000, transaction_time: '2024-02-02T00:00:00Z' } } },
              ],
            },
          }),
        ); // journal

      const client = new GoBizClient({ transport, auth, adapter });
      const txs = await client.getRecentTransactions();

      expect(adapter.parseJournalTx).toHaveBeenCalledOnce();
      expect(txs).toEqual([
        { txId: 'jtx-1', amount: 50000, type: 'payin', time: '2024-02-02T00:00:00Z', raw: expect.any(Object) },
      ]);
    });

    it('falls back to the journal when analytics returns a non-OK status', async () => {
      transport.request
        .mockResolvedValueOnce(makeResponse({ body: MERCHANTS_BODY })) // merchants
        .mockResolvedValueOnce(makeResponse({ status: 503, body: {} })) // analytics fails
        .mockResolvedValueOnce(makeResponse({ body: { data: [] } })); // journal

      const client = new GoBizClient({ transport, auth, adapter });
      const txs = await client.getRecentTransactions();

      expect(txs).toEqual([]);
      expect(adapter.parseJournalTx).toHaveBeenCalledOnce();
    });
  });

  describe('single 401 retry', () => {
    it('invalidates the token and retries once on a 401', async () => {
      transport.request
        .mockResolvedValueOnce(makeResponse({ body: MERCHANTS_BODY })) // merchants (init)
        .mockResolvedValueOnce(makeResponse({ status: 401, body: {} })) // analytics 401
        .mockResolvedValueOnce(
          makeResponse({ body: { transactions: [{ id: 'tx-9', gross_amount: 100000, transaction_time: '2024-03-03T00:00:00Z' }] } }),
        ); // analytics retry succeeds

      const client = new GoBizClient({ transport, auth, adapter });
      const txs = await client.getRecentTransactions();

      expect(auth.invalidateCount).toBe(1);
      expect(auth.forceLoginCount).toBe(1);
      expect(txs).toHaveLength(1);
      expect(txs[0].txId).toBe('tx-9');
    });

    it('retries only once and does not loop on a persistent 401', async () => {
      // merchants ok, then analytics returns 401 twice -> falls back to journal,
      // journal also 401 twice -> throws.
      transport.request
        .mockResolvedValueOnce(makeResponse({ body: MERCHANTS_BODY })) // merchants
        .mockResolvedValueOnce(makeResponse({ status: 401, body: {} })) // analytics try 1
        .mockResolvedValueOnce(makeResponse({ status: 401, body: {} })) // analytics retry
        .mockResolvedValueOnce(makeResponse({ status: 401, body: {} })) // journal try 1
        .mockResolvedValueOnce(makeResponse({ status: 401, body: {} })); // journal retry

      const client = new GoBizClient({ transport, auth, adapter });

      await expect(client.getRecentTransactions()).rejects.toThrow(/Journal request failed/);
      // One invalidate for analytics + one for journal.
      expect(auth.invalidateCount).toBe(2);
    });
  });

  describe('init', () => {
    it('runs token resolution and merchant resolution only once', async () => {
      transport.request.mockResolvedValue(makeResponse({ body: MERCHANTS_BODY }));
      const getTokenSpy = vi.spyOn(auth, 'getValidToken');
      const client = new GoBizClient({ transport, auth, adapter });

      await client.init();
      await client.init();

      // getValidToken called once in init + once inside the merchants request,
      // but the second init() is a no-op.
      expect(transport.request).toHaveBeenCalledTimes(1);
      expect(getTokenSpy).toHaveBeenCalled();
    });
  });
});
