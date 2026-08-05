// Adaptive Shared_Poller — a single instance that monitors every Active_Payment.
//
// It keeps a SINGLE poll loop running for all pending Payment instead of one
// poller per request, and adapts its behaviour to the number of
// Active_Payment:
//
//   * Poll_Window  : `clamp(activeCount + margin, minWindow, maxWindow)`
//                    (defaults: margin 10, minWindow 10, maxWindow 100). This is
//                    the `size` passed to `GoBizClient.getRecentTransactions`, so
//                    a single poll always covers more transactions than there are
//                    Active_Payment.
//   * Poll_Interval: the configured interval (read from the Config Service), but
//                    never below `minInterval` (default 1000 ms). When
//                    the Poll_Window has reached its maximum — i.e. there are so
//                    many Active_Payment that the window is saturated — the
//                    interval is lowered to `minInterval` so transactions are not
//                    missed.
//   * Lifecycle    : when there are no Active_Payment the loop stops;
//                    creating a new Active_Payment restarts it via
//                    `ensureRunning()`.
//
// The poller does NOT match transactions itself — matching/settlement lives in
// the Payment_Service. Each poll cycle hands the fetched transactions to the
// injected `onTransactions` callback (wired to
// `paymentService.handleTransactions`).
//
// A Config Poll_Interval change is applied within ≤ 5 seconds: the
// route/Config layer calls `setInterval(ms)`, which reschedules the pending
// timer immediately rather than waiting for the (possibly long) old interval to
// elapse.
//
// Timers and the clock are injectable so tests can drive the loop deterministically
// with fake timers.

/** Default number of extra Poll_Window slots beyond the Active_Payment count. */
export const DEFAULT_MARGIN = 10;
/** Default lower bound for the Poll_Window. */
export const DEFAULT_MIN_WINDOW = 10;
/** Default upper bound for the Poll_Window. */
export const DEFAULT_MAX_WINDOW = 100;
/** Default lower bound for the Poll_Interval in milliseconds. */
export const DEFAULT_MIN_INTERVAL_MS = 1000;
/**
 * Fallback Poll_Interval used when no Config value is available. It sits within
 * the valid Config range so an unconfigured System still polls sensibly.
 *
 * @type {number}
 */
export const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Default minimum spacing between `onMaintenance` invocations: once per 24
 * hours. The maintenance hook (webhook-log pruning, etc.) rides the poll tick,
 * so this constant bounds how often it actually fires.
 *
 * @type {number}
 */
export const DEFAULT_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Clamp `value` into the inclusive `[min, max]` range.
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The adaptive Shared_Poller.
 *
 * @example
 *   const poller = new SharedPoller(gobizClient, {
 *     getActiveCount: () => storage.payments.countActive(),
 *     onTransactions: (txs) => paymentService.handleTransactions(txs),
 *     getPollInterval: () => config.getPollInterval(),
 *   });
 *   poller.ensureRunning(); // called by the Payment_Service after a create
 */
