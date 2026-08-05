<script>
  import { money, rupiah, percent, text, formatTime, source, share, toJson } from './transaction-format.js';

  /**
   * @type {{ tx: any, timeZone?: string }}
   * `tx` is a canonical transaction row (with `.raw`) or a `{ raw }` wrapper —
   * the same shape used by the Transactions table and the payment's `tx_raw`.
   */
  let { tx, timeZone } = $props();

  const src = $derived(tx ? source(tx) : {});
  const settle = $derived(tx ? share(tx) : {});

  const orderRows = $derived([
    { label: 'Order ID', value: text(src.order_id) },
    { label: 'Transaction ID', value: text(src.id) },
    { label: 'Wallstreet ID', value: text(src.wallstreet_transaction_id) },
    { label: 'Merchant ID', value: text(src.merchant_id) },
    { label: 'Status', value: text(src.transaction_status) },
    { label: 'Payment type', value: text(src.payment_type) },
    { label: 'Service type', value: text(src.service_type) },
    { label: 'Channel', value: text(src.channel_type) },
    { label: 'Source', value: text(src.transaction_source) },
    { label: 'Currency', value: text(src.currency) },
    { label: 'Transaction time', value: formatTime(src.transaction_time, timeZone) },
    { label: 'Settlement time', value: formatTime(src.settlement_time, timeZone) }
  ]);

  const settlementRows = $derived([
    { label: 'Gross amount', value: money(src.gross_amount) },
    { label: 'Real gross amount', value: money(src.real_gross_amount) },
    { label: 'Net (merchant share)', value: money(settle.merchant_share), strong: true },
    { label: 'Platform fee', value: money(settle.platform_total_fee) },
    { label: 'Provider share', value: money(settle.provider_share) },
    { label: 'Gojek share', value: money(settle.gojek_share) },
    { label: 'Merchant fee rate', value: percent(settle.merchant_percentage_fee) },
    { label: 'Merchant fixed fee', value: money(settle.merchant_fixed_fee) },
    { label: 'Refund amount', value: money(settle.refund_amount) },
    { label: 'WHT', value: money(settle.wht) },
    { label: 'VAT', value: money(settle.vat) },
    { label: 'Voucher commission', value: money(settle.voucher_commission) },
    { label: 'Voucher amount', value: money(settle.voucher_amount) }
  ]);

  const customerName = $derived(
    [src.customer_first_name, src.customer_last_name].filter(Boolean).join(' ').trim()
  );
  const hasCustomer = $derived(Boolean(customerName || src.customer_email || src.customer_phone));
  const customerRows = $derived([
    { label: 'Name', value: text(customerName) },
    { label: 'Email', value: text(src.customer_email) },
    { label: 'Phone', value: text(src.customer_phone) }
  ]);

  const qrisRows = $derived([
    {
      label: 'On us',
      value: src.qris_on_us === true ? 'On us' : src.qris_on_us === false ? 'Off us' : '—'
    },
    { label: 'Issuer', value: text(src.qris_provider_aspi_issuer) },
    { label: 'Acquirer', value: text(src.qris_provider_aspi_acquirer) },
    { label: 'Retrieval ref (RRN)', value: text(src.qris_provider_retrieval_reference_number) },
    { label: 'Merchant cross reference', value: text(src.merchant_cross_reference_id) }
  ]);

  const promo = $derived(src.promo_details && typeof src.promo_details === 'object' ? src.promo_details : {});
  const externalPromos = $derived(Array.isArray(promo.external_promos) ? promo.external_promos : []);
  const hasPromo = $derived(Boolean(promo.promo_code || promo.promo_original_amount || externalPromos.length > 0));

  const history = $derived(Array.isArray(src.transaction_history) ? src.transaction_history : []);
</script>

<div class="space-y-6">
  <!-- Order / summary -->
  <div class="space-y-2">
    <h3 class="text-sm font-semibold text-slate-800">Order</h3>
    <dl class="grid grid-cols-2 gap-3 text-sm">
      {#each orderRows as row (row.label)}
        <div>
          <dt class="text-slate-500">{row.label}</dt>
          <dd class="break-all text-slate-900">{row.value}</dd>
        </div>
      {/each}
    </dl>
  </div>

  <!-- Settlement / fees -->
  <div class="space-y-2">
    <h3 class="text-sm font-semibold text-slate-800">Settlement &amp; fees</h3>
    <dl class="grid grid-cols-2 gap-3 text-sm">
      {#each settlementRows as row (row.label)}
        <div>
          <dt class="text-slate-500">{row.label}</dt>
          <dd class={`break-all ${row.strong ? 'font-semibold text-emerald-700' : 'text-slate-900'}`}>{row.value}</dd>
        </div>
      {/each}
    </dl>
  </div>

  <!-- Customer -->
  {#if hasCustomer}
    <div class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-800">Customer</h3>
      <dl class="grid grid-cols-2 gap-3 text-sm">
        {#each customerRows as row (row.label)}
          <div>
            <dt class="text-slate-500">{row.label}</dt>
            <dd class="break-all text-slate-900">{row.value}</dd>
          </div>
        {/each}
      </dl>
    </div>
  {/if}

  <!-- Promo -->
  {#if hasPromo}
    <div class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-800">Promo</h3>
      <dl class="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt class="text-slate-500">Promo code</dt>
          <dd class="break-all text-slate-900">{text(promo.promo_code)}</dd>
        </div>
        <div>
          <dt class="text-slate-500">Original amount</dt>
          <dd class="break-all text-slate-900">{money(promo.promo_original_amount)}</dd>
        </div>
      </dl>
      {#if externalPromos.length > 0}
        <ul class="space-y-1 text-sm">
          {#each externalPromos as ep, i (i)}
            <li class="rounded border border-slate-200 px-3 py-2">
              <span class="font-medium text-slate-800">{text(ep.type)}</span>
              · {money(ep.amount)}
              {#if ep.code}<span class="font-mono text-xs text-slate-500"> · {ep.code}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <!-- QRIS -->
  <div class="space-y-2">
    <h3 class="text-sm font-semibold text-slate-800">QRIS</h3>
    <dl class="grid grid-cols-2 gap-3 text-sm">
      {#each qrisRows as row (row.label)}
        <div>
          <dt class="text-slate-500">{row.label}</dt>
          <dd class="break-all text-slate-900">{row.value}</dd>
        </div>
      {/each}
    </dl>
  </div>

  <!-- Transaction history -->
  {#if history.length > 0}
    <div class="space-y-2">
      <h3 class="text-sm font-semibold text-slate-800">History</h3>
      <div class="overflow-x-auto rounded border border-slate-200">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-50 text-slate-600">
            <tr>
              <th class="px-2 py-2 font-medium">Time</th>
              <th class="px-2 py-2 font-medium">Action</th>
              <th class="px-2 py-2 font-medium">Amount</th>
              <th class="px-2 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            {#each history as h, i (h.id ?? i)}
              <tr>
                <td class="px-2 py-2 text-slate-700">{formatTime(h.action_time, timeZone)}</td>
                <td class="px-2 py-2 text-slate-700">{text(h.action_name)}</td>
                <td class="px-2 py-2 text-slate-900">{money(h.amount)}</td>
                <td class="px-2 py-2 text-slate-700">{text(h.action_status)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  <!-- Raw data -->
  <details class="space-y-1">
    <summary class="cursor-pointer text-sm font-semibold text-slate-800">Raw data</summary>
    <pre class="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-900 p-3 font-mono text-xs text-slate-100">{toJson(tx?.raw ?? tx)}</pre>
  </details>
</div>
