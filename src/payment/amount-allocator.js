// Amount allocation: client-managed validation & server-managed suffix allocation.
//
// This module is pure and storage-agnostic so it can be unit/property tested in
// isolation. It covers the two amount modes:
//
//   * Client_Managed_Mode (Type 1): the API_Client supplies the full Amount.
//     The allocator only *validates* that the Amount is a positive integer in
//     the range 1000..9999000 Rupiah.
//
//   * Server_Managed_Mode (Type 2): the API_Client supplies a plain Base_Amount
//     and the System forms the Amount by adding a Unique_Suffix in the range
//     0..999 (a maximum of 1000 slots per Base_Amount). The allocator tries
//     candidate amounts against a caller-supplied attempt function (so the
//     real DAL UNIQUE constraint stays the source of truth and the allocation
//     is race-safe). When every slot is taken it surfaces a "no free slot"
//     condition the service maps to `NO_AVAILABLE_AMOUNT`.
//
// The allocator never touches the database itself; the caller passes in the
// behavior (validation throws, the attempt callback performs the actual
// insertion).

import { getErrorDefinition } from '../errors.js';

/** Inclusive lower bound of a valid Amount in Rupiah. */
export const MIN_AMOUNT = 1000;

/** Inclusive upper bound of a valid Amount in Rupiah. */
export const MAX_AMOUNT = 9999000;

/** Inclusive lower bound of a Unique_Suffix. */
export const MIN_SUFFIX = 0;

/** Inclusive upper bound of a Unique_Suffix. */
export const MAX_SUFFIX = 999;

/**
 * The number of Unique_Suffix slots available per Base_Amount, which is also
 * the default maximum number of allocation attempts.
 *
 * @type {1000}
 */
export const SUFFIX_SLOTS = MAX_SUFFIX - MIN_SUFFIX + 1;

/**
 * Error thrown by the allocator for an invalid input or an exhausted set of
 * suffix slots. The `code` property always matches a key in the central error
 * map (`src/errors.js`) so the route layer can translate it into the correct
 * HTTP status and response body without knowing about this module.
 *
 * Possible codes:
 *   * `INVALID_AMOUNT`        - client-managed amount is not a valid Amount.
 *   * `INVALID_BASE_AMOUNT`   - server-managed base amount is not valid.
 *   * `NO_AVAILABLE_AMOUNT`   - every Unique_Suffix slot is already in use.
 */
export class AmountAllocationError extends Error {
  /**
   * @param {'INVALID_AMOUNT'|'INVALID_BASE_AMOUNT'|'NO_AVAILABLE_AMOUNT'} code
   *   the error code; must be a key in the central error map.
   * @param {string} [message] - optional English detail message. Defaults to
   *   the registered message for the code.
   */
  constructor(code, message) {
    const fallback = getErrorDefinition(code).message;
    super(message ?? fallback);
    this.name = 'AmountAllocationError';
    /** @type {'INVALID_AMOUNT'|'INVALID_BASE_AMOUNT'|'NO_AVAILABLE_AMOUNT'} */
    this.code = code;
  }
}

/**
 * Test whether a value is a valid client-managed Amount: a positive integer in
 * the range 1000..9999000 Rupiah.
 *
 * @param {unknown} amount - the candidate Amount.
 * @returns {boolean} true if the value is a valid Amount.
 */
export function isValidAmount(amount) {
  return (
    typeof amount === 'number' &&
    Number.isInteger(amount) &&
    amount >= MIN_AMOUNT &&
    amount <= MAX_AMOUNT
  );
}

/**
 * Test whether a value is a valid Base_Amount: a positive integer of at least 1.
 * The Base_Amount itself is not bounded above here; the
 * server-managed allocation guarantees the *formed* Amount stays within the
 * valid Amount range.
 *
 * @param {unknown} baseAmount - the candidate Base_Amount.
 * @returns {boolean} true if the value is a valid Base_Amount.
 */
export function isValidBaseAmount(baseAmount) {
  return (
    typeof baseAmount === 'number' &&
    Number.isInteger(baseAmount) &&
    baseAmount >= MIN_AMOUNT
  );
}

/**
 * Validate a client-managed Amount (Client_Managed_Mode / Type 1).
 *
 * @param {unknown} amount - the Amount supplied by the API_Client.
 * @returns {number} the validated Amount (unchanged) when it is valid.
 * @throws {AmountAllocationError} with code `INVALID_AMOUNT` when the Amount is
 *   missing, not a positive integer, or outside the range 1000..9999000.
 */
export function validateClientAmount(amount) {
  if (!isValidAmount(amount)) {
    throw new AmountAllocationError('INVALID_AMOUNT');
  }
  return amount;
}

