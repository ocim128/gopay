// Secure token storage for the GoBiz access token.
//
// Stores the GoBiz access token encrypted at rest using AES-256-GCM with a key
// derived from `process.env.MASTER_KEY`, and the backing file is written with
// 0600 (owner read/write only) permissions.
//
// If `MASTER_KEY` is not configured, the store falls back to writing the token
// in plaintext (still with 0600 permissions) and logs an English warning. This
// keeps local development unblocked while still encouraging a secure
// configuration in production.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Project root is two levels up from src/gobiz/.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// Default location of the encrypted token file (gitignored).
const DEFAULT_TOKEN_FILE = path.join(PROJECT_ROOT, '.gopay_token.enc');

// Owner-only read/write permissions for the token file.
const FILE_MODE = 0o600;

// AES-256-GCM parameters.
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256-bit key.
const IV_LENGTH = 12; // 96-bit nonce recommended for GCM.
const AUTH_TAG_LENGTH = 16; // 128-bit authentication tag.

// Fixed, application-specific salt for key derivation. The salt must be stable
// so that a token encrypted in one process can be decrypted in another; the
// secrecy of the scheme rests on MASTER_KEY, not on this salt.
const KEY_SALT = 'gopay-payment-panel/token-store/v1';

// Format markers written to the file so `load()` can tell encrypted payloads
// apart from the plaintext fallback.
const FORMAT_ENCRYPTED = 'aes-256-gcm';
const FORMAT_PLAIN = 'plain';
const FORMAT_VERSION = 1;

/**
 * Derive a 32-byte AES key from the master key using scrypt with a fixed salt.
 *
 * @param {string} masterKey - the raw MASTER_KEY value.
 * @returns {Buffer} a 32-byte key suitable for AES-256.
 */
function deriveKey(masterKey) {
  return crypto.scryptSync(masterKey, KEY_SALT, KEY_LENGTH);
}

/**
 * Encrypted, persistent store for the GoBiz access token.
 *
 * Usage:
 *   const store = createTokenStore();
 *   store.save('the-access-token');
 *   const token = store.load(); // 'the-access-token' or null
 *   store.clear();
 */
export class TokenStore {
  /**
   * @param {object} [options]
   * @param {string} [options.filePath] - path to the token file.
   * @param {string|null} [options.masterKey] - master key used for encryption;
   *   when null/empty the store falls back to plaintext storage.
   * @param {Pick<Console, 'warn'>} [options.logger] - logger for warnings.
   */
  constructor(options = {}) {
    const {
      filePath = process.env.TOKEN_FILE_PATH || DEFAULT_TOKEN_FILE,
      masterKey = process.env.MASTER_KEY,
      logger = console,
    } = options;

    this.filePath = filePath;
    this.masterKey = masterKey && masterKey.length > 0 ? masterKey : null;
    this.logger = logger;
    this._warnedAboutPlaintext = false;
  }

  /**
   * Whether encryption is enabled (i.e. a MASTER_KEY is configured).
   * @returns {boolean}
   */
  get isEncrypted() {
    return this.masterKey !== null;
  }

  /**
   * Emit the plaintext-fallback warning once per store instance.
   * @private
   */
  _warnPlaintextFallback() {
    if (this._warnedAboutPlaintext) return;
    this._warnedAboutPlaintext = true;
    this.logger?.warn?.(
      '[TokenStore] MASTER_KEY is not set. The GoBiz token will be stored in ' +
        'plaintext (with 0600 permissions). Set MASTER_KEY in your environment ' +
        'to enable AES-256-GCM encryption at-rest.',
    );
  }

  /**
   * Persist the token to disk.
   *
   * When MASTER_KEY is configured the token is encrypted with AES-256-GCM and
   * stored as `{ v, alg, iv, tag, data }` (base64 fields). Otherwise it is
   * stored as plaintext `{ v, alg: 'plain', data }`. In both cases the file is
   * written with 0600 permissions.
   *
   * @param {string} token - the access token to persist.
   */
  save(token) {
    if (typeof token !== 'string' || token.length === 0) {
      throw new TypeError('token must be a non-empty string');
    }

    let payload;
    if (this.isEncrypted) {
      const key = deriveKey(this.masterKey);
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
        authTagLength: AUTH_TAG_LENGTH,
      });
      const ciphertext = Buffer.concat([
        cipher.update(token, 'utf8'),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();
      payload = {
        v: FORMAT_VERSION,
        alg: FORMAT_ENCRYPTED,
        iv: iv.toString('base64'),
        tag: authTag.toString('base64'),
        data: ciphertext.toString('base64'),
      };
    } else {
      this._warnPlaintextFallback();
      payload = {
        v: FORMAT_VERSION,
        alg: FORMAT_PLAIN,
        data: token,
      };
    }

    this._writeFile(JSON.stringify(payload));
  }

  /**
   * Load and return the persisted token, or null when no usable token exists.
   *
   * Returns null when the file is missing, unreadable, corrupt, or when an
   * encrypted payload cannot be decrypted (for example because MASTER_KEY is
   * absent or does not match). Decryption failures are logged as warnings.
   *
   * @returns {string|null}
   */
  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      // Missing or unreadable file: treat as "no token".
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.logger?.warn?.(
        '[TokenStore] The token file is corrupt and could not be parsed. ' +
          'Ignoring the stored token.',
      );
      return null;
    }

    if (payload?.alg === FORMAT_PLAIN) {
      return typeof payload.data === 'string' ? payload.data : null;
    }

    if (payload?.alg === FORMAT_ENCRYPTED) {
      if (!this.isEncrypted) {
        this.logger?.warn?.(
          '[TokenStore] The token file is encrypted but MASTER_KEY is not set. ' +
            'The stored token cannot be decrypted and will be ignored.',
        );
        return null;
      }
      try {
        const key = deriveKey(this.masterKey);
        const iv = Buffer.from(payload.iv, 'base64');
        const authTag = Buffer.from(payload.tag, 'base64');
        const ciphertext = Buffer.from(payload.data, 'base64');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
          authTagLength: AUTH_TAG_LENGTH,
        });
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        return plaintext.toString('utf8');
      } catch {
        this.logger?.warn?.(
          '[TokenStore] Failed to decrypt the stored token. It may be corrupt ' +
            'or MASTER_KEY may have changed. Ignoring the stored token.',
        );
        return null;
      }
    }

    // Unknown format.
    this.logger?.warn?.(
      '[TokenStore] The token file has an unrecognized format. Ignoring it.',
    );
    return null;
  }

  /**
   * Remove the persisted token file, if it exists.
   */
  clear() {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch (error) {
      this.logger?.warn?.(
        `[TokenStore] Failed to remove the token file: ${error.message}`,
      );
    }
  }

  /**
   * Write contents to the token file with 0600 permissions.
   *
   * `writeFileSync`'s mode only applies when the file is created, so chmod is
   * called afterwards to guarantee 0600 even when the file already existed.
   *
   * @param {string} contents
   * @private
   */
  _writeFile(contents) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, contents, { mode: FILE_MODE });
    try {
      fs.chmodSync(this.filePath, FILE_MODE);
    } catch {
      // On platforms that do not support chmod (e.g. Windows) this is a no-op.
    }
  }
}

/**
 * Create a TokenStore using the default file path and MASTER_KEY from the
 * environment.
 *
 * @param {ConstructorParameters<typeof TokenStore>[0]} [options]
 * @returns {TokenStore}
 */
export function createTokenStore(options) {
  return new TokenStore(options);
}

export default TokenStore;
