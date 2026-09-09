// Storage contract for the Data Access Layer (DAL).
//
// This module defines the *storage-agnostic* contract that every storage
// backend (SQLite today, MongoDB tomorrow) must implement. It is expressed as
// JSDoc typedefs plus a small runtime validator so that callers never depend on
// SQLite-specific types, query syntax, or connection objects — or MongoDB
// collections, documents, or client handles. No part of this contract leaks
// better-sqlite3 statements, row objects, or PRAGMA details, nor MongoDB
// documents, `MongoClient` instances, or collection handles — only plain
// JavaScript values and the domain types defined below cross the boundary.
//
// Every method is asynchronous: it returns a Promise of its declared result.
// This keeps SQLite (synchronous internally) and MongoDB (asynchronous) behind
// the same boundary, so swapping backends never changes a caller's control
// flow. Awaiting the result is mandatory in production code.

// ---------------------------------------------------------------------------
// Async result type
// ---------------------------------------------------------------------------

/**
 * A Promise of `T`. The storage boundary is uniformly async so the same contract
 * serves both the synchronous SQLite adapter and the asynchronous MongoDB
 * adapter without changing any caller.
 *
 * @template T
 * @typedef {Promise<T>} Awaitable
 */

/**
 * The uniform result returned by write operations that can fail in a
 * domain-meaningful way (for example a unique-amount collision) without
 * throwing. Read operations return their value directly (or `null`) instead of
 * a Result.
 *
 * - `ok: true`  -> the operation succeeded; `value` holds the result (if any).
 * - `ok: false` -> the operation failed; `code` is a stable, storage-agnostic
 *                  error code (e.g. `'AMOUNT_IN_USE'`) and `error` is an
 *                  optional English description.
 *
 * @template [T=unknown]
 * @typedef {Object} Result
 * @property {boolean} ok
 * @property {T} [value]
 * @property {string} [code]
 * @property {string} [error]
 */

// ---------------------------------------------------------------------------
// Domain entities (storage-agnostic shapes)
// ---------------------------------------------------------------------------

/**
 * A payment record. Money values are integers in Rupiah. Timestamps are
 * integer epoch milliseconds. These are plain values, never SQLite rows or
 * MongoDB documents.
 *
 * @typedef {Object} Payment
 * @property {string|null} [request_hash] Fingerprint for client-scoped creation retries.
 * @property {string|null} [notification_state] Durable terminal notification state.
 * @property {number} [notification_attempts] Completed delivery attempts.
 * @property {number} [notification_next_at] Next delivery time, epoch ms.
 * @property {string|null} [notification_lease] Current delivery owner's token.
 * @property {number|null} [notification_lease_until] Lease expiry, epoch ms.
 * @property {string|null} [notification_request] Persisted signed request JSON.
 * @property {string} id
 * @property {number} amount                 Integer Rupiah, 1..999999999.
 * @property {'pending'|'paid'|'expired'} status
 * @property {string} qris_string            The Dynamic_QRIS payload.
 * @property {string|null} qris_url          Optional rendered image reference.
 * @property {number} created_at             Epoch ms.
 * @property {number} expires_at             Epoch ms (created_at + timeout).
 * @property {number} timeout                Milliseconds.
 * @property {number} tolerance              Integer Rupiah, 0..999.
 * @property {string|null} webhook_url       Per-payment override, if any.
 * @property {string|null} tx_id             Settlement transaction id, if paid.
 * @property {number|null} paid_amount       Integer Rupiah, if paid.
 * @property {number|null} paid_at           Epoch ms, if paid.
 * @property {string|null} tx_raw            The raw GoBiz transaction object as a
 *   JSON string captured at settlement, or `null` when not settled/unavailable.
 * @property {string|null} tz                Optional per-Payment IANA display
 *   timezone used to render the Payment's `_iso` timestamp fields, or `null` to
 *   fall back to the server-configured default zone.
 */

/**
 * The input accepted by `payments.insertPending`. The caller supplies a fully
 * formed pending payment; the DAL enforces amount uniqueness among pending
 * payments at insertion time.
 *
 * @typedef {Object} PendingPaymentInput
 * @property {string|null} [request_hash]
 * @property {string} id
 * @property {number} amount
 * @property {string} qris_string
 * @property {string|null} [qris_url]
 * @property {number} created_at
 * @property {number} expires_at
 * @property {number} timeout
 * @property {number} [tolerance]
 * @property {string|null} [webhook_url]
 * @property {string|null} [tz]   Optional per-Payment IANA display timezone.
 */

