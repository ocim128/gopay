// Tests for the adaptive Shared_Poller (shared-poller.js).
//
// These exercise the pure adaptive computations (Poll_Window clamp, interval
// lower bound) directly, and the timer-driven lifecycle / Config-change
// behaviour with vi.useFakeTimers(). No mocking framework is used for the
// collaborators: a tiny in-test fake GoBiz client and plain functions stand in
// for getActiveCount / onTransactions / getPollInterval.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MARGIN,
  DEFAULT_MAX_WINDOW,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MIN_WINDOW,
  SharedPoller,
  createSharedPoller,
} from '../poller/shared-poller.js';

/**
 * Build a fake GoBiz client whose getRecentTransactions records every call and
 * resolves with the configured transaction list.
 */
function makeFakeClient(transactions = []) {
  const calls = [];
  return {
    calls,
    getRecentTransactions: vi.fn(async (params) => {
      calls.push(params);
      return transactions;
    }),
  };
}

describe('SharedPoller — construction', () => {
  it('requires a GoBizClient with getRecentTransactions', () => {
    expect(() => new SharedPoller({}, { getActiveCount: () => 0, onTransactions: () => {} })).toThrow(
      /getRecentTransactions/,
    );
  });

  it('requires getActiveCount and onTransactions', () => {
    const client = makeFakeClient();
    expect(() => new SharedPoller(client, { onTransactions: () => {} })).toThrow(/getActiveCount/);
    expect(() => new SharedPoller(client, { getActiveCount: () => 0 })).toThrow(/onTransactions/);
  });
});

describe('SharedPoller — adaptive Poll_Window', () => {
  /** @type {SharedPoller} */
  let poller;

  beforeEach(() => {
    poller = createSharedPoller(makeFakeClient(), {
      getActiveCount: () => 0,
      onTransactions: () => {},
    });
  });

  it('grows the window as activeCount + margin', () => {
    // 25 active + margin 10 = 35, inside [10, 100].
    expect(poller.computePollWindow(25)).toBe(25 + DEFAULT_MARGIN);
  });

  it('never drops below the minimum window', () => {
    expect(poller.computePollWindow(0)).toBe(DEFAULT_MIN_WINDOW);
    // Even a single active payment: 1 + margin 10 = 11, still clamped >= min.
    expect(poller.computePollWindow(1)).toBeGreaterThanOrEqual(DEFAULT_MIN_WINDOW);
  });

  it('never exceeds the maximum window', () => {
    expect(poller.computePollWindow(1000)).toBe(DEFAULT_MAX_WINDOW);
    // At the saturation boundary (maxWindow - margin) the window is maxed.
    expect(poller.computePollWindow(DEFAULT_MAX_WINDOW - DEFAULT_MARGIN)).toBe(DEFAULT_MAX_WINDOW);
  });
});

describe('SharedPoller — adaptive Poll_Interval', () => {
  it('keeps the interval at the configured base when the window is not maxed', () => {
    const poller = createSharedPoller(makeFakeClient(), {
      getActiveCount: () => 0,
      onTransactions: () => {},
      getPollInterval: () => 5000,
    });
    // Few active payments -> window not maxed -> base interval is used.
    expect(poller.computeInterval(5)).toBe(5000);
  });

  it('lowers the interval toward the minimum when the window is maxed', () => {
    const poller = createSharedPoller(makeFakeClient(), {
      getActiveCount: () => 0,
      onTransactions: () => {},
      getPollInterval: () => 30000,
    });
    // Enough active payments to saturate the window -> interval drops to the floor.
    const saturating = DEFAULT_MAX_WINDOW; // well past (maxWindow - margin)
    expect(poller.computeInterval(saturating)).toBe(DEFAULT_MIN_INTERVAL_MS);
  });

  it('never goes below the configured minimum interval', () => {
    const poller = createSharedPoller(makeFakeClient(), {
      getActiveCount: () => 0,
      onTransactions: () => {},
      // A bogus sub-minimum config value must be clamped up to the floor.
      getPollInterval: () => 10,
    });
    expect(poller.computeInterval(1)).toBe(DEFAULT_MIN_INTERVAL_MS);
    expect(poller.computeInterval(1000)).toBe(DEFAULT_MIN_INTERVAL_MS);
  });
});

