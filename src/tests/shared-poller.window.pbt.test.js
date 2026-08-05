// Property-based test for the adaptive Shared_Poller's Poll_Window.
//
// pollWindow = clamp(activeCount + margin,
// minWindow=10, maxWindow=100). The computed Poll_Window always covers the
// Active_Payment count when it sits within bounds and never escapes the
// [minWindow, maxWindow] range. This is the `size` handed to
// `GoBizClient.getRecentTransactions`, so a single poll always queries more
// transactions than there are Active_Payment.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  SharedPoller,
  DEFAULT_MARGIN,
  DEFAULT_MIN_WINDOW,
  DEFAULT_MAX_WINDOW,
} from '../poller/shared-poller.js';

/**
 * Build a SharedPoller wired to harmless fakes. Only `computePollWindow` is
 * exercised here, so the GoBiz client, the active-count source and the
 * transaction sink are all inert stubs.
 *
 * @returns {SharedPoller}
 */
function makePoller() {
  const gobizClient = {
    // Async by contract; never invoked by computePollWindow.
    getRecentTransactions: async () => [],
  };
  return new SharedPoller(gobizClient, {
    getActiveCount: () => 0,
    onTransactions: () => {},
  });
}

describe('Property 17: Poll_Window clamp & cover', () => {
  it('clamps activeCount + margin into [minWindow, maxWindow] and covers the count within bounds', () => {
    const poller = makePoller();

    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (activeCount) => {
        const window = poller.computePollWindow(activeCount);
        const raw = activeCount + DEFAULT_MARGIN;

        // Never escapes the [minWindow, maxWindow] range.
        expect(window).toBeGreaterThanOrEqual(DEFAULT_MIN_WINDOW);
        expect(window).toBeLessThanOrEqual(DEFAULT_MAX_WINDOW);

        if (raw >= DEFAULT_MAX_WINDOW) {
          // Saturated upper bound: the window pins to maxWindow.
          expect(window).toBe(DEFAULT_MAX_WINDOW);
        } else if (raw <= DEFAULT_MIN_WINDOW) {
          // Low end: the window pins to the minWindow floor.
          expect(window).toBe(DEFAULT_MIN_WINDOW);
        } else {
          // Within bounds: the window is exactly activeCount + margin and so
          // strictly covers the Active_Payment count.
          expect(window).toBe(raw);
          expect(window).toBeGreaterThan(activeCount);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('equals minWindow at activeCount 0 and maxWindow once the count saturates the window', () => {
    const poller = makePoller();

    // Low-end anchor: with no Active_Payment the window is the minWindow floor.
    expect(poller.computePollWindow(0)).toBe(DEFAULT_MIN_WINDOW);

    fc.assert(
      fc.property(
        // Any count large enough that count + margin reaches the cap.
        fc.integer({ min: DEFAULT_MAX_WINDOW - DEFAULT_MARGIN, max: 1000 }),
        (activeCount) => {
          expect(poller.computePollWindow(activeCount)).toBe(DEFAULT_MAX_WINDOW);
        },
      ),
      { numRuns: 100 },
    );
  });
});
