// Unit tests for the Webhook_Dispatcher event handling: the `X-Event` header
// and the signed `payment_status` body field, for both `paid` and `expired`.

import { describe, expect, it } from 'vitest';

import { createWebhookDispatcher } from '../webhook/webhook-dispatcher.js';
import { verify } from '../webhook/hmac.js';

const HMAC_KEY = 'test-secret-key';

/** In-memory webhookLogs store recording appends. */
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
      if (row) row.status = 'failed_permanent';
      return { ok: true };
    },
  };
}

/** Transport returning a fixed status and recording the requests it received. */
function makeTransport(status) {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      return { status, ok: status >= 200 && status <= 299, text: async () => 'ok' };
    },
  };
}

describe('Webhook_Dispatcher event header and body', () => {
  it('defaults to the paid event: X-Event=paid and payment_status=paid in the signed body', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const dispatcher = createWebhookDispatcher({ webhookLogs, transport, hmacKey: HMAC_KEY });

    const payment = {
      id: 'pay-1',
      webhook_url: 'https://pay.example/hook',
      tx_raw: JSON.stringify({ gross_amount: 2500000, transaction_id: 'tx-1' }),
    };
    await dispatcher.dispatch(payment); // no options -> paid

    const req = transport.calls[0];
    expect(req.headers['X-Event']).toBe('paid');
    const body = JSON.parse(req.body);
    expect(body.payment_id).toBe('pay-1');
    expect(body.payment_status).toBe('paid');
    expect(body.provider_transaction.transaction_id).toBe('tx-1');
    // The signature covers the body (so payment_status is tamper-proof).
    expect(verify(req.body, req.headers['X-Signature'], HMAC_KEY)).toBe(true);
  });

  it('sends an expired event: X-Event=expired and an expired body with payment context', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const dispatcher = createWebhookDispatcher({ webhookLogs, transport, hmacKey: HMAC_KEY });

    const payment = {
      id: 'pay-2',
      amount: 25000,
      created_at: 1700000000000,
      expires_at: 1700000300000,
      webhook_url: 'https://pay.example/hook',
    };
    await dispatcher.dispatch(payment, { event: 'expired' });

    const req = transport.calls[0];
    expect(req.headers['X-Event']).toBe('expired');
    const body = JSON.parse(req.body);
    expect(body).toMatchObject({
      payment_id: 'pay-2',
      payment_status: 'expired',
      amount: 25000,
      created_at: 1700000000000,
      expires_at: 1700000300000,
      tz: 'Asia/Jakarta',
    });
    // The ISO siblings are offset-aware (+07:00 WIB) and point at the same
    // absolute instants as the epoch-ms fields.
    expect(body.created_at_iso).toMatch(/\+07:00$/);
    expect(body.expires_at_iso).toMatch(/\+07:00$/);
    expect(new Date(body.created_at_iso).getTime()).toBe(1700000000000);
    expect(new Date(body.expires_at_iso).getTime()).toBe(1700000300000);
    expect(verify(req.body, req.headers['X-Signature'], HMAC_KEY)).toBe(true);
  });

  it('renders the expired _iso fields in the per-payment tz when set', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const dispatcher = createWebhookDispatcher({ webhookLogs, transport, hmacKey: HMAC_KEY });

    await dispatcher.dispatch(
      {
        id: 'pay-tz',
        amount: 1000,
        created_at: 1700000000000,
        expires_at: 1700000300000,
        tz: 'Asia/Makassar',
        webhook_url: 'https://pay.example/hook',
      },
      { event: 'expired' },
    );

    const body = JSON.parse(transport.calls[0].body);
    expect(body.tz).toBe('Asia/Makassar');
    expect(body.created_at_iso).toMatch(/\+08:00$/);
    expect(new Date(body.created_at_iso).getTime()).toBe(1700000000000);
  });

  it('falls back to the Config display_timezone for expired _iso when the payment has no tz', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(200);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      config: { get: (key) => (key === 'display_timezone' ? 'Asia/Jayapura' : null) },
    });

    await dispatcher.dispatch(
      {
        id: 'pay-cfg',
        amount: 1000,
        created_at: 1700000000000,
        expires_at: 1700000300000,
        webhook_url: 'https://pay.example/hook',
      },
      { event: 'expired' },
    );

    const body = JSON.parse(transport.calls[0].body);
    expect(body.tz).toBe('Asia/Jayapura');
    expect(body.created_at_iso).toMatch(/\+09:00$/);
  });

  it('carries the event through dispatchOnce (manual resend single attempt)', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport(404);
    const dispatcher = createWebhookDispatcher({ webhookLogs, transport, hmacKey: HMAC_KEY });

    await dispatcher.dispatchOnce(
      { id: 'pay-3', amount: 1000, created_at: 1, expires_at: 2, webhook_url: 'https://pay.example/hook' },
      { event: 'expired' },
    );

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].headers['X-Event']).toBe('expired');
    expect(JSON.parse(transport.calls[0].body).payment_status).toBe('expired');
  });
});
