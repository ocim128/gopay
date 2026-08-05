// Property-based test for Admin session expiration.
//
// For any session whose age has passed 24 hours, the
// Panel SHALL consider it invalid. A token minted at t0 is valid for every
// instant strictly before t0 + SESSION_TTL_MS (24h) and is EXPIRED at or after
// that instant.
//
// Strategy: build the real `createAdminAuth` facade with an injected clock and
// signing secret, backed by a minimal in-memory `adminUsers` store seeded with
// a single user whose password is hashed once (via hashPasswordSync). For each
// run we pick a login time t0, mint a token through `login`, then probe
// `validateSession(token, t0 + offset)` across offsets drawn from both sides of
// the boundary and assert:
//   - offset in [0, SESSION_TTL_MS - 1]  -> { valid: true } and isAuthenticated
//   - offset >= SESSION_TTL_MS           -> { valid: false, reason: 'EXPIRED' }
//                                           and !isAuthenticated

import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';

import { createAdminAuth, SESSION_TTL_MS } from '../auth/admin-auth.js';
import { hashPasswordSync } from '../auth/hashing.js';

const SECRET = 'pbt-session-expiration-secret';
const USERNAME = 'admin';
const PASSWORD = 'correct horse battery staple';

// Hash the seed password exactly once: scrypt hashing is intentionally slow, so
// reusing the same hash across all generated runs keeps the property fast.
const PASSWORD_HASH = hashPasswordSync(PASSWORD);

/**
 * Build a minimal in-memory `adminUsers` store seeded with one never-locked
 * user, exposing just the surface the login success path touches:
 * isLockedOut, getByUsername, resetFailures.
 *
 * @returns {{ adminUsers: object }}
 */
function makeStorage() {
  const user = {
    id: 'u1',
    username: USERNAME,
    password_hash: PASSWORD_HASH,
    failed_attempts: 0,
    lockout_until: null,
  };
  return {
    adminUsers: {
      getByUsername(username) {
        return username === user.username ? user : null;
      },
    },
    loginAttempts: {
      isLockedOut() {
        return false;
      },
      resetFailures() {
        // No failures are recorded in this property; nothing to reset.
      },
      recordFailure() {
        // Unused on the success path; present for interface completeness.
      },
      getByIp() {
        return null;
      }
    },
  };
}

describe('Property 32: Admin session expiration', () => {
  // A fixed login time t0. We mint the token once (login runs slow scrypt
  // verification, so doing it per-iteration is needlessly expensive) and then
  // probe expiry across many generated offsets relative to this t0.
  const t0 = 1_700_000_000_000;
  const auth = createAdminAuth(makeStorage(), { now: () => t0, secret: SECRET });

  /** @type {string} */
  let token;
  beforeAll(async () => {
    const result = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
    expect(result.ok).toBe(true);
    expect(result.session.issuedAt).toBe(t0);
    expect(result.session.expiresAt).toBe(t0 + SESSION_TTL_MS);
    token = result.token;
  });

  // Offsets that exercise both sides of the 24h boundary, including the exact
  // boundary instants where valid flips to EXPIRED.
  const offsetArb = fc.oneof(
    // Strictly inside the validity window: [0, SESSION_TTL_MS - 1].
    fc.integer({ min: 0, max: SESSION_TTL_MS - 1 }),
    // At or after expiry: [SESSION_TTL_MS, 3 * SESSION_TTL_MS].
    fc.integer({ min: SESSION_TTL_MS, max: 3 * SESSION_TTL_MS }),
    // Pin the exact boundary instants so they are always covered.
    fc.constantFrom(0, SESSION_TTL_MS - 1, SESSION_TTL_MS, SESSION_TTL_MS + 1),
  );

  it('treats a token as valid before 24h and EXPIRED at/after 24h', () => {
    fc.assert(
      fc.property(offsetArb, (offset) => {
        const at = t0 + offset;
        const check = auth.validateSession(token, at);

        if (offset < SESSION_TTL_MS) {
          // Before the 24h boundary the session is valid.
          expect(check).toEqual({
            valid: true,
            session: {
              username: USERNAME,
              issuedAt: t0,
              expiresAt: t0 + SESSION_TTL_MS,
            },
          });
          expect(auth.isAuthenticated(token, at)).toBe(true);
        } else {
          // At or after the 24h boundary the session is EXPIRED.
          expect(check).toEqual({ valid: false, reason: 'EXPIRED' });
          expect(auth.isAuthenticated(token, at)).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });
});
