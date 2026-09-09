# GoPay Payment Panel — REST API & Webhook Reference

Machine-to-machine API for creating dynamic QRIS payments, checking their
status, and receiving HMAC-signed webhook notifications when a payment is paid.

- **Base URL:** `http://YOUR_HOST:3000` (the backend `gopay-api` process)
- **Content type:** `application/json` for all request/response bodies
- **Money:** all amounts are **integers in Rupiah** (e.g. `12345` = Rp 12.345). No decimals.
- **Time:** timestamps are **epoch milliseconds** (integers) unless noted otherwise.

> The web panel (port 3001) is a separate admin UI authenticated by a login
> session and is **not** part of this API. Everything below is the
> API-key-protected machine interface plus the outgoing webhook.

---

## 1. Authentication

Every `/payment*` endpoint requires an **API key**. Create one from the panel
(**API Keys** page); the full value is shown only once.

Send it in **either** header:

```
Authorization: Bearer <API_KEY>      # preferred
X-API-Key: <API_KEY>                 # alternative
```

Rules:
- If both headers are present, the `Authorization: Bearer` value is used and `X-API-Key` is ignored.
- An empty/whitespace key, a wrong scheme (e.g. `Basic`), an unknown key, or a revoked key → **HTTP 401 `UNAUTHORIZED`**.

---

## 2. Error format

All errors share one shape:

```json
{ "error_code": "INVALID_AMOUNT", "message": "The amount is invalid. It must be an integer between 1000 and 9999000." }
```

### Error code reference

| error_code            | HTTP | Meaning |
|-----------------------|------|---------|
| `INVALID_REQUEST`     | 400  | Body malformed, or `timeout`/`tolerance` out of range. |
| `INVALID_AMOUNT`      | 400  | Client-managed `amount` missing / not an integer / outside 1000..9999000. |
| `INVALID_BASE_AMOUNT` | 400  | Server-managed `base_amount` missing / not a positive integer (≥ 1). |
| `INVALID_WEBHOOK_URL` | 400  | `webhook_url` is not an absolute http/https URL, or exceeds 2048 chars. |
| `UNAUTHORIZED`        | 401  | Missing/invalid/revoked API key. |
| `PAYMENT_NOT_FOUND`   | 404  | No payment with that id. |
| `AMOUNT_IN_USE`       | 409  | Client-managed amount already used by another **pending** payment. |
| `NO_AVAILABLE_AMOUNT` | 409  | Server-managed: all 1000 suffix slots for the base amount are taken. |
| `QRIS_INVALID`        | 500  | The configured Static QRIS is missing or invalid (set it in the panel Config). |

---

## 3. Endpoints

### 3.1 Create payment — `POST /payment`

Creates a `pending` payment and returns a dynamic QRIS immediately (does not
wait for the customer to pay).

**Request body**

| Field         | Type    | Required | Notes |
|---------------|---------|----------|-------|
| `mode`        | string  | _optional_     | `"client_managed"` or `"server_managed"`. Default is inferred.                |
| `amount`      | integer | client-managed | Full amount in Rupiah, `1000..9999000`. Must be unique among pending payments. |
| `base_amount` | integer | server-managed | Base amount in Rupiah, `1000..9999000`. The system adds a `0..999` suffix.     |
| `timeout`     | integer | no       | Lifetime in ms, `10000..86400000`. Default `300000` (5 min). |
| `tolerance`   | integer | no       | Amount-match tolerance in Rupiah, `0..999`. Default `0`. |
| `webhook_url` | string  | no       | Absolute http/https URL ≤ 2048 chars. Overrides the Config default for this payment. |
| `tz`          | string  | no       | IANA timezone for this payment's `*_at_iso` fields (e.g. `Asia/Jakarta`, `Asia/Makassar`, `UTC`). Defaults to the server Config `display_timezone`. An unknown zone → `INVALID_REQUEST`. |

> A `poll_interval` field in the body is **ignored** (it is a server-level setting).

**Response `201 Created`**:

