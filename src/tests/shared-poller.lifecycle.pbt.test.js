// Property-based test for the Shared_Poller lifecycle.
//
// For any transition in the count of Active_Payment,
// the Shared_Poller SHALL stop when the count reaches 0 and SHALL run when there
// is >= 1 Active_Payment.
//
// Strategy: drive the timer-based loop deterministically with vi.useFakeTimers()
// and a mutable `active` variable behind the injected getActiveCount. We generate
// random sequences of Active_Payment counts and, for each transition, advance the
// clock by exactly one Poll_Interval and assert the lifecycle invariants:
//   * a tick that observes 0 active stops the loop (running === false) and issues
//     no further polls;
//   * ensureRunning() (called by the Payment_Service when a new Active_Payment
//     appears) (re)starts a stopped loop;
//   * while active > 0 the loop polls exactly once per interval.
//
// Active counts are kept below the window-saturation boundary so the effective
// interval stays at the configured base — this makes "one poll per interval" an
// exact, deterministic assertion (the adaptive interval drop at saturation is
// covered by the window-saturation tests).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';

import { createSharedPoller } from '../poller/shared-poller.js';

/** Configured Poll_Interval used throughout (well above the 1000 ms floor). */
const INTERVAL_MS = 5000;

/**
 * A fake GoBiz client whose getRecentTransactions resolves with an empty batch
 * and counts how many times it was called (one call == one completed poll).
 */
function makeFakeClient() {
  return {
    getRecentTransactions: vi.fn(async () => []),
  };
}

describe('SharedPoller lifecycle — Property 19', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops at 0 active and (re)starts via ensureRunning when active > 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A sequence of Active_Payment counts. 0 means "no active payments".
        // Counts are capped at 50 so count + margin (10) < maxWindow (100): the
        // window never saturates and the interval stays at the configured base,
        // giving exactly one poll per interval.
        fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 15 }),
        async (counts) => {
          const client = makeFakeClient();
          let active = 0;
          const poller = createSharedPoller(client, {
            getActiveCount: () => active,
            onTransactions: () => {},
            getPollInterval: () => INTERVAL_MS,
          });

          // The loop starts stopped until the first Active_Payment appears.
          expect(poller.running).toBe(false);

          try {
            for (const count of counts) {
              active = count;

              // The Payment_Service calls ensureRunning() whenever a new
              // Active_Payment is created. Model that for any count > 0.
              if (count > 0) {
                poller.ensureRunning();
                // ensureRunning must guarantee the loop is running.
                expect(poller.running).toBe(true);
              }

              const pollsBefore = client.getRecentTransactions.mock.calls.length;

              // Advance by exactly one Poll_Interval -> at most one poll cycle.
              await vi.advanceTimersByTimeAsync(INTERVAL_MS);

              const pollsAfter = client.getRecentTransactions.mock.calls.length;

              if (count > 0) {
                // While there is >= 1 Active_Payment the loop keeps running and
                // polls exactly once per interval.
                expect(poller.running).toBe(true);
                expect(pollsAfter).toBe(pollsBefore + 1);
              } else {
                // A tick observing 0 active stops the loop and performs
                // no fetch — and a loop that was already stopped stays stopped
                // with no polls either way.
                expect(poller.running).toBe(false);
                expect(pollsAfter).toBe(pollsBefore);
              }
            }

            // Once stopped (final count 0), no amount of extra time produces a
            // poll until ensureRunning is called again.
            if (counts[counts.length - 1] === 0) {
              const pollsAtRest = client.getRecentTransactions.mock.calls.length;
              await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);
              expect(poller.running).toBe(false);
              expect(client.getRecentTransactions.mock.calls.length).toBe(pollsAtRest);

              // A brand-new Active_Payment must restart the loop.
              active = 1;
              poller.ensureRunning();
              expect(poller.running).toBe(true);
              await vi.advanceTimersByTimeAsync(INTERVAL_MS);
              expect(client.getRecentTransactions.mock.calls.length).toBe(pollsAtRest + 1);
            }
          } finally {
            poller.stop();
            vi.clearAllTimers();
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
