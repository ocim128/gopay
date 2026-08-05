// Formatting helpers shared by the Transactions page table and the reusable
// TransactionDetail component (so the payment drawer can show the exact same
// transaction breakdown as the Transactions page).
//
// GoBiz reports every monetary value in the smallest currency unit (sen), i.e.
// Rupiah * 100. The merchant dashboard divides by 100 and FLOORS to whole
// Rupiah for display, so we do the same.

const idrFormatter = new Intl.NumberFormat('id-ID', {
  style: 'currency',
  currency: 'IDR',
  maximumFractionDigits: 0
});

/**
 * Format a value that is already in Rupiah, floored to a whole Rupiah.
 * @param {unknown} value
 * @returns {string}
 */
export function rupiah(value) {
  if (value === undefined || value === null || value === '' || Number.isNaN(Number(value))) {
    return '—';
  }
  return idrFormatter.format(Math.floor(Number(value)));
}

/**
 * Format a value expressed in sen (Rupiah * 100), floored to a whole Rupiah.
 * @param {unknown} cents
 * @returns {string}
 */
export function money(cents) {
  if (cents === undefined || cents === null || cents === '' || Number.isNaN(Number(cents))) {
    return '—';
  }
  return idrFormatter.format(Math.floor(Number(cents) / 100));
}

/**
 * Format a fractional fee rate (e.g. 0.003) as a percentage (0.3%).
 * @param {unknown} value
 * @returns {string}
 */
export function percent(value) {
  if (value === undefined || value === null || value === '' || Number.isNaN(Number(value))) {
    return '—';
  }
  const pct = Number(value) * 100;
  return `${Number(pct.toFixed(4))}%`;
}

/**
 * Plain text with an em-dash fallback for empty values.
 * @param {unknown} value
 * @returns {string}
 */
export function text(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

/**
 * Format a timestamp (ISO string or epoch ms) for display.
 * @param {unknown} value
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatTime(value, timeZone) {
  const options = {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    ...(timeZone ? { timeZone } : {})
  };
  if (typeof value === 'number') {
    return new Date(value).toLocaleString('id-ID', options);
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString('id-ID', options);
  }
  return '—';
}

/**
 * Resolve the rich GoBiz transaction object from a canonical row. Analytics
 * rows keep the full object in `raw`; journal rows nest it under
 * `metadata.transaction`. Guard both shapes.
 * @param {any} tx
 * @returns {Record<string, any>}
 */
export function source(tx) {
  const raw = tx && typeof tx.raw === 'object' && tx.raw ? tx.raw : tx ?? {};
  if (
    raw &&
    typeof raw === 'object' &&
    raw.metadata &&
    typeof raw.metadata === 'object' &&
    raw.metadata.transaction
  ) {
    return raw.metadata.transaction;
  }
  return raw ?? {};
}

/**
 * The first settlement "share" entry (the fee / net breakdown).
 * @param {any} tx
 * @returns {Record<string, any>}
 */
export function share(tx) {
  const src = source(tx);
  if (Array.isArray(src.shares) && src.shares.length > 0 && src.shares[0]) {
    return src.shares[0];
  }
  return {};
}

/**
 * Pretty-print a value as JSON for the full raw dump.
 * @param {unknown} value
 * @returns {string}
 */
export function toJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
