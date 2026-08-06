# Optional MongoDB Storage Backend

## Goal

Add MongoDB as an optional storage backend while keeping SQLite as the default.
Both backends must preserve the current REST API, webhook payloads, payment
matching, authentication, configuration, Panel behavior, and error codes.

Out of scope:

- AutoBeli integration.
- Removing SQLite or `better-sqlite3`.
- Runtime dual writes between SQLite and MongoDB.
- Automatic data migration during application startup.
- Durable or exactly-once webhook delivery. Webhooks keep their current
  in-process retry behavior; payment state remains available for reconciliation
  through `GET /payment/:id`.

## Backend selection

Use explicit environment configuration:

```env
STORAGE_BACKEND=sqlite
MONGODB_URI=mongodb+srv://user:password@host/gopay
```

Rules:

- `STORAGE_BACKEND` accepts `sqlite` or `mongodb` and defaults to `sqlite`.
- `MONGODB_URI` is required only for `mongodb`.
- The MongoDB URI must include an explicit database name.
- MongoDB selection must never fall back to SQLite after an error.
- Gopay must use its own database and least-privilege database user. It may
  share an Atlas cluster with another application, but not its database or user.
- `src/dal/index.js` remains the only storage factory.

## Asynchronous storage boundary

MongoDB operations are asynchronous. Every storage method must be typed as
`Awaitable<T>`, and every production caller must await it. SQLite may still
return values synchronously internally.

Required changes:

- Make storage-backed payment, auth, config, API-key, route, and webhook methods
  async.
- Convert the server-managed suffix allocation loop to await each insert attempt
  before trying the next amount.
- Make the poller await configuration reads, active-payment counts,
  `onTransactions`, and maintenance callbacks.
- Await webhook configuration reads and delivery-log writes.
- Make DAL creation and shutdown awaitable.
- Add delayed Promise-based fakes to tests so SQLite cannot hide a missing
  `await`.

Remove the unused generic `storage.tx(fn)` contract. Atomicity belongs in domain
operations such as `payments.markPaid()` and `loginAttempts.recordFailure()`.

The production storage contract must include:

- Existing payment, API-key, webhook-log, admin-user, login-attempt, and config
  operations.
- `payments.findCandidatesByAmount()`.
- `payments.maxActiveTolerance()`.
- `payments.expireOverdueReturning()`.
- Atomic `adminUsers.ensure()`.
- Atomic `loginAttempts.recordFailure()`.
- `ping()` for readiness checks.
- Idempotent, awaitable `close()`.

## MongoDB data model

Use domain string keys as MongoDB `_id` values and map them back to the existing
public shapes. MongoDB-specific and internal fields must not leave the DAL.

| Collection | Identity and notes |
| --- | --- |
| `payments` | `_id` is the payment ID. Store the existing payment fields plus internal `terminal_at`, absent while pending, set to `paid_at` when paid, and set to `created_at` when expired. |
| `api_keys` | `_id` is the API-key record ID. Store only the key hash and display metadata. |
| `webhook_delivery_logs` | `_id` is the log ID. Sort oldest-first by `last_attempt_at`, then `_id` for a deterministic tie-break. |
| `admin_users` | `_id` is the admin ID. Username is unique; store only the password hash. |
| `login_attempts` | `_id` is the IP address. |
| `config` | `_id` is the config key and `value` is a string. |

MongoDB does not need a `settled_tx` collection. Settlement is a single atomic
update to a payment, and a unique partial index on `payments.tx_id` prevents one
transaction ID from settling more than one payment.

The adapter must validate writes and normalize returned documents so nullable
SQLite fields are returned as `null`, not omitted or `undefined`.

### Indexes

Create named indexes idempotently at startup and fail startup if an existing
index with the same purpose has a conflicting definition.

`payments`:

- `{ amount: 1 }`, unique where `status: 'pending'` — pending amount allocation.
- `{ tx_id: 1 }`, unique where `tx_id` is a string — settlement idempotency.
- `{ status: 1, expires_at: 1, _id: 1 }` — active listing and expiry.
- `{ created_at: -1, _id: -1 }` — unfiltered payment pagination.
- `{ status: 1, created_at: -1, _id: -1 }` — status-filtered pagination.
- `{ terminal_at: -1, created_at: -1, _id: -1 }`, sparse — terminal history.
- `{ status: 1, tolerance: -1 }` — maximum active tolerance.

The pending-amount index also supports candidate amount range scans. Candidate
results are sorted by `created_at`, then `_id`, before settlement.

Other collections:

- `api_keys`: unique `{ key_hash: 1 }` and `{ created_at: -1, _id: -1 }`.
- `webhook_delivery_logs`: `{ payment_id: 1, last_attempt_at: 1, _id: 1 }` and
  `{ last_attempt_at: 1 }` for retention pruning.
- `admin_users`: unique `{ username: 1 }`.

The automatic `_id` indexes enforce unique payment IDs, API-key IDs, webhook-log
IDs, IP addresses, and config keys. Payment-ID prefix search must use an escaped,
anchored, case-sensitive query so the `_id` index remains usable.

## Atomic operations

### Payment creation

Insert the pending payment directly. Map a duplicate on the pending-amount index
to `AMOUNT_IN_USE`. Server-managed allocation retries the next suffix only after
the insert result has resolved.

### Settlement

Implement `markPaid()` with one `findOneAndUpdate` filtered by payment ID and
`status: 'pending'`. Set the paid fields, `tx_id`, and `terminal_at` in that
update.

- A duplicate on the unique `tx_id` index returns `TX_ALREADY_SETTLED`.
- If no pending payment matches, look up `tx_id`: return
  `TX_ALREADY_SETTLED` when it already exists, otherwise return
  `PAYMENT_NOT_PENDING`.