describe('SharedPoller — lifecycle with fake timers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls on each interval while there are active payments', async () => {
    let active = 2;
    const client = makeFakeClient([]);
    const poller = createSharedPoller(client, {
      getActiveCount: () => active,
      onTransactions: () => {},
      getPollInterval: () => 5000,
    });

    poller.ensureRunning();
    expect(poller.running).toBe(true);
    expect(client.getRecentTransactions).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(2);
  });

  it('stops polling once there are no active payments', async () => {
    let active = 1;
    const client = makeFakeClient([]);
    const poller = createSharedPoller(client, {
      getActiveCount: () => active,
      onTransactions: () => {},
      getPollInterval: () => 5000,
    });

    poller.ensureRunning();
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(1);

    // The last active payment is settled/expired before the next tick.
    active = 0;
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.running).toBe(false);

    // No further polls happen once stopped.
    await vi.advanceTimersByTimeAsync(50000);
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(1);
  });

  it('restarts when a new active payment appears after stopping', async () => {
    let active = 1;
    const client = makeFakeClient([]);
    const poller = createSharedPoller(client, {
      getActiveCount: () => active,
      onTransactions: () => {},
      getPollInterval: () => 5000,
    });

    poller.ensureRunning();
    await vi.advanceTimersByTimeAsync(5000); // poll #1 with one active payment
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(1);

    // The active payment is settled/expired; the next tick stops the loop.
    active = 0;
    await vi.advanceTimersByTimeAsync(5000); // tick sees 0 -> stops
    expect(poller.running).toBe(false);

    // A new Active_Payment is created -> the Payment_Service calls ensureRunning.
    active = 1;
    poller.ensureRunning();
    expect(poller.running).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); // poll #2 after restart
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(2);
  });

  it('ensureRunning is a no-op when already running', () => {
    const poller = createSharedPoller(makeFakeClient(), {
      getActiveCount: () => 1,
      onTransactions: () => {},
      getPollInterval: () => 5000,
    });
    poller.ensureRunning();
    poller.ensureRunning(); // should not throw or schedule a second loop
    expect(poller.running).toBe(true);
  });

  it('polls immediately on start when pollImmediately is set, then on the normal cadence', async () => {
    const client = makeFakeClient([]);
    const poller = createSharedPoller(client, {
      getActiveCount: () => 1,
      onTransactions: () => {},
      getPollInterval: () => 5000,
      pollImmediately: true,
    });

    poller.ensureRunning();
    // The first poll fires on the next tick (delay 0), not after a full 5s.
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(1);

    // Subsequent polls follow the configured interval.
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(2);

    poller.stop();
  });

  it('emits fetched transactions to the onTransactions callback', async () => {
    const txs = [{ txId: 'tx-1', amount: 1000, type: 'payin' }];
    const client = makeFakeClient(txs);
    const received = [];
    const poller = createSharedPoller(client, {
      getActiveCount: () => 1,
      onTransactions: (batch) => received.push(batch),
      getPollInterval: () => 5000,
    });

    poller.ensureRunning();
    await vi.advanceTimersByTimeAsync(5000);
    expect(received).toEqual([txs]);
    // Poll_Window passed as size: 1 active + margin 10 = 11.
    expect(client.calls[0]).toMatchObject({ size: 1 + DEFAULT_MARGIN });
  });
});

