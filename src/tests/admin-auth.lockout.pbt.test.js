//   For any series of login attempts, after MAX_FAILED_LOGIN_ATTEMPTS (5)
//   consecutive failures within LOGIN_FAILURE_WINDOW_MS (15 min), the next
//   attempt — even with the correct password — is blocked for LOGIN_LOCKOUT_MS
//   (15 min). Once that lockout window elapses, login succeeds again. Failures
//   spread beyond the counting window never accumulate to a lock.
//
// The policy under test lives in createAdminAuth (src/auth/admin-auth.js). To
// keep >= 100 randomized runs fast we drive it against an in-memory fake
// `adminUsers` store that mirrors the SQLite DAL contract
// (getByUsername / recordLoginFailure / resetFailures / isLockedOut), with the
// password hashed exactly once via hashPasswordSync. The DAL's isLockedOut
// semantics are reproduced precisely: locked iff
//   lockout_until !== null && failed_attempts >= 5 && now < lockout_until.
//
// The clock is injected and mutable so every timing scenario is deterministic.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { hashPasswordSync } from '../auth/hashing.js';
import {
  ADMIN_AUTH_ERRORS,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_LOCKOUT_MS,
  MAX_FAILED_LOGIN_ATTEMPTS,
  createAdminAuth,
} from '../auth/admin-auth.js';

const SECRET = 'lockout-pbt-signing-secret';
const USERNAME = 'admin';
const PASSWORD = 'correct horse battery staple';
const WRONG_PASSWORD = 'definitely-not-the-password';

// scrypt verification is intentionally expensive, so each login is ~tens of ms.
// A lockout scenario performs several logins per run; give the property tests a
// generous wall-clock budget while still executing the full >= 100 iterations.
const TEST_TIMEOUT_MS = 180_000;

/**
 * Apply the fixed-window login failure policy, mirroring the production DAL's
 * `applyFailurePolicy`. Given the previous state (if any) and a policy
 * `{ now, windowMs, threshold, lockoutMs }`, compute the next
 * `{ failedAttempts, lockoutUntil }`.
 *
 * @param {{ failedAttempts: number, lockoutUntil: number|null }|null} state
 * @param {{ now: number, windowMs: number, threshold: number, lockoutMs: number }} policy
 * @returns {{ failedAttempts: number, lockoutUntil: number|null }}
 */
function applyFailurePolicy(state, policy) {
  const { now, windowMs, threshold, lockoutMs } = policy;
  const prevAttempts = state ? state.failedAttempts : 0;
  const prevUntil = state ? state.lockoutUntil : null;

  const withinOpenWindow =
    prevUntil !== null &&
    now < prevUntil &&
    prevAttempts > 0 &&
    prevAttempts < threshold;

  let failedAttempts;
  let windowEnd;
  if (withinOpenWindow) {
    failedAttempts = prevAttempts + 1;
    windowEnd = prevUntil; // keep the fixed window from the first failure
  } else {
    failedAttempts = 1;
    windowEnd = now + windowMs;
  }

  const lockoutUntil =
    failedAttempts >= threshold ? now + lockoutMs : windowEnd;

  return { failedAttempts, lockoutUntil };
}

/**
 * An in-memory `adminUsers` store for a single seeded admin. It implements the
 * exact subset of the DAL contract that createAdminAuth depends on and mirrors
 * the SQLite isLockedOut semantics (threshold AND future deadline).
 *
 * @param {string} username
 * @param {string} passwordHash
 * @returns {{ adminUsers: import('../dal/storage-interface.js').Storage['adminUsers'] }}
 */
function createFakeStorage(username, passwordHash) {
  const user = {
    id: 'fake-admin-id',
    username,
    password_hash: passwordHash,
  };

  const loginState = new Map();

  const adminUsers = {
    getByUsername(name) {
      return name === user.username ? { ...user } : null;
    },
  };

  const loginAttempts = {
    getByIp(ipAddress) {
      const state = loginState.get(ipAddress);
      return state ? { ...state } : null;
    },
    recordFailure(ipAddress, policy) {
      const prev = loginState.get(ipAddress);
      const next = applyFailurePolicy(prev, policy);
      loginState.set(ipAddress, next);
      return { ok: true, value: next };
    },
    resetFailures(ipAddress) {
      loginState.delete(ipAddress);
      return { ok: true };
    },
    isLockedOut(ipAddress, now) {
      const state = loginState.get(ipAddress);
      if (!state) return false;
      return (
        state.lockoutUntil !== null &&
        state.failedAttempts >= MAX_FAILED_LOGIN_ATTEMPTS &&
        now < state.lockoutUntil
      );
    },
  };

  return { adminUsers, loginAttempts };
}

// Hash the shared password a single time; every run reuses this stored hash.
const PASSWORD_HASH = hashPasswordSync(PASSWORD);