/**
 * Settlement details supplied to `payments.markPaid`.
 *
 * @typedef {Object} SettlementInput
 * @property {string} txId         The settling transaction id (idempotency key).
 * @property {number} paidAmount   Integer Rupiah actually received.
 * @property {number} paidAt       Epoch ms when settlement was observed.
 * @property {string|null} [raw]   The raw GoBiz transaction object, already
 *   serialized to a JSON string, to persist verbatim into `tx_raw`. Stored as
 *   `null` when absent.
 */

/**
 * Pagination options for list operations.
 *
 * @typedef {Object} ListOptions
 * @property {number} [limit]   Max rows to return (1..100, default 100).
 * @property {number} [offset]  Rows to skip (>= 0, default 0).
 */

/**
 * An API key record as stored by the DAL. The secret value is never stored or
 * returned in plaintext; only its hash and a display prefix are kept.
 *
 * @typedef {Object} ApiKeyRecord
 * @property {string} id
 * @property {string} key_hash
 * @property {string} key_prefix
 * @property {'active'|'revoked'} status
 * @property {number} created_at
 * @property {number|null} revoked_at
 */

/**
 * Input for creating an API key (already hashed by the auth layer).
 *
 * @typedef {Object} ApiKeyCreateInput
 * @property {string} id
 * @property {string} keyHash
 * @property {string} keyPrefix
 * @property {number} createdAt
 */

/**
 * A masked API key suitable for display in the Panel (no hash, no full value).
 *
 * @typedef {Object} MaskedApiKey
 * @property {string} id
 * @property {string} key_prefix
 * @property {'active'|'revoked'} status
 * @property {number} created_at
 * @property {number|null} revoked_at
 */

/**
 * A webhook delivery log entry to append.
 *
 * @typedef {Object} WebhookLogEntry
 * @property {string} id
 * @property {string} payment_id
 * @property {string} target_url
 * @property {'success'|'failed'|'failed_permanent'} status
 * @property {number} attempts
 * @property {number} last_attempt_at
 * @property {string|null} [last_error]
 * @property {number|null} [response_status]  HTTP status of the attempt, or null when the request threw.
 * @property {string|null} [response_body]    Truncated response body text, or null when unavailable.
 * @property {string|null} [request_body]     The JSON request body that was sent.
 */

/**
 * An admin user record.
 *
 * @typedef {Object} AdminUser
 * @property {string} id
 * @property {string} username
 * @property {string} password_hash
 */

/**
 * Input for `adminUsers.ensure`: an idempotent insert-if-absent of the initial
 * admin user. The password is already hashed by the caller.
 *
 * @typedef {Object} EnsureAdminInput
 * @property {string} id
 * @property {string} username
 * @property {string} passwordHash
 */

/**
 * The fixed-window login-failure policy the Admin_Auth layer enforces. The DAL
 * applies it atomically inside `loginAttempts.recordFailure` so concurrent
 * login attempts cannot race past the threshold.
 *
 * @typedef {Object} LoginFailurePolicy
 * @property {number} now             Epoch ms at the attempted login.
 * @property {number} windowMs        Length of the rolling failure window.
 * @property {number} threshold       Failures at/above this trigger a lockout.
 * @property {number} lockoutMs       Length of the lockout once triggered.
 */

// ---------------------------------------------------------------------------
// Storage sub-contracts
// ---------------------------------------------------------------------------

