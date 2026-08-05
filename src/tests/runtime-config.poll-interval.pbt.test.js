// Property-based test for Poll_Interval validation in the Config Service.
//
// `setPollInterval` accepts integers in
// the inclusive range POLL_INTERVAL_MIN_MS..POLL_INTERVAL_MAX_MS and persists
// them (so `getPollInterval` returns them), while it rejects out-of-range or
// non-integer values by throwing a `ConfigValidationError` that maps to HTTP
// 400 and leaves the previously stored value untouched.
//
// The test runs against the real in-memory SQLite DAL (no mocks), with fresh
// storage seeded to a known value per run so the retain-previous-value
// guarantee can be asserted deterministically.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { IN_MEMORY_PATH } from '../dal/sqlite/db.js';
import {
  ConfigValidationError,
  POLL_INTERVAL_MAX_MS,
  POLL_INTERVAL_MIN_MS,
  createConfigService,
} from '../config/runtime-config.js';

const NUM_RUNS = 200;

// A known, valid Poll_Interval used to seed storage before exercising a
// candidate value, so we can assert it is retained when a candidate is invalid.
const SEED_POLL_INTERVAL = 2000;

describe('Property 34: Poll_Interval validation', () => {
  /** @type {import('../dal/storage-interface.js').Storage} */
  let storage;
  /** @type {ReturnType<typeof createConfigService>} */
  let config;

  beforeEach(() => {
    storage = createSqliteStorage({ dbPath: IN_MEMORY_PATH });
    config = createConfigService(storage);
  });

  afterEach(() => {
    storage.close();
  });

  it('accepts and persists integers in 1000..60000', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: POLL_INTERVAL_MIN_MS, max: POLL_INTERVAL_MAX_MS }),
        (valid) => {
          // setPollInterval returns the stored integer and getPollInterval reads it back.
          expect(config.setPollInterval(valid)).toBe(valid);
          expect(config.getPollInterval()).toBe(valid);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('rejects out-of-range / non-integer values with HTTP 400 and retains the previous value', () => {
    // Generators for the invalid input space: below the minimum, above the
    // maximum, non-integer (fractional) numbers, NaN, and non-numeric strings.
    const belowMin = fc.integer({ min: -1_000_000, max: POLL_INTERVAL_MIN_MS - 1 });
    const aboveMax = fc.integer({ min: POLL_INTERVAL_MAX_MS + 1, max: 1_000_000 });
    const nonInteger = fc
      .double({ min: POLL_INTERVAL_MIN_MS, max: POLL_INTERVAL_MAX_MS, noNaN: true })
      .filter((n) => !Number.isInteger(n));
    const nan = fc.constant(Number.NaN);
    const nonNumericString = fc
      .string()
      .filter((s) => !/^[+-]?\d+$/.test(s.trim()));

    const invalid = fc.oneof(belowMin, aboveMax, nonInteger, nan, nonNumericString);

    fc.assert(
      fc.property(invalid, (bad) => {
        // Seed a known valid value so the retain guarantee is observable.
        config.setPollInterval(SEED_POLL_INTERVAL);

        let thrown;
        try {
          config.setPollInterval(bad);
        } catch (err) {
          thrown = err;
        }

        // A ConfigValidationError mapping to HTTP 400 must have been thrown.
        expect(thrown).toBeInstanceOf(ConfigValidationError);
        expect(thrown.http).toBe(400);

        // The previously stored value is retained unchanged (nothing written).
        expect(config.getPollInterval()).toBe(SEED_POLL_INTERVAL);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
