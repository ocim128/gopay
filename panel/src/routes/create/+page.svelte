<script>
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { paymentStatusBadgeClass } from '$lib/status.js';
  import { subscribePaymentEvents } from '$lib/realtime.js';
  import { QrCode, CirclePlus } from '@lucide/svelte';

  /** @type {{ data: any, form: { message?: string, created?: any, values?: Record<string, string> } | null }} */
  let { data, form } = $props();

  // Local mode state so the amount/base-amount fields toggle without a reload.
  // Seeded once (untracked) from the action's echoed values.
  let mode = $state(untrack(() => form?.values?.mode ?? 'client_managed'));
  let submitting = $state(false);

  // Format numbers with dot separators
  function formatRupiah(val) {
    const raw = String(val).replace(/\D/g, '');
    if (!raw) return '';
    return parseInt(raw, 10).toLocaleString('id-ID');
  }

  let amountStr = $state('');
  let baseAmountStr = $state('');
  let timeoutVal = $state(untrack(() => form?.values?.timeout ?? '300000'));
  let toleranceVal = $state(untrack(() => form?.values?.tolerance ?? '0'));
  
  const timeoutDisplay = $derived.by(() => {
    if (!timeoutVal) return null;
    const ms = parseInt(timeoutVal, 10);
    if (isNaN(ms)) return null;

    if (ms > 86400000) return '> 24 jam (Max)';
    
    let totalSeconds = Math.floor(ms / 1000);
    if (totalSeconds === 0) return '< 1 detik';

    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    const parts = [];
    if (hours > 0) parts.push(`${hours} jam`);
    if (minutes > 0) parts.push(`${minutes} menit`);
    if (seconds > 0) parts.push(`${seconds} detik`);

    return parts.join(' ');
  });

  $effect(() => {
    if (form?.values?.amount !== undefined) {
      amountStr = formatRupiah(form.values.amount);
    }
    if (form?.values?.base_amount !== undefined) {
      baseAmountStr = formatRupiah(form.values.base_amount);
    }
    if (form?.values?.timeout !== undefined) {
      timeoutVal = form.values.timeout;
    }
    if (form?.values?.tolerance !== undefined) {
      toleranceVal = form.values.tolerance;
    }
  });
  
  function onAmountInput(e) {
    const raw = e.target.value.replace(/\D/g, '');
    amountStr = raw ? parseInt(raw, 10).toLocaleString('id-ID') : '';
    e.target.value = amountStr;
  }
  function onBaseAmountInput(e) {
    const raw = e.target.value.replace(/\D/g, '');
    baseAmountStr = raw ? parseInt(raw, 10).toLocaleString('id-ID') : '';
    e.target.value = baseAmountStr;
  }

  const created = $derived(form?.created ?? null);

  // Live status of the just-created payment so the result card is never stuck
  // on "pending". Seeded from the create response, then kept current via a
  // realtime signal (instant) plus a short poll fallback (robust). Both update
  // the same `live` object.
  let live = $state(/** @type {{ status: string, paid_amount: number|null, paid_at: number|null }|null} */ (null));

  const displayStatus = $derived(live?.status ?? created?.status ?? null);

  $effect(() => {
    const current = created;
    if (!current || typeof current.id !== 'string') {
      live = null;
      return;
    }

    // Seed from the create response.
    live = { status: current.status, paid_amount: null, paid_at: null };

    let stopped = false;

    /** Re-fetch this payment's status from the session-guarded proxy. */
    async function sync() {
      try {
        const res = await fetch(`/api/payments/${encodeURIComponent(current.id)}`);
        if (res.ok) {
          const payment = await res.json();
          live = {
            status: payment.status,
            paid_amount: payment.paid_amount ?? null,
            paid_at: payment.paid_at ?? null
          };
        }
      } catch {
        // Keep the last known status on a transient error.
      }
    }

    const isTerminal = () => live?.status === 'paid' || live?.status === 'expired';

    // Poll fallback every 3s until the payment reaches a terminal state.
    const timer = setInterval(() => {
      if (stopped || isTerminal()) {
        return;
      }
      sync();
    }, 3000);

    // Realtime nudge: sync immediately when this payment changes.
    const unsubscribe = subscribePaymentEvents((event) => {
      if (event && event.payment_id === current.id) {
        sync();
      }
    });

    return () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
    };
  });

  /**
   * Format a millisecond epoch timestamp for display.
   * @param {number} value
   * @returns {string}
   */
  function formatTimestamp(value) {
    if (typeof value !== 'number') {
      return '—';
    }
    const tz = data.summary?.display_timezone;
    return new Date(value).toLocaleString('id-ID', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      ...(tz ? { timeZone: tz } : {})
    });
  }
