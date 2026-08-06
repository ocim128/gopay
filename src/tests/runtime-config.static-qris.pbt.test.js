// Property-based tests for Static_QRIS validation on Config set.
//
// setStaticQris (and the underlying
// validateStaticQrisValue) rejects empty, whitespace-only, structurally
// malformed, and invalid-CRC16 payloads by throwing a ConfigValidationError
// that maps to HTTP 400, while retaining the previously stored value. A valid
// Static_QRIS is accepted, normalized (trimmed), and persisted through the DAL.
//
// These run against a real in-memory SQLite DAL (no mocks) so the
// retain-previous-value and persistence guarantees are exercised end-to-end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import {
  ConfigValidationError,
  createConfigService,
  validateStaticQrisValue,
} from '../config/runtime-config.js';

// A real, structurally valid single-merchant Static_QRIS with a correct
// trailing CRC16 ("CD45"). Everything up to the final 4 characters is the
// payload-with-tag; the last 4 characters are the checksum.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

// The valid payload up to and including the `6304` CRC tag (drops "CD45").
const VALID_PAYLOAD_WITH_TAG = VALID_STATIC_QRIS.slice(0, -4);
const CORRECT_CRC = VALID_STATIC_QRIS.slice(-4).toUpperCase();

const HEX_DIGITS = '0123456789ABCDEF'.split('');

// ---- generators for invalid candidates -----------------------------------

// Empty string: the simplest rejection case.
const emptyArb = fc.constant('');

// Whitespace-only strings (spaces, tabs, newlines): trim to empty.
const whitespaceOnlyArb = fc.string({
  unit: fc.constantFrom(' ', '\t', '\n', '\r'),
  minLength: 1,
  maxLength: 12,
});

// Random garbage that is structurally malformed. Excluding the mandatory
// country-code field (5802ID) guarantees the payload cannot be parsed as a
// QRIS, so these are always rejected.
const garbageArb = fc.string({ maxLength: 80 }).filter((s) => !s.includes('5802ID'));

// Valid structure but a wrong trailing CRC16: keep the real payload-with-tag
// and replace the checksum with a 4-hex value that differs from the correct
// one (case-insensitively, since validation upper-cases the provided CRC).
const wrongCrcArb = fc
  .string({ unit: fc.constantFrom(...HEX_DIGITS), minLength: 4, maxLength: 4 })
  .filter((hex) => hex.toUpperCase() !== CORRECT_CRC)
  .map((hex) => VALID_PAYLOAD_WITH_TAG + hex);

const invalidCandidateArb = fc.oneof(emptyArb, whitespaceOnlyArb, garbageArb, wrongCrcArb);

// A valid Static_QRIS, optionally surrounded by whitespace that must be
// trimmed away on storage (normalization).
const validCandidateArb = fc
  .tuple(
    fc.string({ unit: fc.constantFrom(' ', '\t', '\n'), maxLength: 4 }),
    fc.string({ unit: fc.constantFrom(' ', '\t', '\n'), maxLength: 4 }),
  )
  .map(([lead, trail]) => lead + VALID_STATIC_QRIS + trail);

describe('Property 36: Static_QRIS validation on Config set', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {ReturnType<typeof createConfigService>} */
  let config;

  beforeEach(() => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    config = createConfigService(storage);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('rejects invalid payloads with ConfigValidationError (HTTP 400) and retains the previous value', async () => {
    await fc.assert(
      fc.asyncProperty(invalidCandidateArb, async (bad) => {
        // Establish a known-good previously stored value.
        await config.setStaticQris(VALID_STATIC_QRIS);

        let thrown;
        try {
          await config.setStaticQris(bad);
          thrown = null;
        } catch (err) {
          thrown = err;
        }

        // The set must be rejected.
        expect(thrown).toBeInstanceOf(ConfigValidationError);
        expect(thrown.http).toBe(400);
        expect(thrown.code).toBe('INVALID_REQUEST');

        // Nothing was written: the previous value is retained unchanged.
        expect(await config.getStaticQris()).toBe(VALID_STATIC_QRIS);
      }),
      { numRuns: 100 },
    );
  });

  it('validateStaticQrisValue throws ConfigValidationError (HTTP 400) for invalid payloads', () => {
    fc.assert(
      fc.property(invalidCandidateArb, (bad) => {
        let thrown;
        try {
          validateStaticQrisValue(bad);
          thrown = null;
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(ConfigValidationError);
        expect(thrown.http).toBe(400);
        expect(thrown.code).toBe('INVALID_REQUEST');
      }),
      { numRuns: 100 },
    );
  });

  it('accepts a valid Static_QRIS, normalizes it, and persists it through the DAL', async () => {
    await fc.assert(
      fc.asyncProperty(validCandidateArb, async (candidate) => {
        const stored = await config.setStaticQris(candidate);

        // The stored value is the trimmed, canonical Static_QRIS.
        expect(stored).toBe(VALID_STATIC_QRIS);
        expect(await config.getStaticQris()).toBe(VALID_STATIC_QRIS);

        // Persistence: a fresh service over the same storage reads it back.
        const reopened = createConfigService(storage);
        expect(await reopened.getStaticQris()).toBe(VALID_STATIC_QRIS);
      }),
      { numRuns: 100 },
    );
  });
});
