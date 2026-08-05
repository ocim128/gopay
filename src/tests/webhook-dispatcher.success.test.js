// Unit tests for the Webhook_Dispatcher success and no-URL paths.
//
// Focus:
//  - A 2xx response on the first attempt is treated as success: the transport
//    is called exactly once (no retries) and a single delivery-log row is
//    appended with status 'success'.
//  - When neither a per-Payment `webhook_url` nor a Config default exists, the
//    dispatcher sends nothing, records nothing, and does not treat it as a
//    failure (result.sent === false).
//
// Every collaborator is faked: a recording transport, an in-memory webhookLogs
// store, an immediate sleep stub, and a fixed clock. This mirrors the
// construction pattern used in webhook-dispatcher.test.js.

import { describe, expect, it } from 'vitest';

import { createWebhookDispatcher } from '../webhook/webhook-dispatcher.js';

const HMAC_KEY = 'test-secret-key';

const PAYMENT = {
  id: 'pay-success-1',
  amount: 75000,
  paid_amount: 75000,
  paid_at: 1700000000000,
  tx_id: 'tx-success',
};

/**
 * Build an in-memory webhookLogs store that records appended rows and permanent
 * failure marks, mirroring the DAL contract surface used by the dispatcher.
 */
function makeWebhookLogs() {
  const rows = [];
  return {
    rows,
    append(entry) {
      rows.push({ ...entry });
      return { ok: true };
    },
    markPermanentFailure(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) {
        return { ok: false, code: 'LOG_NOT_FOUND' };
      }
      row.status = 'failed_permanent';
      return { ok: true };
    },
  };
}

/**
 * Build a transport that returns a fixed HTTP status for every request and
 * records the requests it received.
 */
function makeTransport(status) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      return { status, ok: status >= 200 && status <= 299 };
    },
  };
}

/** A sleep stub that records every requested delay and resolves immediately. */
function makeSleep() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

describe('Webhook_Dispatcher 2xx success', () => {
  it('records a single success log and performs no retries on a 200 response', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const { sleep, delays } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
      now: () => 999000,
    });

    const result = await dispatcher.dispatch({
      ...PAYMENT,
      webhook_url: 'https://pay.example/hook',
    });

    // The 2xx response is a success with no retries.
    expect(result).toMatchObject({
      sent: true,
      success: true,
      attempts: 1,
      status: 200,
      url: 'https://pay.example/hook',
    });

    // The transport was invoked exactly once (no retries).
    expect(transport.calls).toHaveLength(1);
    expect(delays).toEqual([]);

    // Exactly one delivery-log row, recorded as success.
    expect(webhookLogs.rows).toHaveLength(1);
    expect(webhookLogs.rows[0]).toMatchObject({
      payment_id: 'pay-success-1',
      target_url: 'https://pay.example/hook',
      status: 'success',
      attempts: 1,
      last_attempt_at: 999000,
      last_error: null,
    });
  });

  it('treats any 2xx status (e.g. 201) as success on the first attempt', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(201);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
    });

    const result = await dispatcher.dispatch({
      ...PAYMENT,
      webhook_url: 'https://pay.example/hook',
    });

    expect(result.success).toBe(true);
    expect(transport.calls).toHaveLength(1);
    expect(webhookLogs.rows).toHaveLength(1);
    expect(webhookLogs.rows[0].status).toBe('success');
  });
});

describe('Webhook_Dispatcher no-URL handling', () => {
  it('sends nothing and records nothing when neither per-Payment nor Config URL exists', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      config: { get: () => null },
      hmacKey: HMAC_KEY,
    });

    const result = await dispatcher.dispatch({ ...PAYMENT, webhook_url: null });

    // Not sent, and explicitly not a failure.
    expect(result).toEqual({ sent: false });
    expect(result.sent).toBe(false);

    // No transport call and no delivery-log row.
    expect(transport.calls).toHaveLength(0);
    expect(webhookLogs.rows).toHaveLength(0);
  });

  it('treats an empty-string per-Payment URL with no Config default as no-URL', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      config: { get: () => null },
      hmacKey: HMAC_KEY,
    });

    const result = await dispatcher.dispatch({ ...PAYMENT, webhook_url: '' });

    expect(result).toEqual({ sent: false });
    expect(transport.calls).toHaveLength(0);
    expect(webhookLogs.rows).toHaveLength(0);
  });
});
