// Data Access Layer factory.
//
// `createDal()` is the single entry point the rest of the application uses to
// obtain a storage backend. It returns an object that satisfies the
// storage-agnostic `Storage` contract (see ./storage-interface.js). Callers
// depend only on that contract and never on backend-specific details, so
// swapping the backend means changing only this factory and adding a sibling
// implementation under ./<backend>/.
//
// Backend selection is driven by explicit environment configuration:
//
//   STORAGE_BACKEND=sqlite | mongodb   (default: sqlite)
//   MONGODB_URI=mongodb+srv://...       (required for mongodb)
//   MONGODB_DB_NAME=gopay               (required when the URI has no path)
//
// Rules enforced here:
//   - `STORAGE_BACKEND` accepts `sqlite` or `mongodb` and defaults to `sqlite`.
//   - `MONGODB_URI` is required for `mongodb`.
//   - MongoDB must receive an explicit database name, from the URI or
//     MONGODB_DB_NAME.
//   - MongoDB selection must NEVER fall back to SQLite after an error: a
//     startup failure is fatal and surfaces to the caller.

import { assertStorage } from './storage-interface.js';
import { createSqliteStorage } from './sqlite/sqlite-storage.js';
import { createMongoStorage } from './mongo/mongo-storage.js';

/**
 * Default on-disk location of the SQLite database, relative to the process
 * working directory. The schema and WAL files live alongside it.
 *
 * @type {string}
 */
export const DEFAULT_DB_PATH = 'data/panel.db';

/**
 * The storage backends recognized by the factory.
 *
 * @typedef {'sqlite'|'mongodb'} StorageBackend
 */

/**
 * Normalized options for {@link createDal}.
 *
 * @typedef {Object} CreateDalOptions
 * @property {StorageBackend} [backend]   Override the backend (otherwise read
 *   from `STORAGE_BACKEND`, default `sqlite`). Useful for tests.
 * @property {string} [dbPath]            SQLite database path. Use `':memory:'`
 *   for an ephemeral in-memory database. Defaults to
 *   {@link DEFAULT_DB_PATH} / `DB_PATH`.
 * @property {string} [mongoUri]          MongoDB connection URI (required when
 *   the backend is `mongodb`). Defaults to `MONGODB_URI`.
 * @property {string} [mongoDbName]       MongoDB database name. Optional: when
 *   omitted MONGODB_DB_NAME or the database encoded in the URI is used.
 */

/**
 * The default backend when `STORAGE_BACKEND` is omitted or invalid-looking.
 *
 * @type {StorageBackend}
 */
const DEFAULT_BACKEND = 'sqlite';

/**
 * Read the configured backend from `STORAGE_BACKEND`, defaulting to
 * {@link DEFAULT_BACKEND}. Unknown values are reported as an error rather than
 * silently downgraded.
 *
 * @param {StorageBackend|undefined} override
 * @returns {{ backend: StorageBackend, error: string|null }}
 */
function resolveBackend(override) {
  const raw = override ?? process.env.STORAGE_BACKEND ?? DEFAULT_BACKEND;
  if (raw === 'sqlite' || raw === 'mongodb') {
    return { backend: raw, error: null };
  }
  return {
    backend: DEFAULT_BACKEND,
    error: `Unknown STORAGE_BACKEND '${raw}'. It must be 'sqlite' or 'mongodb'.`,
  };
}

/**
 * Resolve the MongoDB database name. An explicit option or MONGODB_DB_NAME may
 * supply the name when a shared-cluster URI intentionally has no path. The
 * plan mandates Gopay use its own database — so a missing name is a hard error.
 *
 * Returns the database name parsed out of the URI when one is present.
 *
 * @param {string} uri
 * @param {string|undefined} configuredName
 * @returns {string}
 * @throws {Error} when no database name is configured.
 */
export function resolveMongoDatabaseName(uri, configuredName) {
  // Parse the pathname out without a try (an invalid URI here is a
  // configuration error; letting it throw is the correct signal).
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)(?:\?.*)?$/);
  const uriDbName = match ? decodeURIComponent(match[1]) : '';
  const dbName = (configuredName ?? uriDbName).trim();
  if (!dbName) {
    throw new Error(
      'Set MONGODB_DB_NAME or include an explicit database name in MONGODB_URI (e.g. mongodb+srv://host/gopay).',
    );
  }
  if (/[\\/?.#]/.test(dbName)) {
    throw new Error('MONGODB_DB_NAME contains invalid characters.');
  }
  return dbName;
}

/**
 * Create a DAL instance backed by the configured storage implementation.
 *
 * The current default is SQLite (better-sqlite3, WAL mode). MongoDB is selected
 * when `STORAGE_BACKEND=mongodb` and `MONGODB_URI` is set. The returned object
 * is validated against the `Storage` contract so callers remain decoupled from
 * the backend.
 *
 * Selection is fail-fast and never falls back: if the selected backend cannot
 * start, the error propagates to the caller (and stops the process at boot).
 *
 * @param {CreateDalOptions} [options]
 * @returns {Promise<import('./storage-interface.js').Storage>} a contract-compliant DAL.
 * @throws {Error} when the selected backend cannot start or the configuration is invalid.
 */
export async function createDal(options = {}) {
  const { backend, error } = resolveBackend(options.backend);
  if (error) {
    throw new Error(error);
  }

  /** @type {import('./storage-interface.js').Storage} */
  let storage;

  if (backend === 'mongodb') {
    const uri = options.mongoUri ?? process.env.MONGODB_URI;
    if (!uri) {
      throw new Error(
        "STORAGE_BACKEND is 'mongodb' but MONGODB_URI is not set. Set MONGODB_URI to a MongoDB connection string.",
      );
    }
    const dbName = resolveMongoDatabaseName(
      uri,
      options.mongoDbName ?? process.env.MONGODB_DB_NAME,
    );
    storage = await createMongoStorage({
      uri,
      dbName,
    });
  } else {
    const dbPath = options.dbPath ?? process.env.DB_PATH ?? DEFAULT_DB_PATH;
    storage = createSqliteStorage({ dbPath });
  }

  // Fail fast if the backend drifts from the contract, keeping the DAL boundary
  // honest for every caller and for mock-substitution tests.
  return assertStorage(storage);
}

export { findStorageContractViolations, assertStorage } from './storage-interface.js';
