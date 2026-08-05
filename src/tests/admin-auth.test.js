// Tests for Admin authentication (admin-auth.js).
//
// These exercise the login + session + rate-limit policy against the real
// SQLite `adminUsers` store (an ephemeral temp-file database that is deleted
// after each test) with an injected clock, so the behavior is fully
// deterministic:
//
//   - 24h session creation on success
//   - a single generic error that hides which field was wrong
//   - empty-field rejection
//   - 5 failures / 15 min => 15 min block, then recovery
//   - unauthenticated/expired sessions are rejected
//   - the stored credential is a hash, never the plaintext

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { hashPasswordSync } from '../auth/hashing.js';
import {
  ADMIN_AUTH_ERRORS,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_LOCKOUT_MS,
  MAX_FAILED_LOGIN_ATTEMPTS,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  createAdminAuth,
} from '../auth/admin-auth.js';

const SECRET = 'unit-test-signing-secret';
const USERNAME = 'admin';
const PASSWORD = 'correct horse battery staple';

/**
 * Insert a single admin user directly through a raw connection that shares the
 * same on-disk database file as the Storage under test.
 *
 * @param {string} dbPath
 * @param {{ username?: string, password?: string }} [over]
 */
function seedAdmin(dbPath, over = {}) {
  const username = over.username ?? USERNAME;
  const password = over.password ?? PASSWORD;
  const raw = new Database(dbPath);
  raw
    .prepare(
      `INSERT INTO admin_users (id, username, password_hash)
       VALUES (?, ?, ?)`,
    )
    .run(randomUUID(), username, hashPasswordSync(password));
  raw.close();
}