</script>

<svelte:head>
  <title>GoMerch | Create Payment</title>
</svelte:head>

<section class="space-y-6">

  {#if form?.message}
    <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      {form.message}
    </div>
  {/if}

  <div class="grid gap-6 lg:grid-cols-2">
    <form
      method="POST"
      class="gp-card"
      aria-label="Payment creation form"
      use:enhance={() => {
        submitting = true;
        return async ({ update }) => {
          await update();
          submitting = false;
        };
      }}
    >
      <div class="flex items-center gap-4 border-b border-slate-100 p-5">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-600 ring-1 ring-inset ring-brand-200/60 shadow-sm">
          <CirclePlus class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-base font-bold text-slate-900 tracking-tight">Create Payment</h3>
          <p class="mt-0.5 text-xs font-medium text-slate-500">Generate a new dynamic QRIS</p>
        </div>
      </div>
      <div class="space-y-5 p-5">
        <fieldset class="space-y-3">
          <legend class="gp-label mb-1">Amount Mode <span class="text-red-500">*</span></legend>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition {mode === 'client_managed'
            ? 'border-brand-300 bg-brand-50/60'
            : 'border-slate-200 hover:bg-slate-50'}"
        >
          <input type="radio" name="mode" value="client_managed" class="mt-1 accent-brand-600 focus:ring-0 focus:ring-offset-0" bind:group={mode} />
          <span>
            <span class="font-semibold text-slate-900">Client-managed</span>
            <span class="block text-slate-500">You provide the full amount, including your own unique code.</span>
          </span>
        </label>
        <label
          class="flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition {mode === 'server_managed'
            ? 'border-brand-300 bg-brand-50/60'
            : 'border-slate-200 hover:bg-slate-50'}"
        >
          <input type="radio" name="mode" value="server_managed" class="mt-1 accent-brand-600 focus:ring-0 focus:ring-offset-0" bind:group={mode} />
          <span>
            <span class="font-semibold text-slate-900">Server-managed</span>
            <span class="block text-slate-500">Provide a base amount; the system appends a unique suffix.</span>
          </span>
        </label>
      </fieldset>

      {#if mode === 'client_managed'}
        <div class="space-y-1">
          <label for="amount_display" class="gp-label">Amount <span class="text-red-500">*</span></label>
          <div class="group flex overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition focus-within:border-brand-400">
            <div class="flex w-14 items-center justify-center border-r border-slate-200 bg-slate-50 transition group-focus-within:border-brand-400">
              <span class="text-sm font-semibold text-slate-500">Rp</span>
            </div>
            <input type="hidden" name="amount" value={amountStr.replace(/\D/g, '')} />
            <input
              id="amount_display"
              type="text"
              required
              inputmode="numeric"
              value={amountStr}
              oninput={onAmountInput}
              class="w-full border-0 bg-transparent px-3.5 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-0"
              placeholder="50.000"
            />
          </div>
          <p class="text-[11px] text-slate-500">Min: 1.000 &bull; Max: 9.999.000</p>
        </div>
      {:else}
        <div class="space-y-1">
          <label for="base_amount_display" class="gp-label">Base Amount <span class="text-red-500">*</span></label>
          <div class="group flex overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition focus-within:border-brand-400">
            <div class="flex w-14 items-center justify-center border-r border-slate-200 bg-slate-50 transition group-focus-within:border-brand-400">
              <span class="text-sm font-semibold text-slate-500">Rp</span>
            </div>
            <input type="hidden" name="base_amount" value={baseAmountStr.replace(/\D/g, '')} />
            <input
              id="base_amount_display"
              type="text"
              required
              inputmode="numeric"
              value={baseAmountStr}
              oninput={onBaseAmountInput}
              class="w-full border-0 bg-transparent px-3.5 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-0"
              placeholder="50.000"
            />
          </div>
          <p class="text-[11px] text-slate-500">Min: 1.000 &bull; Max: 9.999.000</p>
        </div>
      {/if}

      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1">
          <div class="flex items-center justify-between">
            <label for="timeout" class="gp-label">Timeout</label>
            {#if timeoutDisplay}
              <span class="inline-flex max-w-[200px] items-center rounded-md bg-brand-50 px-2 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-inset ring-brand-600/20">
                <span class="truncate">≈ {timeoutDisplay}</span>
              </span>
            {/if}
          </div>
          <div class="group flex overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition focus-within:border-brand-400">
            <input
              id="timeout"
              name="timeout"
              type="number"
              step="1"
              min="10000"
              max="86400000"
              inputmode="numeric"
              bind:value={timeoutVal}
              class="w-full border-0 bg-transparent px-3.5 py-2.5 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-0"
              placeholder="300000"
            />
            <div class="flex w-14 items-center justify-center border-l border-slate-200 bg-slate-50 transition group-focus-within:border-brand-400">
              <span class="text-sm font-semibold text-slate-500">ms</span>
            </div>
          </div>
          <p class="text-[11px] text-slate-500">Min: 10000 &bull; Max: 86400000</p>
        </div>
        <div class="space-y-1">
          <label for="tolerance" class="gp-label">Tolerance</label>
          <input
            id="tolerance"
            name="tolerance"
            type="number"
            step="1"
            min="0"
            max="999"
            inputmode="numeric"
            bind:value={toleranceVal}
            class="gp-input"
            placeholder="0"
          />
          <p class="text-[11px] text-slate-500">Min: 0 &bull; Max: 999</p>
        </div>
      </div>

      <div class="space-y-1">
        <label for="webhook_url" class="gp-label">Webhook URL</label>
        <input
          id="webhook_url"
          name="webhook_url"
          type="url"
          value={form?.values?.webhook_url ?? ''}
          class="gp-input"
          placeholder="https://example.com/webhook"
        />
      </div>

        <button type="submit" disabled={submitting} class="gp-btn-primary w-full sm:w-auto">
          {submitting ? 'Creating…' : 'Create Payment'}
        </button>
      </div>
    </form>

    <div class="gp-card">
      <div class="flex items-center gap-4 border-b border-slate-100 p-5">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-600 ring-1 ring-inset ring-emerald-200/60 shadow-sm">
          <QrCode class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-base font-bold text-slate-900 tracking-tight">Result</h3>
          <p class="mt-0.5 text-xs font-medium text-slate-500">QRIS payment details</p>
        </div>
      </div>
      <div class="p-5">
        {#if created}
          <div class="space-y-4 text-sm">
          <div class="flex flex-col items-center gap-3 rounded-2xl bg-slate-50 p-4">
            <img
              src={`/qris/${encodeURIComponent(created.id)}`}
              alt="QRIS code for this payment"
              class="h-48 w-48 max-w-full rounded-xl border border-slate-200 bg-white p-2"
            />
            <span class="gp-status {paymentStatusBadgeClass(displayStatus)}">{displayStatus}</span>
          </div>
          <dl class="space-y-3">
            <div>
              <dt class="gp-hint">Payment ID</dt>
              <dd class="break-all font-mono text-slate-900">{created.id}</dd>
            </div>
            <div>
              <dt class="gp-hint">Amount</dt>
              <dd class="text-lg font-bold text-slate-900">Rp {Number(created.amount).toLocaleString('id-ID')}</dd>
            </div>
            <div>
              <dt class="gp-hint">Expires at</dt>
              <dd class="text-slate-900">{formatTimestamp(created.expires_at)}</dd>
            </div>
            {#if live?.status === 'paid'}
              <div class="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <p class="text-sm font-semibold text-emerald-800">Payment received</p>
                <dl class="mt-1 space-y-1 text-sm text-emerald-900">
                  <div class="flex justify-between gap-3">
                    <dt class="text-emerald-700">Paid amount</dt>
                    <dd class="font-semibold">Rp {Number(live.paid_amount ?? created.amount).toLocaleString('id-ID')}</dd>
                  </div>
                  <div class="flex justify-between gap-3">
                    <dt class="text-emerald-700">Paid at</dt>
                    <dd>{formatTimestamp(live.paid_at)}</dd>
                  </div>
                </dl>
              </div>
            {/if}
            <div>
              <dt class="gp-hint">QRIS string</dt>
              <dd class="break-all rounded-lg bg-slate-50 p-2 font-mono text-xs text-slate-700">{created.qris_string}</dd>
            </div>
          </dl>
        </div>
      {:else}
        <div class="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-12 text-center">
          <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
            <QrCode class="h-6 w-6" strokeWidth={1.6} />
          </span>
          <p class="mt-3 text-sm text-slate-500">
            Submit the form to create a payment.<br />The QRIS code will appear here.
          </p>
        </div>
        {/if}
      </div>
    </div>
  </div>
</section>
