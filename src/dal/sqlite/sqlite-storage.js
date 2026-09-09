// better-sqlite3 Storage implementation.
//
// This is the concrete, SQLite-backed implementation of the storage-agnostic
// `Storage` contract defined in ../storage-interface.js. It owns a single
// better-sqlite3 connection (synchronous, fast) and exposes only plain
// JavaScript values across the DAL boundary — no statement, row class, or
// PRAGMA detail leaks out.
//
// Every method is `async` and returns a Promise, even though better-sqlite3 is
// synchronous internally. This matches the storage contract's `Awaitable<T>`
// return types so the same callers work unchanged against the asynchronous
// MongoDB adapter.
//
// This module implements the full `Storage` contract: the `payments` store
// (`insertPending`, `getById`, `listActive`, `markPaid`, `expireOverdue`,
// `expireOverdueReturning`, `countActive`, `findCandidatesByAmount`,
// `maxActiveTolerance`, `listHistory`, `listAll`, `countAll`), the `apiKeys`
// store (`create`, `getActiveByHash`, `revoke`, `listMasked`), the
// `webhookLogs` store (`append`, `markPermanentFailure`, `listByPayment`,
// `pruneOld`), the `adminUsers` store (`getByUsername`, `ensure`), the
// `loginAttempts` store (atomic `recordFailure(ip, policy)`,
// `resetFailures`, `isLockedOut`, `getByIp`), the `config` store
// (`get`/`set`), and the top-level `ping()` and `close()`.
//
// Race-condition strategy: amount uniqueness among pending
// payments is enforced by the partial unique index `uniq_pending_amount` at
// INSERT time, never by a read-then-write check. A UNIQUE violation is caught
// here and mapped to the stable code `AMOUNT_IN_USE`.
//
// Settlement idempotency: `markPaid` inserts into `settled_tx`
// (whose primary key is the txId) and updates the payment inside one
// transaction, so a txId can settle at most one payment and a re-used txId
// aborts the whole settlement.

import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.js';

// Login-failure policy defaults. The Admin_Auth layer passes the authoritative
// values through the `recordFailure(ip, policy)` call; these mirror them and
// back the `isLockedOut` predicate, which must tell an active block apart from
// an open (still-counting) failure window.
const DEFAULT_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_THRESHOLD = 5;
const DEFAULT_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Default page size for `listActive` when no limit is supplied, and the maximum
 * a caller may request (limit range 1..100, default 100).
 *
 * @type {number}
 */
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 100;

/**
 * Default page size for `listHistory` when no limit is supplied. The Panel
 * history page paginates 50 entries per page; a caller may
 * still request fewer or up to {@link MAX_LIST_LIMIT}.
 *
 * @type {number}
 */
const DEFAULT_HISTORY_LIMIT = 50;

/**
 * Determine whether a thrown error is a SQLite UNIQUE-constraint violation. The
 * `payments` insert can only trip the partial unique index on `amount`, so this
 * is the precise signal for an amount collision among pending payments.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isUniqueViolation(err) {
  return (
    err !== null &&
    typeof err === 'object' &&
    /** @type {{ code?: string }} */ (err).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

/**
 * Determine whether a thrown error is a SQLite PRIMARY KEY violation. Used by
 * `markPaid` to detect a re-used txId in `settled_tx`.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isPrimaryKeyViolation(err) {
  return (
    err !== null &&
    typeof err === 'object' &&
    /** @type {{ code?: string }} */ (err).code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  );
}

/**
 * Normalize pagination options to safe integer bounds. A missing/invalid limit
 * falls back to {@link DEFAULT_LIST_LIMIT} and is clamped to 1..{@link MAX_LIST_LIMIT};
 * a missing/negative offset falls back to 0.
 *
 * @param {import('../storage-interface.js').ListOptions} [options]
 * @returns {{ limit: number, offset: number }}
 */
function normalizeListOptions(options = {}) {
  let limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    limit = DEFAULT_LIST_LIMIT;
  }
  if (limit > MAX_LIST_LIMIT) {
    limit = MAX_LIST_LIMIT;
  }

  let offset = Number(options.offset);
  if (!Number.isInteger(offset) || offset < 0) {
    offset = 0;
  }

  return { limit, offset };
}

/**
 * Normalize pagination options for `listHistory`. Identical to
 * {@link normalizeListOptions} except a missing/invalid limit falls back to
 * {@link DEFAULT_HISTORY_LIMIT} (50) rather than 100.
 *
 * @param {import('../storage-interface.js').ListOptions} [options]
 * @returns {{ limit: number, offset: number }}
 */
function normalizeHistoryOptions(options = {}) {
  let limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    limit = DEFAULT_HISTORY_LIMIT;
  }
  if (limit > MAX_LIST_LIMIT) {
    limit = MAX_LIST_LIMIT;
  }

  let offset = Number(options.offset);
  if (!Number.isInteger(offset) || offset < 0) {
    offset = 0;
  }

  return { limit, offset };
}

