<script>
  // API documentation page. Code/JSON samples are kept as plain strings and
  // rendered inside <pre> so Svelte does not try to parse the braces.
  import { onMount } from 'svelte';

  // Base URL shown in the docs and code samples. Defaults to a placeholder for
  // SSR, then auto-detects from the browser on mount: the panel runs on :3001
  // by convention and the REST API on :3000, so we map the panel port to the
  // API port; otherwise we assume the API shares this origin (e.g. behind a
  // reverse proxy).
  let baseUrl = $state('http://YOUR_HOST:3000');
  let activeSection = $state('flow');

  function scrollToSection(e, id) {
    e.preventDefault();
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
      activeSection = id;
    }
  }

  onMount(() => {
    const { protocol, hostname, port } = window.location;
    const apiPort = port === '3001' ? '3000' : port;
    baseUrl = apiPort ? `${protocol}//${hostname}:${apiPort}` : `${protocol}//${hostname}`;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.find(entry => entry.isIntersecting);
      if (visible) {
        activeSection = visible.target.id;
      }
    }, { rootMargin: '-100px 0px -40% 0px' });

    sections.forEach(s => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  });

  const authHeaders = `Authorization: Bearer <API_KEY>      # preferred
X-API-Key: <API_KEY>                 # alternative`;

  const errorJson = `{
  "error_code": "INVALID_AMOUNT",
  "message": "The amount is invalid. It must be an integer between 1000 and 9999000."
}`;

  const createCurlClient = $derived(`curl -s -X POST ${baseUrl}/payment \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "mode": "client_managed",
        "amount": 25000,
        "timeout": 600000,
        "tolerance": 0,
        "webhook_url": "https://merchant.example/webhooks/gopay",
        "tz": "Asia/Jakarta"
      }'`);

  const createCurlServer = $derived(`curl -s -X POST ${baseUrl}/payment \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "mode": "server_managed", "base_amount": 10000 }'
# -> { "amount": 10007, ... }  (base 10000 + suffix 7)`);

  const create201 = `{
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
}`;

  const get200pending = `{
  "id": "4ad4f8df-...",
  "amount": 25000,
  "status": "pending",
  "expires_at": 1782689000000,
  "created_at": 1782688700000,
  "expires_at_iso": "2026-06-29T06:23:20.000+07:00",
  "created_at_iso": "2026-06-29T06:18:20.000+07:00",
  "tz": "Asia/Jakarta"
}`;

  const get200paid = `{
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
}`;

  const listJson = `[
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
]`;

  const imgTag = `<img src="/your-store/order/ORDER_ID/qris" alt="QRIS" />`;

  const webhookJson = `{
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
}`;

  const webhookExpiredJson = `{
  "payment_id": "4ad4f8df-a549-482d-8b73-2e25d74f2b28",
  "payment_status": "expired",
  "amount": 25000,
  "created_at": 1782688700000,
  "expires_at": 1782689000000,
  "created_at_iso": "2026-06-29T06:18:20.000+07:00",
  "expires_at_iso": "2026-06-29T06:23:20.000+07:00",
  "tz": "Asia/Jakarta"
}`;

  const nodeHandler = `import express from 'express';
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
  // event.payment_status is "paid" or "expired" (signed). Use event.payment_id
  // (your internal id from the create response) to look up and fulfill the order.
  // Idempotency: ignore if this payment_id+status was already processed.

  return res.sendStatus(200); // return 2xx quickly
});

app.listen(8080);`;

  const phpHandler = `<?php
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
// $event['payment_status'] is "paid" or "expired".
// Idempotency: skip if $event['payment_id'] already processed.
http_response_code(200);
echo 'ok';`;

  const pyVerify = `import hmac, hashlib, os

def verify(raw_body: bytes, signature_hex: str) -> bool:
    key = os.environ["WEBHOOK_HMAC_KEY"].encode()
    expected = hmac.new(key, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_hex or "")`;

  const errorRows = [
    ['INVALID_REQUEST', 400, 'Body malformed, or timeout/tolerance out of range.'],
    ['INVALID_AMOUNT', 400, 'Client-managed amount missing / not an integer / outside 1000..9999000.'],
    ['INVALID_BASE_AMOUNT', 400, 'Server-managed base_amount missing / not a positive integer (≥ 1).'],
    ['INVALID_WEBHOOK_URL', 400, 'webhook_url is not an absolute http/https URL, or exceeds 2048 chars.'],
    ['UNAUTHORIZED', 401, 'Missing / invalid / revoked API key.'],
    ['PAYMENT_NOT_FOUND', 404, 'No payment with that id.'],
    ['AMOUNT_IN_USE', 409, 'Client-managed amount already used by another pending payment.'],
    ['NO_AVAILABLE_AMOUNT', 409, 'Server-managed: all 1000 suffix slots for the base amount are taken.'],
    ['QRIS_INVALID', 500, 'The configured Static QRIS is missing or invalid (set it in Config).']
  ];

  const bodyRows = [
    ['mode', 'string', 'no', 'client_managed or server_managed. If omitted, inferred from which amount field is present.'],
    ['amount', 'integer', 'client-managed', 'Full amount in Rupiah, 1000..9999000. Unique among pending payments.'],
    ['base_amount', 'integer', 'server-managed', 'Base amount in Rupiah, 1000..9999000. System appends a unique suffix 0..999.'],
    ['timeout', 'integer', 'no', 'Lifetime in ms, 10000..86400000. Default 300000 (5 min).'],
    ['tolerance', 'integer', 'no', 'Amount-match tolerance in Rupiah, 0..999. Default 0.'],
    ['webhook_url', 'string', 'no', 'Absolute http/https URL ≤ 2048 chars. Overrides the Config default for this payment.'],
    ['tz', 'string', 'no', 'IANA timezone for this payment\u2019s *_at_iso fields (e.g. Asia/Jakarta, Asia/Makassar, UTC). Defaults to the Config display_timezone; an unknown zone returns INVALID_REQUEST.']
  ];

  const sections = [
    { id: 'flow', label: 'Integration Flow', num: '01' },
    { id: 'auth', label: 'Authentication', num: '02' },
    { id: 'errors', label: 'Errors', num: '03' },
    { id: 'create', label: 'Create Payment', num: '04' },
    { id: 'get', label: 'Get Payment', num: '05' },
    { id: 'list', label: 'List Payments', num: '06' },
    { id: 'image', label: 'QRIS Image', num: '07' },
    { id: 'webhook', label: 'Webhook', num: '08' }
  ];

  const quickFacts = $derived([
    { label: 'Base URL', value: baseUrl, mono: true },
    { label: 'Content type', value: 'application/json', mono: true }
  ]);

  /**
   * Tailwind classes for an HTTP method pill.
   * @param {string} method
   * @returns {string}
   */
  function methodClass(method) {
    if (method === 'POST') return 'bg-emerald-100 text-emerald-700';
    if (method === 'GET') return 'bg-brand-100 text-brand-700';
    return 'bg-slate-100 text-slate-700';
  }
