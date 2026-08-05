<script>
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import TransactionDetail from '$lib/TransactionDetail.svelte';
  import Modal from '$lib/Modal.svelte';
  import { tooltip } from '$lib/tooltip.js';
  import Select from '$lib/Select.svelte';
  import { paymentStatusBadgeClass } from '$lib/status.js';
  import { subscribePaymentEvents } from '$lib/realtime.js';
  import { Copy, Check, Search, CreditCard, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/svelte';

  /**
   * @type {{ data: {
   *   payments: any[],
   *   total: number,
   *   status: string,
   *   page: number,
   *   pageSize: number,
   *   hasPrev: boolean,
   *   hasNext: boolean,
   *   loadError: string|null
   * } }}
   */
  let { data } = $props();

  // Poll interval in milliseconds. Kept at 15000ms as a fallback since SSE handles real-time updates.
  const POLL_INTERVAL_MS = 15000;

  let payments = $state(untrack(() => data.payments ?? []));
  let errorMessage = $state(untrack(() => data.loadError ?? null));
  let lastUpdated = $state(/** @type {number|null} */ (null));

  // Re-sync the table whenever a navigation (status filter / pagination) loads
  // new server data, so the list reflects filter/page changes rather than the
  // value captured at mount. The poller below updates `payments` directly
  // (which does not change `data`), so it does not re-trigger this effect.
  $effect(() => {
    payments = data.payments ?? [];
    errorMessage = data.loadError ?? null;
  });

  // Always enable auto-refresh so the countdown and polling are active for all statuses.
  const autoRefresh = true;

  const statusFilters = [
    { value: 'all', label: 'All' },
    { value: 'pending', label: 'Pending' },
    { value: 'paid', label: 'Paid' },
    { value: 'expired', label: 'Expired' }
  ];

  let selectedStatus = $state(untrack(() => data.status));
  $effect(() => {
    selectedStatus = data.status;
  });

  $effect(() => {
    if (selectedStatus !== data.status) {
      applyFilters();
    }
  });

  /**
   * Build a Payments page URL for a given status and page number.
   * @param {string} status
   * @param {number} page
   * @returns {string}
   */
  function pageUrl(status, page, overrideId = data.id, overrideDate = data.date) {
    const params = new URLSearchParams();
    if (status && status !== 'all') {
      params.set('status', status);
    }
    if (overrideId) {
      params.set('id', overrideId);
    }
    if (overrideDate) {
      params.set('date', overrideDate);
    }
    if (page > 1) {
      params.set('page', String(page));
    }
    const qs = params.toString();
    return qs.length > 0 ? `/payments?${qs}` : '/payments';
  }

  /**
   * Shorten a payment id for the table while keeping it recognizable.
   * @param {string} id
   * @returns {string}
   */
  function shortId(id) {
    if (typeof id !== 'string' || id.length <= 14) {
      return id ?? '—';
    }
    return `${id.slice(0, 8)}…${id.slice(-4)}`;
  }

  let filterId = $state(untrack(() => data.id || ''));
  let filterDate = $state(untrack(() => data.date || ''));

  $effect(() => {
    const currentDataId = data.id || '';
    const currentDataDate = data.date || '';
    if (untrack(() => filterId) !== currentDataId) {
      filterId = currentDataId;
    }
    if (untrack(() => filterDate) !== currentDataDate) {
      filterDate = currentDataDate;
    }
  });

  function applyFilters() {
    goto(pageUrl(selectedStatus, 1, filterId, filterDate), { keepFocus: true });
  }

  let searchTimer;
  function handleSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      applyFilters();
    }, 400);
  }

  function handleFilterKeydown(e) {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      applyFilters();
    }
  }

  let copiedId = $state(null);
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        textArea.remove();
      }
      copiedId = text;
      setTimeout(() => (copiedId = null), 2000);
    } catch (e) {
      console.error('Failed to copy', e);
    }
  }

  /**
   * Format a millisecond epoch timestamp for display.
   * @param {number|null|undefined} value
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

  /**
   * Tailwind classes for a status badge. Delegates to the shared scheme
   * (pending = blue, paid = green, expired = red).
   * @param {string} status
   * @returns {string}
   */
  function badgeClass(status) {
    return paymentStatusBadgeClass(status);
  }

  /**
   * Calculate which page numbers to display for windowed pagination.
   * @param {number} current
   * @param {number} total
   * @returns {(number|string)[]}
   */
  function getPageNumbers(current, total) {
    if (total === 0) return [];
    let start = Math.max(1, current - 1);
    let end = Math.min(total, start + 2);
    if (end - start < 2) {
      start = Math.max(1, end - 2);
    }
    const pages = [];
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  }

  let refreshing = $state(false);

  /**
   * Refresh the current page of payments from the polling endpoint without a
   * manual reload. Only active when viewing pending/all.
   */
  async function refresh() {
    refreshing = true;
    const offset = (data.page - 1) * data.pageSize;
    const params = new URLSearchParams({
      status: data.status,
      limit: String(data.pageSize),
      offset: String(offset)
    });
    if (data.id) params.set('id', data.id);
    if (data.date) params.set('date', data.date);

    let response;
    try {
      response = await fetch(`/api/payments?${params.toString()}`);
    } catch {
      errorMessage = 'Unable to reach the server.';
      return;
    }

    if (response.status === 401) {
      await goto('/login');
      return;
    }

    if (!response.ok) {
      errorMessage = 'Unable to load payments.';
      return;
    }

    try {
      const body = await response.json();
      payments = Array.isArray(body.payments) ? body.payments : [];
      errorMessage = null;
      lastUpdated = Date.now();
    } catch {
      errorMessage = 'Received an unexpected response.';
    }
    refreshing = false;
  }

  // Manage the auto-refresh timer reactively: it starts when viewing a live
  // (all/pending) filter and stops when switching to a terminal (paid/expired)
  // filter, so changing the filter correctly starts/stops polling.
  let countdown = $state(POLL_INTERVAL_MS / 1000);
  $effect(() => {
    if (!autoRefresh) {
      return;
    }
    const timer = setInterval(() => {
      countdown -= 1;
      if (countdown <= 0) {
        refresh();
        syncOpenDetail();
        countdown = POLL_INTERVAL_MS / 1000;
      }
    }, 1000);
    return () => clearInterval(timer);
  });

  function forceRefresh() {
    refresh();
    syncOpenDetail();
    countdown = POLL_INTERVAL_MS / 1000;
  }

  // Realtime: refresh the list the instant the backend signals a payment
  // change (created/paid/expired), regardless of the active filter. If the
  // detail drawer is open, also re-sync the payment shown inside it so the
  // modal never lags behind the table. Polling above remains as a fallback if
  // the stream drops.
  $effect(() => {
    return subscribePaymentEvents(() => {
      refresh();
      syncOpenDetail();
    });
  });

  // ── Detail drawer state ────────────────────────────────────────────────────
  let drawerOpen = $state(false);
  // Which view the drawer shows: the payment record + webhook deliveries, or
  // the rich provider transaction (same view as the Transactions page).
  let detailMode = $state(/** @type {'payment'|'transaction'} */ ('payment'));
  let detail = $state(/** @type {any} */ (null));
  let detailLoading = $state(false);
  let detailError = $state(/** @type {string|null} */ (null));
  let expandedLog = $state(/** @type {string|null} */ (null));

  // Live provider transaction (fetched fresh, matched by txId) so the
  // Transaction Detail in this drawer is identical to the Transactions page —
  // not the leaner settlement-time snapshot.
  let liveTx = $state(/** @type {any} */ (null));
  let liveTxLoading = $state(false);

  // Resend webhook state.
  let resending = $state(false);
  let resendResult = $state(/** @type {string|null} */ (null));
  let resendError = $state(/** @type {string|null} */ (null));

  // The parsed provider transaction captured at settlement (paid payments
  // only), wrapped as a `{ raw }` row for the shared TransactionDetail.
  const txDetail = $derived.by(() => {
    const raw = detail?.tx_raw;
    if (typeof raw !== 'string' || raw.length === 0) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? { raw: parsed } : null;
    } catch {
      return null;
    }
  });

  /**
   * Open the right-side detail drawer for a payment and load its full record
   * (including webhook delivery logs and the raw transaction) from the
   * session-guarded proxy.
   * @param {string} id
   * @param {'payment'|'transaction'} [mode]
   */
  async function openDetail(id, mode = 'payment') {
    drawerOpen = true;
    detailMode = mode;
    detail = null;
    detailError = null;
    detailLoading = true;
    expandedLog = null;
    resendResult = null;
    resendError = null;
    liveTx = null;
    liveTxLoading = false;

    let response;
    try {
      response = await fetch(`/api/payments/${encodeURIComponent(id)}`);
    } catch {
      detailError = 'Unable to reach the server.';
      detailLoading = false;
      return;
    }

    if (response.status === 401) {
      await goto('/login');
      return;
    }

    if (response.status === 404) {
      detailError = 'Payment not found.';
      detailLoading = false;
      return;
    }

    if (!response.ok) {
      detailError = 'Unable to load the payment.';
      detailLoading = false;
      return;
    }

    try {
      detail = await response.json();
    } catch {
      detailError = 'Received an unexpected response.';
    }
    detailLoading = false;

    // For the transaction view, fetch the SAME live transaction the Transactions
    // page shows (matched by txId) so the two are identical.
    if (detailMode === 'transaction' && detail && typeof detail.tx_id === 'string' && detail.tx_id) {
      await loadLiveTransaction(detail.tx_id);
    }
  }

  /**
   * Fetch recent provider transactions and pick the one matching `txId`, so the
   * Transaction Detail drawer renders the same rich data as the Transactions
   * page (rather than the leaner settlement snapshot stored on the payment).
   * @param {string} txId
   */
  async function loadLiveTransaction(txId) {
    liveTx = null;
    liveTxLoading = true;
    try {
      const res = await fetch('/api/transactions?days=30&size=100');
      if (res.ok) {
        const body = await res.json();
        const list = Array.isArray(body.transactions) ? body.transactions : [];
        liveTx = list.find((t) => t && t.txId === txId) ?? null;
      }
    } catch {
      liveTx = null;
    }
    liveTxLoading = false;
  }

  function closeDrawer() {
    drawerOpen = false;
    detail = null;
    detailError = null;
    expandedLog = null;
    resendResult = null;
    resendError = null;
    liveTx = null;
    liveTxLoading = false;
  }

  /**
   * Toggle the expanded request/response bodies for a webhook log row, keyed by
   * its stable id.
   * @param {string} id
   */
  function toggleLog(id) {
    expandedLog = expandedLog === id ? null : id;
  }

  /**
   * Group a flat list of webhook delivery-log rows into delivery cycles. Each
   * cycle is one dispatch run: the automatic on-settlement delivery (which may
   * retry up to 5 times) or a manual resend (a single attempt). A new cycle
   * begins whenever the per-cycle attempt counter (`attempts`) is 1, since both
   * the auto cycle and every resend start their counter at 1.
   *
   * The first cycle is the automatic on-settlement dispatch; any later cycle is
   * a manual resend (the webhook is auto-sent exactly once at settlement, so
   * subsequent deliveries can only come from the Resend button).
   *
   * @param {Array<Record<string, any>>|undefined} logs - oldest-first rows.
   * @param {string} [paymentStatus] - the payment's terminal status, used to
   *   label the automatic (first) delivery as settlement vs expiry.
   * @returns {Array<{ number: number, trigger: string, outcome: string, rows: Array<Record<string, any>> }>}
   */
  function groupWebhookLogs(logs, paymentStatus) {
    if (!Array.isArray(logs) || logs.length === 0) {
      return [];
    }
    /** @type {Array<{ number: number, trigger: string, outcome: string, rows: any[] }>} */
    const groups = [];
    let current = null;
    for (const log of logs) {
      const attempt = Number(log?.attempts);
      if (current === null || attempt === 1) {
        current = { number: groups.length + 1, trigger: '', outcome: 'unknown', rows: [] };
        groups.push(current);
      }
      current.rows.push(log);
    }
    const autoLabel =
      paymentStatus === 'expired' ? 'Automatic (on expiry)' : 'Automatic (on settlement)';
    for (const group of groups) {
      group.trigger = group.number === 1 ? autoLabel : 'Manual resend';
      const last = group.rows[group.rows.length - 1];
      group.outcome = last?.status ?? 'unknown';
    }
    return groups;
  }

  // Webhook delivery cycles for the open payment, derived from the flat log list.
  const webhookDeliveries = $derived(groupWebhookLogs(detail?.webhook_logs, detail?.status));

  /**
   * Tailwind classes for a delivery-outcome badge (the cycle's final status).
   * @param {string} outcome
   * @returns {string}
   */
  function deliveryOutcomeClass(outcome) {
    if (outcome === 'success') {
      return 'bg-emerald-100 text-emerald-800';
    }
    if (outcome === 'failed_permanent') {
      return 'bg-red-100 text-red-800';
    }
    return 'bg-amber-100 text-amber-800';
  }

  /**
   * Human-readable label for a delivery-outcome badge.
   * @param {string} outcome
   * @returns {string}
   */
  function deliveryOutcomeLabel(outcome) {
    if (outcome === 'success') {
      return 'Delivered';
    }
    if (outcome === 'failed_permanent') {
      return 'Failed (gave up after retries)';
    }
    if (outcome === 'failed') {
      return 'Failed';
    }
    return outcome ?? 'unknown';
  }

  /**
   * Re-dispatch the webhook for the payment in the drawer via the session-
   * guarded proxy. Allowed for terminal payments (paid or expired).
   */
  async function resendWebhook() {
    if (!detail || (detail.status !== 'paid' && detail.status !== 'expired')) {
      return;
    }
    resending = true;
    resendResult = null;
    resendError = null;

    let response;
    try {
      response = await fetch(
        `/api/payments/${encodeURIComponent(detail.id)}/webhook/resend`,
        { method: 'POST' }
      );
    } catch {
      resendError = 'Unable to reach the server.';
      resending = false;
      return;
    }

    if (response.status === 401) {
      await goto('/login');
      return;
    }

    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      resendError =
        body && typeof body.message === 'string' && body.message.length > 0
          ? body.message
          : 'Unable to resend the webhook.';
      resending = false;
      return;
    }

    const success = body && body.success === true;
    resendResult = success
      ? `Webhook delivered (status ${body.status ?? '—'}, attempts ${body.attempts ?? '—'}).`
      : `Webhook attempted but did not succeed (status ${body?.status ?? '—'}, attempts ${body?.attempts ?? '—'}).`;
    resending = false;

    // Refresh the detail so the new delivery attempt appears in the log table.
    await openDetailRefresh(detail.id);
  }

  /**
   * Re-sync the payment shown in the open drawer with the latest server state,
   * triggered by a realtime event. No-op when the drawer is closed. Guards
   * against races where the user closes or switches the drawer while the
   * request is in flight. In transaction mode, also loads the live provider
   * transaction once a `tx_id` becomes available (e.g. the payment just paid).
   */
  async function syncOpenDetail() {
    if (!drawerOpen || !detail || typeof detail.id !== 'string') {
      return;
    }
    const id = detail.id;
    let response;
    try {
      response = await fetch(`/api/payments/${encodeURIComponent(id)}`);
    } catch {
      return;
    }
    if (!response.ok) {
      return;
    }
    let next;
    try {
      next = await response.json();
    } catch {
      return;
    }
    // The drawer may have been closed or pointed at a different payment while
    // the request was in flight; discard a stale response in that case.
    if (!drawerOpen || !detail || detail.id !== id) {
      return;
    }
    detail = next;
    if (
      detailMode === 'transaction' &&
      !liveTx &&
      typeof next.tx_id === 'string' &&
      next.tx_id
    ) {
      await loadLiveTransaction(next.tx_id);
    }
  }

  /**
   * Reload the detail in place (used after a resend) without resetting the
   * drawer-open state or the resend message.
   * @param {string} id
   */
  async function openDetailRefresh(id) {
    let response;
    try {
      response = await fetch(`/api/payments/${encodeURIComponent(id)}`);
    } catch {
      return;
    }
    if (!response.ok) {
      return;
    }
    try {
      detail = await response.json();
    } catch {
      // Keep the previous detail if the refresh response is unreadable.
    }
  }