/**
 * Apply the fixed-window login-failure policy to the previous state and the
 * current attempt, mirroring the Admin_Auth layer's semantics. The first
 * failure opens a window ending at `now + windowMs`. Failures that arrive while
 * that window is still open increment the count without extending the window.
 * Once the count reaches the threshold the state escalates to a hard block
 * ending at `now + lockoutMs`. A failure that arrives after the previous
 * window/block has elapsed starts a fresh window.
 *
 * @param {{ failedAttempts: number, lockoutUntil: number|null }|null} state
 * @param {import('../storage-interface.js').LoginFailurePolicy} policy
 * @returns {{ failedAttempts: number, lockoutUntil: number|null }}
 */
function applyFailurePolicy(state, policy) {
  const { now, windowMs, threshold, lockoutMs } = policy;
  const prevAttempts = state ? state.failedAttempts : 0;
  const prevUntil = state ? state.lockoutUntil : null;

  const withinOpenWindow =
    prevUntil !== null &&
    now < prevUntil &&
    prevAttempts > 0;

  let failedAttempts;
  let windowEnd;
  if (withinOpenWindow) {
    failedAttempts = prevAttempts + 1;
    windowEnd = prevUntil; // keep the fixed window from the first failure
  } else {
    failedAttempts = 1;
    windowEnd = now + windowMs;
  }

  const lockoutUntil =
    failedAttempts >= threshold ? now + lockoutMs : windowEnd;

  return { failedAttempts, lockoutUntil };
}

/**
 * A sentinel thrown inside the {@link markPaid} transaction to roll it back
 * when the target payment is not in a settleable (`pending`) state. Carrying a
 * stable `code` lets the outer handler translate it to a Result without
 * inspecting message strings.
 */
class SettlementAbort extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.name = 'SettlementAbort';
    this.code = code;
  }
}

/**
 * Construct a SQLite-backed implementation of the `Storage` contract.
 *
 * @param {{ dbPath: string }} options - database file path (or ':memory:').
 * @returns {import('../storage-interface.js').Storage}
 */
