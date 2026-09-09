# Payment gateway code audit

Date: 2026-09-09

The reported symptom is an error when selecting the gateway, before the customer pays. The strongest code-level explanation is a collision on the requested amount, especially when multiple customers buy the same product. This is a hypothesis about the complaints, not a confirmed production diagnosis: the customer-facing error text, checkout integration, production request logs, and live GoBiz responses were not available.

The review traced creation, validation, QR generation and loading, settlement, polling, both storage adapters, webhook delivery, and the panel proxy. This section records the original audit before fixes; the implementation status below supersedes its descriptions of current behavior. Reproductions use synthetic transactions, SQLite memory databases, and one loopback HTTP server; they do not log in to GoBiz or send real webhooks.

## Implementation status

The identified defects are fixed locally in Gopay and AutoBeli. Deployment has not been performed. AutoBeli already used server-managed amounts and an authenticated QR image proxy, so the original exact-amount and image hypotheses do not explain its current integration. Its 10-second gateway request timeout versus a potentially sleeping Render instance is another plausible cause of the pre-payment errors; production logs are still needed to establish the actual cause.

Fixes cover stale reservation cleanup, persisted client-scoped creation idempotency, authenticated image documentation, a two-minute reconciliation window, strict transaction timestamps and QRIS settlement filtering, full-body transport timeouts, poll recovery and pagination, durable leased webhook retries, input limits, and merchant QR readiness. A concurrent login-lockout counter defect discovered in native MongoDB tests was also corrected in both adapters.

AutoBeli now reuses its original creation attempt after an uncertain timeout, retries after a 30-second lease, forwards the idempotency key, keeps checking during reconciliation, hides expired QR codes, and handles response-body failures. The gateway normalizes journal webhook transactions for the store's timestamp validation.

### Deployment

1. Deploy the gateway first. Apply database migrations through normal startup; confirm `/health/ready` succeeds with the merchant QR loaded. Keep one instance for this rollout.
2. Use an always-on Render instance. `render.yaml` now specifies Starter; editing the file alone does not change an existing deployment or billing plan. Render Free can sleep after 15 minutes of inactivity and takes about a minute to wake: https://render.com/docs/free. Use MongoDB persistence, or a paid persistent disk for SQLite and token files.
3. Deploy AutoBeli to Vercel, retaining the matching gateway API key, webhook HMAC key, and callback URL configuration. No secrets were changed by this fix.
4. Check a real checkout and its signed paid webhook after deployment. No real payment was made during local verification. Outstanding durable jobs recover after restart; old terminal records from before the migration need explicit manual reconciliation if their notifications were missed.

The fixed grace period cannot recover arbitrarily delayed provider reports. Amount-only matching cannot distinguish every late transfer after an amount is reused; investigate those cases manually. Tests use synthetic data and do not prove that the live merchant credentials or provider responses are healthy.

Run `node scripts/audit-payment-repros.mjs` for regression checks. Set `MONGODB_URI_TEST` to an isolated test database to include MongoDB coverage. The historical reproduction observations below describe the original defects, not assertions that should still pass.

## Most relevant to errors before payment

### A. Same exact amount returns an error by design

Posting `{ "amount": 25000 }` twice while the first payment is pending returns `201`, then `409 AMOUNT_IN_USE`. There is one shared pending-amount namespace, so different orders/customers cannot simultaneously reserve the same exact amount. Omitting `mode` defaults an `amount` request to client-managed mode. This is an intentional matching constraint, but can explain intermittent checkout failures if the storefront sends ordinary product totals.

