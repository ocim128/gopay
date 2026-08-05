// Unit tests for the Webhook_Dispatcher single-attempt resend path
// (`dispatchOnce`), which backs the Panel "Resend webhook" action.
//
// Focus:
//  - A manual resend performs EXACTLY ONE delivery attempt — no retry, no
//    backoff — regardless of the outcome.
//  - It records EXACTLY ONE delivery-log row (status 'success' on a 2xx, plain
//    'failed' on a non-2xx). A failure here is never escalated to
//    'failed_permanent' (that status is reserved for the automatic 5-attempt
//    cycle).
//  - When no target URL is available, nothing is sent and nothing is recorded.

import { describe, expect, it } from 'vitest';

import { createWebhookDispatcher } from '../webhook/webhook-dispatcher.js';

const HMAC_KEY = 'test-secret-key';

const PAYMENT = {
  id: 'pay-resend-1',
  amount: 75000,
  paid_amount: 75000,
  paid_at: 1700000000000,
  tx_id: 'tx-resend',
  webhook_url: 'https://pay.example/hook',
};

/** In-memory webhookLogs store recording appends and permanent-failure marks. */
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

/** Transport returning a fixed status for every request and recording calls. */
function makeTransport(status) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      return { status, ok: status >= 200 && status <= 299, text: async () => 'body' };
    },
  };
}

/** A sleep stub that records every requested delay (it must never be called). */
function makeSleep() {
  const delays = [];
  return { delays, sleep: async (ms) => void delays.push(ms) };
}

describe('Webhook_Dispatcher.dispatchOnce (manual resend = single attempt)', () => {
  it('hits the target exactly once and records one success row on a 2xx', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const { sleep, delays } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
      now: () => 1234000,
    });

    const result = await dispatcher.dispatchOnce(PAYMENT);

    expect(transport.calls).toHaveLength(1);
    expect(delays).toHaveLength(0); // no backoff ever
    expect(webhookLogs.rows).toHaveLength(1);
    expect(webhookLogs.rows[0]).toMatchObject({
      payment_id: 'pay-resend-1',
      status: 'success',
      attempts: 1,
      response_status: 200,
    });
    expect(result).toMatchObject({ sent: true, success: true, attempts: 1, status: 200 });
  });

  it('hits the target exactly once and records one plain failed row on a non-2xx (never failed_permanent)', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(404);
    const { sleep, delays } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
      now: () => 1234000,
    });

    const result = await dispatcher.dispatchOnce(PAYMENT);

    // Exactly one attempt and one log row — no retry storm, no backoff.
    expect(transport.calls).toHaveLength(1);
    expect(delays).toHaveLength(0);
    expect(webhookLogs.rows).toHaveLength(1);
    expect(webhookLogs.rows[0]).toMatchObject({
      payment_id: 'pay-resend-1',
      status: 'failed',
      attempts: 1,
      response_status: 404,
    });
    // A single manual attempt is never escalated to failed_permanent.
    expect(webhookLogs.rows[0].status).not.toBe('failed_permanent');
    expect(result).toMatchObject({ sent: true, success: false, attempts: 1, status: 404 });
  });

  it('sends nothing and records nothing when no URL is available', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      config: { get: () => null },
    });

    const result = await dispatcher.dispatchOnce({ ...PAYMENT, webhook_url: null });

    expect(transport.calls).toHaveLength(0);
    expect(webhookLogs.rows).toHaveLength(0);
    expect(result).toEqual({ sent: false });
  });
});
