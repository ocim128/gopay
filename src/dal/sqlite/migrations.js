// Schema migrations for the SQLite backend.
//
// `runMigrations(db)` creates every table and index the application uses. It
// is idempotent — each statement uses `IF NOT EXISTS`, so
// running it against a fresh or an already-migrated database is safe and has no
// effect the second time. The full schema is applied inside
// a single transaction so a partially created schema can never be observed.
//
// The schema is the source of truth for the race-condition prevention strategy:
// the partial unique index `uniq_pending_amount` enforces
// amount uniqueness among `pending` payments at INSERT time, and `settled_tx`
// guarantees a transaction id settles at most one payment.

/**
 * The complete schema DDL. Every
 * statement is written with `IF NOT EXISTS` so the whole script is safe to run
 * repeatedly.
 *
 * @type {string}
 */
export const SCHEMA_SQL = `
-- Payments: the core entity. Money values are INTEGER Rupiah (never floats).
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount BETWEEN 1 AND 999999999),
  status TEXT NOT NULL CHECK (status IN ('pending','paid','expired')),
  qris_string TEXT NOT NULL,
  qris_url TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  timeout INTEGER NOT NULL,
  tolerance INTEGER NOT NULL DEFAULT 0,
  webhook_url TEXT,
  tx_id TEXT,
  paid_amount INTEGER,
  paid_at INTEGER,
  tx_raw TEXT,
  tz TEXT
);

-- RACE-CONDITION PREVENTION: amount uniqueness ONLY among pending.
-- Partial unique index: two pending rows with the same amount => the second
-- INSERT fails UNIQUE. A payment that becomes paid/expired leaves the index,
-- so its amount is automatically free to reuse.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pending_amount
  ON payments(amount) WHERE status = 'pending';

-- Drives the Active_Payment list and lazy-expire scans (status + expires_at).
CREATE INDEX IF NOT EXISTS idx_active_expires ON payments(status, expires_at);

-- Pagination optimization: fast sorting across all statuses or within a status
CREATE INDEX IF NOT EXISTS idx_payments_created_id ON payments(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_payments_status_created_id ON payments(status, created_at DESC, id DESC);

-- History optimization: fast sorting for terminal states with COALESCE
CREATE INDEX IF NOT EXISTS idx_payments_history_sort
  ON payments(COALESCE(paid_at, created_at) DESC, created_at DESC, id DESC)
  WHERE status IN ('paid', 'expired');

-- Settlement idempotency: one txId settles at most one payment.
CREATE TABLE IF NOT EXISTS settled_tx (
  tx_id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  settled_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,             -- for masked display
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Pagination optimization: fast sorting across all API keys
CREATE INDEX IF NOT EXISTS idx_api_keys_created_id ON api_keys(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  target_url TEXT NOT NULL,
  status TEXT NOT NULL,                 -- 'success' | 'failed' | 'failed_permanent'
  attempts INTEGER NOT NULL,
  last_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  response_status INTEGER,             -- HTTP status of the delivery attempt (null when the request threw)
  response_body TEXT,                  -- truncated response body text (null when unavailable)
  request_body TEXT                    -- the JSON request body that was sent
);

CREATE TABLE IF NOT EXISTS admin_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip_address TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  lockout_until INTEGER
);

CREATE TABLE IF NOT EXISTS config ( key TEXT PRIMARY KEY, value TEXT NOT NULL );
`;

/**
 * Column additions that must be applied to EXISTING databases created before
 * the column was part of {@link SCHEMA_SQL}. Each entry names a table, the
 * column to add, and its full column definition. Adding a column to a table
 * that predates it cannot be expressed with `IF NOT EXISTS` (SQLite has no
 * `ADD COLUMN IF NOT EXISTS`), so {@link applyColumnAdditions} inspects
 * `PRAGMA table_info` first and only issues the `ALTER TABLE ... ADD COLUMN`
 * when the column is genuinely missing. Fresh databases already have these
 * columns from `SCHEMA_SQL`, so the additions are skipped there.
 *
 * @type {ReadonlyArray<{ table: string, column: string, definition: string }>}
 */
const COLUMN_ADDITIONS = Object.freeze([
  // Webhook delivery logs gained the response/request capture columns so the
  // Panel can show what was sent and what came back for each attempt.
  { table: 'webhook_delivery_logs', column: 'response_status', definition: 'INTEGER' },
  { table: 'webhook_delivery_logs', column: 'response_body', definition: 'TEXT' },
  { table: 'webhook_delivery_logs', column: 'request_body', definition: 'TEXT' },
  // Payments gained `tx_raw` so the full raw GoBiz transaction captured at
  // settlement can be persisted and re-emitted in the webhook payload.
  { table: 'payments', column: 'tx_raw', definition: 'TEXT' },
  // Payments gained an optional per-Payment display timezone (`tz`, an IANA
  // zone name) used to render the `_iso` timestamp fields for that Payment.
  { table: 'payments', column: 'tz', definition: 'TEXT' },
]);

/**
 * Return the set of column names currently present on a table, read from
 * `PRAGMA table_info`. An empty set is returned for a table that does not yet
 * exist (it will be created by {@link SCHEMA_SQL} with every column in place).
 *
 * @param {import('better-sqlite3').Database} db - an open connection.
 * @param {string} table - the table name to inspect.
 * @returns {Set<string>} the existing column names.
 */
function tableColumns(db, table) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set(rows.map((row) => row.name));
}

/**
 * Apply each entry in {@link COLUMN_ADDITIONS} that is missing from its table.
 * This upgrades a database that was created before a column existed, and is a
 * no-op on a fresh database (where `SCHEMA_SQL` already created the column).
 * The check is driven by `PRAGMA table_info`, so it is safe to run on every
 * boot.
 *
 * @param {import('better-sqlite3').Database} db - an open connection.
 * @returns {void}
 */
function applyColumnAdditions(db) {
  for (const { table, column, definition } of COLUMN_ADDITIONS) {
    const columns = tableColumns(db, table);
    if (columns.size === 0 || columns.has(column)) {
      // The table is absent (SCHEMA_SQL will create it complete) or the column
      // is already present: nothing to add.
      continue;
    }
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Drop columns from an existing table. This is safe to run repeatedly; it
 * checks if the column exists before dropping it.
 *
 * @param {import('better-sqlite3').Database} db - an open connection.
 * @param {string} table - the table name to inspect.
 * @param {string[]} columns - the columns to drop.
 * @returns {void}
 */
function dropColumnsIfExist(db, table, columns) {
  const existing = tableColumns(db, table);
  for (const col of columns) {
    if (existing.has(col)) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
    }
  }
}

/**
 * Apply the full schema to an open better-sqlite3 connection.
 *
 * The DDL is executed inside a single transaction so that, on a fresh database,
 * either the entire schema is created or none of it is. Because every statement
 * uses `IF NOT EXISTS`, calling this on an already-migrated database is a no-op.
 * After the base schema is ensured, {@link applyColumnAdditions}
 * upgrades any pre-existing table that is missing a later-added column.
 *
 * @param {import('better-sqlite3').Database} db - an open connection.
 * @returns {void}
 */
export function runMigrations(db) {
  const apply = db.transaction(() => {
    db.exec(SCHEMA_SQL);
    applyColumnAdditions(db);
    dropColumnsIfExist(db, 'admin_users', ['failed_attempts', 'lockout_until']);
  });
  apply();
}
