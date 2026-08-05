// Tests for the Webhook_Dispatcher (webhook-dispatcher.js).
//
// All collaborators are faked: a recording transport, an in-memory webhookLogs
// store, a fake clock, and a sleep stub that captures the requested backoff
// delays without waiting on real time. This exercises URL selection, signing,
// idempotency, the 2xx success rule, retry/backoff, delivery logging, and
// permanent-failure handling deterministically.

import { describe, expect, it } from 'vitest';

import {
  createWebhookDispatcher,
  selectWebhookUrl,
  backoffDelayMs,
  buildPayload,
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MIN_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_RESPONSE_BODY_CHARS,
} from '../webhook/webhook-dispatcher.js';
import { verify } from '../webhook/hmac.js';

const HMAC_KEY = 'test-secret-key';

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
 * Build a transport whose responses are dictated by a queue of outcomes. Each
 * outcome is either `{ status }` (an HTTP response) or `{ throw: message }`
 * (a network error / timeout). Records every request it received.
 */
function makeTransport(outcomes) {
  const calls = [];
  let i = 0;
  return {
    calls,
    async request(req) {
      calls.push(req);
      const outcome = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (outcome.throw) {
        throw new Error(outcome.throw);
      }
      return {
        status: outcome.status,
        ok: outcome.status >= 200 && outcome.status <= 299,
        text: async () => outcome.body ?? '',
      };
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

/** A sample raw GoBiz transaction, as persisted on the payment's tx_raw. */
const SAMPLE_RAW_TX = {
  transaction_id: 'tx-abc',
  transaction_status: 'settlement',
  gross_amount: 5000000,
  transaction_time: '2023-11-14T22:13:20.000Z',
  payment_type: 'gopay',
};

const PAYMENT = {
  id: 'pay-123',
  amount: 50000,
  paid_amount: 50000,
  paid_at: 1700000000000,
  tx_id: 'tx-abc',
  tx_raw: JSON.stringify(SAMPLE_RAW_TX),
};

describe('selectWebhookUrl', () => {
  it('prefers the per-Payment webhook_url', () => {
    const config = { get: () => 'https://config.example/hook' };
    expect(selectWebhookUrl({ webhook_url: 'https://pay.example/hook' }, config)).toBe(
      'https://pay.example/hook',
    );
  });

  it('falls back to the Config default when the payment has none', () => {
    const config = { get: () => 'https://config.example/hook' };
    expect(selectWebhookUrl({ webhook_url: null }, config)).toBe('https://config.example/hook');
  });

  it('returns null when neither source provides a URL', () => {
    const config = { get: () => null };
    expect(selectWebhookUrl({ webhook_url: null }, config)).toBeNull();
    expect(selectWebhookUrl({}, null)).toBeNull();
  });

  it('ignores an empty-string per-Payment URL and uses the default', () => {
    const config = { get: () => 'https://config.example/hook' };
    expect(selectWebhookUrl({ webhook_url: '' }, config)).toBe('https://config.example/hook');
  });
});

describe('backoffDelayMs', () => {
  it('is exponential and within the 1000..60000 ms window', () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(4)).toBe(8000);
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const delay = backoffDelayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(MIN_BACKOFF_MS);
      expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    }
  });
});

