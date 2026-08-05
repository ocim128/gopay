// Hashing utilities for authentication.
//
// This module provides three independent primitives:
//
//   1. Password hashing for the Admin login. Passwords are hashed
//      with Node's built-in scrypt KDF using a per-password random salt. The
//      result is a self-describing string that bundles the algorithm
//      parameters, the salt, and the derived key, so verification needs no
//      external state. scrypt is memory-hard and ships with Node core, so no
//      heavy native dependency (argon2/bcrypt) is required.
//
//   2. API key hashing for lookup. API keys are high-entropy secrets,
//      so a fast deterministic SHA-256 digest is sufficient and lets the key be
//      stored hashed and looked up by hash without a per-row salt.
//
//   3. A constant-time string comparison helper built on crypto.timingSafeEqual
//      so equality checks do not leak information through timing side channels.

import {
  scrypt as scryptCallback,
  scryptSync,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scryptCallback);

// scrypt parameters. N (cost) must be a power of two. These defaults give a
// strong work factor while staying well within Node's default memory limits.
const SCRYPT_N = 16384; // CPU/memory cost
const SCRYPT_R = 8; // block size
const SCRYPT_P = 1; // parallelization
const SCRYPT_KEYLEN = 64; // derived key length in bytes
const SCRYPT_SALT_BYTES = 16; // random salt length in bytes
// scrypt needs roughly 128 * N * r bytes of memory; raise maxmem accordingly.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

// Identifier stored at the front of a password hash so the format is
// self-describing and future-proof.
const PASSWORD_SCHEME = 'scrypt';
const FIELD_SEPARATOR = '$';

const API_KEY_HASH_ALGORITHM = 'sha256';

const scryptOptions = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: SCRYPT_MAXMEM,
};

/**
 * Assemble the self-describing password-hash string.
 *
 * Format: `scrypt$<N>$<r>$<p>$<saltBase64>$<keyBase64>`
 *
 * @param {Buffer} salt - The random salt.
 * @param {Buffer} derivedKey - The scrypt-derived key.
 * @returns {string} The encoded password hash.
 */
function encodePasswordHash(salt, derivedKey) {
  return [
    PASSWORD_SCHEME,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    derivedKey.toString('base64'),
  ].join(FIELD_SEPARATOR);
}

/**
 * Parse a previously encoded password hash back into its components.
 *
 * @param {string} encoded - A string produced by {@link encodePasswordHash}.
 * @returns {{N: number, r: number, p: number, salt: Buffer, derivedKey: Buffer}}
 * @throws {Error} When the string is not a valid scrypt hash.
 */
function decodePasswordHash(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('Invalid password hash: expected a non-empty string.');
  }
  const parts = encoded.split(FIELD_SEPARATOR);
  if (parts.length !== 6 || parts[0] !== PASSWORD_SCHEME) {
    throw new Error('Invalid password hash: unrecognized format.');
  }
  const [, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    throw new Error('Invalid password hash: non-numeric parameters.');
  }
  const salt = Buffer.from(saltRaw, 'base64');
  const derivedKey = Buffer.from(keyRaw, 'base64');
  if (salt.length === 0 || derivedKey.length === 0) {
    throw new Error('Invalid password hash: empty salt or key.');
  }
  return { N, r, p, salt, derivedKey };
}

/**
 * Validate that a password is a non-empty string before hashing.
 *
 * @param {unknown} password - The candidate password.
 * @returns {string} The validated password.
 * @throws {TypeError} When the password is not a non-empty string.
 */
function requirePassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('Password must be a non-empty string.');
  }
  return password;
}

/**
 * Hash an Admin password with scrypt and a fresh random salt.
 *
 * The returned string differs from the plaintext and embeds everything needed
 * to verify the password later.
 *
 * @param {string} password - The plaintext password.
 * @returns {Promise<string>} The encoded scrypt hash.
 */
export async function hashPassword(password) {
  requirePassword(password);
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derivedKey = await scryptAsync(password, salt, SCRYPT_KEYLEN, scryptOptions);
  return encodePasswordHash(salt, Buffer.from(derivedKey));
}

/**
 * Synchronous variant of {@link hashPassword}.
 *
 * @param {string} password - The plaintext password.
 * @returns {string} The encoded scrypt hash.
 */
export function hashPasswordSync(password) {
  requirePassword(password);
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derivedKey = scryptSync(password, salt, SCRYPT_KEYLEN, scryptOptions);
  return encodePasswordHash(salt, derivedKey);
}

/**
 * Verify a plaintext password against a stored scrypt hash using a
 * constant-time comparison.
 *
 * @param {string} password - The plaintext password to check.
 * @param {string} storedHash - A hash produced by {@link hashPassword}.
 * @returns {Promise<boolean>} True when the password matches, false otherwise.
 */
export async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || password.length === 0) {
    return false;
  }
  let parsed;
  try {
    parsed = decodePasswordHash(storedHash);
  } catch {
    return false;
  }
  const { N, r, p, salt, derivedKey } = parsed;
  let candidate;
  try {
    candidate = await scryptAsync(password, salt, derivedKey.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
  } catch {
    return false;
  }
  return timingSafeEqualString(Buffer.from(candidate), derivedKey);
}

/**
 * Hash an API key into a lowercase hex SHA-256 digest for storage and lookup.
 * The digest is deterministic so a presented key can be hashed and
 * matched against the stored hash.
 *
 * @param {string} apiKey - The plaintext API key.
 * @returns {string} The lowercase hex SHA-256 digest.
 * @throws {TypeError} When the API key is not a non-empty string.
 */
export function hashApiKey(apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    throw new TypeError('API key must be a non-empty string.');
  }
  return createHash(API_KEY_HASH_ALGORITHM).update(apiKey, 'utf8').digest('hex');
}

/**
 * Compare a presented API key against a stored API-key hash in constant time
 * relative to the hash length.
 *
 * @param {string} apiKey - The plaintext API key presented by the client.
 * @param {string} storedHash - The stored hash from {@link hashApiKey}.
 * @returns {boolean} True when the key matches the stored hash.
 */
export function verifyApiKey(apiKey, storedHash) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return false;
  }
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    return false;
  }
  let computed;
  try {
    computed = hashApiKey(apiKey);
  } catch {
    return false;
  }
  return constantTimeEqual(computed, storedHash);
}

/**
 * Constant-time comparison of two Buffers. Differing lengths are reported as
 * unequal without short-circuiting on content.
 *
 * @param {Buffer} a - First buffer.
 * @param {Buffer} b - Second buffer.
 * @returns {boolean} True when the buffers are byte-for-byte equal.
 */
function timingSafeEqualString(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Constant-time comparison of two UTF-8 strings.
 *
 * timingSafeEqual requires equal-length inputs, so unequal lengths return false
 * immediately; equal-length inputs are compared without early exit.
 *
 * @param {string} a - First string.
 * @param {string} b - Second string.
 * @returns {boolean} True when the strings are equal.
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
