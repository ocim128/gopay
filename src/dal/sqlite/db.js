// SQLite connection management for the Data Access Layer.
//
// This module is the single place that opens a better-sqlite3 connection and
// applies the connection-level PRAGMAs the rest of the DAL relies on. It points
// at `data/panel.db` by default but accepts any path, including the special
// `':memory:'` value used by tests for an ephemeral database.
//
// Only the better-sqlite3 `Database` handle and migration runner cross back to
// the SQLite-specific storage implementation; no SQLite type leaks past the DAL
// boundary defined in ../storage-interface.js.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

import { DEFAULT_DB_PATH } from '../index.js';
import { runMigrations } from './migrations.js';

/**
 * The special path that opens a transient, process-private database held
 * entirely in memory. Useful for tests and never written to disk.
 *
 * @type {string}
 */
export const IN_MEMORY_PATH = ':memory:';

/**
 * @typedef {Object} OpenDatabaseOptions
 * @property {string} [dbPath]   Path to the database file. Use
 *   {@link IN_MEMORY_PATH} (`':memory:'`) for an ephemeral in-memory database.
 *   Defaults to {@link DEFAULT_DB_PATH} (`data/panel.db`).
 * @property {boolean} [migrate] Whether to run the schema migrations after
 *   opening the connection. Defaults to `true`.
 */

/**
 * Determine whether a path refers to an in-memory database, which must not be
 * treated as a file on disk (no directory to create, no WAL file).
 *
 * better-sqlite3 also treats an empty string as a private temporary on-disk
 * database; we group it with the non-persistent paths so we never try to
 * `mkdir` an empty directory.
 *
 * @param {string} dbPath
 * @returns {boolean}
 */
function isNonFilePath(dbPath) {
  return dbPath === IN_MEMORY_PATH || dbPath === '';
}

/**
 * Open a better-sqlite3 connection, apply the standard PRAGMAs, and (by default)
 * run the schema migrations.
 *
 * Connection-level settings:
 * - `journal_mode = WAL` enables Write-Ahead Logging so reads do not block
 *   writes and committed data survives a process restart. WAL is a persistent
 *   on-disk mode; for `':memory:'` databases SQLite
 *   keeps an in-memory journal, so the PRAGMA is skipped there.
 * - `foreign_keys = ON` enforces referential integrity for any FK constraints.
 * - `busy_timeout` lets a connection wait briefly for a competing writer rather
 *   than failing immediately under contention.
 *
 * @param {OpenDatabaseOptions} [options]
 * @returns {import('better-sqlite3').Database} an open, migrated connection.
 */
export function openDatabase(options = {}) {
  const { dbPath = DEFAULT_DB_PATH, migrate = true } = options;

  // Ensure the parent directory exists for on-disk databases so the very first
  // run does not fail when `data/` (or a nested path) is missing.
  if (!isNonFilePath(dbPath)) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  // WAL is a no-op (and unnecessary) for in-memory databases.
  if (!isNonFilePath(dbPath)) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  if (migrate) {
    runMigrations(db);
  }

  return db;
}
