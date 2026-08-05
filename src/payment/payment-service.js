// Payment lifecycle: create, status/read, lazy-expire, list active.
//
// The Payment_Service owns the Payment lifecycle. It depends
// on storage-agnostic collaborators only:
//
//   * the DAL (`storage`)           - persistence + the atomic amount-uniqueness
//                                      guarantee (the partial unique index is the
//                                      single source of truth).
//   * the Config Service (`config`) - supplies the Static_QRIS the QRIS_Builder
//                                      reads from.
//   * the AmountAllocator           - client-managed validation & server-managed
//                                      suffix allocation.
//   * the QRIS_Builder              - builds the Dynamic_QRIS.
//
// This module provides `createPayment`, `getPayment` (with lazy-expire),
// `listActive`, and `handleTransactions` (transaction matching and settlement).
//
// The poller is injected as an optional `ensureRunning` hook. After a pending
// Payment is created the service calls the hook so
// the Shared_Poller can start/keep running — but the
// service never constructs a poller itself.
//
// Errors are surfaced with a stable `.code` matching the central error map
// (`src/errors.js`) so the route layer can translate them into the correct HTTP
// status without knowing about this module.

import { randomUUID } from 'node:crypto';

import { getErrorDefinition } from '../errors.js';
import {
  allocateServerAmount,
  validateBaseAmount,
  validateClientAmount,
} from './amount-allocator.js';
import { buildDynamicQris } from './qris-builder.js';

/**
 * The canonical incoming transaction shape broadcast by the Shared_Poller (via
 * the GoBiz ResponseAdapter). Money is an integer in
 * Rupiah; `time` is an ISO timestamp; `raw` is the untouched source payload.
 *
 * @typedef {Object} Transaction
 * @property {string} txId    The transaction id (settlement idempotency key).
 * @property {number} amount  Integer Rupiah received.
 * @property {'payin'} type   Only `payin` transactions can settle a Payment.
 * @property {string} [time]  ISO timestamp of the transaction, if known.
 * @property {unknown} [raw]  The original source payload.
 */

/**
 * Default Payment timeout in milliseconds when the API_Client omits `timeout`.
 *
 * @type {number}
 */
export const DEFAULT_TIMEOUT_MS = 300000;

/**
 * Default Payment tolerance in Rupiah when the API_Client omits `tolerance`.
 *
 * @type {number}
 */
export const DEFAULT_TOLERANCE = 0;

/**
 * The two amount modes accepted by `createPayment`.
 *
 *   * `CLIENT` (Client_Managed_Mode / Type 1): the API_Client supplies the full
 *     `amount`.
 *   * `SERVER` (Server_Managed_Mode / Type 2): the API_Client supplies a
 *     `base_amount` and the System appends a Unique_Suffix.
 *
 * @type {Readonly<{ CLIENT: 'client', SERVER: 'server' }>}
 */
export const PAYMENT_MODE = Object.freeze({
  CLIENT: 'client',
  SERVER: 'server',
});

/**
 * Error thrown by the Payment_Service for a domain failure. The `code` always
 * matches a key in the central error map (`src/errors.js`) and `http` is derived
 * from that map, so a route handler can respond consistently.
 */
export class PaymentError extends Error {
  /**
   * @param {string} code - a key in the central error map.
   * @param {string} [message] - optional English detail; defaults to the
   *   registered message for `code`.
   */
  constructor(code, message) {
    const definition = getErrorDefinition(code);
    super(message ?? definition.message);
    this.name = 'PaymentError';
    /** @type {string} the stable error_code for the response body. */
    this.code = code;
    /** @type {number} the HTTP status callers should respond with. */
    this.http = definition.http;
  }
}