/**
 * Payment persistence operations.
 *
 * @typedef {Object} PaymentsStore
 * @property {(payment: PendingPaymentInput) => Awaitable<Result<Payment>>} insertPending
 *   Insert a new pending payment. On an amount-uniqueness violation among
 *   pending payments, resolves to `{ ok:false, code:'AMOUNT_IN_USE' }` and
 *   stores no partial row.
 * @property {(id: string) => Awaitable<(Payment|null)>} getById
 *   Read a payment by id, or `null` if it does not exist.
 * @property {(options?: ListOptions) => Awaitable<Payment[]>} listActive
 *   List pending payments ordered by `expires_at` ascending.
 * @property {(options?: ListOptions) => Awaitable<Payment[]>} listHistory
 *   List terminal-state payments (`paid` or `expired`) most recent first,
 *   paginated (default page size 50). Powers the Panel history page.
 * @property {(options?: { status?: ('pending'|'paid'|'expired'|null), limit?: number, offset?: number, id?: string, date?: { start: number, end: number } }) => Awaitable<Payment[]>} listAll
 *   List payments across all statuses, most recent first (created_at DESC, id
 *   DESC), paginated (limit default 50, clamped 1..100; offset default 0). When
 *   `status` is provided the result is filtered to that single status; an
 *   omitted/falsy `status` returns every status. Powers the Panel payments list.
 * @property {(options?: { status?: ('pending'|'paid'|'expired'|null), id?: string, date?: { start: number, end: number } }) => Awaitable<number>} countAll
 *   Count payments across all statuses, or only those in `status` when given.
 * @property {(id: string, settlement: SettlementInput) => Awaitable<Result<Payment>>} markPaid
 *   Atomically settle a payment: record the txId for idempotency then mark the
 *   payment paid. If the txId was already used, resolves to
 *   `{ ok:false, code:'TX_ALREADY_SETTLED' }`.
 * @property {(now: number) => Awaitable<number>} expireOverdue
 *   Transition pending payments whose `expires_at` is past `now` to `expired`;
 *   returns the number of payments expired.
 * @property {(now: number) => Awaitable<Payment[]>} expireOverdueReturning
 *   Like {@link expireOverdue} but returns the full rows transitioned by THIS
 *   call, so a caller can fire an "expired" side effect (e.g. a webhook)
 *   exactly once per payment. Required: every backend must implement it.
 * @property {() => Awaitable<number>} countActive
 * @property {() => Awaitable<number|null>} [oldestActiveCreation] Earliest pending creation timestamp.
 *   Count payments currently in `pending` status (drives Adaptive_Polling).
 * @property {(minAmount: number, maxAmount: number) => Awaitable<Payment[]>} findCandidatesByAmount
 *   Find pending payments whose `amount` falls within `[minAmount, maxAmount]`,
 *   ordered earliest-created first (`created_at ASC, id ASC`) so the caller can
 *   settle the oldest match first. Backed by the pending-amount index.
 * @property {() => Awaitable<number>} maxActiveTolerance
 *   Return the maximum `tolerance` among currently-pending payments, or 0 when
 *   there are none. Used to widen the indexed candidate range scan.
 */

/**
 * API key persistence operations.
 *
 * @typedef {Object} ApiKeysStore
 * @property {(input: ApiKeyCreateInput) => Awaitable<Result<ApiKeyRecord>>} create
 *   Insert a new key with `active` status, storing only its hash and display
 *   prefix (never the plaintext). On a hash-uniqueness violation resolves to
 *   `{ ok:false, code:'KEY_HASH_IN_USE' }`.
 * @property {(keyHash: string) => Awaitable<(ApiKeyRecord|null)>} getActiveByHash
 *   Return the key matching `keyHash` only when it is `active`; a missing or
 *   revoked key resolves to `null`.
 * @property {(id: string, revokedAt: number) => Awaitable<Result<ApiKeyRecord>>} revoke
 *   Revoke an `active` key, recording `revoked_at`. A key
 *   that does not exist or is already revoked is rejected with
 *   `{ ok:false, code:'KEY_NOT_REVOCABLE' }` and no key is modified.
 * @property {() => Awaitable<MaskedApiKey[]>} listMasked
 *   List every key in masked form: prefix, status, and timestamps only — never
 *   the hash or full value.
 */

/**
 * Webhook delivery log operations.
 *
 * @typedef {Object} WebhookLogsStore
 * @property {(entry: WebhookLogEntry) => Awaitable<Result>} append
 * @property {(id: string) => Awaitable<Result>} markPermanentFailure
 * @property {(paymentId: string) => Awaitable<Array<Record<string, any>>>} listByPayment
 *   List every delivery-log row for a payment, oldest first, including the
 *   captured `response_status`, `response_body`, and `request_body`.
 * @property {(cutoff: number) => Awaitable<number>} pruneOld
 *   Delete every delivery-log row whose `last_attempt_at` is strictly before
 *   `cutoff` (epoch ms). Returns how many rows were removed.
 */

