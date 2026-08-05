// End-to-end settlement integration test.
//
// This wires the REAL components together (not via buildServer) and drives the
// full settlement lifecycle: create -> poll -> match -> settle -> webhook,
// asserting both the Payment state transition and the webhook delivery log.
//
// Composition (all real, no network):
//   * in-memory SQLite DAL          (src/dal/sqlite/sqlite-storage.js)
//   * real Config Service           (src/config/runtime-config.js) seeded with a
//                                    valid Static_QRIS so createPayment can build
//                                    the Dynamic_QRIS without a network call.
//   * real Payment_Service          (src/payment/payment-service.js) whose
//                                    onSettled hook is wired to a real
//                                    Webhook_Dispatcher.
//   * real Webhook_Dispatcher       (src/webhook/webhook-dispatcher.js) over a
//                                    stubbed transport returning HTTP 200 and the
//                                    real in-memory webhookLogs DAL store.
//   * real Shared_Poller            (src/poller/shared-poller.js) whose
//                                    GoBizClient is stubbed to return one matching
//                                    canonical payin Transaction.
//
// Properties asserted:
//   * the Payment transitions pending -> paid with tx_id / paid_amount / paid_at
//     recorded.
//   * the webhook is sent (the transport is called) and a delivery_log row is
//     recorded with status `success`.
//
// The onSettled hook is fire-and-forget from the Payment_Service's perspective,
// so the test captures the dispatch promise the hook returns and awaits it
// directly before asserting on the webhook outcome.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSqliteStorage } from '../dal/sqlite/sqlite-storage.js';
import { createConfigService } from '../config/runtime-config.js';
import { createPaymentService } from '../payment/payment-service.js';
import { createWebhookDispatcher } from '../webhook/webhook-dispatcher.js';
import { SharedPoller } from '../poller/shared-poller.js';

// A real, structurally valid Static_QRIS with a correct trailing CRC16, so
// createPayment builds the Dynamic_QRIS without any network dependency.
const VALID_STATIC_QRIS =
  '00020101021126610014COM.GO-JEK.WWW01189360091434970566750210G4970566750303UMI51440014ID.CO.QRIS.WWW0215ID10254118460050303UMI5204899953033605802ID5925Scalify Panel, Digital & 6015JAKARTA SELATAN61051200062070703A016304CD45';

const HMAC_KEY = 'integration-test-secret-key';
const WEBHOOK_URL = 'https://merchant.example/webhook';

/**
 * A transport stub that always returns HTTP 200 and records every request, so
 * the test can prove the webhook was actually sent over the wire boundary.
 */
function makeStubTransport() {
  const calls = [];
  return {
    calls,
    async request(req) {
      calls.push(req);
      return { status: 200, ok: true };
    },
  };
}

/**
 * A GoBizClient stub whose `getRecentTransactions` returns a single canonical
 * payin Transaction (the shape the ResponseAdapter produces and the
 * Payment_Service matches against: `txId`, `amount`, `type`).
 *
 * @param {Array<object>} transactions
 */
function makeStubGoBizClient(transactions) {
  return {
    getRecentTransactions: vi.fn().mockResolvedValue(transactions),
  };
}

/**
 * Wrap a real `webhookLogs` DAL store so every appended delivery-log row is
 * recorded for assertions while still being persisted by the real store. The
 * `webhookLogs` store exposes only writers in this slice, so this recorder is
 * how the test observes the rows that were actually written to the DAL.
 *
 * @param {{ append: Function, markPermanentFailure: Function }} realStore
 */
function makeRecordingWebhookLogs(realStore) {
  const rows = [];
  return {
    rows,
    append(entry) {
      rows.push({ ...entry });
      return realStore.append(entry);
    },
    markPermanentFailure(id) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.status = 'failed_permanent';
      }
      return realStore.markPermanentFailure(id);
    },
  };
}