describe('createWebhookDispatcher.dispatch', () => {
  it('does not send and writes no log when no URL is available', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ status: 200 }]);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      config: { get: () => null },
      hmacKey: HMAC_KEY,
    });

    const result = await dispatcher.dispatch({ ...PAYMENT, webhook_url: null });

    expect(result).toEqual({ sent: false });
    expect(transport.calls).toHaveLength(0);
    expect(webhookLogs.rows).toHaveLength(0);
  });

  it('sends with a 10000ms timeout, succeeds on 2xx, logs success', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ status: 204 }]);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      now: () => 12345,
    });

    const result = await dispatcher.dispatch({ ...PAYMENT, webhook_url: 'https://pay.example/hook' });

    expect(result.sent).toBe(true);
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://pay.example/hook',
      timeoutMs: ATTEMPT_TIMEOUT_MS,
    });
    expect(webhookLogs.rows).toHaveLength(1);
    expect(webhookLogs.rows[0]).toMatchObject({
      payment_id: 'pay-123',
      target_url: 'https://pay.example/hook',
      status: 'success',
      attempts: 1,
      last_attempt_at: 12345,
      last_error: null,
    });
  });

  it('signs the body with an X-Signature that verifies', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ status: 200 }]);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
    });

    await dispatcher.dispatch({ ...PAYMENT, webhook_url: 'https://pay.example/hook' });

    const { headers, body } = transport.calls[0];
    expect(headers['X-Signature']).toBeTruthy();
    expect(verify(body, headers['X-Signature'], HMAC_KEY)).toBe(true);
    // A tampered body must fail verification.
    expect(verify(`${body} `, headers['X-Signature'], HMAC_KEY)).toBe(false);
  });

  it('includes a stable payment_id across all retries', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ status: 500 }, { status: 500 }, { status: 200 }]);
    const { sleep } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
    });

    await dispatcher.dispatch({ ...PAYMENT, webhook_url: 'https://pay.example/hook' });

    expect(transport.calls.length).toBe(3);
    const paymentIds = transport.calls.map((c) => JSON.parse(c.body).payment_id);
    expect(paymentIds).toEqual(['pay-123', 'pay-123', 'pay-123']);
    // The signature is identical too, since the body is identical across retries.
    const signatures = transport.calls.map((c) => c.headers['X-Signature']);
    expect(new Set(signatures).size).toBe(1);
  });

  it('retries failures then succeeds, recording each result', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ status: 503 }, { throw: 'timed out' }, { status: 200 }]);
    const { sleep, delays } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
    });

    const result = await dispatcher.dispatch({
      ...PAYMENT,
      webhook_url: 'https://pay.example/hook',
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
    expect(delays).toEqual([1000, 2000]);
    expect(webhookLogs.rows.map((r) => r.status)).toEqual(['failed', 'failed', 'success']);
    expect(webhookLogs.rows.map((r) => r.attempts)).toEqual([1, 2, 3]);
  });

  it('makes exactly 5 attempts then marks failed_permanent and stops', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ status: 500 }]);
    const { sleep, delays } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
    });

    const result = await dispatcher.dispatch({
      ...PAYMENT,
      webhook_url: 'https://pay.example/hook',
    });

    expect(transport.calls).toHaveLength(MAX_ATTEMPTS);
    expect(result).toMatchObject({
      sent: true,
      success: false,
      attempts: MAX_ATTEMPTS,
      permanentlyFailed: true,
    });
    // 4 backoff delays between 5 attempts, each in range.
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    // 5 appended rows; the final one is flipped to failed_permanent.
    expect(webhookLogs.rows).toHaveLength(MAX_ATTEMPTS);
    expect(webhookLogs.rows.slice(0, 4).every((r) => r.status === 'failed')).toBe(true);
    expect(webhookLogs.rows[4].status).toBe('failed_permanent');
  });

  it('treats a timeout (thrown request) as a failed attempt', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ throw: 'request timed out after 10000ms' }, { status: 200 }]);
    const { sleep } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
    });

    const result = await dispatcher.dispatch({
      ...PAYMENT,
      webhook_url: 'https://pay.example/hook',
    });

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
    expect(webhookLogs.rows[0].status).toBe('failed');
    expect(webhookLogs.rows[0].last_error).toContain('timed out');
  });

  it('rejects construction without a valid webhookLogs store', () => {
    expect(() => createWebhookDispatcher({ transport: { request: () => {} } })).toThrow();
  });

  it('records response_status, response_body, and request_body on success', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ status: 200, body: 'OK received' }]);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
    });

    await dispatcher.dispatch({ ...PAYMENT, webhook_url: 'https://pay.example/hook' });

    expect(webhookLogs.rows).toHaveLength(1);
    const row = webhookLogs.rows[0];
    expect(row.response_status).toBe(200);
    expect(row.response_body).toBe('OK received');
    // The request body is the exact serialized payload that was sent.
    expect(row.request_body).toBe(transport.calls[0].body);
    const sentBody = JSON.parse(row.request_body);
    expect(sentBody.payment_id).toBe('pay-123');
    // The body is the base fields plus the nested GoBiz transaction.
    expect(sentBody.provider_transaction.transaction_status).toBe('settlement');
  });

  it('records response_status and a truncated response_body on a failed attempt', async () => {
    const longBody = 'x'.repeat(MAX_RESPONSE_BODY_CHARS + 500);
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ status: 500, body: longBody }, { status: 200, body: '' }]);
    const { sleep } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
    });

    await dispatcher.dispatch({ ...PAYMENT, webhook_url: 'https://pay.example/hook' });

    const failedRow = webhookLogs.rows[0];
    expect(failedRow.status).toBe('failed');
    expect(failedRow.response_status).toBe(500);
    expect(failedRow.response_body).toHaveLength(MAX_RESPONSE_BODY_CHARS);
    expect(failedRow.request_body).toBe(transport.calls[0].body);
  });

  it('records a null response_status when the request throws', async () => {
    const webhookLogs = makeWebhookLogs();
    const transport = makeTransport([{ throw: 'network down' }, { status: 200, body: '' }]);
    const { sleep } = makeSleep();
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
      sleep,
    });

    await dispatcher.dispatch({ ...PAYMENT, webhook_url: 'https://pay.example/hook' });

    const thrownRow = webhookLogs.rows[0];
    expect(thrownRow.status).toBe('failed');
    expect(thrownRow.response_status ?? null).toBeNull();
    expect(thrownRow.response_body ?? null).toBeNull();
    expect(thrownRow.last_error).toContain('network down');
    expect(thrownRow.request_body).toBe(transport.calls[0].body);
  });
});