/**
 * Admin user operations.
 *
 * @typedef {Object} AdminUsersStore
 * @property {(username: string) => Awaitable<(AdminUser|null)>} getByUsername
 *   Read an admin user by username, or `null` if none exists.
 * @property {(input: EnsureAdminInput) => Awaitable<Result<{ created: boolean }>>} ensure
 *   Idempotently insert the initial admin user. When the username already
 *   exists, resolves `{ ok:true, value:{ created:false } }` WITHOUT changing
 *   the stored password hash (so later env value changes do not overwrite it).
 *   When a new row is inserted, resolves `{ ok:true, value:{ created:true } }`.
 * @property {() => Awaitable<Array<Pick<AdminUser, 'username'>>>} listUsernames
 *   List every admin user's username (no password hashes). Used by the
 *   out-of-band management CLI to enumerate configured admins.
 * @property {(input: UpdateAdminInput) => Awaitable<Result<AdminUser>>} updateCredentials
 *   Update an existing admin user's password hash and/or rename it. The lookup
 *   is by `currentUsername`; when no admin matches, resolves
 *   `{ ok:false, code:'ADMIN_NOT_FOUND' }`. A rename to a username that already
 *   exists resolves `{ ok:false, code:'USERNAME_IN_USE' }` without modifying
 *   either row. Used by the out-of-band management CLI; the application never
 *   calls it (env seeding uses {@link ensure}).
 */

/**
 * Input for `adminUsers.updateCredentials`.
 *
 * @typedef {Object} UpdateAdminInput
 * @property {string} currentUsername   The admin to act on.
 * @property {string} [newUsername]     Optional new username (rename).
 * @property {string} [passwordHash]    Optional new password hash.
 */

/**
 * Login rate-limiting operations (IP-based). The rate-limit *policy* (the
 * counting window and the lockout escalation) is supplied by the caller and
 * applied atomically by `recordFailure` so concurrent logins cannot race past
 * the threshold. The DAL persists the counters and reports whether an active
 * block is in effect.
 *
 * @typedef {Object} LoginAttemptsStore
 * @property {(ipAddress: string, policy: LoginFailurePolicy) => Awaitable<Result<{ failedAttempts: number, lockoutUntil: number|null }>>} recordFailure
 *   Atomically read the current counters, apply the fixed-window failure policy,
 *   and persist the new state. Returns the new state so the caller can decide
 *   what to surface.
 * @property {(ipAddress: string) => Awaitable<Result>} resetFailures
 *   Clear the failed-login counters after a successful login for an IP address.
 * @property {(ipAddress: string, now: number) => Awaitable<boolean>} isLockedOut
 *   Report whether the IP address is currently blocked: it has reached the
 *   failure threshold and its `lockout_until` deadline is still in the future.
 * @property {(ipAddress: string) => Awaitable<{ failedAttempts: number, lockoutUntil: number|null } | null>} getByIp
 *   Read the current rate-limit state for an IP address.
 * @property {() => Awaitable<number>} clearAll
 *   Wipe EVERY IP's failed-login counters. Used only by the out-of-band
 *   management CLI to unlock all admins at once; the application never calls
 *   it (a successful login clears only that IP via {@link resetFailures}).
 *   Returns how many rows were removed.
 */

/**
 * Server-level configuration key/value operations.
 *
 * @typedef {Object} ConfigStore
 * @property {(key: string) => Awaitable<(string|null)>} get
 * @property {(key: string, value: string) => Awaitable<Result>} set
 */