/**
 * Create the Payment_Service over its collaborators.
 *
 * @param {Object} deps
 * @param {import('../dal/storage-interface.js').Storage} deps.storage - the DAL.
 * @param {{ getStaticQris: () => (string|null) }} deps.config - the Config
 *   Service (only `getStaticQris` is used here); supplies the Static_QRIS the
 *   QRIS_Builder reads from.
 * @param {() => void} [deps.ensureRunning] - optional poller hook invoked after a
 *   pending Payment is created so the Shared_Poller can start/keep running.
 * @param {(payment: import('../dal/storage-interface.js').Payment, transaction: Transaction) => void} [deps.onSettled]
 *   optional settlement hook invoked once, after a Payment is successfully
 *   settled, so the Webhook_Dispatcher can send its notification. It is an
 *   injected callback rather than a direct dependency: the
 *   Payment_Service never imports the dispatcher. Any error or rejection it
 *   produces is isolated so it cannot abort transaction matching.
 * @param {(payment: import('../dal/storage-interface.js').Payment) => void} [deps.onExpired]
 *   optional hook invoked once per Payment that transitions to `expired`, so the
 *   Webhook_Dispatcher can send an "expired" notification. Best-effort like
 *   `onSettled` (any throw/rejection is swallowed). Requires the DAL to expose
 *   `expireOverdueReturning`; otherwise no expiry notification is emitted.
 * @param {(payment: import('../dal/storage-interface.js').Payment) => void} [deps.onCreated]
 *   optional hook invoked once after a Payment is created (best-effort), so a
 *   realtime signal can be emitted to the panel. A throw is swallowed.
 * @param {() => number} [deps.now] - clock returning epoch ms; injectable for
 *   deterministic tests. Defaults to `Date.now`.
 * @param {() => string} [deps.idFactory] - id generator; defaults to
 *   `crypto.randomUUID`.
 * @returns {{
 *   createPayment: (input?: object) => import('../dal/storage-interface.js').Payment,
 *   getPayment: (id: string) => (import('../dal/storage-interface.js').Payment|null),
 *   listActive: (options?: import('../dal/storage-interface.js').ListOptions) => import('../dal/storage-interface.js').Payment[],
 *   handleTransactions: (transactions?: Transaction[]) => import('../dal/storage-interface.js').Payment[],
 * }}
 */
