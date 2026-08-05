// Unit tests for the amount allocator.
//
// These tests verify client-managed amount validation and server-managed
// suffix allocation, including exhaustion signaling. Property-based tests are
// maintained separately.

import { describe, it, expect } from 'vitest';

import {
  MIN_AMOUNT,
  MAX_AMOUNT,
  MIN_SUFFIX,
  MAX_SUFFIX,
  SUFFIX_SLOTS,
  AmountAllocationError,
  isValidAmount,
  isValidBaseAmount,
  validateClientAmount,
  validateBaseAmount,
  findFreeSuffix,
  allocateServerAmount,
} from '../payment/amount-allocator.js';

describe('constants', () => {
  it('defines the spec-mandated ranges', () => {
    expect(MIN_AMOUNT).toBe(1000);
    expect(MAX_AMOUNT).toBe(9999000);
    expect(MIN_SUFFIX).toBe(0);
    expect(MAX_SUFFIX).toBe(999);
    expect(SUFFIX_SLOTS).toBe(1000);
  });
});

describe('isValidAmount', () => {
  it('accepts integers within 1000..9999000', () => {
    expect(isValidAmount(1000)).toBe(true);
    expect(isValidAmount(10_000)).toBe(true);
    expect(isValidAmount(9999000)).toBe(true);
  });

  it('rejects out-of-range, non-integer, and non-number values', () => {
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount(-1)).toBe(false);
    expect(isValidAmount(1_000_000_000)).toBe(false);
    expect(isValidAmount(1.5)).toBe(false);
    expect(isValidAmount(NaN)).toBe(false);
    expect(isValidAmount('100')).toBe(false);
    expect(isValidAmount(null)).toBe(false);
    expect(isValidAmount(undefined)).toBe(false);
  });
});

describe('validateClientAmount', () => {
  it('returns the amount unchanged when valid', () => {
    expect(validateClientAmount(12_345)).toBe(12_345);
  });

  it('throws INVALID_AMOUNT for invalid amounts', () => {
    for (const bad of [0, -5, 1_000_000_000, 2.5, '10', undefined, null]) {
      let error;
      try {
        validateClientAmount(bad);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AmountAllocationError);
      expect(error.code).toBe('INVALID_AMOUNT');
    }
  });
});

describe('isValidBaseAmount / validateBaseAmount', () => {
  it('accepts positive integers of at least 1', () => {
    expect(isValidBaseAmount(1000)).toBe(true);
    expect(isValidBaseAmount(10_000)).toBe(true);
    expect(validateBaseAmount(50_000)).toBe(50_000);
  });

  it('throws INVALID_BASE_AMOUNT for non-positive or non-integer values', () => {
    for (const bad of [0, -1, 1.5, '100', undefined, null, NaN]) {
      expect(isValidBaseAmount(bad)).toBe(false);
      let error;
      try {
        validateBaseAmount(bad);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AmountAllocationError);
      expect(error.code).toBe('INVALID_BASE_AMOUNT');
    }
  });
});

describe('findFreeSuffix', () => {
  it('returns the lowest free suffix in ascending order', () => {
    expect(findFreeSuffix(10_000, [])).toBe(0);
    expect(findFreeSuffix(10_000, [0, 1, 2])).toBe(3);
    expect(findFreeSuffix(10_000, new Set([0, 1, 2, 4]))).toBe(3);
  });

  it('returns null when every slot is taken', () => {
    const allUsed = new Set();
    for (let s = MIN_SUFFIX; s <= MAX_SUFFIX; s += 1) {
      allUsed.add(s);
    }
    expect(findFreeSuffix(10_000, allUsed)).toBeNull();
  });

  it('does not return a suffix that would overflow the maximum amount', () => {
    // Base amount is the max amount, so only suffix 0 keeps the formed amount valid.
    expect(findFreeSuffix(MAX_AMOUNT, [])).toBe(0);
    expect(findFreeSuffix(MAX_AMOUNT, [0])).toBeNull();
  });
});

describe('allocateServerAmount', () => {
  it('returns the first candidate that the attempt accepts', () => {
    const result = allocateServerAmount(10_000, () => true);
    expect(result).toEqual({ amount: 10_000, suffix: 0, result: true });
  });

  it('skips taken candidates and returns the first free one', () => {
    const used = new Set([10_000, 10_001, 10_002]);
    const result = allocateServerAmount(10_000, (candidate) => !used.has(candidate));
    expect(result.amount).toBe(10_003);
    expect(result.suffix).toBe(3);
  });

  it('passes both the candidate amount and the suffix to the attempt', () => {
    const seen = [];
    allocateServerAmount(1000, (candidate, suffix) => {
      seen.push([candidate, suffix]);
      return suffix === 2;
    });
    expect(seen).toEqual([
      [1000, 0],
      [1001, 1],
      [1002, 2],
    ]);
  });

  it('returns the truthy result object from the attempt', () => {
    const row = { id: 'p_1' };
    const result = allocateServerAmount(7_000, () => row);
    expect(result.result).toBe(row);
  });

  it('throws NO_AVAILABLE_AMOUNT when every slot is taken', () => {
    let attempts = 0;
    let error;
    try {
      allocateServerAmount(10_000, () => {
        attempts += 1;
        return false;
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AmountAllocationError);
    expect(error.code).toBe('NO_AVAILABLE_AMOUNT');
    expect(attempts).toBe(SUFFIX_SLOTS);
  });

  it('respects a custom maxAttempts budget', () => {
    let attempts = 0;
    let error;
    try {
      allocateServerAmount(
        10_000,
        () => {
          attempts += 1;
          return false;
        },
        { maxAttempts: 5 },
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AmountAllocationError);
    expect(error.code).toBe('NO_AVAILABLE_AMOUNT');
    expect(attempts).toBe(5);
  });

  it('stops before forming an amount above the maximum', () => {
    let attempts = 0;
    let error;
    try {
      allocateServerAmount(MAX_AMOUNT, () => {
        attempts += 1;
        return false;
      });
    } catch (e) {
      error = e;
    }
    // Only suffix 0 keeps the amount within range; suffix >= 1 would overflow.
    expect(attempts).toBe(1);
    expect(error.code).toBe('NO_AVAILABLE_AMOUNT');
  });

  it('throws a TypeError when the attempt is not a function', () => {
    expect(() => allocateServerAmount(10_000, null)).toThrow(TypeError);
  });
});