```json
{
  "id": "4ad4f8df-a549-482d-8b73-2e25d74f2b28",
  "status": "pending",
  "amount": 10007,
  "qris_string": "00020101021226...5802ID...6304ABCD",
  "qris_url": "/payment/4ad4f8df-a549-482d-8b73-2e25d74f2b28/qris.png",
  "expires_at": 1782689000000,
  "created_at": 1782688700000,
  "expires_at_iso": "2026-06-29T06:23:20.000+07:00",
  "created_at_iso": "2026-06-29T06:18:20.000+07:00",
  "tz": "Asia/Jakarta"
}
```

- `qris_string` — the dynamic QRIS payload (already includes the amount + CRC16). Render it as a QR code, or use `qris_url`.
- `qris_url` — relative path to a server-rendered PNG of the QRIS (see 3.4).
- In **server-managed** mode, `amount` is the final `base_amount + suffix`.
- **Timestamps:** every `*_at` field is epoch milliseconds (UTC) — one absolute instant. Each has an `*_at_iso` sibling: the same instant as an ISO-8601 string rendered in the resolved display timezone (`tz`), which carries that zone's offset (e.g. `+07:00` WIB, `+08:00` WITA, `+09:00` WIT, `+00:00` UTC). The two representations always agree. The applied zone is echoed back in the `tz` field. Choosing a different `tz` never changes the stored instant — only how it is displayed.

**Example — client-managed**

```bash
curl -s -X POST http://YOUR_HOST:3000/payment \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "mode": "client_managed",
        "amount": 25000,
        "timeout": 600000,
        "tolerance": 0,
        "webhook_url": "https://merchant.example/webhooks/gopay"
      }'
```

**Example — server-managed** (system picks the unique amount)

```bash
curl -s -X POST http://YOUR_HOST:3000/payment \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "mode": "server_managed", "base_amount": 10000 }'
# -> { "amount": 10007, ... }  (base 10000 + suffix 7)
```

**Errors:** `INVALID_REQUEST`, `INVALID_AMOUNT`, `INVALID_BASE_AMOUNT`, `AMOUNT_IN_USE`, `NO_AVAILABLE_AMOUNT`, `INVALID_WEBHOOK_URL`, `QRIS_INVALID`, `UNAUTHORIZED`.

---

### 3.2 Get payment — `GET /payment/:id`

**Response `200 OK`**

```json
{
  "id": "4ad4f8df-...",
  "amount": 25000,
  "status": "pending",
  "expires_at": 1782689000000,
  "created_at": 1782688700000,
  "expires_at_iso": "2026-06-29T06:23:20.000+07:00",
  "created_at_iso": "2026-06-29T06:18:20.000+07:00",
  "tz": "Asia/Jakarta"
}
```

`status` is one of `pending` | `paid` | `expired`. When `paid`, settlement
details are included:

```json
{
  "id": "4ad4f8df-...",
  "amount": 25000,
  "status": "paid",
  "expires_at": 1782689000000,
  "created_at": 1782688700000,
  "expires_at_iso": "2026-06-29T06:23:20.000+07:00",
  "created_at_iso": "2026-06-29T06:18:20.000+07:00",
  "tz": "Asia/Jakarta",
  "txId": "0120260628232046WY1VVrAgVQID",
  "paid_amount": 25000,
  "paid_at": 1782688846904,
  "paid_at_iso": "2026-06-29T06:20:46.904+07:00"
}
```

> Expiry is lazy: reading a `pending` payment whose `expires_at` has passed
> returns `expired`.

```bash
curl -s http://YOUR_HOST:3000/payment/4ad4f8df-... \
  -H "Authorization: Bearer $API_KEY"
```

**Errors:** `PAYMENT_NOT_FOUND`, `UNAUTHORIZED`.

---

### 3.3 List active payments — `GET /payments`

Returns only `pending` payments, ordered by `expires_at` ascending.

**Query params:** `limit` (`1..100`, default `100`), `offset` (`≥ 0`, default `0`).

