// Property-based test for the Shared_Poller adaptive Poll_Interval lower bound.
//
// For any count of Active_Payment, the applied
// Poll_Interval SHALL never be smaller than the configured minimum bound
// (default 1000 ms), including when the interval is lowered because the window
// is at its maximum.
//
// We exercise the pure computation `SharedPoller.computeInterval(activeCount)`
// directly. A tiny in-test fake GoBiz client plus plain functions stand in for
// the injected collaborators (getActiveCount / onTransactions / getPollInterval)
// — no mocking framework and no real timers are needed for the pure path.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  DEFAULT_MARGIN,
  DEFAULT_MAX_WINDOW,
  DEFAULT_MIN_INTERVAL_MS,
  SharedPoller,
} from '../poller/shared-poller.js';

/** Minimal GoBiz client stub — only getRecentTransactions is required. */
const fakeGobizClient = {
  getRecentTransactions: async () => [],
};

/**
 * Build a SharedPoller whose configured base Poll_Interval is `configuredBase`.
 * The configured value is read once at construction time into `_baseInterval`,
 * so computeInterval() reflects it without needing to drive a poll cycle.
 *
 * @param {number} configuredBase
 * @returns {SharedPoller}
 */
function makePoller(configuredBase) {
  return new SharedPoller(fakeGobizClient, {
    getActiveCount: () => 0,
    onTransactions: () => {},
    getPollInterval: () => configuredBase,
  });
}

describe('SharedPoller.computeInterval — Property 18: Poll_Interval lower bound', () => {
  // The Poll_Window maxes out when activeCount + margin >= maxWindow, i.e.
  // activeCount >= maxWindow - margin. Below that boundary the window is not maxed.
  const SATURATION_THRESHOLD = DEFAULT_MAX_WINDOW - DEFAULT_MARGIN;

  it('never returns an interval below the minimum, and matches the spec'
    + ' (floor when window maxed, clamped base otherwise)', () => {
    fc.assert(
      fc.property(
        // Configured base interval: include sub-minimum values (0..min) and
        // in-range/large values so both the clamp and the saturation branch
        // are exercised.
        fc.integer({ min: 0, max: 120_000 }),
        // Active_Payment count across the relevant range, including the
        // saturation boundary and well past maxWindow.
        fc.integer({ min: 0, max: 1000 }),
        (configuredBase, activeCount) => {
          const poller = makePoller(configuredBase);

          // The configured base is clamped up to the floor at construction.
          const clampedBase = Math.max(DEFAULT_MIN_INTERVAL_MS, configuredBase);
          const windowMaxed = poller.computePollWindow(activeCount) >= DEFAULT_MAX_WINDOW;

          const interval = poller.computeInterval(activeCount);

          // (1) Lower bound holds for every input.
          expect(interval).toBeGreaterThanOrEqual(DEFAULT_MIN_INTERVAL_MS);

          if (windowMaxed) {
            // (2) When the window is saturated the interval drops to the floor.
            expect(windowMaxed).toBe(activeCount >= SATURATION_THRESHOLD);
            expect(interval).toBe(DEFAULT_MIN_INTERVAL_MS);
          } else {
            // (3) Otherwise it is exactly the clamped configured base interval.
            expect(interval).toBe(clampedBase);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