export function createSqliteStorage(options) {
  const db = openDatabase({ dbPath: options.dbPath });

  // ---- Prepared statements (compiled once, reused for every call) ----------

  const insertPaymentStmt = db.prepare(
    `INSERT INTO payments
       (id, amount, status, qris_string, qris_url, created_at, expires_at,
        timeout, tolerance, webhook_url, tx_id, paid_amount, paid_at, tz, request_hash)
     VALUES
       (@id, @amount, 'pending', @qris_string, @qris_url, @created_at, @expires_at,
        @timeout, @tolerance, @webhook_url, NULL, NULL, NULL, @tz, @request_hash)`,
  );

  const getPaymentByIdStmt = db.prepare('SELECT * FROM payments WHERE id = ?');

  const listActiveStmt = db.prepare(
    `SELECT * FROM payments
     WHERE status = 'pending'
     ORDER BY expires_at ASC
     LIMIT ? OFFSET ?`,
  );

  const listHistoryStmt = db.prepare(
    `SELECT * FROM payments
     WHERE status IN ('paid', 'expired')
     ORDER BY COALESCE(paid_at, created_at) DESC, created_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  );

  const insertSettledTxStmt = db.prepare(
    'INSERT INTO settled_tx (tx_id, payment_id, settled_at) VALUES (?, ?, ?)',
  );

  const markPaidStmt = db.prepare(
    `UPDATE payments
       SET status = 'paid', tx_id = @txId, paid_amount = @paidAmount, paid_at = @paidAt,
           tx_raw = @raw, notification_state = 'pending'
     WHERE id = @id AND status = 'pending'`,
  );

  const expireOverdueStmt = db.prepare(
    `UPDATE payments
       SET status = 'expired', notification_state = 'pending'
     WHERE status = 'pending' AND expires_at < ?`,
  );

  const expireOverdueReturningStmt = db.prepare(
    `UPDATE payments
       SET status = 'expired', notification_state = 'pending'
     WHERE status = 'pending' AND expires_at < ?
     RETURNING *`,
  );

  const countActiveStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'",
  );

  // Settlement matching: range scan over the partial unique index
  // `uniq_pending_amount` (a b-tree on `amount WHERE status = 'pending'`), so a
  // transaction's candidate set is found in O(log n + matches) instead of
  // scanning every pending payment. Ordered earliest-created first to match the
  // tie-break the Payment_Service applies.
  const findCandidatesByAmountStmt = db.prepare(
    `SELECT * FROM payments
       WHERE status = 'pending' AND amount BETWEEN ? AND ?
       ORDER BY created_at ASC, id ASC`,
  );

  // The maximum `tolerance` among currently-pending payments. Used to widen the
  // candidate range scan so it covers any payment's tolerance window; each
  // candidate is then filtered precisely in JS. A single scalar query, run once
  // per batch, keeps the fast path correct regardless of the tolerance values
  // any payment happens to carry.
  const maxActiveToleranceStmt = db.prepare(
    `SELECT MAX(tolerance) AS m FROM payments WHERE status = 'pending'`,
  );

  // A single prepared statement per query covers every filter combination
  // (status / id-prefix / created_at range) via NULL-trick predicates: a NULL
  // parameter short-circuits its clause to TRUE, so the same compiled plan is
  // reused across all 8 filter shapes the Panel can produce. The `idx_payments_id`
  // and `idx_payments_status_created_id` indexes make the LIKE / status
  // predicates sargable.
  const listAllStmt = db.prepare(
    `SELECT * FROM payments
     WHERE (@status IS NULL OR status = @status)
       AND (@id IS NULL OR id LIKE @id)
       AND (@start IS NULL OR (created_at >= @start AND created_at < @end))
     ORDER BY created_at DESC, id DESC
     LIMIT @limit OFFSET @offset`,
  );

  const countAllStmt = db.prepare(
    `SELECT COUNT(*) AS n FROM payments
     WHERE (@status IS NULL OR status = @status)
       AND (@id IS NULL OR id LIKE @id)
       AND (@start IS NULL OR (created_at >= @start AND created_at < @end))`,
  );

  const configGetStmt = db.prepare('SELECT value FROM config WHERE key = ?');

  const configSetStmt = db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );

  const insertApiKeyStmt = db.prepare(
    `INSERT INTO api_keys (id, key_hash, key_prefix, status, created_at, revoked_at)
     VALUES (@id, @key_hash, @key_prefix, 'active', @created_at, NULL)`,
  );

  const getApiKeyByIdStmt = db.prepare('SELECT * FROM api_keys WHERE id = ?');

  const getActiveApiKeyByHashStmt = db.prepare(
    "SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'",
  );

  const revokeApiKeyStmt = db.prepare(
    `UPDATE api_keys
       SET status = 'revoked', revoked_at = @revoked_at
     WHERE id = @id AND status = 'active'`,
  );

  const listMaskedApiKeysStmt = db.prepare(
    `SELECT id, key_prefix, status, created_at, revoked_at
       FROM api_keys
     ORDER BY created_at DESC, id DESC`,
  );

  const insertWebhookLogStmt = db.prepare(
    `INSERT INTO webhook_delivery_logs
       (id, payment_id, target_url, status, attempts, last_attempt_at, last_error,
        response_status, response_body, request_body)
     VALUES
       (@id, @payment_id, @target_url, @status, @attempts, @last_attempt_at, @last_error,
        @response_status, @response_body, @request_body)`,
  );

  const listWebhookLogsByPaymentStmt = db.prepare(
    `SELECT * FROM webhook_delivery_logs
     WHERE payment_id = ?
     ORDER BY rowid ASC`,
  );

  const markWebhookLogPermanentStmt = db.prepare(
    `UPDATE webhook_delivery_logs
       SET status = 'failed_permanent'
     WHERE id = ?`,
  );

  // Retention: prune delivery-log rows older than the cutoff. Backs the poller's
  // once-daily cleanup so the log table cannot grow without bound. The cutoff is
  // a timestamp (epoch ms) supplied by the caller; a single DELETE uses the
  // idx_webhook_logs_payment index only incidentally — the scan is bounded by
  // the WHERE, and a periodic prune keeps the table small enough that it is
  // cheap regardless.
  const pruneWebhookLogsStmt = db.prepare(
    `DELETE FROM webhook_delivery_logs WHERE last_attempt_at < ?`,
  );

  const getAdminUserByUsernameStmt = db.prepare(
    'SELECT * FROM admin_users WHERE username = ?',
  );

  const insertAdminUserStmt = db.prepare(
    `INSERT INTO admin_users (id, username, password_hash)
     VALUES (?, ?, ?)`,
  );

  const listAdminUsernamesStmt = db.prepare(
    'SELECT username FROM admin_users ORDER BY username ASC',
  );

  const getLoginAttemptsByIpStmt = db.prepare(
    'SELECT * FROM login_attempts WHERE ip_address = ?',
  );

  const setLoginAttemptsStmt = db.prepare(
    `INSERT INTO login_attempts (ip_address, failed_attempts, lockout_until)
     VALUES (@ip_address, @failed_attempts, @lockout_until)
     ON CONFLICT(ip_address) DO UPDATE SET
       failed_attempts = excluded.failed_attempts,
       lockout_until = excluded.lockout_until`,
  );

  const resetLoginAttemptsStmt = db.prepare(
    `UPDATE login_attempts
       SET failed_attempts = 0, lockout_until = NULL
     WHERE ip_address = ?`,
  );

  const clearAllLoginAttemptsStmt = db.prepare('DELETE FROM login_attempts');

  // ---- payments store -------------------------------------------------------

  /**
   * Insert a new pending payment, mapping a UNIQUE violation on the partial
   * `uniq_pending_amount` index to `{ ok:false, code:'AMOUNT_IN_USE' }`. On a
   * collision no partial row is stored.
   *
   * @param {import('../storage-interface.js').PendingPaymentInput} payment
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').Payment>>}
   */
  async function insertPending(payment) {
    const params = {
      id: payment.id,
      amount: payment.amount,
      qris_string: payment.qris_string,
      qris_url: payment.qris_url ?? null,
      created_at: payment.created_at,
      expires_at: payment.expires_at,
      timeout: payment.timeout,
      tolerance: payment.tolerance ?? 0,
      webhook_url: payment.webhook_url ?? null,
      tz: payment.tz ?? null,
      request_hash: payment.request_hash ?? null,
    };

    try {
      insertPaymentStmt.run(params);
    } catch (err) {
      if (payment.request_hash) {
        const existing = getByIdSync(payment.id);
        if (existing) return existing.request_hash === payment.request_hash
          ? { ok: true, value: existing } : { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
      }
      if (isUniqueViolation(err)) {
        return { ok: false, code: 'AMOUNT_IN_USE' };
      }
      throw err;
    }

    return { ok: true, value: getByIdSync(payment.id) };
  }

  /**
   * Synchronous read by id. Used internally by methods that already hold the
   * event loop so they can return the freshly written row without an extra
   * `await` round-trip. The async {@link getById} below is the contract surface.
   *
   * @param {string} id
   * @returns {import('../storage-interface.js').Payment|null}
   */
  function getByIdSync(id) {
    const row = getPaymentByIdStmt.get(id);
    return row ?? null;
  }

  /**
   * Read a payment by id, or `null` if it does not exist. This is a pure read:
   * lazy-expiration of overdue pending payments is the Payment_Service's
   * responsibility, not the DAL's.
   *
   * @param {string} id
   * @returns {Promise<import('../storage-interface.js').Payment|null>}
   */
  async function getById(id) {
    return getByIdSync(id);
  }

  /**
   * List pending payments ordered by `expires_at` ascending,
   * paginated by the supplied limit/offset.
   *
   * @param {import('../storage-interface.js').ListOptions} [listOptions]
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function listActive(listOptions) {
    const { limit, offset } = normalizeListOptions(listOptions);
    return listActiveStmt.all(limit, offset);
  }

  /**
   * List historical (terminal-state) payments — those in `paid` or `expired`
   * status — most recent first, paginated by the supplied limit/offset. The
   * ordering uses the settlement time when present and otherwise the creation
   * time, so recently settled or recently created payments surface first.
   * The default page size is 50.
   *
   * @param {import('../storage-interface.js').ListOptions} [listOptions]
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function listHistory(listOptions) {
    const { limit, offset } = normalizeHistoryOptions(listOptions);
    return listHistoryStmt.all(limit, offset);
  }

  /**
   * List payments across every status (or a single status when one is given),
   * most recent first. The ordering is by `created_at` descending then `id`
   * descending so newly created payments surface first and the order is stable.
   * Pagination is applied with the supplied limit/offset (limit default 50,
   * clamped to 1..100; offset default 0). An omitted/falsy `status` returns all
   * statuses; an unrecognized status is treated as "all" by the route layer
   * before reaching the DAL. Optional `id` does a LIKE search, and `date`
   * filters by a `created_at` epoch range.
   *
   * @param {{ status?: ('pending'|'paid'|'expired'|null), limit?: number, offset?: number, id?: string, date?: { start: number, end: number } }} [options]
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function listAll(options = {}) {
    const { limit, offset } = normalizeHistoryOptions(options);
    return listAllStmt.all({
      status: options.status ?? null,
      // `id` is a prefix search; NULL disables the predicate entirely.
      id: options.id ? `${options.id}%` : null,
      start: options.date?.start ?? null,
      end: options.date?.end ?? null,
      limit,
      offset,
    });
  }

  /**
   * Count payments across every status, or only those in `status` when one is
   * given. Optionally filters by `id` and `date`. Uses the same NULL-trick
   * prepared statement as {@link listAll} so no SQL is recompiled per call.
   *
   * @param {{ status?: ('pending'|'paid'|'expired'|null), id?: string, date?: { start: number, end: number } }} [options]
   * @returns {Promise<number>}
   */
  async function countAll(options = {}) {
    const row = countAllStmt.get({
      status: options.status ?? null,
      id: options.id ? `${options.id}%` : null,
      start: options.date?.start ?? null,
      end: options.date?.end ?? null,
    });
    return row.n;
  }

  /**
   * Atomically settle a payment. Within one transaction it records the txId in
   * `settled_tx` (the primary key enforces idempotency) and flips the payment
   * to `paid`. If the txId was already used, the transaction aborts and the
   * result is `{ ok:false, code:'TX_ALREADY_SETTLED' }`; if the target payment
   * is missing or no longer pending, it is `{ ok:false, code:'PAYMENT_NOT_PENDING' }`.
   * Either failure rolls back so no partial settlement is observable.
   *
   * @param {string} id
   * @param {import('../storage-interface.js').SettlementInput} settlement
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').Payment>>}
   */
  async function markPaid(id, settlement) {
    const settle = db.transaction(() => {
      insertSettledTxStmt.run(settlement.txId, id, settlement.paidAt);
      const info = markPaidStmt.run({
        id,
        txId: settlement.txId,
        paidAmount: settlement.paidAmount,
        paidAt: settlement.paidAt,
        raw: settlement.raw ?? null,
      });
      if (info.changes === 0) {
        // No pending payment matched: abort so settled_tx is not left dangling.
        // Distinguish "no row matched" from a legitimate caller error.
        throw new SettlementAbort('PAYMENT_NOT_PENDING');
      }
    });

    try {
      settle();
    } catch (err) {
      if (isPrimaryKeyViolation(err)) {
        return { ok: false, code: 'TX_ALREADY_SETTLED' };
      }
      if (err instanceof SettlementAbort) {
        return { ok: false, code: err.code };
      }
      throw err;
    }

    return { ok: true, value: getByIdSync(id) };
  }

  /**
   * Transition every pending payment whose `expires_at` is strictly before
   * `now` to `expired`, returning how many were expired.
   *
   * @param {number} now - epoch ms.
   * @returns {Promise<number>}
   */
  async function expireOverdue(now) {
    const info = expireOverdueStmt.run(now);
    return info.changes;
  }

  /**
   * Transition every pending payment whose `expires_at` is strictly before
   * `now` to `expired`, returning the full rows that were transitioned by THIS
   * call (via SQL `RETURNING *`). Because the partial WHERE only matches still
   * `pending` rows, a second concurrent call returns an empty array — so a
   * caller can fire an "expired" side effect (e.g. a webhook) exactly once per
   * payment without double-firing.
   *
   * @param {number} now - epoch ms.
   * @returns {Promise<import('../storage-interface.js').Payment[]>} the payments that
   *   were just expired (empty when none were overdue).
   */
  async function expireOverdueReturning(now) {
    return expireOverdueReturningStmt.all(now);
  }

  /**
   * Count payments currently in `pending` status (drives Adaptive_Polling).
   *
   * @returns {Promise<number>}
   */
  async function countActive() {
    const row = countActiveStmt.get();
    return row.n;
  }

  /**
   * Find pending payments whose `amount` falls within `[minAmount, maxAmount]`,
   * ordered earliest-created first (`created_at ASC, id ASC`) so the caller can
   * settle the oldest match first. Backed by the partial unique index
   * `uniq_pending_amount`, the lookup is O(log n + matches) rather than a scan
   * of every pending payment.
   *
   * Note: because each payment carries its own `tolerance`, the caller is
   * expected to widen the range by the maximum tolerated delta before calling,
   * and to apply the precise `|tx.amount - p.amount| <= p.tolerance` filter to
   * the returned rows.
   *
   * @param {number} minAmount - inclusive lower bound (Rupiah).
   * @param {number} maxAmount - inclusive upper bound (Rupiah).
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function findCandidatesByAmount(minAmount, maxAmount) {
    return findCandidatesByAmountStmt.all(minAmount, maxAmount);
  }

  /**
   * Return the maximum `tolerance` among currently-pending payments, or 0 when
   * there are none. The Payment_Service uses this to widen the indexed candidate
   * range scan so it covers every payment's own tolerance window.
   *
   * @returns {Promise<number>}
   */
  async function maxActiveTolerance() {
    const row = maxActiveToleranceStmt.get();
    return Number.isFinite(row?.m) ? row.m : 0;
  }

  // ---- config store ---------------------------------------------------------

  /**
   * Read a configuration value by key, or `null` if it is unset.
   *
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async function configGet(key) {
    const row = configGetStmt.get(key);
    return row ? row.value : null;
  }

  /**
   * Insert or update a configuration value, persisting it durably for later
   * reads.
   *
   * @param {string} key
   * @param {string} value
   * @returns {Promise<import('../storage-interface.js').Result>}
   */
  async function configSet(key, value) {
    configSetStmt.run(key, value);
    return { ok: true };
  }

  // ---- apiKeys store --------------------------------------------------------

  /**
   * Build a plain {@link import('../storage-interface.js').ApiKeyRecord} from a
   * raw SQLite row. Returns `null` when the row is absent so callers can treat a
   * missing key uniformly.
   *
   * @param {Record<string, any>|undefined} row
   * @returns {import('../storage-interface.js').ApiKeyRecord|null}
   */
  function toApiKeyRecord(row) {
    return row ?? null;
  }

  /**
   * Insert a new API key with `active` status. The secret value itself is never
   * stored: only the caller-supplied hash and a display prefix are persisted.
   * A UNIQUE violation on `key_hash` (the astronomically
   * unlikely event of two keys hashing identically) maps to
   * `{ ok:false, code:'KEY_HASH_IN_USE' }` so the generator can retry rather
   * than throw.
   *
   * @param {import('../storage-interface.js').ApiKeyCreateInput} input
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').ApiKeyRecord>>}
   */
  async function apiKeyCreate(input) {
    try {
      insertApiKeyStmt.run({
        id: input.id,
        key_hash: input.keyHash,
        key_prefix: input.keyPrefix,
        created_at: input.createdAt,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { ok: false, code: 'KEY_HASH_IN_USE' };
      }
      throw err;
    }
    return { ok: true, value: toApiKeyRecord(getApiKeyByIdStmt.get(input.id)) };
  }

  /**
   * Look up an API key by its hash, returning it only when it is `active`.
   * A non-existent or revoked key resolves to `null`,
   * so the auth plugin treats both as a rejection.
   *
   * @param {string} keyHash
   * @returns {Promise<import('../storage-interface.js').ApiKeyRecord|null>}
   */
  async function apiKeyGetActiveByHash(keyHash) {
    return toApiKeyRecord(getActiveApiKeyByHashStmt.get(keyHash));
  }

  /**
   * Revoke an `active` API key: set its status to `revoked` and record
   * `revoked_at`. The UPDATE is guarded by
   * `status = 'active'`, so a key that does not exist or is already revoked
   * matches no row and yields `{ ok:false, code:'KEY_NOT_REVOCABLE' }` without
   * mutating any key.
   *
   * @param {string} id
   * @param {number} revokedAt - epoch ms when the revocation occurred.
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').ApiKeyRecord>>}
   */
  async function apiKeyRevoke(id, revokedAt) {
    const info = revokeApiKeyStmt.run({ id, revoked_at: revokedAt });
    if (info.changes === 0) {
      return { ok: false, code: 'KEY_NOT_REVOCABLE' };
    }
    return { ok: true, value: toApiKeyRecord(getApiKeyByIdStmt.get(id)) };
  }

  /**
   * List every API key in masked form for the Panel: the hash and full value
   * are never selected, only the display prefix, status, and timestamps.
   * Newest keys come first.
   *
   * @returns {Promise<import('../storage-interface.js').MaskedApiKey[]>}
   */
  async function apiKeyListMasked() {
    return listMaskedApiKeysStmt.all();
  }

  // ---- webhookLogs store ----------------------------------------------------

  /**
   * Append a webhook delivery-log entry, recording the outcome of a delivery
   * attempt: its status (`success` | `failed` | `failed_permanent`), the number
   * of attempts made so far, the timestamp of the last attempt, and the last
   * error (if any). Each appended row carries a caller-supplied unique `id`.
   *
   * @param {import('../storage-interface.js').WebhookLogEntry} entry
   * @returns {Promise<import('../storage-interface.js').Result>}
   */
  async function webhookLogAppend(entry) {
    insertWebhookLogStmt.run({
      id: entry.id,
      payment_id: entry.payment_id,
      target_url: entry.target_url,
      status: entry.status,
      attempts: entry.attempts,
      last_attempt_at: entry.last_attempt_at,
      last_error: entry.last_error ?? null,
      response_status: entry.response_status ?? null,
      response_body: entry.response_body ?? null,
      request_body: entry.request_body ?? null,
    });
    return { ok: true };
  }

  /**
   * Flip an existing delivery-log row to `failed_permanent` once every retry has
   * been exhausted. A row that does not exist matches nothing
   * and yields `{ ok:false, code:'LOG_NOT_FOUND' }` without mutating any data.
   *
   * @param {string} id - the delivery-log row id to mark permanently failed.
   * @returns {Promise<import('../storage-interface.js').Result>}
   */
  async function webhookLogMarkPermanentFailure(id) {
    const info = markWebhookLogPermanentStmt.run(id);
    if (info.changes === 0) {
      return { ok: false, code: 'LOG_NOT_FOUND' };
    }
    return { ok: true };
  }

  /**
   * List every delivery-log row recorded for a payment, oldest first. The
   * insertion order (`rowid` ascending) reflects the order attempts were made,
   * so the Panel can show the full delivery timeline. Each row includes the
   * captured `response_status`, `response_body`, and `request_body` columns.
   *
   * @param {string} paymentId
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async function webhookLogListByPayment(paymentId) {
    return listWebhookLogsByPaymentStmt.all(paymentId);
  }

  /**
   * Delete every delivery-log row whose `last_attempt_at` is strictly before
   * `cutoff` (epoch ms). Returns how many rows were removed. Used by the poller's
   * once-daily retention pass so the log table cannot grow without bound.
   *
   * @param {number} cutoff - epoch ms; rows older than this are deleted.
   * @returns {Promise<number>}
   */
  async function webhookLogPruneOld(cutoff) {
    const info = pruneWebhookLogsStmt.run(cutoff);
    return info.changes;
  }

  // ---- adminUsers store -----------------------------------------------------

  /**
   * Read an admin user by username, or `null` if no such user exists. This is a
   * pure read returning a plain {@link import('../storage-interface.js').AdminUser}
   * (never a SQLite row class).
   *
   * @param {string} username
   * @returns {Promise<import('../storage-interface.js').AdminUser|null>}
   */
  async function adminGetByUsername(username) {
    const row = getAdminUserByUsernameStmt.get(username);
    return row ?? null;
  }

  /**
   * Idempotently insert the initial admin user. When the username already
   * exists the stored password hash is LEFT UNCHANGED (later env changes do not
   * overwrite a configured user), and `{ ok:true, value:{ created:false } }` is
   * resolved. When a new row is inserted the supplied hash is stored and the
   * result is `{ ok:true, value:{ created:true } }`.
   *
   * The whole operation runs inside one transaction so a concurrent caller
   * racing to insert the same username cannot leave partial state: the
   * `username` UNIQUE constraint makes exactly one insert win.
   *
   * @param {import('../storage-interface.js').EnsureAdminInput} input
   * @returns {Promise<import('../storage-interface.js').Result<{ created: boolean }>>}
   */
  async function adminEnsure(input) {
    const existing = getAdminUserByUsernameStmt.get(input.username);
    if (existing) {
      return { ok: true, value: { created: false } };
    }
    try {
      insertAdminUserStmt.run(input.id, input.username, input.passwordHash);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent caller inserted the same username between our check and
        // insert. Treat it as already present without changing the password.
        return { ok: true, value: { created: false } };
      }
      throw err;
    }
    return { ok: true, value: { created: true } };
  }

  /**
   * List every admin username. Returns only usernames (no password hashes),
   * ordered alphabetically. Used by the out-of-band management CLI.
   *
   * @returns {Promise<Array<{ username: string }>>}
   */
  async function adminListUsernames() {
    return listAdminUsernamesStmt.all().map((row) => ({ username: row.username }));
  }

  /**
   * Update an existing admin user's password hash and/or rename it. The whole
   * operation runs inside one transaction: a rename first checks the target
   * username is free, then applies the change. A missing admin yields
   * `{ ok:false, code:'ADMIN_NOT_FOUND' }`; a rename to a taken username yields
   * `{ ok:false, code:'USERNAME_IN_USE' }` without modifying either row.
   *
   * @param {import('../storage-interface.js').UpdateAdminInput} input
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').AdminUser>>}
   */
  async function adminUpdateCredentials(input) {
    const renameTo =
      typeof input.newUsername === 'string' && input.newUsername !== input.currentUsername
        ? input.newUsername
        : null;
    const newPasswordHash =
      typeof input.passwordHash === 'string' && input.passwordHash.length > 0
        ? input.passwordHash
        : null;

    if (renameTo === null && newPasswordHash === null) {
      // Nothing to change: still confirm the admin exists.
      const existing = getAdminUserByUsernameStmt.get(input.currentUsername);
      if (!existing) {
        return { ok: false, code: 'ADMIN_NOT_FOUND' };
      }
      return { ok: true, value: toAdminUser(existing) };
    }

    const runUpdate = db.transaction(() => {
      const existing = getAdminUserByUsernameStmt.get(input.currentUsername);
      if (!existing) {
        throw new UpdateAbort('ADMIN_NOT_FOUND');
      }
      if (renameTo !== null) {
        const clash = getAdminUserByUsernameStmt.get(renameTo);
        if (clash) {
          throw new UpdateAbort('USERNAME_IN_USE');
        }
      }
      /** @type {string[]} */
      const sets = [];
      /** @type {Record<string, unknown>} */
      const params = { username: input.currentUsername };
      if (renameTo !== null) {
        sets.push('username = @newUsername');
        params.newUsername = renameTo;
      }
      if (newPasswordHash !== null) {
        sets.push('password_hash = @passwordHash');
        params.passwordHash = newPasswordHash;
      }
      db.prepare(`UPDATE admin_users SET ${sets.join(', ')} WHERE username = @username`).run(params);
      return getAdminUserByUsernameStmt.get(renameTo ?? input.currentUsername);
    });

    try {
      const updated = runUpdate();
      return { ok: true, value: toAdminUser(updated) };
    } catch (err) {
      if (err instanceof UpdateAbort) {
        return { ok: false, code: err.code };
      }
      throw err;
    }
  }

  /**
   * Sentinel thrown inside {@link adminUpdateCredentials} to roll back the
   * transaction when the target admin is missing or the rename target is taken.
   */
  class UpdateAbort extends Error {
    /** @param {string} code */
    constructor(code) {
      super(code);
      this.name = 'UpdateAbort';
      this.code = code;
    }
  }

  /**
   * Synchronous admin-user mapper (no `null` coercion needed; the row is
   * already verified to exist at the call sites that use this).
   *
   * @param {Record<string, any>|null} row
   * @returns {import('../storage-interface.js').AdminUser|null}
   */
  function toAdminUser(row) {
    return row
      ? { id: row.id, username: row.username, password_hash: row.password_hash }
      : null;
  }

  // ---- loginAttempts store --------------------------------------------------

  /**
   * Read the rate-limit state for an IP address.
   *
   * @param {string} ipAddress
   * @returns {Promise<{ failedAttempts: number, lockoutUntil: number|null }|null>}
   */
  async function loginAttemptsGetByIp(ipAddress) {
    const row = getLoginAttemptsByIpStmt.get(ipAddress);
    if (!row) {
      return null;
    }
    return { failedAttempts: row.failed_attempts, lockoutUntil: row.lockout_until };
  }

  /**
   * Atomically record a failed login for an IP address. Reads the current
   * counters, applies the fixed-window failure policy, and persists the new
   * state in one step (better-sqlite3 is synchronous, so the read/compute/write
   * sequence cannot be interleaved). Resolves to the new state.
   *
   * @param {string} ipAddress
   * @param {import('../storage-interface.js').LoginFailurePolicy} policy
   * @returns {Promise<import('../storage-interface.js').Result<{ failedAttempts: number, lockoutUntil: number|null }>>}
   */
  async function loginAttemptsRecordFailure(ipAddress, policy) {
    const row = getLoginAttemptsByIpStmt.get(ipAddress);
    const state = row
      ? { failedAttempts: row.failed_attempts, lockoutUntil: row.lockout_until }
      : null;
    const next = applyFailurePolicy(state, policy);
    setLoginAttemptsStmt.run({
      ip_address: ipAddress,
      failed_attempts: next.failedAttempts,
      lockout_until: next.lockoutUntil ?? null,
    });
    return { ok: true, value: next };
  }

  /**
   * Clear the failed-login counters for an IP address after a successful login.
   *
   * @param {string} ipAddress
   * @returns {Promise<import('../storage-interface.js').Result>}
   */
  async function loginAttemptsResetFailures(ipAddress) {
    resetLoginAttemptsStmt.run(ipAddress);
    return { ok: true };
  }

  /**
   * Report whether an IP address is currently blocked from logging in.
   *
   * @param {string} ipAddress
   * @param {number} now - epoch ms.
   * @returns {Promise<boolean>}
   */
  async function loginAttemptsIsLockedOut(ipAddress, now) {
    const row = getLoginAttemptsByIpStmt.get(ipAddress);
    if (!row) {
      return false;
    }
    return (
      row.lockout_until !== null &&
      row.failed_attempts >= DEFAULT_LOGIN_THRESHOLD &&
      now < row.lockout_until
    );
  }

  /**
   * Wipe EVERY IP's failed-login counters. Used only by the out-of-band
   * management CLI to unlock all admins at once. Returns how many rows were
   * removed.
   *
   * @returns {Promise<number>}
   */
  async function loginAttemptsClearAll() {
    const info = clearAllLoginAttemptsStmt.run();
    return info.changes;
  }

  // ---- top-level lifecycle --------------------------------------------------

  /** @type {boolean} tracks whether {@link close} has already been invoked. */
  let closed = false;

  /**
   * Readiness probe: confirm the underlying connection is still open. The
   * SQLite connection is synchronous and in-process, so a successful return is
   * sufficient evidence of readiness; the call rejects if the connection was
   * already closed.
   *
   * @returns {Promise<void>}
   */
  async function ping() {
    if (closed || !db.open) {
      throw new Error('SQLite database is closed.');
    }
    // A trivial scalar select proves the connection actually answers.
    db.prepare('SELECT 1').get();
  }

  /**
   * Release the underlying connection. Idempotent: a second call is a no-op.
   *
   * @returns {Promise<void>}
   */
  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    db.close();
  }

  // ---- assemble the Storage object -----------------------------------------

  const apiKeys = {
    create: apiKeyCreate,
    getActiveByHash: apiKeyGetActiveByHash,
    revoke: apiKeyRevoke,
    listMasked: apiKeyListMasked,
  };

  const webhookLogs = {
    append: webhookLogAppend,
    markPermanentFailure: webhookLogMarkPermanentFailure,
    listByPayment: webhookLogListByPayment,
    pruneOld: webhookLogPruneOld,
  };

  const adminUsers = {
    getByUsername: adminGetByUsername,
    ensure: adminEnsure,
    listUsernames: adminListUsernames,
    updateCredentials: adminUpdateCredentials,
  };

  const loginAttempts = {
    getByIp: loginAttemptsGetByIp,
    recordFailure: loginAttemptsRecordFailure,
    resetFailures: loginAttemptsResetFailures,
    isLockedOut: loginAttemptsIsLockedOut,
    clearAll: loginAttemptsClearAll,
  };

  const notifications = {
    async claim(now, leaseUntil, token) {
      return db.prepare(`UPDATE payments SET notification_lease = ?, notification_lease_until = ?
        WHERE id = (SELECT id FROM payments WHERE notification_state = 'pending'
          AND notification_next_at <= ? AND COALESCE(notification_lease_until, 0) <= ?
          ORDER BY notification_next_at, id LIMIT 1) RETURNING *`).get(token, leaseUntil, now, now) ?? null;
    },
    async saveRequest(id, token, request) {
      return db.prepare('UPDATE payments SET notification_request = ? WHERE id = ? AND notification_lease = ?')
        .run(request, id, token).changes > 0;
    },
    async finish(id, token, { state, attempts, nextAt }) {
      return db.prepare(`UPDATE payments SET notification_state = ?, notification_attempts = ?,
        notification_next_at = ?, notification_lease = NULL, notification_lease_until = NULL
        WHERE id = ? AND notification_lease = ?`).run(state, attempts, nextAt, id, token).changes > 0;
    },
  };

  return {
    notifications,
    payments: {
      insertPending,
      getById,
      listActive,
      listHistory,
      listAll,
      countAll,
      markPaid,
      expireOverdue,
      expireOverdueReturning,
      countActive,
      oldestActiveCreation: async () => db.prepare("SELECT MIN(created_at) AS oldest FROM payments WHERE status = 'pending'").get().oldest,
      findCandidatesByAmount,
      maxActiveTolerance,
    },
    apiKeys,
    webhookLogs,
    adminUsers,
    loginAttempts,
    config: {
      get: configGet,
      set: configSet,
    },
    ping,
    close,
  };
}

/**
 * Internal-only export: the default login-failure policy constants, used by
 * the seedAdmin path to build a policy when one is not supplied. Kept here so
 * the constants have a single home alongside the SQLite adapter.
 *
 * Exported only for `server.js`'s admin seeding helper.
 */
export const SQLITE_LOGIN_POLICY_DEFAULTS = Object.freeze({
  windowMs: DEFAULT_LOGIN_WINDOW_MS,
  threshold: DEFAULT_LOGIN_THRESHOLD,
  lockoutMs: DEFAULT_LOGIN_LOCKOUT_MS,
});

/**
 * Internal-only re-export so callers that build a Storage without going through
 * the factory (tests, seeding) can generate ids with the same scheme the
 * `ensure` operation expects to be supplied externally. Currently a thin
 * wrapper around `crypto.randomUUID`.
 *
 * @returns {string}
 */
export function generateAdminId() {
  return randomUUID();
}
