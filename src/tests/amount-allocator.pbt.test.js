// Property-based test for server-managed Unique_Suffix allocation.
//
// For any Base_Amount and set of already-used suffixes
// within 0..999, the AmountAllocator SHALL return Amount = Base_Amount + suffix
// with a suffix in 0..999 that is not yet used as long as a free slot remains
// (within the maximum number of attempts); and if all 1000 slots are used, the
// allocation SHALL fail with `NO_AVAILABLE_AMOUNT` without producing an Amount.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  MIN_SUFFIX,
  MAX_SUFFIX,
  SUFFIX_SLOTS,
  AmountAllocationError,
  allocateServerAmount,
  findFreeSuffix,
} from '../payment/amount-allocator.js';

// Keep Base_Amount low enough that Base_Amount + 999 never exceeds the maximum
// valid Amount, so overflow skipping does not interfere with the suffix-slot
// reasoning this property is about (the overflow boundary is covered by the
// unit tests). MAX_AMOUNT is 999,999,999.
const MAX_BASE_AMOUNT = 9999000 - MAX_SUFFIX;

// A set of already-used suffixes drawn from 0..999. Occasionally produces the
// fully-saturated set (all 1000 slots used) so the exhaustion branch is
// exercised alongside the partially-used cases.
const usedSuffixesArb = fc.oneof(
  {
    weight: 9,
    arbitrary: fc.uniqueArray(fc.integer({ min: MIN_SUFFIX, max: MAX_SUFFIX }), {
      minLength: 0,
      maxLength: SUFFIX_SLOTS,
    }),
  },
  {
    // The fully-saturated case: every suffix in 0..999 is already taken.
    weight: 1,
    arbitrary: fc.constant(
      Array.from({ length: SUFFIX_SLOTS }, (_, i) => MIN_SUFFIX + i),
    ),
  },
);

describe('Property 9: Unique_Suffix allocation (server-managed)', () => {
  it('allocates a free, in-range suffix while one remains, else NO_AVAILABLE_AMOUNT', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: MAX_BASE_AMOUNT }),
        usedSuffixesArb,
        (baseAmount, usedList) => {
          const used = new Set(usedList);

          // The attempt callback emulates the real DAL UNIQUE constraint: a
          // candidate succeeds only when its suffix is not already used.
          const attempt = (candidateAmount, suffix) => !used.has(suffix);

          const everySlotUsed = used.size >= SUFFIX_SLOTS;

          if (everySlotUsed) {
            // All 1000 slots are taken: allocation must fail with
            // NO_AVAILABLE_AMOUNT and yield no Amount.
            let error;
            try {
              allocateServerAmount(baseAmount, attempt);
            } catch (e) {
              error = e;
            }
            expect(error).toBeInstanceOf(AmountAllocationError);
            expect(error.code).toBe('NO_AVAILABLE_AMOUNT');
            // The pure helper agrees that no free slot exists.
            expect(findFreeSuffix(baseAmount, used)).toBeNull();
            return;
          }

          // A free slot remains: allocation must return Amount = Base_Amount +
          // suffix with a suffix in 0..999 that is not in the used set.
          const { amount, suffix } = allocateServerAmount(baseAmount, attempt);

          expect(Number.isInteger(suffix)).toBe(true);
          expect(suffix).toBeGreaterThanOrEqual(MIN_SUFFIX);
          expect(suffix).toBeLessThanOrEqual(MAX_SUFFIX);
          expect(used.has(suffix)).toBe(false);
          expect(amount).toBe(baseAmount + suffix);

          // The allocator and the pure helper agree on the chosen free suffix.
          expect(suffix).toBe(findFreeSuffix(baseAmount, used));
        },
      ),
      { numRuns: 100 },
    );
  });
});
