// Data Access Layer factory.
//
// `createDal()` is the single entry point the rest of the application uses to
// obtain a storage backend. It returns an object that satisfies the
// storage-agnostic `Storage` contract (see ./storage-interface.js). Callers
// depend only on that contract and never on SQLite details, so swapping the
// backend (e.g. to Postgres) means changing only this factory and adding a
// sibling implementation under ./<backend>/.

import { assertStorage } from './storage-interface.js';
import { createSqliteStorage } from './sqlite/sqlite-storage.js';

/**
 * Default on-disk location of the SQLite database, relative to the process
 * working directory. The schema and WAL files live alongside it.
 *
 * @type {string}
 */
export const DEFAULT_DB_PATH = 'data/panel.db';

/**
 * @typedef {Object} CreateDalOptions
 * @property {string} [dbPath]   Path to the database file. Use `':memory:'`
 *   for an ephemeral in-memory database (handy for tests). Defaults to
 *   {@link DEFAULT_DB_PATH}.
 */

/**
 * Create a DAL instance backed by the default storage implementation.
 *
 * The current backend is SQLite (better-sqlite3, WAL mode), but the returned
 * value is validated against the `Storage` contract so callers remain decoupled
 * from the backend. The returned object exposes `payments`, `apiKeys`,
 * `webhookLogs`, `adminUsers`, `config`, `tx(fn)`, and `close()`.
 *
 * @param {CreateDalOptions} [options]
 * @returns {import('./storage-interface.js').Storage} a contract-compliant DAL.
 */
export function createDal(options = {}) {
  const { dbPath = DEFAULT_DB_PATH } = options;

  const storage = createSqliteStorage({ dbPath });

  // Fail fast if the backend drifts from the contract, keeping the DAL boundary
  // honest for every caller and for mock-substitution tests.
  return assertStorage(storage);
}

export { findStorageContractViolations, assertStorage } from './storage-interface.js';