describe('createAdminAuth', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  let dbPath;
  let clock;
  /** @type {ReturnType<typeof createAdminAuth>} */
  let auth;

  beforeEach(() => {
    dbPath = join(tmpdir(), `admin-auth-${randomUUID()}.db`);
    storage = createSqliteStorage({ dbPath });
    seedAdmin(dbPath);
    clock = 1_000_000;
    auth = createAdminAuth(storage, { now: () => clock, secret: SECRET });
  });

  afterEach(() => {
    storage.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  describe('construction', () => {
    it('requires a storage with an adminUsers store', () => {
      expect(() => createAdminAuth(null, { secret: SECRET })).toThrow(TypeError);
      expect(() => createAdminAuth({}, { secret: SECRET })).toThrow(TypeError);
    });

    it('requires a non-empty signing secret', () => {
      const saved = process.env.ADMIN_SESSION_SECRET;
      delete process.env.ADMIN_SESSION_SECRET;
      expect(() => createAdminAuth(storage, {})).toThrow(TypeError);
      if (saved !== undefined) {
        process.env.ADMIN_SESSION_SECRET = saved;
      }
    });
  });

  describe('login success', () => {
    it('creates a 24h session with an httpOnly cookie on correct credentials', async () => {
      const result = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
      expect(result.ok).toBe(true);
      expect(result.token).toMatch(/^[\w-]+\.[\w-]+$/);
      // Session validity is exactly 24h (86,400,000 ms).
      expect(result.session.expiresAt - result.session.issuedAt).toBe(SESSION_TTL_MS);
      expect(result.session.issuedAt).toBe(clock);
      expect(result.session.username).toBe(USERNAME);
      // httpOnly cookie with the matching 24h max-age.
      expect(result.cookie).toContain(`${SESSION_COOKIE_NAME}=${result.token}`);
      expect(result.cookie).toContain('HttpOnly');
      expect(result.cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
    });

    it('stores only a password hash, never the plaintext', () => {
      const stored = storage.adminUsers.getByUsername(USERNAME);
      expect(stored.password_hash).not.toBe(PASSWORD);
      expect(stored.password_hash.startsWith('scrypt$')).toBe(true);
    });

    it('clears the failure counters on success', async () => {
      await auth.login(USERNAME, 'wrong', '127.0.0.1');
      await auth.login(USERNAME, 'wrong', '127.0.0.1');
      expect(storage.loginAttempts.getByIp('127.0.0.1').failedAttempts).toBe(2);

      await auth.login(USERNAME, PASSWORD, '127.0.0.1');
      const after = storage.loginAttempts.getByIp('127.0.0.1');
      expect(after.failedAttempts).toBe(0);
      expect(after.lockoutUntil).toBeNull();
    });
  });

  describe('login failure is generic', () => {
    it('rejects a wrong password with a generic error', async () => {
      const result = await auth.login(USERNAME, 'wrong-password', '127.0.0.1');
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS);
      // The generic message references username and password together (an
      // either/or form) and never states which one specifically was wrong.
      expect(result.message).toBe('Invalid username or password.');
    });

    it('returns the identical message for a wrong password and an unknown user', async () => {
      const wrongPassword = await auth.login(USERNAME, 'wrong-password', '127.0.0.1');
      const unknownUser = await auth.login('nobody', PASSWORD, '127.0.0.1');
      expect(wrongPassword.message).toBe(unknownUser.message);
      expect(wrongPassword.code).toBe(unknownUser.code);
    });

    it('rejects an unknown username with the same generic error', async () => {
      const result = await auth.login('nobody', PASSWORD, '127.0.0.1');
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS);
    });

    it('does track IP failure for unknown usernames', async () => {
      for (let i = 0; i < MAX_FAILED_LOGIN_ATTEMPTS + 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await auth.login('nobody', 'x', '10.0.0.1');
        if (i < MAX_FAILED_LOGIN_ATTEMPTS) {
          expect(r.code).toBe(ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS);
        } else {
          expect(r.code).toBe(ADMIN_AUTH_ERRORS.ACCOUNT_LOCKED);
        }
      }
      expect(storage.loginAttempts.getByIp('10.0.0.1').failedAttempts).toBe(5);
    });
  });

  describe('empty fields', () => {
    it('rejects an empty username without a lookup', async () => {
      const result = await auth.login('', PASSWORD, '127.0.0.1');
      expect(result.ok).toBe(false);
      expect(result.code).toBe(ADMIN_AUTH_ERRORS.MISSING_CREDENTIALS);
    });

    it('rejects a whitespace-only username', async () => {
      const result = await auth.login('   ', PASSWORD, '127.0.0.1');
      expect(result.code).toBe(ADMIN_AUTH_ERRORS.MISSING_CREDENTIALS);
    });

    it('rejects an empty password', async () => {
      const result = await auth.login(USERNAME, '', '127.0.0.1');
      expect(result.code).toBe(ADMIN_AUTH_ERRORS.MISSING_CREDENTIALS);
    });

    it('does not record a failure for an empty submission', async () => {
      await auth.login(USERNAME, '', '127.0.0.1');
      expect(storage.loginAttempts.getByIp('127.0.0.1')).toBeNull();
    });
  });

  describe('rate limiting', () => {
    it('blocks login for 15 minutes after 5 failures within 15 minutes', async () => {
      for (let i = 0; i < MAX_FAILED_LOGIN_ATTEMPTS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const r = await auth.login(USERNAME, 'wrong', '127.0.0.1');
        expect(r.code).toBe(ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS);
        clock += 1000; // each attempt a second apart, well inside the window
      }
      expect(storage.loginAttempts.isLockedOut('127.0.0.1', clock)).toBe(true);

      // Even the correct password is refused while blocked.
      const blocked = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
      expect(blocked.ok).toBe(false);
      expect(blocked.code).toBe(ADMIN_AUTH_ERRORS.ACCOUNT_LOCKED);
    });

    it('allows login again once the 15-minute block has elapsed', async () => {
      for (let i = 0; i < MAX_FAILED_LOGIN_ATTEMPTS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await auth.login(USERNAME, 'wrong', '127.0.0.1');
        clock += 1000;
      }
      expect((await auth.login(USERNAME, PASSWORD, '127.0.0.1')).code).toBe(
        ADMIN_AUTH_ERRORS.ACCOUNT_LOCKED,
      );

      // Advance past the lockout window.
      clock += LOGIN_LOCKOUT_MS + 1;
      const recovered = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
      expect(recovered.ok).toBe(true);
    });

    it('does not lock when failures are spread beyond the 15-minute window', async () => {
      // Four failures, each separated by more than the full window, never reach
      // the threshold within a single window.
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await auth.login(USERNAME, 'wrong', '127.0.0.1');
        clock += LOGIN_FAILURE_WINDOW_MS + 1;
      }
      expect(storage.loginAttempts.isLockedOut('127.0.0.1', clock)).toBe(false);
      const ok = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
      expect(ok.ok).toBe(true);
    });
  });

  describe('session validation', () => {
    it('accepts a freshly issued token', async () => {
      const { token } = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
      const check = auth.validateSession(token, clock);
      expect(check.valid).toBe(true);
      expect(check.session.username).toBe(USERNAME);
      expect(auth.isAuthenticated(token, clock)).toBe(true);
    });

    it('rejects a token after its 24h validity elapses', async () => {
      const { token } = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
      const justBefore = auth.validateSession(token, clock + SESSION_TTL_MS - 1);
      expect(justBefore.valid).toBe(true);

      const atExpiry = auth.validateSession(token, clock + SESSION_TTL_MS);
      expect(atExpiry).toEqual({ valid: false, reason: 'EXPIRED' });
      expect(auth.isAuthenticated(token, clock + SESSION_TTL_MS)).toBe(false);
    });

    it('rejects a tampered or foreign token as INVALID', async () => {
      const { token } = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
      const tampered = `${token}x`;
      expect(auth.validateSession(tampered, clock)).toEqual({ valid: false, reason: 'INVALID' });

      // A token signed with a different secret must not validate.
      const otherAuth = createAdminAuth(storage, { now: () => clock, secret: 'different' });
      const otherToken = (await otherAuth.login(USERNAME, PASSWORD, '127.0.0.1')).token;
      expect(auth.validateSession(otherToken, clock)).toEqual({
        valid: false,
        reason: 'INVALID',
      });
    });

    it('rejects empty/garbage tokens', () => {
      expect(auth.validateSession('', clock).valid).toBe(false);
      expect(auth.validateSession('not-a-token', clock).valid).toBe(false);
      expect(auth.isAuthenticated(undefined, clock)).toBe(false);
    });

    it('clears the cookie via buildClearedCookie', () => {
      const cleared = auth.buildClearedCookie();
      expect(cleared).toContain(`${SESSION_COOKIE_NAME}=`);
      expect(cleared).toContain('Max-Age=0');
      expect(cleared).toContain('HttpOnly');
    });
  });
});