Evidence: [mode selection](../src/routes/payments.routes.js#L63), [collision handling](../src/payment/payment-service.js#L272), [SQLite insert](../src/dal/sqlite/sqlite-storage.js#L404). Reproduction observation 1.

Integration action: if the checkout supports a unique amount suffix, send `base_amount` (or explicit `server_managed` mode) and display/charge the returned `amount`. Do not silently change the total or remove the uniqueness constraint: settlement currently depends on it. The stale reservation defect below makes these collisions last longer than intended.

### 1. High: expired reservations still block new payment creation

**Trigger:** an existing payment has passed `expires_at`, but no status/list read or successful poll has swept it yet. `createPayment()` attempts insertion immediately without expiring overdue rows. Both backends enforce uniqueness on `status = pending`, regardless of the deadline.

**Observed:** create Rp25,000 with a 10-second lifetime; advance time to 10.001 seconds; another create still returns `409 AMOUNT_IN_USE`. Run `listActive()` once and the identical create succeeds. This happens briefly between normal polls and can persist through upstream outages because the poller skips the expiry handler when its fetch fails.

**Customer impact:** the gateway rejects a fresh checkout even though the earlier reservation should have ended. Repeated server-managed attempts can also consume stale suffix slots.

**Evidence:** [create flow](../src/payment/payment-service.js#L246), [insert](../src/payment/payment-service.js#L272), [poll fetch failure](../src/poller/shared-poller.js#L413). Reproduction observation 2.

**Fix direction:** make reservation cleanup part of allocation, preserving atomic uniqueness and expiry notifications. Coordinate with the settlement reconciliation changes in findings 4 and 5 so releasing an amount does not misassign a delayed transfer.

### 2. Medium: creation retries are not idempotent

**Trigger:** the first `POST /payment` succeeds, but the response is lost, or a customer double-clicks/retries checkout. No order reference or idempotency key is used to retrieve the existing payment.

**Observed:** two identical server-managed requests with the same `Idempotency-Key` header both return `201`, with different IDs and amounts Rp30,000 and Rp30,001. Exact-amount retries instead return `409` while the original is pending. The API does not currently promise idempotency; this is a payment-integration capability gap with a concrete retry failure mode.

**Customer impact:** an apparently failed checkout cannot recover its existing payment cleanly, or allocates additional payment records and changing totals.

**Evidence:** [request mapping](../src/routes/payments.routes.js#L257), [new ID creation](../src/payment/payment-service.js#L187), [sequential suffix allocation](../src/payment/amount-allocator.js#L207). Reproduction observation 3.

**Fix direction:** persist an idempotency key scoped to the API client, validate that repeated payloads agree, and return the original payment atomically across concurrent retries.

### 3. Medium: documented customer QR image example returns 401

**Trigger:** the integration follows the API documentation and uses the returned `qris_url` directly in a customer `<img>` element. The URL is relative to the backend, and the image endpoint inherits the API-key pre-handler. A normal image element does not attach the backend's bearer key.

**Observed:** the same QR URL returns `401 UNAUTHORIZED` without the header and `200 image/png` with it. The documentation includes a plain `<img src="http://YOUR_HOST:3000/payment/.../qris.png">` example that cannot supply that header. The admin panel avoids this through a separate session-authenticated proxy; that proxy is not available to an ordinary storefront customer.

**Customer impact:** payment creation succeeds, but the checkout shows a missing QR image or an error before payment.

**Evidence:** [route-wide auth](../src/routes/payments.routes.js#L216), [relative URL](../src/routes/payments.routes.js#L136), [image handler](../src/routes/payments.routes.js#L368), [documented example](API.md#34-qris-image--get-paymentidqrispng), [panel proxy](../panel/src/routes/qris/[id]/+server.js#L22). Reproduction observation 4.

**Fix direction:** correct the integration documentation and render `qris_string` locally, proxy images through a checkout-authorized backend, or implement narrowly scoped expiring image URLs. Keep the merchant API key on the server.

### B. Other confirmed request-contract error paths

These are useful diagnostic checks, not automatically implementation bugs:

- `amount: "40000"` is rejected with `400 INVALID_AMOUNT`; this field must be a JSON number. Confirmed in reproduction observation 5.
- Amounts below Rp1,000 or above Rp9,999,000 fail validation. The panel action's error text still says “at least 1 Rupiah,” which disagrees with the backend minimum.
- `timeout` is milliseconds, with a minimum of 10,000. Sending `300` to mean five minutes returns `400 INVALID_REQUEST`.
- Missing/revoked API credentials return `401 UNAUTHORIZED`.
- Missing/invalid configured static QRIS returns `500 QRIS_INVALID`. GoBiz pre-warming is asynchronous and health readiness only checks storage, so a new instance can accept traffic before an initially missing QRIS has been synced.

Evidence: [amount validator](../src/payment/amount-allocator.js#L78), [timeout schema](../src/routes/schemas.js#L107), [panel validation text](../panel/src/routes/create/+page.server.js#L88), [QRIS validation](../src/payment/qris-builder.js#L76), [health readiness](../src/server.js#L421), [background initialization](../src/server.js#L481).

## Additional confirmed payment-processing defects

### 4. High: on-time payment is discarded when observed after expiry

`handleTransactions()` expires all overdue payments before processing the batch already fetched from GoBiz. It uses current processing time to decide eligibility, rather than allowing an on-time provider transaction to reconcile after a polling delay. Status reads can independently cause the same terminal transition.

**Observed:** five-minute payment, transfer at second 299, poll processing at second 301: zero settlements and `status = expired`. This can occur under normal polling or network latency, without the customer paying late.

**Evidence:** [expiry before matching](../src/payment/payment-service.js#L488), [expiry on status reads](../src/payment/payment-service.js#L328). Reproduction observation 6.

**Fix direction:** reconcile by provider transaction time, introduce an explicit reconciliation/grace policy, and delay irreversible expiry notification until that policy is satisfied. Merely moving one expiry call is insufficient because GET/list reads also expire records.

### 5. High: a delayed transfer can mark a different customer's order paid

Amounts are reusable as soon as the old payment expires. Matching accepts transactions up to two minutes before the new payment's creation. A transfer not previously matched has no entry in the settlement idempotency index, so that index cannot protect against this case.

**Observed:** A requests Rp25,000, transfers at second 299, and is expired at second 301 before the transfer is seen. B then requests Rp25,000. When A's transfer appears, the service marks **B paid** and leaves **A expired**.

**Evidence:** [two-minute allowance](../src/payment/payment-service.js#L76), [candidate time filter](../src/payment/payment-service.js#L554), [settlement](../src/payment/payment-service.js#L577). Reproduction observation 7.

**Fix direction:** reconcile recently expired reservations before assigning transfers to newer ones; retain amount ownership through a defined reconciliation window and handle ambiguous matches explicitly. A provider-issued order identifier would be stronger if available. Do not rely on amount plus a permissive lower time bound alone.

### 6. High: response-body stalls bypass HTTP timeout

`HttpTransport.request()` clears the abort timer as soon as `fetch()` returns headers, then reads `response.text()` outside that timeout. A server that sends headers and stalls the body can exceed the configured deadline and stall the shared poll cycle or a webhook attempt. It is not bounded by the application's advertised 30-second/10-second deadline.

**Observed:** a synthetic body remains unresolved past the deadline without an abort; a real loopback endpoint delaying its body by 300 ms returns success after approximately 313 ms despite `timeoutMs: 100`.

**Evidence:** [timer cleared before body read](../src/gobiz/http-transport.js#L114), [poll waits for cycle completion](../src/poller/shared-poller.js#L508). Reproduction observations 11 and 12.

**Fix direction:** keep the timer active through body consumption and handle errors from both fetch and body reading within the same try/finally. Test delayed headers and delayed bodies separately.

### 7. High: one database count error stops automatic monitoring

`_safeActiveCount()` converts a storage error into zero. `onTick()` interprets zero as no pending payments and stops the loop. After storage recovers, existing pending payments have no scheduled retry; monitoring restarts only through another `ensureRunning()` trigger, such as a new payment or process startup.

**Observed:** inject one count-read error while a payment exists; recover storage; poller is stopped with no timer and no transaction fetch.

**Evidence:** [error becomes zero](../src/poller/shared-poller.js#L548), [zero stops loop](../src/poller/shared-poller.js#L402), [restart hook](../src/server.js#L302). Reproduction observation 9.

**Fix direction:** distinguish “no payments” from “count unavailable,” preserve the loop on transient errors, and retry with bounded backoff.

### 8. High: transactions outside the first poll page are missed

The poller requests one page sized from the number of active payments plus ten, capped at 100. It never follows `total`, supplies an offset, or maintains a progress cursor. Unrelated merchant transactions can displace a relevant transfer from that page, especially after downtime or a busy interval. The GoBiz client already supports pagination, but the poller does not use it.

**Observed:** one pending payment gives a window of 11. Put its matching transfer in position 12 behind 11 unrelated transfers; two consecutive polls fetch the same first page and the payment remains pending.

**Evidence:** [window calculation](../src/poller/shared-poller.js#L280), [single fetch](../src/poller/shared-poller.js#L415), [client offset support](../src/gobiz/gobiz-client.js#L209). Reproduction observation 10.

**Fix direction:** fetch all pages needed to cover the reconciliation interval with a stable ordering/watermark, overlapping boundaries and durable transaction deduplication. Pending-payment count is not a reliable measure of merchant transaction volume.

### 9. High: refunds are treated as incoming payment evidence

The client explicitly requests refund and partial-refund statuses. The response adapter unconditionally labels every returned transaction `type: 'payin'`, ignoring status and payment type. The matcher checks that manufactured type but does not revalidate the provider status.

**Observed:** a synthetic `status: REFUND` row with positive gross amount, a matching amount/time, and an unused transaction ID settles a pending order. This proves missing validation; whether the live provider returns that exact combination must be verified with real response samples. The query also includes non-QRIS card payments, creating additional ambiguity for a merchant that accepts several payment methods.

**Evidence:** [requested statuses/types](../src/gobiz/gobiz-client.js#L26), [unconditional normalization](../src/gobiz/response-adapter.js#L72), [matching type check](../src/payment/payment-service.js#L521). Reproduction observation 8.

**Fix direction:** explicitly allow supported successful incoming QRIS statuses/types, validate money and timestamps, and reject or quarantine refund/unknown records before matching. Add fixtures from both actual upstream response formats.

### 10. High: webhook delivery can be abandoned after settlement

Payment state is committed first and notification is a detached callback whose rejection is swallowed. The dispatcher records an attempt after sending it; a failure writing that log aborts the loop before the next retry. There is no durable queue/outbox or startup recovery for unfinished notifications. Shutdown stops the poller and closes storage without draining webhook work.

**Observed:** first send returns 503; the attempt-log insert throws; dispatcher rejects after **one** send, never reaching its remaining four attempts. The process-restart loss path is established by code inspection, not a killed-process reproduction.

**Customer impact:** this service may show paid while the storefront never receives the event and keeps the order unpaid. This is separate from the user's reported pre-payment errors.

**Evidence:** [swallowed hook rejection](../src/payment/payment-service.js#L408), [failed-attempt log before retry](../src/webhook/webhook-dispatcher.js#L398), [in-memory retry delay](../src/webhook/webhook-dispatcher.js#L427), [shutdown](../src/server.js#L459). Reproduction observation 13.

**Fix direction:** atomically persist a notification job with the payment transition, deliver from a durable worker with retry state and recovery, and make receiver processing idempotent. A log write failure must not silently erase delivery obligations.

## Validation and next diagnosis

Run the standalone reproductions with:

```sh
node scripts/audit-payment-repros.mjs
```

The script checks **13 observations of current behavior**, including deliberate API constraints. Its assertions confirm the audit; they are not regression tests of corrected behavior and should be revised or retired when fixes land.

Existing test results on this Windows workspace (Node v22.16.0):

| Suite | Result |
| --- | --- |
| Backend `npm test -- --reporter=dot` | 579 passed, 2 failed, 49 skipped |
| Panel `npm test -- --reporter=dot` | 49 passed |
| Standalone audit reproductions | 13 observations confirmed |

The two backend failures assert POSIX `0600` file modes but observe `0666` on Windows; they do not reproduce the checkout complaint. The 49 MongoDB contract tests were skipped because no test URI was configured. Runtime reproductions used SQLite; MongoDB-specific behavior was reviewed statically. No live-provider conformance or production-load test was performed.

For the actual complaint, correlate a failed checkout with the backend route, HTTP status, `error_code`, numeric amount, amount mode, and timestamp. Start with `409 AMOUNT_IN_USE`; check whether the conflicting payment is still within its lifetime. If the failing request is the image GET, check `401` and how the storefront obtains the PNG. If it is `400`, compare the request field types and units against the API contract. Exclude API keys, credentials, and customer-sensitive data from diagnostic excerpts.

Address checkout collisions/stale reservations, idempotent creation, and the QR integration documentation first for the reported symptom. Treat wrong-order settlement and the other high-priority processing defects as separate correctness work before relying on automated payment confirmation.

## Verification of local fixes

- Full gateway suite with a local native MongoDB: 652 passed, two POSIX-only permission checks skipped on Windows.
- Final payment regression rerun, including an additional incomplete-pagination case: 25 passed across SQLite and MongoDB.
- Panel: 49 passed; documentation component rerun passed after its example was corrected.
- AutoBeli: 109 targeted tests and five Playwright checkout/webhook tests passed. ESLint passed on all changed TypeScript files. Gateway language lint passed.
- AutoBeli whole-project TypeScript check remains blocked by four errors in untouched tests: readonly NODE_ENV assignments in health.test.ts and pakasirWebhook.test.ts, and the $setOnInsert mock typing in orders.test.ts.
