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
   * @param {() => (Promise<number>|number)} deps.getActiveCount - returns the
   *   current number of Active_Payment (typically
   *   `storage.payments.countActive`). Drives the adaptive window/interval and
   *   the stop/restart lifecycle.
   * @param {(transactions: Array<object>) => (Promise<unknown>|unknown)} deps.onTransactions -
   *   invoked with the transactions fetched each cycle so the Payment_Service
   *   can match and settle them. Errors it throws/rejects are isolated from the
   *   poll loop.
   * @param {() => (Promise<number>|number)} [deps.getPollInterval] - returns
   *   the configured Poll_Interval in ms (the Config Service). Re-read every
   *   cycle so a Config change is eventually picked up even without an explicit
   *   `setInterval` push.
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
   * @param {() => (Promise<unknown>|unknown)} [deps.onMaintenance] - optional
   *   callback invoked at most once every {@link deps.maintenanceIntervalMs}
   *   from inside the poll tick. Used for periodic housekeeping (e.g. pruning
   *   old webhook delivery logs) that should ride the existing loop rather than
   *   schedule its own timer. A throw/rejection is caught and logged so it can
   *   never kill the loop.
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
    this.getStartTime = deps.getStartTime ?? null;
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

    /**
     * The configured base interval, never below `minInterval`. Initialized
     * synchronously from the Config getter when that getter is itself
     * synchronous (so `computeInterval()` reflects the configured value without
     * needing a poll cycle); when the getter is asynchronous the constructor
     * falls back to {@link DEFAULT_POLL_INTERVAL_MS} and the first
     * {@link onTick} / {@link ensureRunning} call refreshes it. This keeps
     * `this._baseInterval` a real number — never a Promise — even though
     * `_readConfiguredInterval` is async.
     *
     * @type {number}
     */
    this._baseInterval = this._readConfiguredIntervalSync();
    /** @type {boolean} whether the poll loop is currently running. */
    this._running = false;
    /** @type {any} the pending timer handle, or null when none is scheduled. */
    this._timer = null;
    /** @type {number} the most recently computed Poll_Window (for inspection). */
    this._pollWindow = this.minWindow;
    /**
     * A chain that serializes every {@link _scheduleNext} call. Because the
     * Active_Payment count is read asynchronously, two concurrent reschedules
     * (e.g. `ensureRunning` + `setInterval` racing) could otherwise each await
     * the count and each install a timer, leaving two pending timers at once.
     * Chaining the async reschedule onto this Promise guarantees they run one
     * at a time, so at most one timer is ever pending.
     *
     * @type {Promise<void>}
     */
    this._scheduling = Promise.resolve();
    this._cycle = null;
  }

  /**
   * Synchronous variant of {@link _readConfiguredInterval}: read the configured
   * Poll_Interval immediately when the supplied `getPollInterval` returns a
   * plain number; fall back to {@link DEFAULT_POLL_INTERVAL_MS} when the getter
   * is absent, throws, returns a Promise (the async path handles that on the
   * first tick), or returns a non-finite value. Used by the constructor so
   * `_baseInterval` is a real number before the first cycle.
   *
   * When the getter returns a Promise (an async Config), a rejection is attached
   * a `.catch` here so it can never surface as an unhandled rejection between
   * construction and the first tick that resolves the real value.
   *
   * @returns {number}
   * @private
   */
  _readConfiguredIntervalSync() {
    if (!this.getPollInterval) {
      return Math.max(this.minInterval, DEFAULT_POLL_INTERVAL_MS);
    }
    try {
      const value = this.getPollInterval();
      // A thenable means the getter is async — defer to the first tick, but
      // attach a rejection handler so the Promise never leaks unhandled.
      if (value && typeof /** @type {any} */ (value).then === 'function') {
        Promise.resolve(value).catch((err) => {
          this.logger?.warn?.(
            `[SharedPoller] Failed to read the configured poll interval: ${err?.message ?? err}`,
          );
        });
        return Math.max(this.minInterval, DEFAULT_POLL_INTERVAL_MS);
      }
      if (Number.isFinite(value)) {
        return Math.max(this.minInterval, value);
      }
    } catch (err) {
      this.logger?.warn?.(
        `[SharedPoller] Failed to read the configured poll interval: ${err?.message ?? err}`,
      );
    }
    return Math.max(this.minInterval, DEFAULT_POLL_INTERVAL_MS);
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
   * Returns a Promise that resolves once the first cycle has been scheduled
   * (the count read is asynchronous). Callers that fire-and-forget (the
   * Payment_Service after a create) may ignore it; awaiting it is useful in
   * tests that need the timer to be in place before asserting on it.
   *
   * @returns {Promise<void>}
   */
  ensureRunning() {
    if (this._running) {
      // Already running: surface a resolved Promise so callers can await
      // uniformly without forcing a redundant reschedule.
      return Promise.resolve();
    }
    this._running = true;
    this.logger?.log?.('[SharedPoller] Poller started.');
    // Fire the first poll immediately when configured, so monitoring begins at
    // create time rather than after a full Poll_Interval; otherwise schedule the
    // first cycle on the normal cadence. Returning the scheduling Promise keeps
    // a rejection observable instead of floating.
    return this._scheduleNext(this._pollImmediately ? 0 : undefined);
  }

  /**
   * Stop the poll loop and cancel any pending timer. Safe to call when
   * already stopped.
   *
   * Because rescheduling is asynchronous, `stop()` also waits for any in-flight
   * `_scheduleNext` to settle (via `_scheduling`) before returning, so a
   * `stop()` that races an `ensureRunning()` cannot leave a timer installed
   * after it returns.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this._running && this._timer === null) {
      // Still drain any in-flight reschedule so a concurrent schedule cannot
      // resurrect a timer after stop() returns.
      await this._scheduling.catch(() => {});
      return;
    }
    this._running = false;
    if (this._timer !== null) {
      this._clearTimeoutFn(this._timer);
      this._timer = null;
    }
    this.logger?.log?.('[SharedPoller] Poller stopped (no active payments).');
    // Drain an in-flight reschedule: after it runs, _scheduleNext's post-await
    // `_running` check observes `false` and refuses to install a timer.
    await this._scheduling.catch(() => {});
  }

  /**
   * Apply a new configured Poll_Interval. The value is clamped to the
   * `minInterval` floor. When the loop is running the pending timer is
   * rescheduled immediately so the change takes effect right away rather than
   * after the old interval elapses.
   *
   * Returns a Promise that resolves once the reschedule has settled, so a
   * concurrent `setInterval` + `stop` cannot float a rejection.
   *
   * @param {number} ms - the new Poll_Interval in milliseconds.
   * @returns {Promise<void>}
   */
  setInterval(ms) {
    const next = Number.isFinite(ms) ? Math.max(this.minInterval, ms) : this._baseInterval;
    this._baseInterval = next;
    if (this._running) {
      // Reschedule immediately so a Config change applies within ≤ 5s.
      return this._scheduleNext();
    }
    return Promise.resolve();
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
    this._baseInterval = await this._readConfiguredInterval();

    // Run periodic maintenance (webhook-log pruning, etc.) before the active-
    // count check so it still fires on a system that is briefly idle — the
    // hook gates itself on maintenanceIntervalMs and swallows its own errors.
    await this._runMaintenanceIfDue();

    const activeCount = await this._safeActiveCount();
    if (activeCount === null) return;
    if (activeCount <= 0) {
      // No Active_Payment: stop polling. `stop()` is async (it drains any
      // in-flight reschedule) so await it; otherwise the drain Promise would
      // float and a racing reschedule could resurrect a timer.
      await this.stop();
      return;
    }

    this._pollWindow = this.computePollWindow(activeCount);

    let transactions = [];
    try {
      // Freeze the query bounds across pages. An incomplete batch must not
      // expire payments that could match a later page on the next tick.
      const end = new Date(this._now()).toISOString();
      const oldest = this.getStartTime ? await this.getStartTime() : null;
      const start = new Date(Number.isFinite(oldest) ? oldest : this._now() - this.days * 86400000).toISOString();
      let offset = 0;
      const seen = new Set();
      for (;;) {
        const page = await this.gobizClient.getRecentTransactions({
          days: this.days, size: this._pollWindow, offset, start, end,
        });
        if (!Array.isArray(page)) throw new Error('Invalid transaction page');
        const rawCount = page.pageCount ?? page.length;
        let newIds = 0;
        for (const tx of page) {
          if (!tx?.txId || !seen.has(tx.txId)) {
            transactions.push(tx);
            if (tx?.txId) { seen.add(tx.txId); newIds++; }
          }
        }
        offset += rawCount;
        if (rawCount === 0 && page.total > offset) throw new Error('Incomplete transaction pagination');
        if (rawCount === 0 || (page.total > 0 ? offset >= page.total : rawCount < this._pollWindow)) break;
        if (newIds === 0) throw new Error('Transaction pagination made no progress');
      }
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
      await this.onTransactions(batch);
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
   * Concurrency safety: the whole reschedule is chained onto `_scheduling` so
   * two concurrent calls (e.g. `ensureRunning` racing `setInterval`) cannot
   * each await the active count and each install a timer — the links run
   * strictly one after another, so only the last caller's timer survives. After
   * awaiting the count the method re-checks `_running` so a `stop()` that
   * landed during the await cannot leave a timer installed.
   *
   * @param {number} [overrideDelay] - an explicit delay in ms; when omitted the
   *   adaptive interval is used.
   * @returns {Promise<void>} resolves once the reschedule has settled (the
   *   timer is installed, or the loop is observed to be stopped).
   * @private
   */
  _scheduleNext(overrideDelay) {
    // Chain onto `_scheduling` so concurrent calls execute one at a time. Each
    // link clears the prior timer and computes its delay from the freshest
    // state (after the previous link finished), guaranteeing only the last
    // caller's timer survives.
    this._scheduling = this._scheduling
      .catch(() => {
        // Swallow a prior link's rejection so the chain keeps flowing; the
        // originator of each link observes its own outcome via the final catch.
      })
      .then(async () => {
        // Pre-await check: bail out fast when stopped before the count read.
        if (!this._running) {
          return;
        }
        if (this._timer !== null) {
          this._clearTimeoutFn(this._timer);
          this._timer = null;
        }
        const delay = Number.isFinite(overrideDelay)
          ? overrideDelay
          : this.computeInterval(await this._safeActiveCount());
        // Post-await check: a stop()/setInterval() that landed during the count
        // read must not leave a stale timer behind.
        if (!this._running) {
          return;
        }
        this._timer = this._setTimeoutFn(() => this._runCycle(), delay);
      })
      .catch((err) => {
        // The count read or the timer scheduling threw; log so it never
        // surfaces as an unhandled rejection, then propagate so the caller
        // (ensureRunning/setInterval/_runCycle) can observe it.
        this.logger?.error?.(
          `[SharedPoller] Failed to schedule the next poll: ${err?.message ?? err}`,
        );
        throw err;
      });
    return this._scheduling;
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
    if (this._cycle) return;
    this._cycle = this.onTick();
    try {
      await this._cycle;
    } catch (err) {
      this.logger?.error?.(`[SharedPoller] Poll cycle failed: ${err?.message ?? err}`);
    } finally {
      this._cycle = null;
      if (this._running) await this._scheduleNext();
    }
  }

  async drain() {
    await this.stop();
    await this._cycle;
  }

  /**
   * Read the configured Poll_Interval, clamped to the `minInterval` floor.
   * Falls back to {@link DEFAULT_POLL_INTERVAL_MS} when no Config getter is
   * provided or it returns a non-finite value.
   *
   * @returns {Promise<number>}
   * @private
   */
  async _readConfiguredInterval() {
    let configured = DEFAULT_POLL_INTERVAL_MS;
    if (this.getPollInterval) {
      try {
        const value = await this.getPollInterval();
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
   * Read the Active_Payment count defensively, treating a throw/rejection or a
   * non-finite value as unknown (which keeps the loop available for recovery).
   *
   * @returns {Promise<number>}
   * @private
   */
  async _safeActiveCount() {
    try {
      const count = await this.getActiveCount();
      return Number.isFinite(count) ? count : null;
    } catch (err) {
      this.logger?.error?.(
        `[SharedPoller] Failed to read the active payment count: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Invoke the {@link onMaintenance} hook when at least
   * {@link maintenanceIntervalMs} has elapsed since the last run. A
   * throw/rejection is caught and logged so housekeeping can never kill the poll
   * loop. No-op when no hook was injected or the spacing has not yet elapsed.
   *
   * @returns {Promise<void>}
   * @private
   */
  async _runMaintenanceIfDue() {
    if (this.onMaintenance === null) {
      return;
    }
    const now = this._now();
    if (now - this._lastMaintenanceAt < this.maintenanceIntervalMs) {
      return;
    }
    this._lastMaintenanceAt = now;
    try {
      await this.onMaintenance();
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