export class SharedPoller {
  /**
   * @param {{ getRecentTransactions: (params?: { days?: number, size?: number }) => Promise<Array<object>> }} gobizClient
   *   the GoBiz facade; only `getRecentTransactions` is used.
   * @param {object} deps
   * @param {() => number} deps.getActiveCount - returns the current number of
   *   Active_Payment (typically `storage.payments.countActive`). Drives the
   *   adaptive window/interval and the stop/restart lifecycle.
   * @param {(transactions: Array<object>) => void} deps.onTransactions - invoked
   *   with the transactions fetched each cycle so the Payment_Service can match
   *   and settle them. Errors it throws are isolated from the poll loop.
   * @param {() => number} [deps.getPollInterval] - returns the configured
   *   Poll_Interval in ms (the Config Service). Re-read every cycle so a Config
   *   change is eventually picked up even without an explicit `setInterval` push.
   * @param {number} [deps.margin] - Poll_Window margin (default {@link DEFAULT_MARGIN}).
   * @param {number} [deps.minWindow] - Poll_Window lower bound (default {@link DEFAULT_MIN_WINDOW}).
   * @param {number} [deps.maxWindow] - Poll_Window upper bound (default {@link DEFAULT_MAX_WINDOW}).
   * @param {number} [deps.minInterval] - Poll_Interval lower bound in ms (default {@link DEFAULT_MIN_INTERVAL_MS}).
   * @param {number} [deps.days] - how many days back each poll queries (default 1).
   * @param {boolean} [deps.pollImmediately] - when true, the first poll cycle
   *   after {@link ensureRunning} fires right away (delay 0) instead of waiting a
   *   full Poll_Interval. This minimizes the window between a Payment being
   *   created and the first transaction fetch. Defaults to false
   *   so existing interval-driven tests keep their timing semantics.
   * @param {(handler: () => void, ms: number) => any} [deps.setTimeoutFn] - injectable
   *   timer scheduler; defaults to the global `setTimeout` (resolved at call time
   *   so fake timers are honoured).
   * @param {(handle: any) => void} [deps.clearTimeoutFn] - injectable timer
   *   canceller; defaults to the global `clearTimeout`.
   * @param {() => void} [deps.onMaintenance] - optional callback invoked at most
   *   once every {@link deps.maintenanceIntervalMs} from inside the poll tick.
   *   Used for periodic housekeeping (e.g. pruning old webhook delivery logs)
   *   that should ride the existing loop rather than schedule its own timer.
   *   A throw is caught and logged so it can never kill the loop.
   * @param {number} [deps.maintenanceIntervalMs] - minimum spacing between
   *   `onMaintenance` invocations in ms (default {@link DEFAULT_MAINTENANCE_INTERVAL_MS}).
   * @param {() => number} [deps.now] - clock returning epoch ms, used to gate
   *   maintenance; defaults to `Date.now`.
   * @param {Pick<Console, 'log' | 'warn' | 'error'>} [deps.logger] - logger.
   */
  constructor(gobizClient, deps = {}) {
    if (!gobizClient || typeof gobizClient.getRecentTransactions !== 'function') {
      throw new TypeError(
        'SharedPoller requires a GoBizClient with a getRecentTransactions() method.',
      );
    }
    if (typeof deps.getActiveCount !== 'function') {
      throw new TypeError('SharedPoller requires a getActiveCount function.');
    }
    if (typeof deps.onTransactions !== 'function') {
      throw new TypeError('SharedPoller requires an onTransactions() callback.');
    }

    this.gobizClient = gobizClient;
    this.getActiveCount = deps.getActiveCount;
    this.onTransactions = deps.onTransactions;
    this.getPollInterval =
      typeof deps.getPollInterval === 'function' ? deps.getPollInterval : null;

    this.margin = Number.isFinite(deps.margin) ? deps.margin : DEFAULT_MARGIN;
    this.minWindow = Number.isFinite(deps.minWindow) ? deps.minWindow : DEFAULT_MIN_WINDOW;
    this.maxWindow = Number.isFinite(deps.maxWindow) ? deps.maxWindow : DEFAULT_MAX_WINDOW;
    this.minInterval = Number.isFinite(deps.minInterval)
      ? deps.minInterval
      : DEFAULT_MIN_INTERVAL_MS;
    this.days = Number.isFinite(deps.days) ? deps.days : 1;
    this._pollImmediately = deps.pollImmediately === true;

    this._setTimeoutFn =
      typeof deps.setTimeoutFn === 'function'
        ? deps.setTimeoutFn
        : (handler, ms) => globalThis.setTimeout(handler, ms);
    this._clearTimeoutFn =
      typeof deps.clearTimeoutFn === 'function'
        ? deps.clearTimeoutFn
        : (handle) => globalThis.clearTimeout(handle);

    this.logger = deps.logger ?? console;

    /** Optional periodic-maintenance hook (e.g. webhook-log pruning). */
    this.onMaintenance = typeof deps.onMaintenance === 'function' ? deps.onMaintenance : null;
    this.maintenanceIntervalMs = Number.isFinite(deps.maintenanceIntervalMs)
      ? deps.maintenanceIntervalMs
      : DEFAULT_MAINTENANCE_INTERVAL_MS;
    this._now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    /** @type {number} epoch ms of the last onMaintenance run, or 0 when never. */
    this._lastMaintenanceAt = 0;

    /** @type {number} the configured base interval, never below minInterval. */
    this._baseInterval = this._readConfiguredInterval();
    /** @type {boolean} whether the poll loop is currently running. */
    this._running = false;
    /** @type {any} the pending timer handle, or null when none is scheduled. */
    this._timer = null;
    /** @type {number} the most recently computed Poll_Window (for inspection). */
    this._pollWindow = this.minWindow;
  }