**Response `200 OK`**

```json
[
  {
    "id": "...",
    "amount": 25000,
    "status": "pending",
    "expires_at": 1782689000000,
    "created_at": 1782688700000,
    "expires_at_iso": "2026-06-29T06:23:20.000+07:00",
    "created_at_iso": "2026-06-29T06:18:20.000+07:00",
    "tz": "Asia/Jakarta"
  }
]
```

An empty list is `200 []` (never 404).

```bash
curl -s "http://YOUR_HOST:3000/payments?limit=50&offset=0" \
  -H "Authorization: Bearer $API_KEY"
```

---

### 3.4 QRIS image — `GET /payment/:id/qris.png`

Returns the payment's QRIS rendered as a PNG (`Content-Type: image/png`).
Served internally — no external upload.

This endpoint requires the server-side API key. Fetch it through a storefront backend route that checks ownership of the order and forwards `Authorization: Bearer <API_KEY>`, then display that route in the image element. Never put the API key in customer HTML or a URL. Alternatively, render `qris_string` with a QR library. AutoBeli already uses an authenticated image proxy.

**Errors:** `PAYMENT_NOT_FOUND`, `UNAUTHORIZED`.

---

## 4. Webhook

When a payment reaches a **terminal state** — `paid` or `expired` — the system
POSTs a signed notification to a webhook URL.

### 4.1 When and where

- **Trigger:** the payment transitions to `paid` (matched by amount within `tolerance`) **or** to `expired` (its lifetime elapsed before payment). The two are mutually exclusive, so a payment has one terminal event, which may be delivered more than once during retries.
- **Target URL selection:** the payment's own `webhook_url` → otherwise the Config default `webhook_url` → if neither exists, **nothing is sent** (and it is not treated as a failure).

### 4.2 Request

- **Method:** `POST`
- **Headers:**
  - `Content-Type: application/json`
  - `X-Signature: <hex>` — HMAC-SHA256 of the **raw request body** (see 4.4)
  - `X-Event: paid | expired` — the event type. This mirrors the signed `payment_status` body field below; prefer the **body** field for security-sensitive logic (the header is not covered by the signature).
- **Body:** always carries the base payment fields: `payment_id`, `payment_status` (`"paid"` | `"expired"`), `amount`, `created_at`, `created_at_iso`, and `tz`. 
  - For a `paid` event, it adds `paid_at` and `paid_at_iso`, and the **raw GoBiz transaction** is nested inside the `provider_transaction` object.
  - For an `expired` event, it adds `expires_at` and `expires_at_iso`.

**`paid` event:**

```json
{
  "payment_id": "4ad4f8df-a549-482d-8b73-2e25d74f2b28",
  "payment_status": "paid",
  "amount": 25000,
  "created_at": 1782688700000,
  "paid_at": 1782689000000,
  "created_at_iso": "2026-06-29T06:18:20.000+07:00",
  "paid_at_iso": "2026-06-29T06:23:20.000+07:00",
  "tz": "Asia/Jakarta",
  "provider_transaction": {
    "id": "019f1089-10b0-7000-81da-4b096275ca9b",
    "order_id": "QRIS-0120260628232046WY1VVrAgVQID",
    "wallstreet_transaction_id": "0120260628232046WY1VVrAgVQID",
    "transaction_status": "SETTLEMENT",
    "payment_type": "QRIS",
    "transaction_time": "2026-06-29T06:20:46+07:00",
    "settlement_time": "2026-06-29T06:20:46.904351+07:00",
    "gross_amount": 500000,
    "real_gross_amount": 500000,
    "currency": "IDR",
    "qris_provider_aspi_issuer": "GOPAY",
    "qris_provider_aspi_acquirer": "gopay",
    "shares": [ { "merchant_share": 498500, "platform_total_fee": 1500, "merchant_percentage_fee": 0.003 } ],
    "promo_details": { "promo_code": "", "promo_original_amount": 0 },
    "transaction_history": [ { "action_name": "Settlement Transaction", "amount": 500000, "action_status": "SETTLEMENT" } ]
  }
}
```