/**
 * The complete storage contract. A conforming implementation exposes the
 * entity stores plus `ping()` for readiness checks and `close()` for releasing
 * resources. No SQLite type, statement, connection, MongoDB collection,
 * document, or client object is exposed through any of these members.
 *
 * @typedef {Object} Storage
 * @property {{claim: (now: number, leaseUntil: number, token: string) => Awaitable<Payment|null>, saveRequest: (id: string, token: string, request: string) => Awaitable<boolean>, finish: (id: string, token: string, result: {state: string, attempts: number, nextAt: number}) => Awaitable<boolean>}} [notifications] Atomic leased outbox. Terminal status updates enqueue jobs in the same write; finishing and request persistence require lease ownership.
 * @property {PaymentsStore} payments
 * @property {ApiKeysStore} apiKeys
 * @property {WebhookLogsStore} webhookLogs
 * @property {AdminUsersStore} adminUsers
 * @property {LoginAttemptsStore} loginAttempts
 * @property {ConfigStore} config
 * @property {() => Awaitable<void>} ping
 *   Readiness probe: resolve when the backend is reachable and responsive,
 *   reject otherwise. Used by `/health/ready`.
 * @property {() => Awaitable<void>} close
 *   Release any underlying resources (connections, file handles). Idempotent:
 *   safe to call more than once.
 */

// ---------------------------------------------------------------------------
// Runtime contract validation (used by tests and the factory)
// ---------------------------------------------------------------------------

/**
 * The required top-level members of a {@link Storage} implementation and the
 * methods each entity store must provide. Kept as data so tests and the factory
 * can assert conformance without importing any backend.
 *
 * @type {Readonly<{ namespaces: Readonly<Record<string, readonly string[]>>, methods: readonly string[] }>}
 */
export const STORAGE_CONTRACT = Object.freeze({
  namespaces: Object.freeze({
    payments: Object.freeze([
      'insertPending',
      'getById',
      'listActive',
      'listHistory',
      'listAll',
      'countAll',
      'markPaid',
      'expireOverdue',
      'expireOverdueReturning',
      'countActive',
      'findCandidatesByAmount',
      'maxActiveTolerance',
    ]),
    apiKeys: Object.freeze(['create', 'getActiveByHash', 'revoke', 'listMasked']),
    webhookLogs: Object.freeze(['append', 'markPermanentFailure', 'listByPayment', 'pruneOld']),
    adminUsers: Object.freeze(['getByUsername', 'ensure', 'listUsernames', 'updateCredentials']),
    loginAttempts: Object.freeze(['recordFailure', 'resetFailures', 'isLockedOut', 'getByIp', 'clearAll']),
    config: Object.freeze(['get', 'set']),
  }),
  // Top-level methods that must exist directly on the Storage object.
  methods: Object.freeze(['ping', 'close']),
});

/**
 * Validate that an object satisfies the {@link Storage} contract. Returns the
 * list of missing members; an empty list means the object conforms. This makes
 * it cheap to substitute a mock storage in tests and prove the DAL boundary is
 * the only database access point.
 *
 * @param {unknown} candidate - the object to check.
 * @returns {string[]} a list of human-readable descriptions of missing members.
 */
export function findStorageContractViolations(candidate) {
  /** @type {string[]} */
  const violations = [];

  if (candidate === null || typeof candidate !== 'object') {
    return ['storage must be a non-null object'];
  }

  const storage = /** @type {Record<string, any>} */ (candidate);

  for (const [namespace, methods] of Object.entries(STORAGE_CONTRACT.namespaces)) {
    const store = storage[namespace];
    if (store === null || typeof store !== 'object') {
      violations.push(`missing namespace: ${namespace}`);
      continue;
    }
    for (const method of methods) {
      if (typeof store[method] !== 'function') {
        violations.push(`missing method: ${namespace}.${method}`);
      }
    }
  }

  for (const method of STORAGE_CONTRACT.methods) {
    if (typeof storage[method] !== 'function') {
      violations.push(`missing method: ${method}`);
    }
  }

  return violations;
}

/**
 * Assert that an object satisfies the {@link Storage} contract, throwing a
 * descriptive error if it does not. Returns the object (typed as Storage) on
 * success for convenient chaining inside the factory.
 *
 * @param {unknown} candidate - the object to check.
 * @returns {Storage} the same object, now known to satisfy the contract.
 * @throws {Error} if any required member is missing.
 */
export function assertStorage(candidate) {
  const violations = findStorageContractViolations(candidate);
  if (violations.length > 0) {
    throw new Error(
      `The storage implementation does not satisfy the Storage contract: ${violations.join(', ')}`,
    );
  }
  return /** @type {Storage} */ (candidate);
}