describe('End-to-end settlement (create -> poll -> match -> settle -> webhook)', () => {
  /** @type {ReturnType<typeof createSqliteStorage>} */
  let storage;

  afterEach(() => {
    if (storage) {
      storage.close();
      storage = undefined;
    }
  });

  it('settles a matching payment and records a successful webhook delivery', async () => {
    // ---- Compose the real modules over an in-memory SQLite DAL --------------
    storage = createSqliteStorage({ dbPath: ':memory:' });

    const config = createConfigService(storage);
    config.setStaticQris(VALID_STATIC_QRIS);

    const transport = makeStubTransport();
    const webhookLogs = makeRecordingWebhookLogs(storage.webhookLogs);
    const dispatcher = createWebhookDispatcher({
      webhookLogs,
      transport,
      hmacKey: HMAC_KEY,
    });

    // Capture the dispatch promise the onSettled hook returns so the test can
    // await the (otherwise fire-and-forget) webhook before asserting.
    /** @type {Promise<object>|null} */
    let dispatchPromise = null;

    // The poller is declared with `let` so the Payment_Service ensureRunning
    // hook can reach it once it is constructed below.
    /** @type {SharedPoller} */
    let poller;

    const paymentService = createPaymentService({
      storage,
      config,
      ensureRunning: () => poller.ensureRunning(),
      onSettled: (settledPayment) => {
        dispatchPromise = dispatcher.dispatch(settledPayment);
        return dispatchPromise;
      },
    });

    // The GoBizClient is stubbed to return a canonical payin transaction that
    // matches the payment amount exactly (within the default zero tolerance).
    const PAID_AMOUNT = 87500;
    const stubTx = {
      txId: 'tx-e2e-0001',
      amount: PAID_AMOUNT,
      type: 'payin',
      time: '2024-01-01T00:00:00.000Z',
      raw: { reference_id: 'tx-e2e-0001' },
    };
    const gobizClient = makeStubGoBizClient([stubTx]);

    poller = new SharedPoller(gobizClient, {
      getActiveCount: () => storage.payments.countActive(),
      onTransactions: (txs) => paymentService.handleTransactions(txs),
      getPollInterval: () => config.getPollInterval(),
    });

    // ---- 1. Create a payment: it starts pending -----------------------------
    const created = paymentService.createPayment({
      mode: 'client',
      amount: PAID_AMOUNT,
      webhook_url: WEBHOOK_URL,
    });

    expect(created.status).toBe('pending');
    expect(created.tx_id).toBeNull();
    expect(created.paid_amount).toBeNull();
    expect(created.paid_at).toBeNull();
    // Creating a pending payment starts the shared poller.
    expect(poller.running).toBe(true);

    // ---- 2. Drive one poll cycle: fetch -> match -> settle ------------------
    await poller.onTick();

    // The poller fetched transactions from the (stubbed) GoBiz client.
    expect(gobizClient.getRecentTransactions).toHaveBeenCalledTimes(1);

    // ---- 3. The payment transitioned pending -> paid ---------
    const settled = paymentService.getPayment(created.id);
    expect(settled.status).toBe('paid');
    expect(settled.tx_id).toBe(stubTx.txId);
    expect(settled.paid_amount).toBe(PAID_AMOUNT);
    expect(typeof settled.paid_at).toBe('number');
    expect(settled.paid_at).toBeGreaterThan(0);

    // ---- 4. Await the webhook dispatch the settlement hook kicked off -------
    expect(dispatchPromise).not.toBeNull();
    const dispatchResult = await dispatchPromise;

    // The webhook was sent over the transport.
    expect(dispatchResult).toMatchObject({ sent: true, success: true, attempts: 1 });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]).toMatchObject({
      method: 'POST',
      url: WEBHOOK_URL,
    });
    // The signed payload is the raw GoBiz transaction with payment_id added.
    const sentBody = JSON.parse(transport.calls[0].body);
    expect(sentBody).toMatchObject({
      payment_id: created.id,
      payment_status: 'paid',
      amount: PAID_AMOUNT,
      provider_transaction: {
        reference_id: stubTx.txId,
      }
    });
    // The raw object is nested under provider_transaction.
    expect(sentBody.provider_transaction).toEqual(stubTx.raw);

    // ---- 5. A delivery_log row was recorded as success ------------
    expect(dispatchResult.status).toBe(200);
    expect(webhookLogs.rows).toHaveLength(1);
    expect(webhookLogs.rows[0]).toMatchObject({
      payment_id: created.id,
      target_url: WEBHOOK_URL,
      status: 'success',
      attempts: 1,
    });

    poller.stop();
  });
});