- The returned document is the settled payment.

Because the update affects one document and transaction-ID uniqueness is an
index invariant, MongoDB multi-document transactions and replica-set-only
transaction requirements are unnecessary.

### Expiry

Implement `expireOverdueReturning()` using conditional `findOneAndUpdate`
operations on `status: 'pending'` and `expires_at < now`. Each returned payment
must be a transition won by that caller, so overlapping processes cannot emit
duplicate expiry notifications.

### Login attempts

Replace the current read/compute/write sequence with one atomic
`recordFailure(ip, { now, windowMs, threshold, lockoutMs })` operation. Preserve
the existing fixed failure window and lockout policy under concurrent requests.

### Initial admin

Implement `adminUsers.ensure()` as an insert-if-absent operation. It must not
change the password of an existing user when environment values change.

## Implementation

### 1. Convert the storage boundary

- Update `storage-interface.js` with awaitable return types and the required
  methods above.
- Remove `tx(fn)` from the interface, SQLite adapter, tests, and documentation.
- Update all storage callers, including the amount allocator, poller, auth,
  runtime config, routes, webhook dispatcher, maintenance, startup, and shutdown.
- Move the SQLite-specific initial-admin insert behind `adminUsers.ensure()`.
- Add SQLite `ping()` and awaitable `close()` compatibility.

Acceptance:

- SQLite remains the default and preserves existing behavior.
- Omitted, explicit SQLite, invalid, and missing-MongoDB-URI selector cases are
  tested.
- Delayed Promise-based storage fakes pass all production flows.
- No production caller uses `storage.tx` or a SQLite connection directly.

### 2. Add the MongoDB adapter

- Add the official `mongodb` driver.
- Parse the URI, require a database name, connect one `MongoClient` per storage
  instance, and create indexes before reporting readiness.
- Implement all stores, mapping, validation, error translation, `ping()`, and
  idempotent `close()`.
- Configure bounded connection, socket, and server-selection timeouts and a
  small connection pool suitable for one Render instance.
- Never log the URI or MongoClient options containing credentials.

Acceptance:

- Run the same storage contract tests against SQLite and MongoDB.
- Cover duplicate amounts and transaction IDs, payment ordering and pagination,
  prefix filtering, expiry, API-key revocation, login lockout, admin creation,
  webhook-log ordering, null normalization, connection failure, and index
  definitions.
- Cover concurrent creation, settlement, expiry, login failures, and admin
  creation from two storage instances sharing one database.

### 3. Add runtime and Render configuration

- Document `STORAGE_BACKEND` and `MONGODB_URI` in `.env.example` and README.
- Add `/health/live` for process liveness and `/health/ready` for a bounded
  storage `ping()`.
- Point Render's health check to `/health/ready`.
- Handle `SIGTERM` and `SIGINT` by calling and awaiting `app.close()`. Shutdown
  must stop the poller and close owned storage safely when invoked more than once.
- Allow Atlas access only from the Render service's outbound CIDR ranges or a
  dedicated outbound IP.
- Keep the first production rollout at one application instance because the
  poller is process-local. Atomic storage operations must still tolerate the
  brief old/new instance overlap during deployment.

Render profiles:

- SQLite production uses a paid service with a persistent disk. `DB_PATH` and
  `TOKEN_FILE_PATH` must be under the disk mount. It cannot scale horizontally.
- MongoDB production uses Atlas and does not need a disk for database state.
  `TOKEN_FILE_PATH` still needs either persistent storage or a tested ability to
  reauthenticate after the ephemeral token file is lost. If a disk is attached
  for the token, the same disk-backed deployment and scaling limits apply.
- The free Render plan is for deployment testing only, not SQLite persistence or
  real payment processing.

Acceptance:

- Each backend starts only with its required variables.
- Readiness fails when the selected storage is unavailable and recovers when it
  reconnects.
- Shutdown awaits storage close.
- Logs and health responses contain no credentials or payment data.

### 4. Add migration only when needed

Do not add migration code until an existing SQLite deployment actually needs to
move to MongoDB.

The migration must:

- Use SQLite's online backup API, or stop writes and close SQLite before copying
  the database.
- Read directly from SQLite and write directly to MongoDB without a plaintext
  intermediate export.
- Preserve payment, API-key, webhook-log, admin, login-attempt, and config data.
- Populate `terminal_at` for migrated paid and expired payments.
- Validate `settled_tx` rows against the corresponding payment `tx_id`; do not
  create a MongoDB `settled_tx` collection.
- Use insert-only semantics. Repeated identical records may be skipped; a
  conflicting existing MongoDB record must stop the import instead of being
  overwritten.
- Provide dry-run counts, index verification, post-import counts, and a verified
  SQLite backup.
- Never print hashes, raw transactions, credentials, or webhook bodies.

Rollback requires freezing writes and reconciling MongoDB-only changes before
switching back to SQLite. Switching the environment variable alone is not a safe
rollback after MongoDB has accepted writes.

### 5. Validate and roll out

- Run the complete SQLite suite and MongoDB contract/API tests.
- Test process restart with pending payments.
- Test two overlapping instances against one MongoDB database.
- Verify candidate, expiry, pagination, history, API-key, and webhook-log queries
  use the intended indexes with `explain('executionStats')`.
- Use a dedicated generated test database name. Cleanup must refuse to drop any
  database that does not match the test-name pattern.
- Stage with non-production GoPay credentials before production selection.

Production rollout requires:

- A dedicated production database name and user.
- Atlas region, backup, restore, and network-allowlist configuration.
- A decision on persistent versus ephemeral GoBiz token storage.
- A verified rollback backup and maintenance window when migrating existing
  SQLite data.