export function createPaymentService(deps = {}) {
  const { storage, config } = deps;

  if (!storage || typeof storage !== 'object' || !storage.payments) {
    throw new TypeError('createPaymentService requires a storage (DAL) instance.');
  }
  if (!config || typeof config.getStaticQris !== 'function') {
    throw new TypeError('createPaymentService requires a config service with getStaticQris().');
  }

  const ensureRunning = typeof deps.ensureRunning === 'function' ? deps.ensureRunning : null;
  const onSettled = typeof deps.onSettled === 'function' ? deps.onSettled : null;
  const onExpired = typeof deps.onExpired === 'function' ? deps.onExpired : null;
  const onCreated = typeof deps.onCreated === 'function' ? deps.onCreated : null;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const idFactory = typeof deps.idFactory === 'function' ? deps.idFactory : () => randomUUID();

  /**
   * Build a fully-formed pending Payment record for a concrete Amount. The
   * Dynamic_QRIS is built here; an absent/malformed
   * Static_QRIS makes the QRIS_Builder throw a `QrisError` (code
   * `QRIS_INVALID`) which propagates to the caller.
   *
   * @param {number} amount - the resolved Amount in Rupiah.
   * @param {{ createdAt: number, expiresAt: number, timeout: number, tolerance: number, webhookUrl: (string|null), staticQris: (string|null) }} ctx
   * @returns {import('../dal/storage-interface.js').PendingPaymentInput}
   */
  function buildPendingRecord(amount, ctx) {
    return {
      id: idFactory(),
      amount,
      qris_string: buildDynamicQris(ctx.staticQris, amount),
      qris_url: null,
      created_at: ctx.createdAt,
      expires_at: ctx.expiresAt,
      timeout: ctx.timeout,
      tolerance: ctx.tolerance,
      webhook_url: ctx.webhookUrl,
      tz: ctx.tz,
    };
  }

  /**
   * Create a Payment.
   *
   * Validates the mode and Amount, builds the Dynamic_QRIS, persists a `pending`
   * Payment with `expires_at = created_at + timeout`, and then
   * invokes the poller hook.
   *
   * Amount uniqueness is enforced atomically by the DAL at insertion time, never
   * by a read-then-write check:
   *   * Client_Managed_Mode: a UNIQUE collision surfaces as `AMOUNT_IN_USE`.
   *   * Server_Managed_Mode: a collision triggers a retry with the next
   *     Unique_Suffix; exhausting all slots surfaces as `NO_AVAILABLE_AMOUNT`.
   *
   * @param {Object} [input]
   * @param {'client'|'server'} [input.mode] - the amount mode.
   * @param {number} [input.amount] - the full Amount (Client_Managed_Mode).
   * @param {number} [input.base_amount] - the Base_Amount (Server_Managed_Mode).
   * @param {number} [input.timeout] - per-Payment timeout in ms; defaults to
   *   {@link DEFAULT_TIMEOUT_MS}.
   * @param {number} [input.tolerance] - per-Payment tolerance in Rupiah; defaults
   *   to {@link DEFAULT_TOLERANCE}.
   * @param {string|null} [input.webhook_url] - per-Payment webhook override.
   * @param {string|null} [input.tz] - optional per-Payment IANA display
   *   timezone used to render the Payment's `_iso` timestamp fields.
   * @returns {import('../dal/storage-interface.js').Payment} the stored Payment.
   * @throws {PaymentError} with `INVALID_REQUEST` (bad mode) or `AMOUNT_IN_USE`.
   * @throws {import('./amount-allocator.js').AmountAllocationError} with
   *   `INVALID_AMOUNT`, `INVALID_BASE_AMOUNT`, or `NO_AVAILABLE_AMOUNT`.
   * @throws {import('./qris-builder.js').QrisError} with `QRIS_INVALID`.
   */
  function createPayment(input = {}) {
    const mode = input.mode;
    if (mode !== PAYMENT_MODE.CLIENT && mode !== PAYMENT_MODE.SERVER) {
      throw new PaymentError(
        'INVALID_REQUEST',
        "The amount mode is invalid. It must be 'client' or 'server'.",
      );
    }

    const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS;
    const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
    const webhookUrl = input.webhook_url ?? null;
    const createdAt = now();
    const ctx = {
      createdAt,
      // expires_at is exactly created_at + timeout.
      expiresAt: createdAt + timeout,
      timeout,
      tolerance,
      webhookUrl,
      // Optional per-Payment display timezone (an IANA zone name). Validation
      // happens at the route boundary; the service persists whatever it is
      // given (or null to fall back to the server default zone).
      tz: input.tz ?? null,
      // Read the Static_QRIS once; the QRIS_Builder validates it per build.
      staticQris: config.getStaticQris(),
    };

    /** @type {import('../dal/storage-interface.js').Payment} */
    let stored;

    if (mode === PAYMENT_MODE.CLIENT) {
      const amount = validateClientAmount(input.amount);
      const record = buildPendingRecord(amount, ctx);
      const result = storage.payments.insertPending(record);
      if (!result.ok) {
        if (result.code === 'AMOUNT_IN_USE') {
          throw new PaymentError('AMOUNT_IN_USE');
        }
        throw new PaymentError('INVALID_REQUEST', result.error ?? 'Failed to create the payment.');
      }
      stored = result.value;
    } else {
      const baseAmount = validateBaseAmount(input.base_amount);
      // allocateServerAmount drives the suffix scan; the attempt performs the
      // real atomic insert. A truthy return means success; `false` means the
      // candidate Amount is taken (retry the next suffix); anything else throws.
      const allocation = allocateServerAmount(baseAmount, (candidateAmount) => {
        const record = buildPendingRecord(candidateAmount, ctx);
        const result = storage.payments.insertPending(record);
        if (result.ok) {
          return result.value;
        }
        if (result.code === 'AMOUNT_IN_USE') {
          return false;
        }
        throw new PaymentError('INVALID_REQUEST', result.error ?? 'Failed to create the payment.');
      });
      stored = allocation.result;
    }

    // Register with the Shared_Poller (a single shared instance, never one per
    // request) so monitoring is running for this Active_Payment.
    if (ensureRunning) {
      ensureRunning();
    }

    // Best-effort realtime signal so the panel can show the new pending payment
    // immediately. Isolated so a hook error can never fail the creation.
    if (onCreated) {
      try {
        onCreated(stored);
      } catch {
        // Intentionally ignored: the payment is already created and durable.
      }
    }

    return stored;
  }

  /**
   * Read a Payment by id, applying lazy-expiration.
   *
   * If the Payment is still `pending` but the current time has passed its
   * `expires_at`, it is transitioned to `expired` and the expired record is
   * returned. For `paid` Payment the returned record
   * already carries the settlement details `tx_id`, `paid_amount`, and `paid_at`.
   *
   * @param {string} id
   * @returns {import('../dal/storage-interface.js').Payment|null} the Payment, or
   *   `null` when no Payment exists for `id` (the route maps this to
   *   `PAYMENT_NOT_FOUND`).
   */
  function getPayment(id) {
    let payment = storage.payments.getById(id);
    if (!payment) {
      return null;
    }

    const at = now();
    if (payment.status === 'pending' && at > payment.expires_at) {
      // expireOverdue flips every overdue pending Payment to `expired`; re-read
      // this one to return its updated status. Routing through expireAndNotify
      // also fires the expiry webhook for any Payment that just transitioned.
      expireAndNotify(at);
      payment = storage.payments.getById(id);
    }

    return payment;
  }

  /**
   * List Active_Payment (only `pending`) ordered by `expires_at` ascending.
   * Overdue pending Payment are lazily expired first so the
   * list never includes a Payment whose time has already passed.
   *
   * @param {import('../dal/storage-interface.js').ListOptions} [options]
   *   pagination (`limit` 1..100 default 100, `offset` >= 0 default 0).
   * @returns {import('../dal/storage-interface.js').Payment[]}
   */
  function listActive(options = {}) {
    expireAndNotify(now());
    return storage.payments.listActive(options);
  }

  /**
   * Gather every Active_Payment (status `pending`) as a snapshot, paging through
   * `listActive` so the result is not capped at a single page. The snapshot is
   * ordered by `expires_at` ascending (the DAL's order); callers that need the
   * earliest-created tie-break re-sort by `created_at` themselves.
   *
   * @returns {import('../dal/storage-interface.js').Payment[]}
   */
  function gatherActive() {
    const PAGE = 100;
    /** @type {import('../dal/storage-interface.js').Payment[]} */
    const all = [];
    let offset = 0;
    // better-sqlite3 is synchronous and single-tenant, so this snapshot is
    // consistent for the duration of one matching pass.
    for (;;) {
      const page = storage.payments.listActive({ limit: PAGE, offset });
      all.push(...page);
      if (page.length < PAGE) {
        break;
      }
      offset += PAGE;
    }
    return all;
  }

  /**
   * Notify the injected settlement hook (typically wired to the
   * Webhook_Dispatcher) that a Payment was settled. The hook
   * is best-effort: a synchronous throw or a rejected promise is swallowed so a
   * webhook problem can never abort transaction matching or settle the wrong
   * Payment. The dispatcher owns its own retry/backoff.
   *
   * @param {import('../dal/storage-interface.js').Payment} payment
   * @param {Transaction} transaction
   */
  function notifySettled(payment, transaction) {
    if (!onSettled) {
      return;
    }
    try {
      const result = onSettled(payment, transaction);
      if (result && typeof result.then === 'function') {
        result.then(undefined, () => {});
      }
    } catch {
      // Intentionally ignored: settlement already succeeded and is durable; the
      // webhook is a downstream side effect that must not roll it back.
    }
  }

  /**
   * Notify the injected expiry hook (typically wired to the Webhook_Dispatcher)
   * that a Payment transitioned to `expired`. Best-effort, exactly like
   * {@link notifySettled}: a synchronous throw or rejected promise is swallowed
   * so a webhook problem can never disrupt expiry processing.
   *
   * @param {import('../dal/storage-interface.js').Payment} payment
   */
  function notifyExpired(payment) {
    if (!onExpired) {
      return;
    }
    try {
      const result = onExpired(payment);
      if (result && typeof result.then === 'function') {
        result.then(undefined, () => {});
      }
    } catch {
      // Intentionally ignored: the payment is already durably expired; the
      // webhook is a downstream side effect.
    }
  }

  /**
   * Expire every overdue pending Payment and fire the expiry hook exactly once
   * per Payment that transitioned. When the DAL exposes
   * `expireOverdueReturning` (returns the rows it flipped via SQL RETURNING),
   * each newly-expired Payment is handed to {@link notifyExpired}. Backends
   * without that method fall back to the count-only `expireOverdue`, in which
   * case no expiry notification is emitted (used only by lightweight test mocks).
   *
   * @param {number} at - epoch ms.
   * @returns {number} how many Payments were expired.
   */
  function expireAndNotify(at) {
    if (typeof storage.payments.expireOverdueReturning === 'function') {
      const expired = storage.payments.expireOverdueReturning(at);
      if (Array.isArray(expired) && expired.length > 0) {
        for (const payment of expired) {
          notifyExpired(payment);
        }
        return expired.length;
      }
      return 0;
    }
    return storage.payments.expireOverdue(at);
  }

  /**
   * Handle a batch of transactions broadcast by the Shared_Poller and settle the
   * Active_Payment they match.
   *
   * For each canonical `payin` Transaction:
   *   * Find every Active_Payment whose Amount is within that Payment's
   *     `tolerance`: `|tx.amount - payment.amount| <= payment.tolerance`.
   *   * When several match, settle the one created earliest (`created_at`
   *     ascending, then `id` for a deterministic tie-break) — exactly one
   *     Payment is settled per transaction.
   *   * Settle via {@link import('../dal/storage-interface.js').PaymentsStore.markPaid},
   *     which records the `txId` in `settled_tx` inside one atomic transaction.
   *     A `txId` therefore settles at most one Payment: a re-used `txId` resolves
   *     to `TX_ALREADY_SETTLED` and settles nothing further.
   *     Marking the Payment `paid` stores `txId`/`paid_amount`/`paid_at`
   *     and frees its Amount, since the pending-amount unique
   *     index only covers `pending` rows.
   *   * A transaction that matches no Active_Payment is ignored — no Payment
   *     changes status.
   *
   * Overdue pending Payment are lazily expired first so an already-expired
   * Payment is never settled. Within a single batch a Payment that has just been
   * settled is removed from consideration so a later transaction cannot match it
   * again.
   *
   * @param {Transaction[]} [transactions] - the broadcast transactions.
   * @returns {import('../dal/storage-interface.js').Payment[]} the Payment
   *   settled by this batch, in settlement order.
   */
  function handleTransactions(transactions = []) {
    const batch = Array.isArray(transactions) ? transactions : [];

    const at = now();
    // Expire overdue pending Payments first and fire their expiry webhooks. This
    // runs on every poll tick — even when `batch` is empty — so expiry is
    // detected promptly without waiting for a read. An expired Payment is not an
    // Active_Payment and must never be settled.
    expireAndNotify(at);

    if (batch.length === 0) {
      return [];
    }

    const active = gatherActive();
    /** @type {Set<string>} ids settled within this batch (no double-match). */
    const consumed = new Set();
    /** @type {import('../dal/storage-interface.js').Payment[]} */
    const settled = [];

    for (const tx of batch) {
      // Only never-before-processed payin transactions can settle a Payment.
      if (!tx || tx.type !== 'payin' || typeof tx.txId !== 'string' || tx.txId.length === 0) {
        continue;
      }
      if (!Number.isFinite(tx.amount)) {
        continue;
      }

      // Candidates within tolerance, earliest-created first.
      const candidates = active
        .filter(
          (p) =>
            !consumed.has(p.id) &&
            Math.abs(tx.amount - p.amount) <= p.tolerance,
        )
        .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

      if (candidates.length === 0) {
        // No match: ignore the transaction.
        continue;
      }

      // Try candidates in order until one settles. markPaid is the single source
      // of truth for txId idempotency and the pending->paid transition.
      for (const candidate of candidates) {
        const result = storage.payments.markPaid(candidate.id, {
          txId: tx.txId,
          paidAmount: tx.amount,
          paidAt: at,
          // Persist the full raw GoBiz transaction so the webhook body can be
          // re-emitted verbatim (including on a "Resend webhook" action).
          raw: JSON.stringify(tx.raw ?? null),
        });

        if (result.ok) {
          consumed.add(candidate.id);
          settled.push(result.value);
          notifySettled(result.value, tx);
          break;
        }

        if (result.code === 'TX_ALREADY_SETTLED') {
          // This txId already settled some Payment in a previous pass; it must
          // not settle another. Stop trying this transaction.
          break;
        }

        // PAYMENT_NOT_PENDING (a concurrent expire/settle): the settled_tx row
        // was rolled back, so the txId is still free — fall through to the next
        // earliest candidate.
      }
    }

    return settled;
  }

  return {
    createPayment,
    getPayment,
    listActive,
    handleTransactions,
  };
}