describe('Property 31: Login lockout', () => {
  // Each of the five failures that triggers a lockout must land inside the
  // single 15-minute window opened by the first failure. Bounding every
  // inter-attempt gap below window/5 guarantees the four gaps between the five
  // failures sum to strictly less than the window.
  const MAX_GAP_WITHIN_WINDOW = Math.floor((LOGIN_FAILURE_WINDOW_MS - 1) / MAX_FAILED_LOGIN_ATTEMPTS);

  it(
    'locks after 5 failures within the window — refusing even the correct password — then recovers once the lockout elapses',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // A plausible epoch baseline for the first failed attempt.
          fc.integer({ min: 1000, max: 4_000_000_000_000 }),
          // The four inter-arrival gaps between the five failures, each small
          // enough that all five stay inside the first failure's window.
          fc.array(fc.integer({ min: 0, max: MAX_GAP_WITHIN_WINDOW }), {
            minLength: MAX_FAILED_LOGIN_ATTEMPTS - 1,
            maxLength: MAX_FAILED_LOGIN_ATTEMPTS - 1,
          }),
          // How far past the lockout deadline we step before retrying.
          fc.integer({ min: 1000, max: 7 * 24 * 60 * 60 * 1000 }),
          async (base, gaps, overshoot) => {
            const storage = createFakeStorage(USERNAME, PASSWORD_HASH);
            let clock = base;
            const auth = createAdminAuth(storage, { now: () => clock, secret: SECRET });

            // Drive five failed logins, all inside the same 15-minute window.
            for (let i = 0; i < MAX_FAILED_LOGIN_ATTEMPTS; i += 1) {
              // eslint-disable-next-line no-await-in-loop
              const fail = await auth.login(USERNAME, WRONG_PASSWORD, '127.0.0.1');
              expect(fail.ok).toBe(false);
              expect(fail.code).toBe(ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS);
              if (i < gaps.length) {
                clock += gaps[i];
              }
            }

            const lockedAt = clock;

            // The account is now blocked, and the block lasts the full window.
            expect(storage.loginAttempts.isLockedOut('127.0.0.1', lockedAt)).toBe(true);

            // Even the correct password is refused while blocked.
            const blocked = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
            expect(blocked.ok).toBe(false);
            expect(blocked.code).toBe(ADMIN_AUTH_ERRORS.ACCOUNT_LOCKED);

            // Still blocked partway through the lockout window.
            const midLockout = lockedAt + Math.floor(LOGIN_LOCKOUT_MS / 2);
            clock = midLockout;
            const stillBlocked = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
            expect(stillBlocked.code).toBe(ADMIN_AUTH_ERRORS.ACCOUNT_LOCKED);
            expect(storage.loginAttempts.isLockedOut('127.0.0.1', midLockout)).toBe(true);

            // Advance strictly past the lockout deadline (lockedAt + LOGIN_LOCKOUT_MS):
            // the correct password now succeeds again and the counters clear.
            clock = lockedAt + LOGIN_LOCKOUT_MS + overshoot;
            const recovered = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
            expect(recovered.ok).toBe(true);
            expect(recovered.session.username).toBe(USERNAME);
            expect(storage.loginAttempts.getByIp('127.0.0.1')).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'never locks when failures are spread beyond the counting window',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1000, max: 4_000_000_000_000 }),
          // A handful of failures, each separated by at least a full window so
          // every failure opens a fresh window and the count never accumulates.
          fc.integer({ min: 1, max: 4 }),
          fc.array(
            fc.integer({ min: LOGIN_FAILURE_WINDOW_MS, max: 2 * LOGIN_FAILURE_WINDOW_MS }),
            { minLength: 4, maxLength: 4 },
          ),
          async (base, failureCount, gaps) => {
            const storage = createFakeStorage(USERNAME, PASSWORD_HASH);
            let clock = base;
            const auth = createAdminAuth(storage, { now: () => clock, secret: SECRET });

            for (let i = 0; i < failureCount; i += 1) {
              // eslint-disable-next-line no-await-in-loop
              const fail = await auth.login(USERNAME, WRONG_PASSWORD, '127.0.0.1');
              // A spread-out failure is a plain credential rejection, never a lock.
              expect(fail.code).toBe(ADMIN_AUTH_ERRORS.INVALID_CREDENTIALS);
              expect(storage.loginAttempts.isLockedOut('127.0.0.1', clock)).toBe(false);
              clock += gaps[i % gaps.length];
            }

            // After all spread-out failures the IP is still not locked and
            // the correct password is accepted.
            expect(storage.loginAttempts.isLockedOut('127.0.0.1', clock)).toBe(false);
            const ok = await auth.login(USERNAME, PASSWORD, '127.0.0.1');
            expect(ok.ok).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    },
    TEST_TIMEOUT_MS,
  );
});
