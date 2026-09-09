// MongoDB Storage implementation.
//
// Concrete, MongoDB-backed implementation of the storage-agnostic `Storage`
// contract (../storage-interface.js). It owns a single `MongoClient` and
// exposes only plain JavaScript values across the DAL boundary — no MongoDB
// collection, document, or client handle leaks out. Every document stored here
// is mapped to/from the same domain shape the SQLite adapter produces so the
// rest of the application cannot tell the backends apart.
//
// Identity strategy: every collection uses the domain string key as `_id`
// (payment id, API-key id, webhook-log id, admin id, IP address, config key).
// This relies on the automatic unique `_id` index for uniqueness and keeps
// prefix search on `_id` usable via the `_id` index.
//
// Settlement idempotency: a unique partial index on `payments.tx_id` (where
// `tx_id` is a string) makes one transaction id settle at most one payment, so
// no separate `settled_tx` collection is needed and no multi-document
// transaction is required.
//
// Atomicity: `markPaid`, `expireOverdueReturning`, `adminUsers.ensure`, and
// `loginAttempts.recordFailure` are each a single conditional update or an
// insert-if-absent, so they are atomic on one document and tolerate the brief
// old/new instance overlap during deployment without a replica-set transaction.

import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants and helpers
// ---------------------------------------------------------------------------

/** Default page size for `listActive` when no limit is supplied. */
const DEFAULT_LIST_LIMIT = 100;
/** Maximum page size a caller may request. */
const MAX_LIST_LIMIT = 100;
/** Default page size for `listHistory`/`listAll`. */
const DEFAULT_HISTORY_LIMIT = 50;

/** Maximum Rupiah amount; used to validate payment amounts on write. */
const MAX_AMOUNT = 999999999;

/**
 * Bounded MongoClient timeouts suitable for a single Render instance: a small
 * connection pool, short server-selection/socket timeouts, and a connect
 * timeout so an unreachable Atlas cluster fails fast instead of hanging boot.
 *
 * @type {{ serverSelectionTimeoutMs: number, socketTimeoutMs: number, connectTimeoutMs: number, maxPoolSize: number }}
 */
const CLIENT_TIMEOUTS = Object.freeze({
  serverSelectionTimeoutMs: 5000,
  socketTimeoutMs: 30000,
  connectTimeoutMs: 5000,
  maxPoolSize: 10,
});

/**
 * Determine whether a thrown error is a MongoDB duplicate-key write error
 * (error code 11000). Used to translate unique-index violations into the stable
 * domain Result codes (`AMOUNT_IN_USE`, `TX_ALREADY_SETTLED`, ...).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isDuplicateKeyError(err) {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  const e = /** @type {{ code?: number, name?: string }} */ (err);
  return e.code === 11000 || e.name === 'MongoServerError' && e.code === 11000;
}

/**
 * Read the field of a duplicate-key error that names the violated index, when
 * the driver populates it. Used by `markPaid` to distinguish a `tx_id` collision
 * from a (very unlikely) `_id` collision.
 *
 * @param {unknown} err
 * @returns {string|null}
 */
