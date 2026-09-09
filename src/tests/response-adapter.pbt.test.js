import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import moment from 'moment-timezone';
import {
  parseMerchantList,
  parseAnalyticsTx,
  parseJournalTx,
} from '../gobiz/response-adapter.js';

// These property-based contract tests assert that the response adapter always
// produces a STABLE canonical Transaction[] shape regardless of the (highly
// variable) GoBiz response shapes it is fed:
//
//   Transaction = {
//     txId,   // transaction_id ?? id ?? order_id ?? null
//     amount, // Rupiah = gross_amount / 100 (0 for non-numeric)
//     type: 'payin',
//     time,   // ISO-8601 string or null
//     raw,    // original source object
//   }
//
// Each property runs >= 100 iterations.

const NUM_RUNS = { numRuns: 100 };

/**
 * Expected canonical txId selection, mirroring the documented precedence
 * `transaction_id ?? id ?? order_id` with a `null` fallback. Computed
 * independently from the adapter so the test acts as a real contract.
 */
function expectedTxId(tx) {
  return tx.transaction_id ?? tx.id ?? tx.order_id ?? null;
}

/**
 * Expected Rupiah conversion: numeric gross_amount / 100, otherwise 0.
 */
function expectedAmount(grossAmount) {
  return typeof grossAmount === 'number' ? grossAmount / 100 : 0;
}

/**
 * Arbitrary for a GoBiz transaction object with independently varying:
 *  - gross_amount: a number, or a non-numeric value, or absent
 *  - transaction_id / id / order_id: each independently present or absent
 *  - transaction_time: a valid ISO timestamp, or absent
 */
const txArb = fc.record(
  {
    gross_amount: fc.oneof(
      fc.integer({ min: 0, max: 9_9999000 }),
      fc.constant(undefined),
      fc.constantFrom(null, 'NaN', '1000'),
    ),
    transaction_id: fc.option(fc.string({ minLength: 1, maxLength: 12 }), {
      nil: undefined,
    }),
    id: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: undefined }),
    order_id: fc.option(fc.string({ minLength: 1, maxLength: 12 }), {
      nil: undefined,
    }),
    transaction_time: fc.option(
      fc
        .date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true })
        .map((d) => d.toISOString()),
      { nil: undefined },
    ),
  },
  { requiredKeys: [] },
);

/**
 * Assert a single canonical Transaction matches the invariants for a given
 * source transaction object and the `raw` value it should retain.
 */
function assertCanonical(result, sourceTx, expectedRaw) {
  // Stable key set.
  expect(Object.keys(result).sort()).toEqual(
    ['amount', 'raw', 'time', 'txId', 'type'].sort(),
  );
  // type is always 'payin'.
  expect(result.type).toBe('ignored');
  // amount in Rupiah.
  expect(result.amount).toBe(expectedAmount(sourceTx.gross_amount));
  // txId precedence.
  expect(result.txId).toBe(expectedTxId(sourceTx));
  // time is an ISO string or null.
  if (sourceTx.transaction_time == null) {
    expect(result.time).toBeNull();
  } else {
    expect(result.time).toBe(moment(sourceTx.transaction_time).toISOString());
    expect(moment(result.time, moment.ISO_8601, true).isValid()).toBe(true);
  }
  // raw is preserved by identity.
  expect(result.raw).toBe(expectedRaw);
}

describe('response-adapter canonical Transaction shape', () => {
  it('parseAnalyticsTx yields a stable canonical Transaction[] for any analytics response', () => {
    fc.assert(
      fc.property(fc.array(txArb, { maxLength: 20 }), (transactions) => {
        const result = parseAnalyticsTx({ transactions });
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(transactions.length);
        result.forEach((r, i) => {
          // For analytics, raw is the transaction object itself.
          assertCanonical(r, transactions[i], transactions[i]);
        });
      }),
      NUM_RUNS,
    );
  });

  it('parseJournalTx yields a stable canonical Transaction[] and skips entries without a transaction', () => {
    // A journal item either carries metadata.transaction or does not.
    const journalItemArb = fc.oneof(
      txArb.map((tx) => ({ kind: 'tx', item: { metadata: { transaction: tx } }, tx })),
      fc.constant({ kind: 'empty', item: { metadata: {} }, tx: null }),
      fc.constant({ kind: 'no-metadata', item: {}, tx: null }),
    );

    fc.assert(
      fc.property(fc.array(journalItemArb, { maxLength: 20 }), (entries) => {
        const raw = { data: entries.map((e) => e.item) };
        const result = parseJournalTx(raw);
        expect(Array.isArray(result)).toBe(true);

        const withTx = entries.filter((e) => e.kind === 'tx');
        expect(result).toHaveLength(withTx.length);
        result.forEach((r, i) => {
          const source = withTx[i];
          // For journals, raw is the whole journal entry (item), not the tx.
          assertCanonical(r, source.tx, source.item);
        });
      }),
      NUM_RUNS,
    );
  });

  it('parseAnalyticsTx / parseJournalTx return [] for non-array / absent containers', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.constant({}),
          fc.record({ transactions: fc.oneof(fc.string(), fc.integer(), fc.constant(null)) }),
          fc.record({ data: fc.oneof(fc.string(), fc.integer(), fc.constant(null)) }),
        ),
        (raw) => {
          expect(parseAnalyticsTx(raw)).toEqual(Object.assign([], { total: 0 }));
          expect(parseJournalTx(raw)).toEqual(Object.assign([], { total: 0 }));
        },
      ),
      NUM_RUNS,
    );
  });

  it('parseMerchantList flattens every supported container shape to a merchant array', () => {
    const merchantArb = fc.record({
      id: fc.string({ minLength: 1, maxLength: 8 }),
      name: fc.string({ maxLength: 16 }),
    });

    // Build one of the five container shapes around a known list of merchants,
    // along with the expected flattened output.
    const shapeArb = fc.array(merchantArb, { maxLength: 15 }).chain((merchants) =>
      fc.oneof(
        // 1. bare array
        fc.constant({ raw: merchants, expected: merchants }),
        // 2. .merchants
        fc.constant({ raw: { merchants }, expected: merchants }),
        // 3. .hits (array)
        fc.constant({ raw: { hits: merchants }, expected: merchants }),
        // 4. .hits.hits with optional _source wrapping per entry
        fc.array(fc.boolean(), { minLength: merchants.length, maxLength: merchants.length }).map(
          (wrapFlags) => {
            const hits = merchants.map((m, i) => (wrapFlags[i] ? { _source: m } : m));
            return { raw: { hits: { hits } }, expected: merchants };
          },
        ),
        // 5. .data
        fc.constant({ raw: { data: merchants }, expected: merchants }),
      ),
    );

    fc.assert(
      fc.property(shapeArb, ({ raw, expected }) => {
        const result = parseMerchantList(raw);
        expect(Array.isArray(result)).toBe(true);
        expect(result).toEqual(expected);
      }),
      NUM_RUNS,
    );
  });

  it('parseMerchantList returns [] for unsupported / non-matching shapes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(null),
          fc.constant(undefined),
          fc.record({ foo: fc.integer() }),
          fc.record({ merchants: fc.integer() }),
          fc.record({ data: fc.string() }),
          fc.integer(),
          fc.string(),
        ),
        (raw) => {
          expect(parseMerchantList(raw)).toEqual([]);
        },
      ),
      NUM_RUNS,
    );
  });
});
