// In-process event bus for realtime panel updates.
//
// This is a tiny, dependency-free pub/sub over Node's EventEmitter. The
// Payment_Service settlement/expiry/creation hooks publish a lightweight SIGNAL
// here (no heavy payload), and the SSE endpoint (`GET /admin/events`) fans those
// signals out to connected panels so they can refresh instantly.
//
// IMPORTANT: publishing is a synchronous, in-memory, fire-and-forget operation
// (microseconds, no I/O). It is decoupled from the webhook dispatch and never
// adds latency to the core login -> poll -> settle -> webhook pipeline. When no
// panel is connected there are no listeners and `emit` is a no-op.
//
// The signal intentionally carries only `{ type, payment_id, status, at }` — the
// panel reacts by re-fetching through its existing endpoints, so a dropped or
// missed event never causes stale/incorrect data (polling remains the source of
// truth; SSE is just a "refresh now" nudge).

import { EventEmitter } from 'node:events';

/** The single channel name used for every payment lifecycle signal. */
export const PAYMENT_EVENT = 'payment';

/**
 * Create an event bus.
 *
 * @returns {{
 *   subscribe: (listener: (event: object) => void) => (() => void),
 *   emitPayment: (type: 'created'|'paid'|'expired', payment: { id: string, status?: string }) => void,
 *   listenerCount: () => number,
 * }}
 */
export function createEventBus() {
  const emitter = new EventEmitter();
  // Many panels (browser tabs) may subscribe; lift the default listener cap so
  // Node does not log a false-positive memory-leak warning.
  emitter.setMaxListeners(0);

  return {
    /**
     * Subscribe to payment signals. Returns an unsubscribe function.
     * @param {(event: object) => void} listener
     * @returns {() => void}
     */
    subscribe(listener) {
      emitter.on(PAYMENT_EVENT, listener);
      return () => emitter.off(PAYMENT_EVENT, listener);
    },

    /**
     * Publish a payment lifecycle signal. Ignores malformed input.
     * @param {'created'|'paid'|'expired'} type
     * @param {{ id: string, status?: string }} payment
     */
    emitPayment(type, payment) {
      if (!payment || typeof payment.id !== 'string') {
        return;
      }
      emitter.emit(PAYMENT_EVENT, {
        type,
        payment_id: payment.id,
        status: payment.status ?? null,
        at: Date.now(),
      });
    },

    /** Current number of subscribers (used in tests). */
    listenerCount() {
      return emitter.listenerCount(PAYMENT_EVENT);
    },
  };
}

export default createEventBus;