  /**
   * Whether the poll loop is currently running.
   * @returns {boolean}
   */
  get running() {
    return this._running;
  }

  /**
   * The most recently computed Poll_Window (the `size` used on the last cycle).
   * @returns {number}
   */
  get pollWindow() {
    return this._pollWindow;
  }

  /**
   * The current base Poll_Interval (the configured value, clamped to the floor).
   * @returns {number}
   */
  get baseInterval() {
    return this._baseInterval;
  }

  /**
   * Compute the Poll_Window for a given Active_Payment count:
   * `clamp(activeCount + margin, minWindow, maxWindow)`.
   *
   * @param {number} activeCount
   * @returns {number}
   */
  computePollWindow(activeCount) {
    const count = Number.isFinite(activeCount) ? activeCount : 0;
    return clamp(count + this.margin, this.minWindow, this.maxWindow);
  }

  /**
   * Compute the effective Poll_Interval for a given Active_Payment count.
   *
   * The base is the configured interval (never below `minInterval`).
   * When the Poll_Window has reached its maximum — meaning there are enough
   * Active_Payment to saturate the window — the interval is lowered to
   * `minInterval` so a single interval cannot miss transactions. The
   * result is always clamped to be at least `minInterval`.
   *
   * @param {number} activeCount
   * @returns {number} the interval in milliseconds.
   */
  computeInterval(activeCount) {
    const windowMaxed = this.computePollWindow(activeCount) >= this.maxWindow;
    const interval = windowMaxed ? this.minInterval : this._baseInterval;
    return Math.max(this.minInterval, interval);
  }

  /**
   * Ensure the poll loop is running. Called by the Payment_Service after a new
   * pending Payment is created. If the loop was stopped because
   * there were no Active_Payment, this restarts it. A no-op when the
   * loop is already running.
   *
   * @returns {void}
   */
  ensureRunning() {
    if (this._running) {
      return;
    }
    this._running = true;
    this.logger?.log?.('[SharedPoller] Poller started.');
    // Fire the first poll immediately when configured, so monitoring begins at
    // create time rather than after a full Poll_Interval; otherwise schedule the
    // first cycle on the normal cadence.
    this._scheduleNext(this._pollImmediately ? 0 : undefined);
  }

  /**
   * Stop the poll loop and cancel any pending timer. Safe to call when
   * already stopped.
   *
   * @returns {void}
   */
  stop() {
    if (!this._running && this._timer === null) {
      return;
    }
    this._running = false;
    if (this._timer !== null) {
      this._clearTimeoutFn(this._timer);
      this._timer = null;
    }
    this.logger?.log?.('[SharedPoller] Poller stopped (no active payments).');
  }

  /**
   * Apply a new configured Poll_Interval. The value is clamped to the
   * `minInterval` floor. When the loop is running the pending timer is
   * rescheduled immediately so the change takes effect right away rather than
   * after the old interval elapses.
   *
   * @param {number} ms - the new Poll_Interval in milliseconds.
   * @returns {void}
   */
  setInterval(ms) {
    const next = Number.isFinite(ms) ? Math.max(this.minInterval, ms) : this._baseInterval;
    this._baseInterval = next;
    if (this._running) {
      // Reschedule immediately so a Config change applies within ≤ 5s.
      this._scheduleNext();
    }
  }