describe('buildPayload', () => {
  it('includes the base properties and nests the raw GoBiz transaction (paid)', () => {
    const payload = buildPayload(PAYMENT);
    expect(payload.payment_id).toBe('pay-123');
    expect(payload.payment_status).toBe('paid');
    expect(payload.amount).toBe(50000);
    expect(payload.created_at).toBeNull();
    expect(payload.paid_at).toBe(1700000000000);
    expect(payload.created_at_iso).toBeNull();
    expect(payload.paid_at_iso).toBe('2023-11-15T05:13:20.000+07:00');
    expect(payload.tz).toBe('Asia/Jakarta');
    
    // The raw transaction fields are nested within provider_transaction
    expect(payload.provider_transaction).toEqual(SAMPLE_RAW_TX);
    expect(payload).not.toHaveProperty('transaction_status');
    expect(payload).not.toHaveProperty('transaction_id');
  });

  it('falls back to the base payload without provider_transaction when tx_raw is absent', () => {
    const p = { id: 'pay-123', amount: 500 };
    const expectedBase = {
      payment_id: 'pay-123',
      payment_status: 'paid',
      amount: 500,
      created_at: null,
      paid_at: null,
      created_at_iso: null,
      paid_at_iso: null,
      tz: 'Asia/Jakarta'
    };
    expect(buildPayload(p)).toEqual(expectedBase);
    expect(buildPayload({ ...p, tx_raw: null })).toEqual(expectedBase);
  });

  it('falls back to the base payload without provider_transaction when tx_raw is unparseable', () => {
    const p = { id: 'pay-123' };
    const expectedBase = {
      payment_id: 'pay-123',
      payment_status: 'paid',
      amount: null,
      created_at: null,
      paid_at: null,
      created_at_iso: null,
      paid_at_iso: null,
      tz: 'Asia/Jakarta'
    };
    expect(buildPayload({ ...p, tx_raw: 'not-json' })).toEqual(expectedBase);
    // A JSON value that is not a plain object is also ignored.
    expect(buildPayload({ ...p, tx_raw: '[1,2,3]' })).toEqual(expectedBase);
    expect(buildPayload({ ...p, tx_raw: '42' })).toEqual(expectedBase);
  });

  it('builds an expired-event payload with the payment context and ISO/tz fields (no raw tx)', () => {
    const payload = buildPayload(
      { id: 'pay-999', amount: 25000, created_at: 1700000000000, expires_at: 1700000300000 },
      'expired',
    );
    expect(payload).toEqual({
      payment_id: 'pay-999',
      payment_status: 'expired',
      amount: 25000,
      created_at: 1700000000000,
      expires_at: 1700000300000,
      created_at_iso: '2023-11-15T05:13:20.000+07:00',
      expires_at_iso: '2023-11-15T05:18:20.000+07:00',
      tz: 'Asia/Jakarta',
    });
  });

  it('renders the expired ISO fields in an explicit tz argument', () => {
    const payload = buildPayload(
      { id: 'pay-tz', amount: 50001, created_at: 1700000000000, expires_at: 1700000300000 },
      'expired',
      'Asia/Makassar',
    );
    expect(payload.tz).toBe('Asia/Makassar');
    expect(payload.created_at_iso).toMatch(/\+08:00$/);
    expect(new Date(payload.created_at_iso).getTime()).toBe(1700000000000);
  });
});
