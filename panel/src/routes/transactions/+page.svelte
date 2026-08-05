<script>
  import { goto, invalidateAll } from '$app/navigation';
  import TransactionDetail from '$lib/TransactionDetail.svelte';
  import Modal from '$lib/Modal.svelte';
  import Select from '$lib/Select.svelte';
  import { money, rupiah, text, formatTime, source, share } from '$lib/transaction-format.js';
  import { RefreshCw, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ArrowRightLeft, Copy, Check, Search } from '@lucide/svelte';
  import { tooltip } from '$lib/tooltip.js';
  import { transactionStatusBadgeClass } from '$lib/status.js';
  import { untrack } from 'svelte';

  /**
   * @type {{ data: {
   *   transactions: any[],
   *   period: string,
   *   start: string,
   *   end: string,
   *   page: number,
   *   hasNext: boolean,
   *   loadError: string|null,
   *   summary?: { display_timezone: string }
   * } }}
   */
  let { data } = $props();

  const periodOptions = [
    { value: 'today', label: 'Today' },
    { value: 'yesterday', label: 'Yesterday' },
    { value: 'this_week', label: 'This Week' },
    { value: 'last_week', label: 'Last Week' },
    { value: 'this_month', label: 'This Month' },
    { value: 'last_month', label: 'Last Month' },
    { value: 'this_quarter', label: 'This Quarter' },
    { value: 'last_quarter', label: 'Last Quarter' },
    { value: 'custom', label: 'Select Period' }
  ];

  let selectedPeriod = $state(untrack(() => data.period || 'today'));
  
  // Format Date for HTML5 date input (YYYY-MM-DD)
  function formatDateInput(isoString) {
    if (!isoString) return '';
    try {
      return new Date(isoString).toISOString().split('T')[0];
    } catch {
      return '';
    }
  }

  let customStart = $state(formatDateInput(untrack(() => data.start)));
  let customEnd = $state(formatDateInput(untrack(() => data.end)));

  // Sync selected options if data changes via navigation
  $effect(() => {
    selectedPeriod = data.period || 'today';
    customStart = formatDateInput(data.start);
    customEnd = formatDateInput(data.end);
  });

  $effect(() => {
    if (selectedPeriod !== data.period && selectedPeriod !== 'custom') {
      applyFilters();
    }
  });

  let orderIdSearch = $state(untrack(() => data.order_id || ''));
  
  $effect(() => {
    orderIdSearch = data.order_id || '';
  });

  // ── Detail drawer state ────────────────────────────────────────────────────
  let drawerOpen = $state(false);
  let selected = $state(/** @type {any} */ (null));

  /**
   * @param {any} tx
   */
  function openDetail(tx) {
    selected = tx;
    drawerOpen = true;
  }

  function closeDrawer() {
    drawerOpen = false;
    selected = null;
  }

  function pageUrl(period, page, start = '', end = '', orderId = '') {
    const q = new URLSearchParams();
    q.set('period', period);
    q.set('page', String(page));
    if (period === 'custom') {
      if (start) q.set('start', start);
      if (end) q.set('end', end);
    }
    if (orderId) {
      q.set('order_id', orderId);
    }
    return `/transactions?${q.toString()}`;
  }

  let applying = $state(false);

  async function applyFilters() {
    applying = true;
    await goto(pageUrl(selectedPeriod, 1, customStart, customEnd, orderIdSearch), { keepFocus: true, noScroll: true });
    applying = false;
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

  let refreshing = $state(false);

  async function refresh() {
    refreshing = true;
    await invalidateAll();
    refreshing = false;
  }

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

  function shortId(id) {
    if (typeof id !== 'string' || id.length <= 14) {
      return id ?? '—';
    }
    return `${id.slice(0, 8)}…${id.slice(-4)}`;
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
</script>

<svelte:head>
  <title>GoMerch | Transactions</title>
</svelte:head>

<section class="space-y-4">
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
    <div class="flex flex-wrap items-center gap-2">
      <div class="w-48">
        <Select bind:value={selectedPeriod} options={periodOptions} ariaLabel="Period filter" />
      </div>

      <div class="relative">
        <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          placeholder="Search Order ID..."
          bind:value={orderIdSearch}
          oninput={handleSearchInput}
          onkeydown={handleFilterKeydown}
          class="gp-input w-48 pl-9 text-sm bg-white"
        />
      </div>

      {#if selectedPeriod === 'custom'}
        <div class="flex items-center gap-2">
          <input type="date" bind:value={customStart} class="gp-input w-36 text-sm text-slate-600 bg-white" />
          <span class="text-slate-400">to</span>
          <input type="date" bind:value={customEnd} class="gp-input w-36 text-sm text-slate-600 bg-white" />
          <button onclick={applyFilters} disabled={applying} class="flex shrink-0 items-center justify-center gap-2 h-[42px] rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed">
            {applying ? 'Applying...' : 'Apply'}
          </button>
        </div>
      {/if}

      <button onclick={refresh} disabled={refreshing} class="flex shrink-0 items-center justify-center gap-2 h-[42px] rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed">
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  </div>

  {#if data.loadError}
    <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      {data.loadError}
    </div>
  {/if}

  <div class="gp-card overflow-hidden">
    <div class="border-b border-slate-100 bg-white p-5">
      <div class="flex items-center gap-4">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-600 ring-1 ring-inset ring-brand-200/60 shadow-sm">
          <ArrowRightLeft class="w-5 h-5" />
        </div>
        <div>
          <h2 class="text-base font-bold text-slate-900 tracking-tight">Transactions</h2>
          <p class="mt-0.5 text-xs font-medium text-slate-500">Real transaction mutation from GoBiz server</p>
        </div>
      </div>
    </div>
    
    <div class="overflow-x-auto">
      <table class="w-full min-w-[48rem] whitespace-nowrap text-left text-sm">
        <thead class="bg-slate-50 text-slate-600">
          <tr>
            <th class="px-4 py-3 font-medium">Order ID</th>
            <th class="px-4 py-3 font-medium">Gross</th>
            <th class="px-4 py-3 font-medium">Net</th>
            <th class="px-4 py-3 font-medium">Fee</th>
            <th class="px-4 py-3 font-medium">Status</th>
            <th class="px-4 py-3 font-medium">Transaction Time</th>
            <th class="px-4 py-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 bg-white">
          {#each data.transactions as tx, index (tx.txId ?? index)}
            <tr class="hover:bg-slate-50 transition-colors">
              <td class="px-4 py-3">
                <button
                  type="button"
                  use:tooltip={"Copy ID"}
                  class="group flex items-center gap-1.5 font-mono text-xs text-slate-600 transition hover:text-slate-900"
                  onclick={(e) => { e.stopPropagation(); copyToClipboard(text(source(tx).order_id ?? tx.txId)); }}
                >
                  <span>{shortId(text(source(tx).order_id ?? tx.txId))}</span>
                  {#if copiedId === text(source(tx).order_id ?? tx.txId)}
                    <Check class="h-3.5 w-3.5 text-green-600" strokeWidth={2.5} />
                  {:else}
                    <Copy class="h-3.5 w-3.5 text-brand-500 opacity-0 transition group-hover:opacity-100" strokeWidth={1.8} />
                  {/if}
                </button>
              </td>
              <td class="px-4 py-3 font-semibold text-slate-900">{rupiah(tx.amount)}</td>
              <td class="px-4 py-3 text-slate-900">{money(share(tx).merchant_share)}</td>
              <td class="px-4 py-3 text-slate-600">{money(share(tx).platform_total_fee)}</td>
              <td class="px-4 py-3">
                <span class={`gp-status ${transactionStatusBadgeClass(text(source(tx).transaction_status ?? tx.type))}`}>
                  {text(source(tx).transaction_status ?? tx.type)}
                </span>
              </td>
              <td class="px-4 py-3 text-slate-700">{formatTime(tx.time ?? source(tx).transaction_time, data.summary?.display_timezone)}</td>
              <td class="px-4 py-3">
                <div class="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    class="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                    onclick={() => openDetail(tx)}
                  >
                    Detail
                  </button>
                </div>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="px-4 py-12 text-center text-sm text-slate-500">
                <div class="flex flex-col items-center justify-center space-y-3">
                  <div class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
                    <svg class="h-6 w-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <p>No transactions in this window.</p>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
    
  <!-- Pagination -->
  <div class="flex w-full flex-col items-center justify-between gap-4 lg:flex-row lg:flex-wrap">
    <p class="text-sm text-slate-500 text-center mt-1 lg:mt-0 lg:text-left">
      Showing <span class="font-medium text-slate-900">{(data.page - 1) * data.pageSize + 1}</span> to <span class="font-medium text-slate-900">{Math.min(data.page * data.pageSize, data.total)}</span> of <span class="font-medium text-slate-900">{data.total}</span> transactions
    </p>
      <div class="flex flex-wrap items-center justify-center gap-1.5">
        <!-- First Page -->
        {#if data.page > 1}
          <a href={pageUrl(data.period, 1, customStart, customEnd, orderIdSearch)} class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none">
            <ChevronsLeft class="h-4 w-4" />
          </a>
        {:else}
          <span class="flex h-[42px] w-[42px] shrink-0 cursor-not-allowed items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
            <ChevronsLeft class="h-4 w-4" />
          </span>
        {/if}

        <!-- Previous Page -->
        {#if data.page > 1}
          <a href={pageUrl(data.period, data.page - 1, customStart, customEnd, orderIdSearch)} class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none">
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
              href={pageUrl(data.period, p, customStart, customEnd, orderIdSearch)}
              class="flex h-[42px] min-w-[42px] px-2 items-center justify-center rounded-xl text-sm font-semibold transition shadow-sm focus:outline-none {p === data.page ? 'bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-brand border border-transparent' : 'border border-slate-200 bg-white text-slate-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700'}"
            >
              {p}
            </a>
          {/each}
        </div>

        <!-- Next Page -->
        {#if data.hasNext}
          <a href={pageUrl(data.period, data.page + 1, customStart, customEnd, orderIdSearch)} class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none">
            <ChevronRight class="h-4 w-4" />
          </a>
        {:else}
          <span class="flex h-[42px] w-[42px] shrink-0 cursor-not-allowed items-center justify-center rounded-xl border border-slate-100 bg-slate-50 text-slate-300">
            <ChevronRight class="h-4 w-4" />
          </span>
        {/if}

        <!-- Last Page -->
        {#if data.page < Math.ceil(data.total / data.pageSize)}
          <a href={pageUrl(data.period, Math.ceil(data.total / data.pageSize), customStart, customEnd, orderIdSearch)} class="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus:outline-none">
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

<Modal open={drawerOpen} title="Transaction Detail" size="lg" onClose={closeDrawer}>
  {#if selected}
    <TransactionDetail tx={selected} timeZone={data.summary?.display_timezone} />
  {/if}
</Modal>