  /**
   * Run a single poll cycle: read the Active_Payment count, stop if there are
   * none, otherwise fetch up to Poll_Window transactions and hand them
   * to the `onTransactions` callback. Errors from the GoBiz call or the callback
   * are caught and logged so the loop survives transient failures.
   *
   * Exposed publicly so tests can drive a cycle without timers.
   *
   * @returns {Promise<void>}
   */
  async onTick() {
    // Refresh the base interval from Config so a change is picked up even without
    // an explicit setInterval push (an additional safety net).
    this._baseInterval = this._readConfiguredInterval();

    // Run periodic maintenance (webhook-log pruning, etc.) before the active-
    // count check so it still fires on a system that is briefly idle — the
    // hook gates itself on maintenanceIntervalMs and swallows its own errors.
    this._runMaintenanceIfDue();

    const activeCount = this._safeActiveCount();
    if (activeCount <= 0) {
      // No Active_Payment: stop polling.
      this.stop();
      return;
    }

    this._pollWindow = this.computePollWindow(activeCount);

    let transactions = [];
    try {
      transactions = await this.gobizClient.getRecentTransactions({
        days: this.days,
        size: this._pollWindow,
      });
    } catch (err) {
      this.logger?.error?.(
        `[SharedPoller] Failed to fetch transactions: ${err?.message ?? err}`,
      );
      return;
    }

    // Always hand the batch to the handler, even when empty: the Payment_Service
    // uses each tick to expire overdue payments (and fire their expiry webhooks),
    // which must happen regardless of whether any transactions were fetched.
    const batch = Array.isArray(transactions) ? transactions : [];
    try {
      this.onTransactions(batch);
    } catch (err) {
      // Matching/expiry is the Payment_Service's job; a failure there must not
      // kill the poll loop.
      this.logger?.error?.(
        `[SharedPoller] onTransactions handler threw: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Schedule the next poll cycle, cancelling any previously pending timer first.
   * The delay is the effective interval for the current Active_Payment count,
   * unless `overrideDelay` is a finite number (used to fire the first poll
   * immediately with delay 0).
   *
   * @param {number} [overrideDelay] - an explicit delay in ms; when omitted the
   *   adaptive interval is used.
   * @returns {void}
   * @private
   */
  _scheduleNext(overrideDelay) {
    if (!this._running) {
      return;
    }
    if (this._timer !== null) {
      this._clearTimeoutFn(this._timer);
      this._timer = null;
    }
    const delay = Number.isFinite(overrideDelay)
      ? overrideDelay
      : this.computeInterval(this._safeActiveCount());
    this._timer = this._setTimeoutFn(() => this._runCycle(), delay);
  }

  /**
   * Timer-driven cycle: clear the handle, run the tick, then reschedule while the
   * loop is still running (the tick may have stopped it).
   *
   * @returns {Promise<void>}
   * @private
   */
  async _runCycle() {
    this._timer = null;
    await this.onTick();
    if (this._running) {
      this._scheduleNext();
    }
  }

  /**
   * Read the configured Poll_Interval, clamped to the `minInterval` floor.
   * Falls back to {@link DEFAULT_POLL_INTERVAL_MS} when no Config getter is
   * provided or it returns a non-finite value.
   *
   * @returns {number}
   * @private
   */
  _readConfiguredInterval() {
    let configured = DEFAULT_POLL_INTERVAL_MS;
    if (this.getPollInterval) {
      try {
        const value = this.getPollInterval();
        if (Number.isFinite(value)) {
          configured = value;
        }
      } catch (err) {
        this.logger?.warn?.(
          `[SharedPoller] Failed to read the configured poll interval: ${err?.message ?? err}`,
        );
      }
    }
    return Math.max(this.minInterval, configured);
  }

  /**
   * Read the Active_Payment count defensively, treating a throw or a non-finite
   * value as zero (which stops the loop rather than crashing it).
   *
   * @returns {number}
   * @private
   */
  _safeActiveCount() {
    try {
      const count = this.getActiveCount();
      return Number.isFinite(count) ? count : 0;
    } catch (err) {
      this.logger?.error?.(
        `[SharedPoller] Failed to read the active payment count: ${err?.message ?? err}`,
      );
      return 0;
    }
  }

  /**
   * Invoke the {@link onMaintenance} hook when at least
   * {@link maintenanceIntervalMs} has elapsed since the last run. A throw is
   * caught and logged so housekeeping can never kill the poll loop. No-op when
   * no hook was injected or the spacing has not yet elapsed.
   *
   * @returns {void}
   * @private
   */
  _runMaintenanceIfDue() {
    if (this.onMaintenance === null) {
      return;
    }
    const now = this._now();
    if (now - this._lastMaintenanceAt < this.maintenanceIntervalMs) {
      return;
    }
    this._lastMaintenanceAt = now;
    try {
      this.onMaintenance();
    } catch (err) {
      this.logger?.error?.(
        `[SharedPoller] onMaintenance hook threw: ${err?.message ?? err}`,
      );
    }
  }
}

/**
 * Convenience factory for a SharedPoller.
 *
 * @param {ConstructorParameters<typeof SharedPoller>} args
 * @returns {SharedPoller}
 */
export function createSharedPoller(...args) {
  return new SharedPoller(...args);
}

export default SharedPoller;
