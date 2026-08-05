// Client helper for the realtime payment event stream (SSE).
//
// Opens an EventSource to the session-guarded `/api/events` proxy and invokes
// `onEvent` with each parsed signal `{ type, payment_id, status, at }`. The
// browser's EventSource reconnects automatically, so callers only need to react
// to events (and keep their existing polling as a fallback).
//
// Safe in non-browser environments (e.g. jsdom component tests): when
// `EventSource` is unavailable it is a no-op and returns a no-op cleanup.

/**
 * Subscribe to the payment event stream.
 *
 * @param {(event: { type: string, payment_id: string, status: string|null, at: number }|null) => void} onEvent
 * @returns {() => void} a cleanup function that closes the stream.
 */
export function subscribePaymentEvents(onEvent) {
  if (typeof EventSource === 'undefined') {
    return () => {};
  }

  /** @type {EventSource|undefined} */
  let source;
  try {
    source = new EventSource('/api/events');
  } catch {
    return () => {};
  }

  source.onmessage = (message) => {
    let data = null;
    try {
      data = JSON.parse(message.data);
    } catch {
      data = null;
    }
    onEvent(data);
  };

  // Errors (including disconnects) are handled by EventSource's built-in
  // reconnect; nothing to do here.

  return () => {
    try {
      source?.close();
    } catch {
      // ignored
    }
  };
}
