// API Key management operations for the Panel.
//
// This module sits on top of the DAL `apiKeys` store and owns the parts of API
// key lifecycle that must never touch the database directly: generating a new
// high-entropy secret, hashing it for storage, and deciding what the Panel may
// reveal. It provides:
//
//   - createApiKey generates a unique secret with `active` status and returns
//     the FULL value exactly once. Only the hash and a short
//     display prefix are ever persisted.
//   - listApiKeys returns the masked form only — never the hash or full value.
//   - revokeApiKey flips an active key to `revoked` and records the time, and
//     rejects keys that do not exist or are already revoked.

import { randomBytes, randomUUID } from 'node:crypto';

import { hashApiKey } from './hashing.js';

/**
 * Human-recognizable prefix placed at the front of every generated key so the
 * Panel and logs can tell an API key apart from other tokens at a glance.
 *
 * @type {string}
 */
export const API_KEY_PREFIX = 'gpk_';

/**
 * Number of random bytes in the secret portion of a generated key. 32 bytes
 * (256 bits) of entropy makes accidental collisions effectively impossible.
 *
 * @type {number}
 */
const SECRET_BYTES = 32;

/**
 * Number of leading characters of the full key kept as the masked display
 * `key_prefix`. Enough to visually distinguish keys without revealing enough of
 * the secret to be guessable.
 *
 * @type {number}
 */
const DISPLAY_PREFIX_LENGTH = 12;

/**
 * How many times to retry generation if the freshly generated key's hash
 * collides with an existing one. A single retry is already astronomically more
 * than required for 256-bit secrets; the bound simply guarantees termination.
 *
 * @type {number}
 */
const MAX_GENERATION_ATTEMPTS = 5;

/**
 * Generate a fresh, high-entropy API key value. The value is URL-safe so it can
 * be carried in headers without escaping.
 *
 * @returns {string} The full secret value, e.g. `gpk_<base64url>`.
 */
export function generateApiKeyValue() {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  return `${API_KEY_PREFIX}${secret}`;
}

/**
 * Derive the masked display prefix from a full key value.
 *
 * @param {string} fullValue - the full generated key.
 * @returns {string} the leading slice shown in masked listings.
 */
export function deriveKeyPrefix(fullValue) {
  return fullValue.slice(0, DISPLAY_PREFIX_LENGTH);
}

/**
 * Create an API key management facade bound to a DAL storage instance.
 *
 * Dependencies (`now`, `idFactory`, `generateValue`) are injectable so the
 * behavior is deterministic under test, mirroring the Payment_Service factory.
 *
 * @param {import('../dal/storage-interface.js').Storage} storage
 * @param {Object} [deps]
 * @param {() => number} [deps.now] - clock; defaults to `Date.now`.
 * @param {() => string} [deps.idFactory] - id generator; defaults to
 *   `crypto.randomUUID`.
 * @param {() => string} [deps.generateValue] - key value generator; defaults to
 *   {@link generateApiKeyValue}.
 * @returns {{
 *   createApiKey: () => Promise<{ id: string, value: string, key_prefix: string, status: 'active', created_at: number }>,
 *   listApiKeys: () => Promise<import('../dal/storage-interface.js').MaskedApiKey[]>,
 *   revokeApiKey: (id: string) => Promise<import('../dal/storage-interface.js').Result<import('../dal/storage-interface.js').MaskedApiKey>>
 * }}
 */
export function createApiKeyManager(storage, deps = {}) {
  if (storage === null || typeof storage !== 'object' || typeof storage.apiKeys !== 'object') {
    throw new TypeError('createApiKeyManager requires a Storage instance with an apiKeys store.');
  }

  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === 'function' ? deps.idFactory : () => randomUUID();
  const generateValue =
    typeof deps.generateValue === 'function' ? deps.generateValue : generateApiKeyValue;

  /**
   * Create a new API key. Generates a unique secret with `active` status,
   * persists only its hash and display prefix, and returns the FULL value
   * exactly once for the Panel to show. The full value
   * is intentionally not persisted and cannot be retrieved again afterwards.
   *
   * @returns {Promise<{ id: string, value: string, key_prefix: string, status: 'active', created_at: number }>}
   * @throws {Error} if a unique key could not be generated within the retry bound.
   */
  async function createApiKey() {
    for (let attempt = 0; attempt < MAX_GENERATION_ATTEMPTS; attempt += 1) {
      const value = generateValue();
      const keyHash = hashApiKey(value);
      const keyPrefix = deriveKeyPrefix(value);
      const id = idFactory();
      const createdAt = now();

      // eslint-disable-next-line no-await-in-loop
      const result = await storage.apiKeys.create({ id, keyHash, keyPrefix, createdAt });
      if (result.ok) {
        // Reveal the full value exactly once; the DAL stored only the hash.
        return {
          id: result.value.id,
          value,
          key_prefix: result.value.key_prefix,
          status: result.value.status,
          created_at: result.value.created_at,
        };
      }
      if (result.code !== 'KEY_HASH_IN_USE') {
        throw new Error(`Failed to create API key: ${result.code ?? 'unknown error'}.`);
      }
      // KEY_HASH_IN_USE: regenerate and retry.
    }
    throw new Error('Failed to generate a unique API key after multiple attempts.');
  }

  /**
   * List all API keys in masked form for display in the Panel. The full value
   * and hash are never included.
   *
   * @returns {Promise<import('../dal/storage-interface.js').MaskedApiKey[]>}
   */
  async function listApiKeys() {
    return storage.apiKeys.listMasked();
  }

  /**
   * Revoke an existing active API key, recording the revocation time.
   * A key that does not exist or is already revoked is rejected via
   * `{ ok:false, code:'KEY_NOT_REVOCABLE' }` and no key is modified.
   *
   * @param {string} id
   * @returns {Promise<import('../dal/storage-interface.js').Result<import('../dal/storage-interface.js').MaskedApiKey>>}
   */
  async function revokeApiKey(id) {
    const result = await storage.apiKeys.revoke(id, now());
    if (!result.ok) {
      return result;
    }
    // Return the masked view of the now-revoked key (never the hash).
    const { id: keyId, key_prefix, status, created_at, revoked_at } = result.value;
    return { ok: true, value: { id: keyId, key_prefix, status, created_at, revoked_at } };
  }

  return { createApiKey, listApiKeys, revokeApiKey };
}