describe('SharedPoller — Config Poll_Interval change applied within 5s', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reschedules immediately so a new interval takes effect quickly', async () => {
    const client = makeFakeClient([]);
    let configuredInterval = 60000; // start with the Config maximum (60s)
    const poller = createSharedPoller(client, {
      getActiveCount: () => 1,
      onTransactions: () => {},
      getPollInterval: () => configuredInterval,
    });

    poller.ensureRunning();
    // Almost a full long interval passes with no poll yet.
    await vi.advanceTimersByTimeAsync(59000);
    expect(client.getRecentTransactions).not.toHaveBeenCalled();

    // The Admin saves a much shorter interval; it must apply within ≤ 5s.
    configuredInterval = 2000;
    poller.setInterval(2000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(1);
  });

  it('setInterval clamps below-minimum values to the floor', () => {
    const poller = createSharedPoller(makeFakeClient(), {
      getActiveCount: () => 0,
      onTransactions: () => {},
    });
    poller.setInterval(10);
    expect(poller.baseInterval).toBe(DEFAULT_MIN_INTERVAL_MS);
  });
});

describe('SharedPoller — resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('survives a failing getRecentTransactions and keeps polling', async () => {
    const client = {
      getRecentTransactions: vi
        .fn()
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValue([]),
    };
    const poller = createSharedPoller(client, {
      getActiveCount: () => 1,
      onTransactions: () => {},
      getPollInterval: () => 5000,
    });

    poller.ensureRunning();
    await vi.advanceTimersByTimeAsync(5000); // first poll rejects
    expect(poller.running).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); // second poll resolves
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(2);
  });

  it('isolates a throwing onTransactions handler from the loop', async () => {
    const client = makeFakeClient([{ txId: 'tx', amount: 50001, type: 'payin' }]);
    const poller = createSharedPoller(client, {
      getActiveCount: () => 1,
      onTransactions: () => {
        throw new Error('handler boom');
      },
      getPollInterval: () => 5000,
    });

    poller.ensureRunning();
    await vi.advanceTimersByTimeAsync(5000);
    expect(poller.running).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(2);
  });
});

describe('SharedPoller — periodic maintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes onMaintenance at most once per maintenanceIntervalMs', async () => {
    const client = makeFakeClient();
    const maintenanceCalls = [];
    // Use a realistic epoch base so the (now - 0) >= interval gate opens on the
    // first tick, exactly like production where Date.now() is huge.
    let t = 1_000_000;
    const poller = createSharedPoller(client, {
      getActiveCount: () => 1,
      onTransactions: () => {},
      getPollInterval: () => 1000,
      onMaintenance: () => maintenanceCalls.push(t),
      maintenanceIntervalMs: 10_000,
      now: () => t,
    });

    poller.ensureRunning();
    // First tick fires maintenance (lastMaintenanceAt was 0).
    t = 1_001_000;
    await vi.advanceTimersByTimeAsync(1000);
    // Subsequent ticks within the window must NOT fire it again.
    t = 1_005_000;
    await vi.advanceTimersByTimeAsync(4000);
    expect(maintenanceCalls).toHaveLength(1);

    // Cross the maintenance boundary: a second invocation fires.
    t = 1_012_000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(maintenanceCalls).toHaveLength(2);
  });

  it('runs maintenance even when there are no active payments', async () => {
    const client = makeFakeClient();
    const maintenanceCalls = [];
    // Start at a realistic epoch so the first gate opens.
    let t = 1_000_000;
    const poller = createSharedPoller(client, {
      getActiveCount: () => 0,
      onTransactions: () => {},
      onMaintenance: () => maintenanceCalls.push(t),
      maintenanceIntervalMs: 10_000,
      now: () => t,
    });

    poller.ensureRunning();
    // Drive one tick directly: maintenance runs BEFORE the active-count check,
    // so it fires even when getActiveCount() returns 0.
    await poller.onTick();
    expect(maintenanceCalls).toHaveLength(1);
  });

  it('isolates a throwing onMaintenance from the loop', async () => {
    const client = makeFakeClient();
    const poller = createSharedPoller(client, {
      getActiveCount: () => 1,
      onTransactions: () => {},
      getPollInterval: () => 5000,
      onMaintenance: () => {
        throw new Error('maintenance boom');
      },
      maintenanceIntervalMs: 0,
    });

    poller.ensureRunning();
    await vi.advanceTimersByTimeAsync(5000);
    // The loop survives and the tick still fetched transactions.
    expect(client.getRecentTransactions).toHaveBeenCalledTimes(1);
    expect(poller.running).toBe(true);
  });
});
