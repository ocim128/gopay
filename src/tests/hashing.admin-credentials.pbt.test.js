// Property-based test that stored Admin credentials are hashed.
//
// The stored Admin password must be a hash, never the plaintext:
//   - the produced hash differs from the plaintext and does not contain it,
//   - the hash is self-describing (starts with 'scrypt$'),
//   - verifyPassword accepts the correct password and rejects wrong ones,
//   - a fresh random salt makes two hashes of the same password differ, yet
//     both still verify.
//
// hashPasswordSync is used to keep the scrypt work factor from dominating run
// time across many generated inputs. scrypt is intentionally memory-hard, so
// each property gets a generous timeout while still running >= 100 iterations.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { hashPasswordSync, verifyPassword } from '../auth/hashing.js';

// scrypt is deliberately slow (N=16384), so allow ample time for >=100 runs
// that each perform multiple key derivations.
const SCRYPT_TIMEOUT_MS = 120_000;

// Realistic, non-empty passwords across the full unicode range.
//
// hashPassword/verifyPassword require a non-empty string. A minimum length is
// used so the "hash does not contain the plaintext" assertion stays meaningful:
// the encoded hash embeds base64 salt/key text, and a one-character password
// such as "/" would trivially (and uninterestingly) appear inside that base64.
const passwordArb = fc.string({ minLength: 12, maxLength: 64 });

describe('Property 29: Admin credentials stored hashed', () => {
  it(
    'stores a hash, never the plaintext, and verifies correctly',
    async () => {
      await fc.assert(
        fc.asyncProperty(passwordArb, async (password) => {
          const hash = hashPasswordSync(password);

          // The stored value is a hash, not the plaintext.
          expect(hash).not.toBe(password);
          expect(hash).not.toContain(password);
          expect(hash.startsWith('scrypt$')).toBe(true);

          // The correct password verifies against its hash.
          expect(await verifyPassword(password, hash)).toBe(true);
        }),
        { numRuns: 100 },
      );
    },
    SCRYPT_TIMEOUT_MS,
  );

  it(
    'rejects a password that differs from the one that was hashed',
    async () => {
      await fc.assert(
        fc.asyncProperty(passwordArb, passwordArb, async (password, other) => {
          // Only meaningful when the two passwords actually differ.
          fc.pre(password !== other);
          const hash = hashPasswordSync(password);
          expect(await verifyPassword(other, hash)).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
    SCRYPT_TIMEOUT_MS,
  );

  it(
    'uses a fresh salt: same password yields different hashes that both verify',
    async () => {
      await fc.assert(
        fc.asyncProperty(passwordArb, async (password) => {
          const first = hashPasswordSync(password);
          const second = hashPasswordSync(password);

          // Fresh per-hash salt => the encoded hashes differ.
          expect(first).not.toBe(second);

          // Both hashes still verify the original password.
          expect(await verifyPassword(password, first)).toBe(true);
          expect(await verifyPassword(password, second)).toBe(true);
        }),
        { numRuns: 100 },
      );
    },
    SCRYPT_TIMEOUT_MS,
  );
});