</script>

<svelte:head>
  <title>GoMerch | Payments</title>
</svelte:head>

<section class="space-y-4">
  <div class="flex flex-col sm:flex-row gap-4 sm:items-center sm:justify-between">
    <div class="flex flex-wrap items-center gap-2">
      <div class="w-36">
        <Select bind:value={selectedStatus} options={statusFilters} ariaLabel="Status filter" />
      </div>
      <div class="relative">
        <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder="Search ID..."
          bind:value={filterId}
          oninput={handleSearchInput}
          onkeydown={handleFilterKeydown}
          class="gp-input w-40 pl-9 text-sm bg-white"
        />
      </div>
      <input
        type="date"
        bind:value={filterDate}
        onchange={applyFilters}
        class="gp-input w-36 text-sm text-slate-600 bg-white"
      />
      <button onclick={forceRefresh} disabled={refreshing} class="flex shrink-0 items-center justify-center gap-2 h-[42px] rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed">
        {#if autoRefresh && !refreshing}
          <div class="relative flex h-5 w-5 items-center justify-center">
            <svg class="h-full w-full -rotate-90 text-slate-200" viewBox="0 0 24 24">
              <circle class="stroke-current" cx="12" cy="12" r="10" stroke-width="3" fill="none" />
              <circle 
                class="text-brand-500 transition-all duration-1000 ease-linear" 
                cx="12" cy="12" r="10" stroke-width="3" fill="none" 
                stroke="currentColor" 
                stroke-dasharray="62.83" 
                stroke-dashoffset={62.83 * (1 - countdown / (POLL_INTERVAL_MS / 1000))} />
            </svg>
            <span class="absolute text-[10px] font-bold text-slate-700">{countdown}</span>
          </div>
        {/if}
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if errorMessage}
    <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      {errorMessage}
    </div>
  {/if}

  <div class="gp-card overflow-hidden">
    <div class="border-b border-slate-100 bg-white p-5">
      <div class="flex items-center gap-4">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-600 ring-1 ring-inset ring-brand-200/60 shadow-sm">
          <CreditCard class="w-5 h-5" />
        </div>
        <div>
          <h2 class="text-base font-bold text-slate-900 tracking-tight">Payments</h2>
          <p class="mt-0.5 text-xs font-medium text-slate-500">Manage your inbound transactions</p>
        </div>
      </div>
    </div>
    
    <div class="overflow-x-auto">
      <table class="w-full min-w-[44rem] whitespace-nowrap text-left text-sm">
        <thead class="bg-slate-50 text-slate-600">
          <tr>
            <th class="px-4 py-3 font-medium">ID</th>
            <th class="px-4 py-3 font-medium">Amount</th>
            <th class="px-4 py-3 font-medium">Status</th>
            <th class="px-4 py-3 font-medium">Created at</th>
            <th class="px-4 py-3 font-medium">Expires at</th>
            <th class="px-4 py-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
      <tbody class="divide-y divide-slate-100">
        {#each payments as payment (payment.id)}
          <tr class="hover:bg-slate-50">
            <td class="px-4 py-3">
              <button
                type="button"
                use:tooltip={"Copy ID"}
                class="group flex items-center gap-1.5 font-mono text-xs text-slate-600 transition hover:text-slate-900"
                onclick={() => copyToClipboard(payment.id)}
              >
                <span>{shortId(payment.id)}</span>
                {#if copiedId === payment.id}
                  <Check class="h-3.5 w-3.5 text-green-600" strokeWidth={2.5} />
                {:else}
                  <Copy class="h-3.5 w-3.5 text-brand-500 opacity-0 transition group-hover:opacity-100" strokeWidth={1.8} />
                {/if}
              </button>
            </td>
            <td class="px-4 py-3 font-semibold text-slate-900">Rp {Number(payment.amount).toLocaleString('id-ID')}</td>
            <td class="px-4 py-3">
              <span class={`gp-status ${badgeClass(payment.status)}`}>
                {payment.status}
              </span>
            </td>
            <td class="px-4 py-3 text-slate-700">{formatTimestamp(payment.created_at)}</td>
            <td class="px-4 py-3 text-slate-700">{formatTimestamp(payment.expires_at)}</td>
            <td class="px-4 py-3">
              <div class="flex items-center justify-end gap-2">
                <button
                  type="button"
                  class="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                  onclick={() => openDetail(payment.id, 'payment')}
                >
                  Payment Detail
                </button>
                {#if payment.status === 'paid'}
                  <button
                    type="button"
                    class="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                    onclick={() => openDetail(payment.id, 'transaction')}
                  >
                    Transaction Detail
                  </button>
                {:else}
                  <span
                    use:tooltip={{ text: "Only paid payments have a provider transaction.", placement: "left" }}
                    class="cursor-not-allowed rounded-lg border border-slate-100 px-2.5 py-1.5 text-xs font-semibold text-slate-300"
                  >
                    Transaction Detail
                  </span>
                {/if}
              </div>
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="6" class="px-4 py-8 text-center text-sm text-slate-500">
              No payments to show.
            </td>
          </tr>
        {/each}
      </tbody>
      </table>
    </div>
  </div>

  <div class="flex w-full flex-col items-center justify-between gap-4 lg:flex-row lg:flex-wrap">
    <p class="text-sm text-slate-500 text-center mt-1 lg:mt-0 lg:text-left">
      Showing <span class="font-medium text-slate-900">{(data.page - 1) * data.pageSize + 1}</span> to <span class="font-medium text-slate-900">{Math.min(data.page * data.pageSize, data.total)}</span> of <span class="font-medium text-slate-900">{data.total}</span> payments
    </p>
    <div class="flex flex-wrap items-center justify-center gap-1.5">
      <!-- First Page -->
      {#if data.page > 1}
        <a href={pageUrl(data.status, 1)} class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none">
          <ChevronsLeft class="h-4 w-4" />
        </a>
      {:else}
        <span class="flex h-[42px] w-[42px] shrink-0 cursor-not-allowed items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
          <ChevronsLeft class="h-4 w-4" />
        </span>
      {/if}

      <!-- Previous Page -->
      {#if data.hasPrev}
        <a href={pageUrl(data.status, data.page - 1)} class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none">
          <ChevronLeft class="h-4 w-4" />
        </a>
      {:else}
        <span class="flex h-[42px] w-[42px] shrink-0 cursor-not-allowed items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
          <ChevronLeft class="h-4 w-4" />
        </span>
      {/if}
      
      <!-- Page Numbers -->
      <div class="flex items-center gap-1.5 px-1">
        {#each getPageNumbers(data.page, Math.ceil(data.total / data.pageSize)) as p (p)}
          <a
            href={pageUrl(data.status, p)}
            class="flex h-[42px] min-w-[42px] px-2 items-center justify-center rounded-xl text-sm font-semibold transition shadow-sm focus:outline-none {p === data.page ? 'bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-brand border border-transparent' : 'border border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700'}"
          >
            {p}
          </a>
        {/each}
      </div>

      <!-- Next Page -->
      {#if data.hasNext}
        <a href={pageUrl(data.status, data.page + 1)} class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none">
          <ChevronRight class="h-4 w-4" />
        </a>
      {:else}
        <span class="flex h-[42px] w-[42px] shrink-0 cursor-not-allowed items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
          <ChevronRight class="h-4 w-4" />
        </span>
      {/if}

      <!-- Last Page -->
      {#if data.page < Math.ceil(data.total / data.pageSize)}
        <a href={pageUrl(data.status, Math.ceil(data.total / data.pageSize))} class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none">
          <ChevronsRight class="h-4 w-4" />
        </a>
      {:else}
        <span class="flex h-[42px] w-[42px] shrink-0 cursor-not-allowed items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
          <ChevronsRight class="h-4 w-4" />
        </span>
      {/if}
    </div>
  </div>
</section>

<Modal
    open={drawerOpen}
    title={detailMode === 'transaction' ? 'Transaction Detail' : 'Payment Detail'}
    size="lg"
    onClose={closeDrawer}
  >
      <div class="space-y-5">
        {#if detailLoading}
          <p class="text-sm text-slate-500">Loading…</p>
        {:else if detailError}
          <div class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
            {detailError}
          </div>
        {:else if detail && detailMode === 'transaction'}
          {#if liveTxLoading}
            <p class="text-sm text-slate-500">Loading transaction…</p>
          {:else if liveTx}
            <TransactionDetail tx={liveTx} timeZone={data.summary?.display_timezone} />
          {:else if txDetail}
            <TransactionDetail tx={txDetail} timeZone={data.summary?.display_timezone} />
          {:else}
            <div class="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
              No provider transaction is recorded for this payment.
            </div>
          {/if}
        {:else if detail}
          <dl class="space-y-3 text-sm">
            <div>
              <dt class="text-slate-500">ID</dt>
              <dd class="break-all font-mono text-slate-900">{detail.id}</dd>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <dt class="text-slate-500">Amount</dt>
                <dd class="text-slate-900">{detail.amount}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Status</dt>
                <dd>
                  <span class={`gp-status ${badgeClass(detail.status)}`}>
                    {detail.status}
                  </span>
                </dd>
              </div>
              <div>
                <dt class="text-slate-500">Created at</dt>
                <dd class="text-slate-900">{formatTimestamp(detail.created_at)}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Expires at</dt>
                <dd class="text-slate-900">{formatTimestamp(detail.expires_at)}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Timeout (ms)</dt>
                <dd class="text-slate-900">{detail.timeout ?? '—'}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Tolerance</dt>
                <dd class="text-slate-900">{detail.tolerance ?? '—'}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Paid amount</dt>
                <dd class="text-slate-900">{detail.paid_amount ?? '—'}</dd>
              </div>
              <div>
                <dt class="text-slate-500">Paid at</dt>
                <dd class="text-slate-900">{formatTimestamp(detail.paid_at)}</dd>
              </div>
            </div>
            <div>
              <dt class="text-slate-500">Transaction id</dt>
              <dd class="break-all font-mono text-xs text-slate-900">{detail.tx_id ?? '—'}</dd>
            </div>
            <div>
              <dt class="text-slate-500">Webhook URL</dt>
              <dd class="break-all text-slate-900">{detail.webhook_url ?? '—'}</dd>
            </div>
            <div>
              <dt class="text-slate-500">QRIS string</dt>
              <dd class="mt-1 whitespace-pre-wrap break-all rounded bg-slate-50 p-2 font-mono text-xs text-slate-900">
                {detail.qris_string ?? '—'}
              </dd>
            </div>
            <div>
              <dt class="text-slate-500">QRIS code</dt>
              <dd class="mt-1">
                <img
                  src={`/qris/${encodeURIComponent(detail.id)}`}
                  alt="QRIS code for this payment"
                  class="h-44 w-44 max-w-full rounded border border-slate-200 bg-white"
                />
              </dd>
            </div>
          </dl>

          <!-- Webhook deliveries -->
          <div class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-sm font-semibold text-slate-800">Webhook deliveries</h3>
              <button
                type="button"
                disabled={(detail.status !== 'paid' && detail.status !== 'expired') || resending}
                use:tooltip={detail.status !== 'paid' && detail.status !== 'expired' ? 'Only paid or expired payments can resend a webhook.' : 'Resend webhook'}
                onclick={resendWebhook}
                class="gp-btn-primary px-3 py-1.5 text-xs"
              >
                {resending ? 'Resending…' : 'Resend webhook'}
              </button>
            </div>

            {#if resendError}
              <p class="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700" role="alert">
                {resendError}
              </p>
            {/if}
            {#if resendResult}
              <p class="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-700">
                {resendResult}
              </p>
            {/if}

            {#if webhookDeliveries.length > 0}
              <div class="space-y-3">
                {#each webhookDeliveries as delivery (delivery.number)}
                  <div class="overflow-hidden rounded border border-slate-200">
                    <!-- Delivery cycle header -->
                    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
                      <div class="flex items-center gap-2">
                        <span class="text-xs font-semibold text-slate-800">Delivery {delivery.number}</span>
                        <span class="text-[11px] text-slate-500">· {delivery.trigger}</span>
                      </div>
                      <span class="rounded-full px-2 py-0.5 text-[11px] font-medium {deliveryOutcomeClass(delivery.outcome)}">
                        {deliveryOutcomeLabel(delivery.outcome)}
                      </span>
                    </div>

                    <!-- Attempts within this delivery cycle -->
                    <table class="w-full min-w-[24rem] text-left text-xs">
                      <thead class="text-slate-500">
                        <tr>
                          <th class="px-3 py-1.5 font-medium">Try</th>
                          <th class="px-3 py-1.5 font-medium">Status</th>
                          <th class="px-3 py-1.5 font-medium">HTTP</th>
                          <th class="px-3 py-1.5 font-medium">Time</th>
                          <th class="px-3 py-1.5 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody class="divide-y divide-slate-100">
                        {#each delivery.rows as log (log.id)}
                          <tr class="align-top">
                            <td class="px-3 py-2 text-slate-900">{log.attempts ?? '—'}</td>
                            <td class="px-3 py-2 text-slate-900">{log.status ?? '—'}</td>
                            <td class="px-3 py-2 text-slate-900">{log.response_status ?? '—'}</td>
                            <td class="px-3 py-2 text-slate-700">{formatTimestamp(log.last_attempt_at)}</td>
                            <td class="px-3 py-2">
                              <button
                                type="button"
                                class="text-slate-600 underline-offset-2 hover:underline"
                                onclick={() => toggleLog(log.id)}
                              >
                                {expandedLog === log.id ? 'Hide' : 'Details'}
                              </button>
                            </td>
                          </tr>
                          {#if expandedLog === log.id}
                            <tr>
                              <td colspan="5" class="space-y-2 bg-slate-50 px-3 py-2">
                                {#if log.last_error}
                                  <div>
                                    <p class="font-medium text-slate-600">Last error</p>
                                    <p class="break-all text-red-700">{log.last_error}</p>
                                  </div>
                                {/if}
                                <div>
                                  <p class="font-medium text-slate-600">Request body</p>
                                  <pre class="overflow-x-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[11px] text-slate-800">{log.request_body ?? '—'}</pre>
                                </div>
                                <div>
                                  <p class="font-medium text-slate-600">Response body</p>
                                  <pre class="overflow-x-auto whitespace-pre-wrap break-all rounded bg-white p-2 font-mono text-[11px] text-slate-800">{log.response_body ?? '—'}</pre>
                                </div>
                              </td>
                            </tr>
                          {/if}
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {/each}
              </div>
              <p class="mt-1 text-[11px] leading-snug text-slate-500">
                Each block is one delivery cycle. <strong>Try</strong> is the attempt number within
                that cycle: the automatic delivery retries up to 5 times; a manual resend is always a
                single attempt.
              </p>
            {:else}
              <p class="text-xs text-slate-500">No webhook deliveries recorded.</p>
            {/if}
          </div>
        {/if}
      </div>
  </Modal>