/**
 * Validate a server-managed Base_Amount (Server_Managed_Mode / Type 2).
 *
 * @param {unknown} baseAmount - the Base_Amount supplied by the API_Client.
 * @returns {number} the validated Base_Amount (unchanged) when it is valid.
 * @throws {AmountAllocationError} with code `INVALID_BASE_AMOUNT` when the
 *   Base_Amount is missing or not a positive integer (less than 1).
 */
export function validateBaseAmount(baseAmount) {
  if (!isValidBaseAmount(baseAmount)) {
    throw new AmountAllocationError('INVALID_BASE_AMOUNT');
  }
  return baseAmount;
}

/**
 * Find the first free Unique_Suffix in the range 0..999 for a Base_Amount,
 * given a set of already-used suffixes. This is a pure helper that performs no
 * I/O; it is convenient for callers (and tests) that already know the used
 * suffixes up front.
 *
 * Suffixes are scanned in ascending order. A candidate is considered free only
 * when it is not in `usedSuffixes` and the formed Amount (Base_Amount + suffix)
 * stays within the valid Amount range (so the resulting Amount is always a
 * valid payment Amount).
 *
 * @param {number} baseAmount - the validated Base_Amount.
 * @param {Iterable<number>} usedSuffixes - suffixes already taken by other
 *   Active_Payment for this Base_Amount.
 * @returns {number|null} the first free suffix in 0..999, or `null` when every
 *   slot is taken (or would overflow the maximum Amount).
 */
export function findFreeSuffix(baseAmount, usedSuffixes = []) {
  const used = usedSuffixes instanceof Set ? usedSuffixes : new Set(usedSuffixes);
  for (let suffix = MIN_SUFFIX; suffix <= MAX_SUFFIX; suffix += 1) {
    if (used.has(suffix)) {
      continue;
    }
    if (baseAmount + suffix > MAX_AMOUNT) {
      // A larger suffix would only overflow further, so stop scanning.
      break;
    }
    return suffix;
  }
  return null;
}

/**
 * Allocate a server-managed Amount by trying Unique_Suffix values 0..999 in
 * ascending order against a caller-supplied attempt function.
 *
 * The attempt function performs the real allocation step (for example,
 * inserting a `pending` Payment row). It receives the candidate Amount and its
 * suffix and returns a truthy value to signal success, or a falsy value to
 * signal that the candidate is already taken (for example, a UNIQUE constraint
 * violation). Allocation stops at the first success.
 *
 * The attempt function MAY be asynchronous (return a Promise): the allocation
 * loop awaits each attempt before trying the next suffix. This is required for
 * asynchronous storage backends (MongoDB), where the insert result is only
 * known after the round-trip resolves. A synchronous attempt (SQLite) is still
 * accepted and awaited uniformly.
 *
 * Candidates whose formed Amount would exceed the maximum valid Amount are
 * skipped so the resulting Amount is always a valid payment Amount.
 *
 * @template T
 * @param {number} baseAmount - the validated Base_Amount.
 * @param {(candidateAmount: number, suffix: number) => (Promise<(T|false|null|undefined)>|(T|false|null|undefined))} attempt
 *   the allocation attempt; returns (or resolves to) a truthy result on success
 *   or a falsy value when the candidate Amount is already in use.
 * @param {object} [options]
 * @param {number} [options.maxAttempts=1000] - the maximum number of attempts
 *   to make (defaults to the 1000 suffix slots).
 * @returns {Promise<{ amount: number, suffix: number, result: T }>} the
 *   successfully allocated Amount, its suffix, and the truthy result returned
 *   by `attempt`.
 * @throws {AmountAllocationError} with code `NO_AVAILABLE_AMOUNT` when no free
 *   slot remains within the attempt budget.
 */
export async function allocateServerAmount(baseAmount, attempt, options = {}) {
  if (typeof attempt !== 'function') {
    throw new TypeError('allocateServerAmount requires an attempt function.');
  }

  const maxAttempts = options.maxAttempts ?? SUFFIX_SLOTS;
  let attempts = 0;

  for (let suffix = MIN_SUFFIX; suffix <= MAX_SUFFIX; suffix += 1) {
    if (attempts >= maxAttempts) {
      break;
    }

    const candidateAmount = baseAmount + suffix;
    if (candidateAmount > MAX_AMOUNT) {
      // A larger suffix would only overflow further, so stop scanning.
      break;
    }

    attempts += 1;
    // Await every attempt so an asynchronous storage backend (MongoDB) resolves
    // the insert before we try the next suffix. A synchronous attempt is
    // awaited harmlessly.
    // eslint-disable-next-line no-await-in-loop
    const result = await attempt(candidateAmount, suffix);
    if (result) {
      return { amount: candidateAmount, suffix, result };
    }
  }

  throw new AmountAllocationError('NO_AVAILABLE_AMOUNT');
}