</script>

<svelte:head>
  <title>GoMerch | API Docs</title>
</svelte:head>

<div class="space-y-8">
  <!-- Hero -->
  <div class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-400 via-brand-500 to-brand-700 px-6 py-8 text-white shadow-brand sm:px-8">
    <div class="relative z-10">
      <span class="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold tracking-wide backdrop-blur">
        REST API
      </span>
      <h1 class="mt-3 text-2xl font-extrabold sm:text-3xl">API Documentation</h1>
      <p class="mt-2 max-w-2xl text-sm text-white/80">
        Technical reference for the QRIS payment REST API: endpoints, request and
        response schemas, error codes, and the signed webhook contract. All calls
        are JSON over HTTP, authenticated with an API key; amounts are integer
        Rupiah and timestamps are returned as both epoch milliseconds and
        offset-aware ISO-8601.
      </p>
      <div class="mt-6 grid gap-3 sm:grid-cols-2">
        {#each quickFacts as fact (fact.label)}
          <div class="rounded-2xl bg-white/10 p-3 ring-1 ring-white/15 backdrop-blur">
            <div class="text-[11px] uppercase tracking-wide text-white/60">{fact.label}</div>
            {#if fact.mono}
              <code class="mt-0.5 block text-sm font-semibold text-white">{fact.value}</code>
            {:else}
              <span class="mt-0.5 block text-sm font-semibold text-white">{fact.value}</span>
            {/if}
          </div>
        {/each}
      </div>
    </div>
    <div class="pointer-events-none absolute -right-20 -top-20 h-64 w-64 rounded-full bg-white/10 blur-2xl"></div>
    <div class="pointer-events-none absolute -bottom-24 right-32 h-56 w-56 rounded-full bg-white/10 blur-2xl"></div>
  </div>

  <div class="lg:grid lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-8">
    <!-- Table of contents -->
    <aside class="mb-6 lg:mb-0">
      <nav class="gp-card p-2 lg:sticky lg:top-24">
        <p class="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">On this page</p>
        {#each sections as s (s.id)}
          <a
            href={`#${s.id}`}
            onclick={(e) => scrollToSection(e, s.id)}
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition {activeSection === s.id ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-brand-50 hover:text-brand-700'}"
          >
            <span class="font-mono text-xs pt-[2px] {activeSection === s.id ? 'text-brand-600' : 'text-slate-400'}">{s.num}</span>
            <span>{s.label}</span>
          </a>
        {/each}
      </nav>
    </aside>

    <!-- Sections -->
    <div class="min-w-0 space-y-6">
      <!-- Flow -->
      <article id="flow" class="gp-card gp-card-pad scroll-mt-24 space-y-3">
        <h2 class="text-lg font-bold text-slate-900">1. Integration Flow</h2>
        <ol class="space-y-2 text-sm text-slate-600">
          <li class="flex gap-3"><span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">1</span><span><span class="badge-method-post">POST</span> <code class="badge-route">/payment</code> with the amount (and optionally a <code class="badge-param">webhook_url</code>).</span></li>
          <li class="flex gap-3"><span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">2</span><span>Show the customer <code class="badge-param">qris_string</code> (render a QR) or <code class="badge-param">qris_url</code> (PNG).</span></li>
          <li class="flex gap-3"><span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">3</span><span>Wait for the webhook (<code class="badge-param">payment_status</code>: <code class="badge-value">"paid"</code>) — verify the signature, then fulfill. Optionally reconcile via <span class="badge-method-get">GET</span> <code class="badge-route">/payment/:id</code>.</span></li>
          <li class="flex gap-3"><span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">4</span><span>Hide the QR after <code class="badge-param">timeout</code> and keep checking until <code class="badge-param">reconcile_until</code>, 120 seconds later (<code class="badge-param">payment_status</code>: <code class="badge-value">"expired"</code>).</span></li>
        </ol>
        <p class="rounded-xl bg-slate-50 p-3 text-xs text-slate-500">
          Amount uniqueness is enforced only among pending payments. Ranges: amount 1000..9999000; timeout 10000..86400000 ms; tolerance 0..999.
        </p>
      </article>

      <!-- Auth -->
      <article id="auth" class="gp-card gp-card-pad scroll-mt-24 space-y-3">
        <h2 class="text-lg font-bold text-slate-900">2. Authentication</h2>
        <p class="text-sm text-slate-600">
          Every <code class="badge-route">/payment*</code> endpoint requires an API key. Create one on the
          <a class="font-medium text-brand-600 hover:underline" href="/api-keys">API Keys</a> page (the full value is shown once). Send it in either header:
        </p>
        <pre class="code">{authHeaders}</pre>
        <ul class="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>If both headers are present, <code class="badge-header">Authorization: Bearer</code> wins and <code class="badge-header">X-API-Key</code> is ignored.</li>
          <li>Empty/whitespace key, wrong scheme, unknown, or revoked key → <code class="badge-error">401 UNAUTHORIZED</code>.</li>
        </ul>
      </article>

      <!-- Errors -->
      <article id="errors" class="gp-card gp-card-pad scroll-mt-24 space-y-3">
        <h2 class="text-lg font-bold text-slate-900">3. Errors</h2>
        <p class="text-sm text-slate-600">All errors share one shape:</p>
        <pre class="code">{errorJson}</pre>
        <div class="overflow-x-auto rounded-xl border border-slate-100">
          <table class="w-full min-w-[40rem] text-left text-sm">
            <thead class="bg-slate-50 text-slate-600">
              <tr><th class="px-3 py-2 font-medium">error_code</th><th class="px-3 py-2 font-medium">HTTP</th><th class="px-3 py-2 font-medium">Meaning</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              {#each errorRows as row (row[0])}
                <tr>
                  <td class="whitespace-nowrap px-3 py-2"><code class="badge-error">{row[0]}</code></td>
                  <td class="px-3 py-2 text-slate-700">{row[1]}</td>
                  <td class="px-3 py-2 text-slate-600">{row[2]}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </article>

      <!-- Create -->
      <article id="create" class="gp-card gp-card-pad scroll-mt-24 space-y-3">

        <h2 class="text-lg font-bold text-slate-900">4. Create Payment — <span class="badge-method-post">POST</span> <code class="badge-route">/payment</code></h2>
        <p class="text-sm text-slate-600">Creates a <code class="badge-value">pending</code> payment and returns a dynamic QRIS immediately (non-blocking).</p>
        <h3 class="text-sm font-semibold text-slate-800">Request body</h3>
        <div class="overflow-x-auto rounded-xl border border-slate-100">
          <table class="w-full min-w-[44rem] text-left text-sm">
            <thead class="bg-slate-50 text-slate-600">
              <tr><th class="px-3 py-2 font-medium">Field</th><th class="px-3 py-2 font-medium">Type</th><th class="px-3 py-2 font-medium">Required</th><th class="px-3 py-2 font-medium">Notes</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              {#each bodyRows as row (row[0])}
                <tr>
                  <td class="whitespace-nowrap px-3 py-2"><code class="badge-param">{row[0]}</code></td>
                  <td class="px-3 py-2 text-slate-700">{row[1]}</td>
                  <td class="px-3 py-2 text-slate-700">{row[2]}</td>
                  <td class="px-3 py-2 text-slate-600">{row[3]}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="text-xs text-slate-500">A <code class="badge-param">poll_interval</code> field in the body is ignored (server-level setting).</p>

        <h3 class="text-sm font-semibold text-slate-800">Response 201</h3>
        <pre class="code">{create201}</pre>
        <p class="text-sm text-slate-600">In server-managed mode, <code class="badge-param">amount</code> is the final <code class="badge-param">base_amount + suffix</code>.</p>
        <div class="rounded-xl border border-brand-100 bg-brand-50/60 p-3 text-sm text-slate-600">
          <strong class="text-slate-800">Timestamps:</strong> every <code class="badge-param">*_at</code> field is epoch milliseconds (UTC) — one absolute instant.
          Each has an <code class="badge-param">*_at_iso</code> sibling rendered in the resolved display timezone (returned as <code class="badge-param">tz</code>):
          <code class="badge-value">+07:00</code> (WIB), <code class="badge-value">+08:00</code> (WITA), <code class="badge-value">+09:00</code> (WIT), or <code class="badge-value">+00:00</code> (UTC).
          Set a per-payment <code class="badge-param">tz</code> or the Config default — the stored instant never changes.
        </div>

        <h3 class="text-sm font-semibold text-slate-800">Example — client-managed</h3>
        <pre class="code">{createCurlClient}</pre>
        <h3 class="text-sm font-semibold text-slate-800">Example — server-managed</h3>
        <pre class="code">{createCurlServer}</pre>
      </article>

      <!-- Get -->
      <article id="get" class="gp-card gp-card-pad scroll-mt-24 space-y-3">

        <h2 class="text-lg font-bold text-slate-900">5. Get Payment — <span class="badge-method-get">GET</span> <code class="badge-route">/payment/:id</code></h2>
        <p class="text-sm text-slate-600">Status is one of <code class="badge-value">pending</code> | <code class="badge-value">paid</code> | <code class="badge-value">expired</code>. Expiry is lazy.</p>
        <pre class="code">{get200pending}</pre>
        <p class="text-sm text-slate-600">When <code class="badge-value">paid</code>, settlement details are added:</p>
        <pre class="code">{get200paid}</pre>
      </article>

      <!-- List -->
      <article id="list" class="gp-card gp-card-pad scroll-mt-24 space-y-3">

        <h2 class="text-lg font-bold text-slate-900">6. List Active Payments — <span class="badge-method-get">GET</span> <code class="badge-route">/payments</code></h2>
        <p class="text-sm text-slate-600">Only <code class="badge-value">pending</code> payments, ordered by <code class="badge-param">expires_at</code> ascending. Query: <code class="badge-param">limit</code> (1..100, default 100), <code class="badge-param">offset</code> (≥ 0). Empty list is <code class="badge-value">200 []</code>.</p>
        <pre class="code">{listJson}</pre>
      </article>

      <!-- Image -->
      <article id="image" class="gp-card gp-card-pad scroll-mt-24 space-y-3">

        <h2 class="text-lg font-bold text-slate-900">7. QRIS Image — <span class="badge-method-get">GET</span> <code class="badge-route">/payment/:id/qris.png</code></h2>
        <p class="text-sm text-slate-600">Returns the QRIS rendered as a PNG (<code class="badge-value">image/png</code>).</p>
        <p class="text-sm text-slate-600">Fetch the gateway image from your storefront backend with its bearer API key after checking order ownership. Display that proxy URL below. Keep the API key on the server, or render the returned qris_string directly.</p>
        <pre class="code">{imgTag}</pre>
      </article>

      <!-- Webhook -->
      <article id="webhook" class="gp-card gp-card-pad scroll-mt-24 space-y-3">
        <h2 class="text-lg font-bold text-slate-900">8. Webhook</h2>
        <p class="text-sm text-slate-600">
          When a payment reaches a terminal state — <code class="badge-value">paid</code> or <code class="badge-value">expired</code> — the system POSTs a signed notification.
          Target URL: the payment's own <code class="badge-param">webhook_url</code> → otherwise the Config default → if neither exists, nothing is sent (not a failure).
          A payment fires at most one terminal webhook.
        </p>

        <h3 class="text-sm font-semibold text-slate-800">Request headers</h3>
        <ul class="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li><code class="badge-header">Content-Type: application/json</code></li>
          <li><code class="badge-header">X-Signature: &lt;hex&gt;</code> — HMAC-SHA256 of the raw body</li>
          <li><code class="badge-header">X-Event: paid | expired</code> — the event type. Mirrors the signed <code class="badge-param">payment_status</code> body field; prefer the body field for trust (the header is not signed).</li>
        </ul>

        <h3 class="text-sm font-semibold text-slate-800">Body</h3>
        <p class="text-sm text-slate-600">
          Always carries the base payment fields: <code class="badge-param">payment_id</code>, <code class="badge-param">payment_status</code> (<code class="badge-value">paid</code> | <code class="badge-value">expired</code>), <code class="badge-param">amount</code>, <code class="badge-param">created_at</code>, <code class="badge-param">created_at_iso</code>, and <code class="badge-param">tz</code>.
          A <code class="badge-value">paid</code> event adds <code class="badge-param">paid_at</code> and <code class="badge-param">paid_at_iso</code>, and nests the <strong>raw GoBiz transaction</strong> inside a <code class="badge-param">provider_transaction</code> object.
          An <code class="badge-value">expired</code> event adds <code class="badge-param">expires_at</code> and <code class="badge-param">expires_at_iso</code>.
        </p>
        <div class="flex items-center gap-2">
          <span class="gp-status bg-emerald-100 text-emerald-700">paid</span>
          <span class="text-xs text-slate-400">event</span>
        </div>
        <pre class="code">{webhookJson}</pre>
        <div class="flex items-center gap-2">
          <span class="gp-status bg-red-100 text-red-700">expired</span>
          <span class="text-xs text-slate-400">event</span>
        </div>
        <pre class="code">{webhookExpiredJson}</pre>
        <ul class="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li><code class="badge-param">payment_id</code> is the id returned by <span class="badge-method-post">POST</span> <code class="badge-route">/payment</code> — your reconciliation key, stable across all retries (idempotency).</li>
          <li><code class="badge-param">payment_status</code> is signed (part of the body); trust it over the <code class="badge-header">X-Event</code> header.</li>
          <li><code class="badge-param">amount</code> is the payment amount in <strong>whole Rupiah</strong>.</li>
          <li><code class="badge-param">created_at</code> / <code class="badge-param">expires_at</code> / <code class="badge-param">paid_at</code> are epoch milliseconds (UTC), each with an offset-aware <code class="badge-param">*_iso</code> sibling rendered in <code class="badge-param">tz</code>.</li>
          <li>For <code class="badge-value">paid</code>, <code class="badge-param">provider_transaction</code> contains the raw provider transaction (fields may vary; guard for absent keys).</li>
          <li><strong>provider_transaction money fields are in sen</strong> (Rupiah × 100): divide by 100, e.g. <code class="badge-param">gross_amount</code>: 500000 → Rp 5.000. The REST API and base webhook fields use whole Rupiah.</li>
          <li><strong>provider_transaction timestamps</strong> (<code class="badge-param">transaction_time</code>, <code class="badge-param">settlement_time</code>) are ISO-8601 <code class="badge-value">+07:00</code> (WIB); base webhook fields carry epoch milliseconds plus offset-aware <code class="badge-param">*_iso</code> siblings.</li>
        </ul>

        <h3 class="text-sm font-semibold text-slate-800">Delivery semantics</h3>
        <ul class="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>Per-attempt timeout: <strong>10000 ms</strong>. Success = any <strong>2xx</strong> response.</li>
          <li>Retries: up to <strong>5 attempts</strong> (1 + 4) on non-2xx / timeout / error.</li>
          <li>Backoff: exponential, clamped to <strong>1000–60000 ms</strong> (≈ 1s, 2s, 4s, 8s).</li>
          <li>Idempotency: same <code class="badge-param">payment_id</code> on every retry — treat duplicates as no-ops (still return 2xx).</li>
          <li>After 5 failures it stops and is marked <code class="badge-value">failed_permanent</code>. Every attempt is logged; you can <strong>Resend</strong> from the payment detail in <a class="font-medium text-brand-600 hover:underline" href="/payments">Payments</a>.</li>
        </ul>

        <h3 class="text-sm font-semibold text-slate-800">Signature verification</h3>
        <p class="text-sm text-slate-600">
          <code class="badge-header">X-Signature</code> = HMAC_SHA256(rawBody, <code class="badge-param">WEBHOOK_HMAC_KEY</code>) as lowercase hex.
          Compute over the <strong>exact raw bytes</strong> (do not re-serialize parsed JSON), and compare in constant time.
        </p>

        <h3 class="text-sm font-semibold text-slate-800">Handler — Node.js / Express</h3>
        <pre class="code">{nodeHandler}</pre>
        <h3 class="text-sm font-semibold text-slate-800">Handler — PHP</h3>
        <pre class="code">{phpHandler}</pre>
        <h3 class="text-sm font-semibold text-slate-800">Verify — Python</h3>
        <pre class="code">{pyVerify}</pre>
      </article>
    </div>
  </div>
</div>

<style>
  /* Premium dark code block. */
  .code {
    overflow-x: auto;
    white-space: pre;
    border-radius: 0.875rem;
    background-color: #0b1220;
    background-image: linear-gradient(180deg, rgba(28, 149, 236, 0.12), transparent 60px);
    padding: 1rem 1.1rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.75rem;
    line-height: 1.25rem;
    color: #e2e8f0;
    box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.14);
  }

  /* Inline code chips inside prose (not the <pre class="code"> blocks). */
  :global(.gp-card) code:not([class*="badge-"]) {
    border-radius: 0.375rem;
    background-color: #eef8ff;
    padding: 0.1rem 0.4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 0.78em;
    font-weight: 600;
    color: #0a60aa;
    overflow-wrap: anywhere;
  }

  /* But code inside the dark block must stay plain (no chip styling). */
  .code,
  :global(.gp-card) pre.code {
    color: #e2e8f0;
  }
</style>