function duplicateKeyIndex(err) {
  if (err === null || typeof err !== 'object') {
    return null;
  }
  const e = /** @type {{ indexCatalog?: Record<string, unknown>, keyValue?: Record<string, unknown>, errmsg?: string }} */ (err);
  if (e.keyValue && typeof e.keyValue === 'object') {
    const keys = Object.keys(e.keyValue);
    if (keys.length > 0) {
      return keys[0];
    }
  }
  if (typeof e.errmsg === 'string') {
    // Best-effort parse of older server error messages: "E11000 duplicate key
    // error collection: db.col index: uniq_tx_id dup key: { tx_id: \"x\" }".
    const match = e.errmsg.match(/index:\s+(\S+)\s+dup key/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Normalize pagination options to safe integer bounds. A missing/invalid limit
 * falls back to `defaultLimit` and is clamped to 1..{@link MAX_LIST_LIMIT}; a
 * missing/negative offset falls back to 0.
 *
 * @param {{ limit?: number, offset?: number }} [options]
 * @param {number} defaultLimit
 * @returns {{ limit: number, offset: number }}
 */
function normalizePagination(options = {}, defaultLimit = DEFAULT_LIST_LIMIT) {
  let limit = Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    limit = defaultLimit;
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
 * Validate a pending-payment input before it is written. Mirrors the CHECK
 * constraints the SQLite schema applies so an invalid value surfaces as a throw
 * here (translated to a Result by the caller where appropriate) rather than
 * being silently persisted.
 *
 * @param {import('../storage-interface.js').PendingPaymentInput} payment
 * @returns {void}
 * @throws {Error} when the amount or required fields are invalid.
 */
function validatePendingPayment(payment) {
  if (payment === null || typeof payment !== 'object') {
    throw new Error('Pending payment must be an object.');
  }
  if (!Number.isInteger(payment.amount) || payment.amount < 1 || payment.amount > MAX_AMOUNT) {
    throw new Error(`Invalid payment amount: ${payment.amount}.`);
  }
  if (typeof payment.id !== 'string' || payment.id.length === 0) {
    throw new Error('Payment id is required.');
  }
  if (typeof payment.qris_string !== 'string' || payment.qris_string.length === 0) {
    throw new Error('Payment qris_string is required.');
  }
}

// ---------------------------------------------------------------------------
// Mapping (document <-> domain). Mongo-specific fields NEVER leave the DAL.
// ---------------------------------------------------------------------------

/**
 * Map a stored payment document to the public {@link Payment} shape, replacing
 * MongoDB's omission/`undefined` with explicit `null` for nullable fields and
 * stripping the internal `terminal_at` field used to support indexes.
 *
 * @param {Record<string, any>|null} doc
 * @returns {import('../storage-interface.js').Payment|null}
 */
function toPayment(doc) {
  if (!doc) {
    return null;
  }
  return {
    id: doc._id,
    amount: doc.amount,
    status: doc.status,
    qris_string: doc.qris_string,
    qris_url: doc.qris_url ?? null,
    created_at: doc.created_at,
    expires_at: doc.expires_at,
    timeout: doc.timeout,
    tolerance: doc.tolerance,
    webhook_url: doc.webhook_url ?? null,
    tx_id: doc.tx_id ?? null,
    paid_amount: doc.paid_amount ?? null,
    paid_at: doc.paid_at ?? null,
    tx_raw: doc.tx_raw ?? null,
    tz: doc.tz ?? null,
    request_hash: doc.request_hash ?? null,
    notification_state: doc.notification_state ?? null,
    notification_attempts: doc.notification_attempts ?? 0,
    notification_next_at: doc.notification_next_at ?? 0,
    notification_lease: doc.notification_lease ?? null,
    notification_lease_until: doc.notification_lease_until ?? null,
    notification_request: doc.notification_request ?? null,
  };
}

/**
 * Map a stored API-key document to the public {@link ApiKeyRecord} shape.
 *
 * @param {Record<string, any>|null} doc
 * @returns {import('../storage-interface.js').ApiKeyRecord|null}
 */
function toApiKeyRecord(doc) {
  if (!doc) {
    return null;
  }
  return {
    id: doc._id,
    key_hash: doc.key_hash,
    key_prefix: doc.key_prefix,
    status: doc.status,
    created_at: doc.created_at,
    revoked_at: doc.revoked_at ?? null,
  };
}

/**
 * Map a stored API-key document to the masked {@link MaskedApiKey} shape (no
 * hash).
 *
 * @param {Record<string, any>} doc
 * @returns {import('../storage-interface.js').MaskedApiKey}
 */
function toMaskedApiKey(doc) {
  return {
    id: doc._id,
    key_prefix: doc.key_prefix,
    status: doc.status,
    created_at: doc.created_at,
    revoked_at: doc.revoked_at ?? null,
  };
}

/**
 * Map a stored admin-user document to the public {@link AdminUser} shape.
 *
 * @param {Record<string, any>|null} doc
 * @returns {import('../storage-interface.js').AdminUser|null}
 */
function toAdminUser(doc) {
  if (!doc) {
    return null;
  }
  return {
    id: doc._id,
    username: doc.username,
    password_hash: doc.password_hash,
  };
}

/**
 * Map a stored webhook-log document to the plain row shape the SQLite adapter
 * returns from `listByPayment`.
 *
 * @param {Record<string, any>} doc
 * @returns {Record<string, any>}
 */
function toWebhookLogRow(doc) {
  return {
    id: doc._id,
    payment_id: doc.payment_id,
    target_url: doc.target_url,
    status: doc.status,
    attempts: doc.attempts,
    last_attempt_at: doc.last_attempt_at,
    last_error: doc.last_error ?? null,
    response_status: doc.response_status ?? null,
    response_body: doc.response_body ?? null,
    request_body: doc.request_body ?? null,
  };
}

// ---------------------------------------------------------------------------
// Index creation
// ---------------------------------------------------------------------------

/**
 * Named index definitions, keyed by the index `name` so that re-running
 * `createIndexes` is idempotent. The driver's `createIndex` is itself
 * idempotent on name *as long as the existing index matches*; when the spec
 * differs the server returns an error, which is exactly the fail-fast behaviour
 * the plan requires.
 *
 * @returns {Promise<void>}
 * @param {import('mongodb').Db} db
 */
async function createIndexes(db) {
  const payments = db.collection('payments');
  await payments.createIndex({ notification_state: 1, notification_next_at: 1, notification_lease_until: 1 },
    { name: 'idx_notification_due' });

  // Pending-amount allocation: unique amount among pending rows. Also backs the
  // candidate amount range scan (the same index serves both because it is
  // ordered on `amount`).
  await payments.createIndex(
    { amount: 1 },
    { name: 'uniq_pending_amount', unique: true, partialFilterExpression: { status: 'pending' } },
  );

  // Settlement idempotency: one tx_id settles at most one payment.
  await payments.createIndex(
    { tx_id: 1 },
    {
      name: 'uniq_tx_id',
      unique: true,
      partialFilterExpression: { tx_id: { $type: 'string' } },
    },
  );

  // Active listing + expiry scan.
  await payments.createIndex(
    { status: 1, expires_at: 1, _id: 1 },
    { name: 'idx_active_expires' },
  );

  // Unfiltered payment pagination.
  await payments.createIndex(
    { created_at: -1, _id: -1 },
    { name: 'idx_payments_created_id' },
  );

  // Status-filtered pagination.
  await payments.createIndex(
    { status: 1, created_at: -1, _id: -1 },
    { name: 'idx_payments_status_created_id' },
  );

  // Terminal history. Sparse so pending rows (no `terminal_at`) are excluded.
  await payments.createIndex(
    { terminal_at: -1, created_at: -1, _id: -1 },
    { name: 'idx_payments_history_sort', sparse: true },
  );

  // Maximum active tolerance scalar query.
  await payments.createIndex(
    { status: 1, tolerance: -1 },
    { name: 'idx_payments_status_tolerance' },
  );

  const apiKeys = db.collection('api_keys');
  await apiKeys.createIndex({ key_hash: 1 }, { name: 'uniq_key_hash', unique: true });
  await apiKeys.createIndex(
    { created_at: -1, _id: -1 },
    { name: 'idx_api_keys_created_id' },
  );

  const webhookLogs = db.collection('webhook_delivery_logs');
  await webhookLogs.createIndex(
    { payment_id: 1, last_attempt_at: 1, _id: 1 },
    { name: 'idx_webhook_logs_payment' },
  );
  await webhookLogs.createIndex(
    { last_attempt_at: 1 },
    { name: 'idx_webhook_logs_retention' },
  );

  await db.collection('admin_users').createIndex(
    { username: 1 },
    { name: 'uniq_admin_username', unique: true },
  );
}

// ---------------------------------------------------------------------------
// Login-failure policy (mirrors admin-auth's fixed-window policy). Kept here so
// the atomic recordFailure stays self-contained.
// ---------------------------------------------------------------------------

/**
 * Apply the fixed-window login-failure policy to the previous state and the
 * current attempt. Same algorithm as the SQLite adapter and the Admin_Auth
 * layer: first failure opens a window ending at `now + windowMs`; further
 * failures inside that window increment without extending it; reaching the
 * threshold escalates to a hard block ending at `now + lockoutMs`; a failure
 * after the previous window/block elapsed starts a fresh window.
 *
 * Exported so the contract test can cross-check the atomic
 * `recordFailure` aggregation pipeline against this reference implementation.
 *
 * @param {{ failedAttempts: number, lockoutUntil: number|null }|null} state
 * @param {import('../storage-interface.js').LoginFailurePolicy} policy
 * @returns {{ failedAttempts: number, lockoutUntil: number|null }}
 */
export function applyFailurePolicy(state, policy) {
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
    windowEnd = prevUntil;
  } else {
    failedAttempts = 1;
    windowEnd = now + windowMs;
  }

  const lockoutUntil =
    failedAttempts >= threshold ? now + lockoutMs : windowEnd;

  return { failedAttempts, lockoutUntil };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * The index specifications, in declaration order. Exported only so the test
 * suite can assert the named indexes exist and `explain` queries against them.
 *
 * @type {ReadonlyArray<{ collection: string, name: string }>}
 */
export const PAYMENT_INDEXES = Object.freeze([
  { collection: 'payments', name: 'uniq_pending_amount' },
  { collection: 'payments', name: 'uniq_tx_id' },
  { collection: 'payments', name: 'idx_active_expires' },
  { collection: 'payments', name: 'idx_payments_created_id' },
  { collection: 'payments', name: 'idx_payments_status_created_id' },
  { collection: 'payments', name: 'idx_payments_history_sort' },
  { collection: 'payments', name: 'idx_payments_status_tolerance' },
]);

/**
 * Construct a MongoDB-backed implementation of the `Storage` contract.
 *
 * One `MongoClient` is opened per storage instance, the indexes are created
 * idempotently, and the connection is kept open until {@link close} is called.
 *
 * @param {{ uri: string, dbName?: string }} options - the connection URI
 *   (must include a database name) and an optional explicit database name.
 * @returns {Promise<import('../storage-interface.js').Storage>}
 * @throws {Error} when the URI is missing or the connection/indexes fail.
 */
export async function createMongoStorage(options) {
  if (!options || typeof options.uri !== 'string' || options.uri.length === 0) {
    throw new Error('createMongoStorage requires a MongoDB `uri`.');
  }

  const client = new MongoClient(options.uri, CLIENT_TIMEOUTS);
  // The Node driver throws on `connect` when the URI is malformed or the server
  // is unreachable; that error propagates to the caller and stops boot.
  await client.connect();
  const db = client.db(options.dbName);

  try {
    // Create indexes idempotently before reporting readiness. An existing index
    // with a conflicting definition makes `createIndex` throw here — fail-fast
    // at boot is exactly the required behaviour. If this throws, close the
    // client so a failed startup does not leak the connection.
    await createIndexes(db);
  } catch (err) {
    try {
      await client.close();
    } catch {
      // Swallow a close failure so the original index/connect error propagates
      // unmodified (it is the more actionable signal for the operator).
    }
    throw err;
  }

  // Collection handles. The driver lazily creates a collection on first write,
  // so these references are always valid even when the database is empty.
  const paymentsCol = db.collection('payments');
  const apiKeysCol = db.collection('api_keys');
  const webhookLogsCol = db.collection('webhook_delivery_logs');
  const adminUsersCol = db.collection('admin_users');
  const loginAttemptsCol = db.collection('login_attempts');
  const configCol = db.collection('config');

  // ---- payments store -------------------------------------------------------

  /**
   * @param {import('../storage-interface.js').PendingPaymentInput} payment
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').Payment>>}
   */
  async function insertPending(payment) {
    validatePendingPayment(payment);
    const doc = {
      _id: payment.id,
      amount: payment.amount,
      status: 'pending',
      qris_string: payment.qris_string,
      qris_url: payment.qris_url ?? null,
      created_at: payment.created_at,
      expires_at: payment.expires_at,
      timeout: payment.timeout,
      tolerance: payment.tolerance ?? 0,
      webhook_url: payment.webhook_url ?? null,
      // tx_id / paid_* are absent while pending so the partial unique index on
      // tx_id excludes this row.
      tz: payment.tz ?? null,
      request_hash: payment.request_hash ?? null,
      // terminal_at is absent while pending (sparse history index excludes it).
    };
    try {
      await paymentsCol.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        if (payment.request_hash) {
          const existing = await paymentsCol.findOne({ _id: payment.id });
          if (existing) return existing.request_hash === payment.request_hash
            ? { ok: true, value: toPayment(existing) } : { ok: false, code: 'IDEMPOTENCY_CONFLICT' };
        }
        // The only unique index a fresh pending row can trip is
        // `uniq_pending_amount` (the automatic `_id` index would only trip on a
        // duplicate id, which is a caller bug — surface as AMOUNT_IN_USE for the
        // amount case, and rethrow for the id case so the caller learns).
        const idx = duplicateKeyIndex(err);
        if (idx === '_id' || (idx === null && payment.id)) {
          // Conservative: if the duplicate is provably on `_id`, rethrow; if we
          // cannot tell, the pending-amount index is the only partial unique
          // index on this collection, so treat it as an amount collision.
          // Re-reading the row disambiguates: if a row with this id already
          // exists, it was an _id collision.
          const existing = await paymentsCol.findOne({ _id: payment.id }, { projection: { _id: 1 } });
          if (existing) {
            throw err;
          }
        }
        return { ok: false, code: 'AMOUNT_IN_USE' };
      }
      throw err;
    }
    return { ok: true, value: toPayment(doc) };
  }

  /**
   * @param {string} id
   * @returns {Promise<import('../storage-interface.js').Payment|null>}
   */
  async function getById(id) {
    return toPayment(await paymentsCol.findOne({ _id: id }));
  }

  /**
   * @param {import('../storage-interface.js').ListOptions} [options]
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function listActive(options) {
    const { limit, offset } = normalizePagination(options, DEFAULT_LIST_LIMIT);
    const docs = await paymentsCol
      .find({ status: 'pending' })
      .sort({ expires_at: 1, _id: 1 })
      .limit(limit)
      .skip(offset)
      .toArray();
    return docs.map(toPayment);
  }

  /**
   * @param {import('../storage-interface.js').ListOptions} [options]
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function listHistory(options) {
    const { limit, offset } = normalizePagination(options, DEFAULT_HISTORY_LIMIT);
    // Terminal rows carry `terminal_at`; sort by it (then created_at, then id)
    // so recently settled/expired payments surface first — mirroring SQLite's
    // COALESCE(paid_at, created_at) ordering.
    const docs = await paymentsCol
      .find({ status: { $in: ['paid', 'expired'] } })
      .sort({ terminal_at: -1, created_at: -1, _id: -1 })
      .limit(limit)
      .skip(offset)
      .toArray();
    return docs.map(toPayment);
  }

  /**
   * @param {{ status?: ('pending'|'paid'|'expired'|null), limit?: number, offset?: number, id?: string, date?: { start: number, end: number } }} [options]
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function listAll(options = {}) {
    const { limit, offset } = normalizePagination(options, DEFAULT_HISTORY_LIMIT);
    const filter = buildListAllFilter(options);
    const docs = await paymentsCol
      .find(filter)
      .sort({ created_at: -1, _id: -1 })
      .limit(limit)
      .skip(offset)
      .toArray();
    return docs.map(toPayment);
  }

  /**
   * @param {{ status?: ('pending'|'paid'|'expired'|null), id?: string, date?: { start: number, end: number } }} [options]
   * @returns {Promise<number>}
   */
  async function countAll(options = {}) {
    const filter = buildListAllFilter(options);
    return paymentsCol.countDocuments(filter);
  }

  /**
   * Atomically settle a payment with one `findOneAndUpdate` filtered by id and
   * `status: 'pending'`. The settlement fields and `terminal_at` are written in
   * that single update. A unique-index violation on `tx_id` (from the
   * `uniq_tx_id` partial index) is translated to `TX_ALREADY_SETTLED`. When no
   * pending payment matches, we look up the tx_id to distinguish
   * `TX_ALREADY_SETTLED` (it exists on a different payment) from
   * `PAYMENT_NOT_PENDING`.
   *
   * @param {string} id
   * @param {import('../storage-interface.js').SettlementInput} settlement
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').Payment>>}
   */
  async function markPaid(id, settlement) {
    try {
      const updated = await paymentsCol.findOneAndUpdate(
        { _id: id, status: 'pending' },
        {
          $set: {
            status: 'paid',
            notification_state: 'pending', notification_attempts: 0, notification_next_at: 0,
            tx_id: settlement.txId,
            paid_amount: settlement.paidAmount,
            paid_at: settlement.paidAt,
            tx_raw: settlement.raw ?? null,
            // terminal_at set to paid_at so the history index orders by
            // settlement time (matching SQLite's COALESCE(paid_at, created_at)).
            terminal_at: settlement.paidAt,
          },
        },
        { returnDocument: 'after' },
      );
      if (updated) {
        return { ok: true, value: toPayment(updated) };
      }
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // The tx_id already exists on another payment.
        return { ok: false, code: 'TX_ALREADY_SETTLED' };
      }
      throw err;
    }

    // No pending payment matched. Distinguish TX_ALREADY_SETTLED (the tx_id is
    // already on some other payment) from PAYMENT_NOT_PENDING.
    const owner = await paymentsCol.findOne(
      { tx_id: settlement.txId },
      { projection: { _id: 1 } },
    );
    if (owner) {
      return { ok: false, code: 'TX_ALREADY_SETTLED' };
    }
    return { ok: false, code: 'PAYMENT_NOT_PENDING' };
  }

  /**
   * @param {number} now
   * @returns {Promise<number>}
   */
  async function expireOverdue(now) {
    // Use an aggregation-pipeline update so `terminal_at` can copy `created_at`
    // (a `$set` with `$created_at` only resolves inside an array pipeline).
    const result = await paymentsCol.updateMany(
      { status: 'pending', expires_at: { $lt: now } },
      [
        {
          $set: {
            status: 'expired',
            notification_state: 'pending', notification_attempts: 0, notification_next_at: 0,
            // terminal_at = created_at for expired payments, so the history
            // index surfaces them by creation time (matching SQLite's COALESCE
            // fallback to created_at).
            terminal_at: '$created_at',
          },
        },
      ],
    );
    return result.modifiedCount;
  }

  /**
   * Transition overdue pending payments to `expired` one document at a time via
   * conditional `findOneAndUpdate`, returning the rows THIS call actually
   * transitioned. Because the filter requires `status: 'pending'`, an
   * overlapping caller cannot win the same row twice — so each returned payment
   * is a transition won by this caller and an expiry side effect can fire
   * exactly once.
   *
   * `terminal_at` is set to `created_at` for expired payments (the history index
   * then orders them by creation time, mirroring SQLite's COALESCE).
   *
   * @param {number} now
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function expireOverdueReturning(now) {
    /** @type {import('../storage-interface.js').Payment[]} */
    const expired = [];
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const doc = await paymentsCol.findOneAndUpdate(
        { status: 'pending', expires_at: { $lt: now } },
        [
          {
            $set: {
              status: 'expired',
              notification_state: 'pending', notification_attempts: 0, notification_next_at: 0,
              // Use an aggregation pipeline so terminal_at can copy created_at.
              terminal_at: '$created_at',
            },
          },
        ],
        { returnDocument: 'after' },
      );
      if (!doc) {
        break;
      }
      expired.push(/** @type {import('../storage-interface.js').Payment} */ (toPayment(doc)));
    }
    return expired;
  }

  /**
   * @returns {Promise<number>}
   */
  async function countActive() {
    return paymentsCol.countDocuments({ status: 'pending' });
  }

  /**
   * @param {number} minAmount
   * @param {number} maxAmount
   * @returns {Promise<import('../storage-interface.js').Payment[]>}
   */
  async function findCandidatesByAmount(minAmount, maxAmount) {
    const docs = await paymentsCol
      .find({
        status: 'pending',
        amount: { $gte: minAmount, $lte: maxAmount },
      })
      .sort({ created_at: 1, _id: 1 })
      .toArray();
    return docs.map(toPayment);
  }

  /**
   * @returns {Promise<number>}
   */
  async function maxActiveTolerance() {
    const docs = await paymentsCol
      .find({ status: 'pending' })
      .sort({ tolerance: -1 })
      .limit(1)
      .project({ tolerance: 1, _id: 0 })
      .toArray();
    if (docs.length === 0) {
      return 0;
    }
    const m = docs[0].tolerance;
    return Number.isFinite(m) ? m : 0;
  }

  // ---- config store ---------------------------------------------------------

  /**
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async function configGet(key) {
    const doc = await configCol.findOne({ _id: key });
    return doc ? doc.value : null;
  }

  /**
   * @param {string} key
   * @param {string} value
   * @returns {Promise<import('../storage-interface.js').Result>}
   */
  async function configSet(key, value) {
    await configCol.updateOne(
      { _id: key },
      { $set: { value } },
      { upsert: true },
    );
    return { ok: true };
  }

  // ---- apiKeys store --------------------------------------------------------

  /**
   * @param {import('../storage-interface.js').ApiKeyCreateInput} input
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').ApiKeyRecord>>}
   */
  async function apiKeyCreate(input) {
    const doc = {
      _id: input.id,
      key_hash: input.keyHash,
      key_prefix: input.keyPrefix,
      status: 'active',
      created_at: input.createdAt,
      revoked_at: null,
    };
    try {
      await apiKeysCol.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const idx = duplicateKeyIndex(err);
        if (idx === 'uniq_key_hash') {
          return { ok: false, code: 'KEY_HASH_IN_USE' };
        }
        // `_id` collision (duplicate id): surface as KEY_HASH_IN_USE too so the
        // API-key manager retries generation, matching SQLite behaviour where
        // both unique constraints map to the same retry signal.
        return { ok: false, code: 'KEY_HASH_IN_USE' };
      }
      throw err;
    }
    return { ok: true, value: toApiKeyRecord(doc) };
  }

  /**
   * @param {string} keyHash
   * @returns {Promise<import('../storage-interface.js').ApiKeyRecord|null>}
   */
  async function apiKeyGetActiveByHash(keyHash) {
    return toApiKeyRecord(
      await apiKeysCol.findOne({ key_hash: keyHash, status: 'active' }),
    );
  }

  /**
   * @param {string} id
   * @param {number} revokedAt
   * @returns {Promise<import('../storage-interface.js').Result<import('../storage-interface.js').ApiKeyRecord>>}
   */
  async function apiKeyRevoke(id, revokedAt) {
    const updated = await apiKeysCol.findOneAndUpdate(
      { _id: id, status: 'active' },
      { $set: { status: 'revoked', revoked_at: revokedAt } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      return { ok: false, code: 'KEY_NOT_REVOCABLE' };
    }
    return { ok: true, value: toApiKeyRecord(updated) };
  }

  /**
   * @returns {Promise<import('../storage-interface.js').MaskedApiKey[]>}
   */
  async function apiKeyListMasked() {
    const docs = await apiKeysCol
      .find({})
      .sort({ created_at: -1, _id: -1 })
      .project({ key_hash: 0 })
      .toArray();
    return docs.map(toMaskedApiKey);
  }

  // ---- webhookLogs store ----------------------------------------------------

  /**
   * @param {import('../storage-interface.js').WebhookLogEntry} entry
   * @returns {Promise<import('../storage-interface.js').Result>}
   */
  async function webhookLogAppend(entry) {
    await webhookLogsCol.insertOne({
      _id: entry.id,
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
   * @param {string} id
   * @returns {Promise<import('../storage-interface.js').Result>}
   */
  async function webhookLogMarkPermanentFailure(id) {
    const result = await webhookLogsCol.updateOne(
      { _id: id },
      { $set: { status: 'failed_permanent' } },
    );
    if (result.matchedCount === 0) {
      return { ok: false, code: 'LOG_NOT_FOUND' };
    }
    return { ok: true };
  }

  /**
   * @param {string} paymentId
   * @returns {Promise<Array<Record<string, any>>>}
   */
  async function webhookLogListByPayment(paymentId) {
    const docs = await webhookLogsCol
      .find({ payment_id: paymentId })
      .sort({ last_attempt_at: 1, _id: 1 })
      .toArray();
    return docs.map(toWebhookLogRow);
  }

  /**
   * @param {number} cutoff
   * @returns {Promise<number>}
   */
  async function webhookLogPruneOld(cutoff) {
    const result = await webhookLogsCol.deleteMany({ last_attempt_at: { $lt: cutoff } });
    return result.deletedCount;
  }

  // ---- adminUsers store -----------------------------------------------------

  /**
   * @param {string} username
   * @returns {Promise<import('../storage-interface.js').AdminUser|null>}
   */
  async function adminGetByUsername(username) {
    return toAdminUser(await adminUsersCol.findOne({ username }));
  }

  /**
   * Idempotent insert-if-absent. When the username already exists the stored
   * password hash is LEFT UNCHANGED and `{ created: false }` is resolved. When a
   * new row is inserted `{ created: true }` is resolved. The `username` UNIQUE
   * index makes a concurrent double-insert fail with a duplicate-key error,
   * which is also reported as `{ created: false }` (the other caller won).
   *
   * @param {import('../storage-interface.js').EnsureAdminInput} input
   * @returns {Promise<import('../storage-interface.js').Result<{ created: boolean }>>}
   */
  async function adminEnsure(input) {
    try {
      await adminUsersCol.insertOne({
        _id: input.id,
        username: input.username,
        password_hash: input.passwordHash,
      });
      return { ok: true, value: { created: true } };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        return { ok: true, value: { created: false } };
      }
      throw err;
    }
  }

  /**
   * List every admin username. Returns only usernames (no password hashes),
   * ordered alphabetically. Used by the out-of-band management CLI.
   *
   * @returns {Promise<Array<{ username: string }>>}
   */
  async function adminListUsernames() {
    const docs = await adminUsersCol
      .find({})
      .project({ username: 1, _id: 0 })
      .sort({ username: 1 })
      .toArray();
    return docs.map((d) => ({ username: d.username }));
  }

  /**
   * Update an existing admin user's password hash and/or rename it.
   *
   * Rename-target clash detection: when renaming, first check the target
   * username is free. The `uniq_admin_username` index still makes a true race
   * produce a duplicate-key error, which we map to `USERNAME_IN_USE` so a
   * concurrent insert cannot leave the operation half-applied. A missing admin
   * yields `ADMIN_NOT_FOUND`.
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
      const existing = await adminUsersCol.findOne({ username: input.currentUsername });
      if (!existing) {
        return { ok: false, code: 'ADMIN_NOT_FOUND' };
      }
      return { ok: true, value: toAdminUser(existing) };
    }

    // Rename clash guard (the unique index still defends against races).
    if (renameTo !== null) {
      const clash = await adminUsersCol.findOne({ username: renameTo }, { projection: { _id: 1 } });
      if (clash) {
        return { ok: false, code: 'USERNAME_IN_USE' };
      }
    }

    /** @type {Record<string, unknown>} */
    const set = {};
    if (renameTo !== null) set.username = renameTo;
    if (newPasswordHash !== null) set.password_hash = newPasswordHash;

    try {
      const updated = await adminUsersCol.findOneAndUpdate(
        { username: input.currentUsername },
        { $set: set },
        { returnDocument: 'after' },
      );
      if (!updated) {
        return { ok: false, code: 'ADMIN_NOT_FOUND' };
      }
      return { ok: true, value: toAdminUser(updated) };
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // A concurrent caller grabbed the target username between our check and
        // the update.
        return { ok: false, code: 'USERNAME_IN_USE' };
      }
      throw err;
    }
  }

  // ---- loginAttempts store --------------------------------------------------

  /**
   * @param {string} ipAddress
   * @returns {Promise<{ failedAttempts: number, lockoutUntil: number|null }|null>}
   */
  async function loginAttemptsGetByIp(ipAddress) {
    const doc = await loginAttemptsCol.findOne({ _id: ipAddress });
    if (!doc) {
      return null;
    }
    return { failedAttempts: doc.failed_attempts, lockoutUntil: doc.lockout_until ?? null };
  }

  /**
   * Apply the fixed-window failure policy atomically. The previous counters are
   * read, the policy is applied, and the new state is written in ONE
   * `findOneAndUpdate` whose update is an aggregation pipeline — so the whole
   * read/compute/write happens atomically on a single document. Two concurrent
   * failures for the same IP therefore cannot read the same counter and
   * overwrite each other: each call observes the previous call's write and
   * increments past it, so the threshold cannot be bypassed by racing callers.
   *
   * The pipeline mirrors {@link applyFailurePolicy} exactly (same fixed-window
   * semantics). It is expressed with `$cond`/`$ifNull` so the new
   * `failed_attempts` and `lockout_until` are computed server-side from the
   * stored document and the supplied policy values. When no document matches,
   * `upsert` seeds `_id` and the pipeline treats the missing prior state as
   * null/0 (first failure opens a fresh window).
   *
   * @param {string} ipAddress
   * @param {import('../storage-interface.js').LoginFailurePolicy} policy
   * @returns {Promise<import('../storage-interface.js').Result<{ failedAttempts: number, lockoutUntil: number|null }>>}
   */
  async function loginAttemptsRecordFailure(ipAddress, policy) {
    const { now, windowMs, threshold, lockoutMs } = policy;

    // Aggregate-pipeline update. `$ifNull` defaults a missing document's prior
    // counters so the same pipeline serves the first failure (no row yet) and
    // every subsequent one. The two `$cond` blocks mirror applyFailurePolicy:
    //   withinOpenWindow => increment without extending the window
    //   otherwise        => open a fresh window at now + windowMs with count 1
    //   lockoutUntil     => escalate to now + lockoutMs once the threshold lands
    const updated = await loginAttemptsCol.findOneAndUpdate(
      { _id: ipAddress },
      [
        {
          $set: {
            prev_attempts: { $ifNull: ['$failed_attempts', 0] },
            prev_until: { $ifNull: ['$lockout_until', null] },
          },
        },
        {
          $set: {
            within_open_window: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$prev_until', null] },
                    { $lt: [now, '$prev_until'] },
                    { $gt: ['$prev_attempts', 0] },
                  ],
                },
                true,
                false,
              ],
            },
          },
        },
        {
          $set: {
            window_end: {
              $cond: ['$within_open_window', '$prev_until', { $add: [now, windowMs] }],
            },
          },
        },
        {
          $set: {
            failed_attempts: {
              $cond: ['$within_open_window', { $add: ['$prev_attempts', 1] }, 1],
            },
          },
        },
        {
          $set: {
            lockout_until: {
              $cond: [
                {
                  $gte: [
                    {
                      $cond: [
                        '$within_open_window',
                        { $add: ['$prev_attempts', 1] },
                        1,
                      ],
                    },
                    threshold,
                  ],
                },
                { $add: [now, lockoutMs] },
                '$window_end',
              ],
            },
          },
        },
        {
          // Drop the intermediate fields so only the public counters persist.
          $unset: ['prev_attempts', 'prev_until', 'within_open_window', 'window_end'],
        },
      ],
      { upsert: true, returnDocument: 'after' },
    );

    const next = {
      failedAttempts: updated.failed_attempts,
      lockoutUntil: updated.lockout_until ?? null,
    };
    return { ok: true, value: next };
  }

  /**
   * @param {string} ipAddress
   * @returns {Promise<import('../storage-interface.js').Result>}
   */
  async function loginAttemptsResetFailures(ipAddress) {
    await loginAttemptsCol.updateOne(
      { _id: ipAddress },
      { $set: { failed_attempts: 0, lockout_until: null } },
      { upsert: true },
    );
    return { ok: true };
  }

  /**
   * @param {string} ipAddress
   * @param {number} now
   * @returns {Promise<boolean>}
   */
  async function loginAttemptsIsLockedOut(ipAddress, now) {
    const doc = await loginAttemptsCol.findOne({ _id: ipAddress });
    if (!doc) {
      return false;
    }
    return (
      doc.lockout_until != null &&
      doc.failed_attempts >= LOGIN_THRESHOLD &&
      now < (doc.lockout_until ?? 0)
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
    const result = await loginAttemptsCol.deleteMany({});
    return result.deletedCount;
  }

  // ---- top-level lifecycle --------------------------------------------------

  /** @type {boolean} tracks whether {@link close} has already been invoked. */
  let closed = false;

  /**
   * Readiness probe: run the driver's `command` to confirm the cluster answers.
   * Used by `/health/ready`.
   *
   * @returns {Promise<void>}
   */
  async function ping() {
    if (closed) {
      throw new Error('MongoDB client is closed.');
    }
    // `db.command` throws on a connection/server-selection failure, which is
    // exactly what the readiness probe needs to report 503.
    await db.command({ ping: 1 });
  }

  /**
   * Close the underlying `MongoClient`. Idempotent: a second call is a no-op.
   *
   * @returns {Promise<void>}
   */
  async function close() {
    if (closed) {
      return;
    }
    closed = true;
    await client.close();
  }

  // ---- assemble the Storage object -----------------------------------------

  const notifications = {
    async claim(now, leaseUntil, token) {
      return toPayment(await paymentsCol.findOneAndUpdate({
        notification_state: 'pending', notification_next_at: { $lte: now },
        $or: [{ notification_lease_until: null }, { notification_lease_until: { $lte: now } }],
      }, { $set: { notification_lease: token, notification_lease_until: leaseUntil } },
      { sort: { notification_next_at: 1, _id: 1 }, returnDocument: 'after' }));
    },
    async saveRequest(id, token, request) {
      const result = await paymentsCol.updateOne({ _id: id, notification_lease: token },
        { $set: { notification_request: request } });
      return result.matchedCount > 0;
    },
    async finish(id, token, { state, attempts, nextAt }) {
      const result = await paymentsCol.updateOne({ _id: id, notification_lease: token },
        { $set: { notification_state: state, notification_attempts: attempts, notification_next_at: nextAt },
          $unset: { notification_lease: '', notification_lease_until: '' } });
      return result.matchedCount > 0;
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
      oldestActiveCreation: async () => (await paymentsCol.findOne({ status: 'pending' }, { sort: { created_at: 1 }, projection: { created_at: 1 } }))?.created_at ?? null,
      findCandidatesByAmount,
      maxActiveTolerance,
    },
    apiKeys: {
      create: apiKeyCreate,
      getActiveByHash: apiKeyGetActiveByHash,
      revoke: apiKeyRevoke,
      listMasked: apiKeyListMasked,
    },
    webhookLogs: {
      append: webhookLogAppend,
      markPermanentFailure: webhookLogMarkPermanentFailure,
      listByPayment: webhookLogListByPayment,
      pruneOld: webhookLogPruneOld,
    },
    adminUsers: {
      getByUsername: adminGetByUsername,
      ensure: adminEnsure,
      listUsernames: adminListUsernames,
      updateCredentials: adminUpdateCredentials,
    },
    loginAttempts: {
      getByIp: loginAttemptsGetByIp,
      recordFailure: loginAttemptsRecordFailure,
      resetFailures: loginAttemptsResetFailures,
      isLockedOut: loginAttemptsIsLockedOut,
      clearAll: loginAttemptsClearAll,
    },
    config: {
      get: configGet,
      set: configSet,
    },
    ping,
    close,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers exposed for internal reuse
// ---------------------------------------------------------------------------

/**
 * Build the MongoDB filter for `listAll`/`countAll` from the optional status,
 * id-prefix, and created_at range filters. A prefix search uses an escaped,
 * anchored, case-sensitive regex so the `_id` index remains usable.
 *
 * @param {{ status?: ('pending'|'paid'|'expired'|null), id?: string, date?: { start: number, end: number } }} options
 * @returns {Record<string, unknown>}
 */
function buildListAllFilter(options) {
  /** @type {Record<string, unknown>} */
  const filter = {};
  if (options.status) {
    filter.status = options.status;
  }
  if (options.id) {
    filter._id = { $regex: '^' + escapeRegex(options.id) };
  }
  if (options.date && Number.isFinite(options.date.start) && Number.isFinite(options.date.end)) {
    filter.created_at = { $gte: options.date.start, $lt: options.date.end };
  }
  return filter;
}

/**
 * Escape a string for literal use inside a RegExp.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lockout threshold mirrored from admin-auth.js (5 failures). */
const LOGIN_THRESHOLD = 5;

/**
 * Internal helper exported for tests that want to seed an admin directly via
 * the same id scheme the ensure() operation uses internally.
 *
 * @returns {string}
 */
export function generateMongoAdminId() {
  return randomUUID();
}