**`expired` event:**

```json
{
  "payment_id": "4ad4f8df-a549-482d-8b73-2e25d74f2b28",
  "payment_status": "expired",
  "amount": 25000,
  "created_at": 1782688700000,
  "expires_at": 1782689000000,
  "created_at_iso": "2026-06-29T06:18:20.000+07:00",
  "expires_at_iso": "2026-06-29T06:23:20.000+07:00",
  "tz": "Asia/Jakarta"
}
```

| Field            | Notes |
|------------------|-------|
| `payment_id`     | Our internal id (the value returned by `POST /payment`). **Stable across all retries** — use it for idempotency/reconciliation. |
| `payment_status` | `"paid"` or `"expired"`. **Signed** (part of the body), so trust this over the `X-Event` header. |
| `amount`         | The payment amount in **whole Rupiah**. |
| `created_at` / `expires_at` / `paid_at` | Epoch milliseconds (UTC), each with an offset-aware ISO sibling (`*_iso`) rendered in `tz`. |
| `tz`             | The IANA display timezone applied to the `*_iso` fields (per-payment `tz` → Config `display_timezone` → `Asia/Jakarta`). |
| `provider_transaction` (paid) | The raw provider transaction. Fields vary per transaction; guard for absent keys. |

- **`provider_transaction` money fields are in sen** (Rupiah × 100): divide by 100 (e.g. `gross_amount: 500000` → Rp 5.000). This differs from the REST API and the base webhook `amount`, which use whole Rupiah.
- **`provider_transaction` timestamps** (`transaction_time`, `settlement_time`) are ISO-8601 with the `+07:00` (WIB) offset; the base webhook fields carry both epoch milliseconds and offset-aware `*_iso` siblings.

### 4.3 Delivery semantics

- **Per-attempt timeout:** 10000 ms.
- **Success:** any **2xx** response. Respond fast (ideally `200`) and process asynchronously.
- **Retries:** up to **5 attempts total** (1 + 4 retries) on non-2xx / timeout / network error (applies to both `paid` and `expired`).
- **Backoff:** exponential, clamped to **1000–60000 ms** (≈ 1s, 2s, 4s, 8s).
- **Idempotency:** the same `payment_id` is sent on every retry. Treat a `payment_id`+`payment_status` you have already processed as a no-op (still return 2xx).
- **Permanent failure:** after 5 failures it stops and the delivery is marked `failed_permanent`.
- Every attempt (status, response code/body, error) is recorded and viewable in the panel (payment detail → **Webhook deliveries**), where you can also **Resend** (a single attempt).

### 4.4 Signature verification (IMPORTANT)

The signature is `HMAC-SHA256(rawBody, WEBHOOK_HMAC_KEY)` encoded as **lowercase hex**.

- Compute it over the **exact raw bytes** of the request body — do **not**
  re-serialize the parsed JSON (key order/spacing would differ and break the check).
- The key is the `WEBHOOK_HMAC_KEY` configured in the backend `.env`.
- Compare using a constant-time comparison.

### 4.5 Example handler — Node.js / Express

```js
import express from 'express';
import crypto from 'node:crypto';

const WEBHOOK_HMAC_KEY = process.env.WEBHOOK_HMAC_KEY;
const app = express();

// Capture the RAW body so the signature is verified over exact bytes.
app.use('/webhooks/gopay', express.raw({ type: '*/*' }));

app.post('/webhooks/gopay', (req, res) => {
  const raw = req.body; // Buffer
  const expected = crypto.createHmac('sha256', WEBHOOK_HMAC_KEY).update(raw).digest('hex');
  const got = String(req.get('X-Signature') || '');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(got, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'bad signature' });
  }

  const event = JSON.parse(raw.toString('utf8'));
  // Receiving this webhook means the payment was PAID. Use event.payment_id
  // (your internal id from the create response) to reconcile and fulfill.
  // Idempotency: ignore if this payment_id was already processed.
  // fulfill the order for event.payment_id ...

  // Return 2xx quickly; heavy work should be done asynchronously.
  return res.sendStatus(200);
});

app.listen(8080);
```

