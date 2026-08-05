// Property-based test for Admin login generic rejection.
//
// For ANY incorrect username/password combination the
// Panel SHALL reject the login without creating a session and SHALL display an
// identical message without distinguishing whether the username or the password
// was wrong. Concretely, `createAdminAuth(...).login(...)` MUST return
// `ok: false` with the SAME `code` (`INVALID_CREDENTIALS`) and the IDENTICAL
// generic `message` ('Invalid username or password.') for both:
//   * a known username with a WRONG password, and
//   * an UNKNOWN username (with any password).
// Neither outcome may reveal which field was wrong.
//
// To keep >= 100 runs fast this drives the real `createAdminAuth` against a
// lightweight in-memory fake of the DAL `adminUsers` store seeded with a single
// admin whose scrypt hash is precomputed ONCE via `hashPasswordSync`. The clock
// and signing secret are injected so the behavior is fully deterministic.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { hashPasswordSync } from '../auth/hashing.js';
import { ADMIN_AUTH_ERRORS, createAdminAuth } from '../auth/admin-auth.js';

const SECRET = 'pbt-generic-rejection-secret';
const KNOWN_USERNAME = 'admin';
const KNOWN_PASSWORD = 'correct horse battery staple';
// The single generic message that hides which field was wrong.
const GENERIC_MESSAGE = 'Invalid username or password.';

// Precompute the stored scrypt hash exactly once so each property run only pays
// for a single password verification rather than a fresh hash + DB per run.
const KNOWN_PASSWORD_HASH = hashPasswordSync(KNOWN_PASSWORD);

/**
 * Build an in-memory fake of the DAL `adminUsers` store seeded with one admin.
 *
 * It mirrors the contract `createAdminAuth` depends on:
 *   - `getByUsername` returns the seeded record only for the exact username,
 *     and `null` for everyone else (so unknown users have no stored hash).
 *   - `isLockedOut` is always false here: this property isolates the generic
 *     rejection behavior from the separate lockout policy.
 *   - `recordLoginFailure` / `resetFailures` are inert no-ops; lockout state is
 *     out of scope for this property.
 */
function makeStorage() {
  const user = {
    username: KNOWN_USERNAME,
    password_hash: KNOWN_PASSWORD_HASH,
    failed_attempts: 0,
    lockout_until: null,
  };
  return {
    adminUsers: {
      getByUsername(username) {
        return username === KNOWN_USERNAME ? { ...user } : null;
      },
    },
    loginAttempts: {
      getByIp() { return null; },
      isLockedOut() { return false; },
      recordFailure() {},
      resetFailures() {},
    },
  };
}

describe('Property 30: Generic login rejection', () => {
  // Each wrong-password run pays for one (deliberately memory-hard) scrypt
  // verification, so allow a generous budget for the full 100-run sweep.
  it('returns the identical generic error for a wrong password and an unknown username', async () => {
    const storage = makeStorage();
    const auth = createAdminAuth(storage, { now: () => 1_000_000, secret: SECRET });

    // A wrong password: any non-empty string that is not the correct password.
    const wrongPassword = fc
      .string({ minLength: 1, maxLength: 64 })
      .filter((s) => s !== KNOWN_PASSWORD);

    // An unknown username: any non-blank string that is not the seeded admin.
    const unknownUsername = fc
      .string({ minLength: 1, maxLength: 64 })
      .filter((s) => s.trim().length > 0 && s !== KNOWN_USERNAME);

    // Any password to pair with the unknown username (incl. the correct one).
    const anyPassword = fc.string({ minLength: 1, maxLength: 64 });

    await fc.assert(
      fc.asyncProperty(
        wrongPassword,
        unknownUsername,
        anyPassword,
        async (badPassword, badUsername, pairedPassword) => {
          // Case A: known username + wrong password.
          const wrongPasswordResult = await auth.login(KNOWN_USERNAME, badPassword, '127.0.0.1');
          // Case B: unknown username + any password.
          const unknownUserResult = await auth.login(badUsername, pairedPassword, '127.0.0.1');

          // Both reject without creating a session.
          expect(wrongPasswordResult.ok).toBe(false);
          expect(unknownUserResult.ok).toBe(false);
          expect(wrongPasswordResult.token).toBeUndefined();
          expect(unknownUserResult.token).toBeUndefined();

          // Both use the same generic credential-failure code...
          expect(wrongPasswordResult.code).toBe(ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS);
          expect(unknownUserResult.code).toBe(ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS);

          // ...and the byte-for-byte identical generic message.
          expect(wrongPasswordResult.message).toBe(GENERIC_MESSAGE);
          expect(unknownUserResult.message).toBe(GENERIC_MESSAGE);
          expect(wrongPasswordResult.message).toBe(unknownUserResult.message);
          expect(wrongPasswordResult.code).toBe(unknownUserResult.code);
        },
      ),
      { numRuns: 100 },
    );
  }, 60000);
});
