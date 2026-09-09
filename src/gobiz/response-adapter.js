// GoBiz response normalizer.
//
// This module isolates ALL parsing of GoBiz / Gojek JSON responses. The
// analytics + journal normalization and the five merchant-list branches are
// implemented here as PURE functions so that a change in the shape of a GoBiz
// response only requires editing this single file.
//
// Canonical internal Transaction shape consumed by the poller and the payment
// service:
//
//   Transaction = {
//     txId,            // transaction_id ?? id ?? order_id (or null when absent)
//     amount,          // Rupiah (gross_amount / 100)
//     type: 'payin',
//     time,            // ISO-8601 string (or null when absent/unparseable)
//     raw,             // the original source object for downstream context
//   }

/**
 * Select the canonical transaction id from a transaction object, using the
 * precedence `transaction_id ?? id ?? order_id`.
 *
 * @param {object} tx - A GoBiz transaction object.
 * @returns {string|null} The transaction id, or `null` when none is present.
 */
function selectTxId(tx) {
  return tx?.transaction_id ?? tx?.id ?? tx?.order_id ?? null;
}

/**
 * Convert a GoBiz `gross_amount` (stored in cents) into whole Rupiah.
 *
 * Divides `gross_amount` by 100, falling back to `0` for non-numeric values.
 *
 * @param {unknown} grossAmount - The raw `gross_amount` value.
 * @returns {number} The amount in Rupiah.
 */
function toRupiah(grossAmount) {
  return typeof grossAmount === 'number' ? grossAmount / 100 : 0;
}

/**
 * Normalize a transaction timestamp into an ISO-8601 string.
 *
 * Accepts anything `Date` can parse (ISO strings, epoch numbers, date strings).
 * Returns `null` for absent or unparseable values, mirroring the previous
 * `moment(time).isValid()` behaviour via `Number.isNaN` on the parsed time. A
 * falsy input (including `0`, which is never a real transaction time) returns
 * `null`, preserving the previous truthiness guard exactly.
 *
 * @param {unknown} time - The raw transaction time value.
 * @returns {string|null} The ISO-8601 representation, or `null` when the value
 *   is absent or cannot be parsed.
 */
function toIso(time) {
  if (!time) return null;
  const parsed = new Date(/** @type {any} */ (time));
  // Invalid dates yield NaN; preserve the previous "null on bad input" contract.
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/**
 * Build a canonical Transaction from a GoBiz transaction object.
 *
 * @param {object} tx - The transaction object carrying `gross_amount`,
 *   `transaction_time`, and the id fields.
 * @param {object} raw - The object to retain as `raw` for downstream context
 *   (the transaction itself for analytics, the journal entry for journals).
 * @returns {{ txId: string|null, amount: number, type: 'payin', time: string|null, raw: object }}
 */
function toTransaction(tx, raw) {
  const status = String(tx?.status ?? '').toLowerCase();
  const paymentType = String(tx?.payment_type ?? '').toLowerCase();
  return {
    txId: selectTxId(tx),
    amount: toRupiah(tx?.gross_amount),
    type: ['settlement', 'capture'].includes(status) && paymentType === 'qris'
      ? 'payin' : 'ignored',
    time: toIso(tx?.transaction_time),
    raw,
  };
}

/**
 * Normalize the merchant-list response into a flat array of merchant objects.
 *
 * Handles the five response shapes, in order:
 *   1. a bare array
 *   2. `.merchants`
 *   3. `.hits` (array)
 *   4. `.hits.hits` (each entry unwrapped via `_source` when present)
 *   5. `.data`
 *
 * @param {unknown} raw - The raw merchants response.
 * @returns {object[]} The list of merchant objects (empty when none match).
 */
export function parseMerchantList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw?.merchants && Array.isArray(raw.merchants)) return raw.merchants;
  if (raw?.hits && Array.isArray(raw.hits)) return raw.hits;
  if (raw?.hits?.hits && Array.isArray(raw.hits.hits)) {
    return raw.hits.hits.map((h) => h._source || h);
  }
  if (raw?.data && Array.isArray(raw.data)) return raw.data;
  return [];
}

/**
 * Normalize the merchant-analytics response into canonical Transactions.
 *
 * Reads the `transactions` array; each entry becomes a canonical Transaction
 * with `raw` set to the transaction object.
 *
 * @param {unknown} raw - The raw analytics response.
 * @returns {Array<{ txId: string|null, amount: number, type: 'payin', time: string|null, raw: object }>}
 */
export function parseAnalyticsTx(raw) {
  const transactions = raw?.transactions;
  if (!Array.isArray(transactions)) {
    const empty = [];
    empty.total = 0;
    return empty;
  }
  const result = transactions.map((tx) => toTransaction(tx, tx));
  result.total = raw?.total ?? 0;
  result.pageCount = transactions.length;
  return result;
}

/**
 * Normalize the journal-search response into canonical Transactions.
 *
 * Reads the `data` array; for each entry the transaction lives under
 * `metadata.transaction`. Entries without a transaction are skipped. The
 * canonical Transaction keeps the whole journal entry as `raw`.
 *
 * @param {unknown} raw - The raw journal response.
 * @returns {Array<{ txId: string|null, amount: number, type: 'payin', time: string|null, raw: object }>}
 */
export function parseJournalTx(raw) {
  const items = raw?.data;
  if (!Array.isArray(items)) {
    const empty = [];
    empty.total = 0;
    return empty;
  }
  const transactions = [];
  for (const item of items) {
    const tx = item?.metadata?.transaction;
    if (!tx) continue;
    transactions.push(toTransaction(tx, item));
  }
  transactions.total = raw?.total ?? 0;
  transactions.pageCount = items.length;
  return transactions;
}

/**
 * The ResponseAdapter facade exposing the pure parsers as a single object, as
 * referenced by the GoBiz client.
 */
export const ResponseAdapter = {
  parseMerchantList,
  parseAnalyticsTx,
  parseJournalTx,
};

export default ResponseAdapter;