### 4.6 Example handler — PHP

```php
<?php
$key = getenv('WEBHOOK_HMAC_KEY');
$raw = file_get_contents('php://input');
$expected = hash_hmac('sha256', $raw, $key); // lowercase hex
$got = $_SERVER['HTTP_X_SIGNATURE'] ?? '';

if (!hash_equals($expected, $got)) {
    http_response_code(401);
    echo 'bad signature';
    exit;
}

$event = json_decode($raw, true);
// Receiving this webhook means the payment was PAID.
// Idempotency: skip if $event['payment_id'] already processed.
// fulfill order for $event['payment_id'] ...

http_response_code(200);
echo 'ok';
```

### 4.7 Example verification — Python

```python
import hmac, hashlib, os

def verify(raw_body: bytes, signature_hex: str) -> bool:
    key = os.environ["WEBHOOK_HMAC_KEY"].encode()
    expected = hmac.new(key, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_hex or "")
```

---

## 5. Typical integration flow

1. `POST /payment` with the amount (and optionally a `webhook_url`).
2. Show the customer `qris_string` (render a QR) or proxy `qris_url` through your authenticated storefront backend (PNG).
3. Wait for the **webhook** (`status: "paid"`) — verify the signature, then fulfill.
   - As a fallback / reconciliation, you may also poll `GET /payment/:id`.
4. Hide the QR after `timeout`; keep polling through `reconcile_until`. If no qualifying transfer is found, the payment expires after reconciliation (`status: "expired"`).

---

## 6. Notes & limits

- **Amount uniqueness** is enforced only among **pending** payments; once a
  payment is paid/expired its amount is free to reuse.
- **Server-managed** mode appends a suffix `0..999` (so the first payment for a
  base may equal the base itself, e.g. base `1000` → `1000`).
- `amount`/`base_amount` range: **1000..9999000** Rupiah.
- `timeout`: **10000..86400000** ms. `tolerance`: **0..999** Rupiah.
- Set the merchant **Static QRIS** and the default `webhook_url` in the panel **Config** page before going live.
- Set the default **display timezone** (`display_timezone`) in the panel **Config** page if your clients are not in WIB; per-payment `tz` overrides it. This only affects the `*_at_iso` display fields — stored timestamps stay absolute epoch milliseconds.

## Reliability and retry contract

- Send a stable `Idempotency-Key` header on `POST /payment` for each checkout attempt (1-200 printable ASCII characters without spaces). It is scoped to the authenticated API key. Concurrent requests and retries return the original payment when the creation parameters match. Changed parameters return `409 IDEMPOTENCY_CONFLICT`; recover the original attempt instead of allocating another payment. Keys remain effective while their payment records are retained.
- Creation and status responses include `reconcile_until` (epoch milliseconds). Stop displaying the QR at `expires_at`. The payment can remain `pending` until `reconcile_until`, currently 120 seconds later, to collect delayed reports of transfers made within the QR lifetime. Poll during this interval; do not allocate a replacement QR yet. Transfers timestamped before creation or after expiry cannot settle that payment.
- Only successful QRIS settlement/capture transactions can pay an order; refunds and other payment methods are ignored. Outages longer than the reconciliation interval and payments sent after QR expiry require manual investigation.
- Terminal-state webhook obligations are persisted atomically with the payment. A background worker recovers outstanding jobs after restarts, retries up to five delivery attempts with backoff, and reuses the original signed request. Delivery is at least once: receivers must deduplicate by payment ID and event. Historical terminal records created before this change are not automatically replayed.
- `503 PROVIDER_UNAVAILABLE` means the merchant QR is not ready. Retry the same checkout attempt after recovery. `409 AMOUNT_IN_USE` means a live reservation owns that amount; server-managed creation allocates a unique amount and the checkout must show the returned total.
