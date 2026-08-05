<script>
  import { enhance } from '$app/forms';
  import { Key, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/svelte';
  import { goto } from '$app/navigation';
  import Select from '$lib/Select.svelte';
  import { untrack } from 'svelte';

  /**
   * @type {{
   *   data: { keys: any[], loadError: string|null },
   *   form: { message?: string, created?: any, revoked?: boolean } | null
   * }}
   */
  let { data, form } = $props();

  let creating = $state(false);

  const created = $derived(form?.created ?? null);

  const statusOptions = [
    { value: 'active', label: 'Active' },
    { value: 'revoked', label: 'Revoked' },
    { value: 'all', label: 'All Status' }
  ];

  let selectedStatus = $state(untrack(() => data.status || 'active'));
  $effect(() => {
    selectedStatus = data.status || 'active';
  });

  $effect(() => {
    if (selectedStatus !== (data.status || 'active')) {
      goto(pageUrl(selectedStatus, 1), { keepFocus: true });
    }
  });

  function pageUrl(status, page) {
    const params = new URLSearchParams();
    if (status && status !== 'active') {
      params.set('status', status);
    }
    if (page > 1) {
      params.set('page', String(page));
    }
    const qs = params.toString();
    return qs.length > 0 ? `/api-keys?${qs}` : '/api-keys';
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

  /**
   * Format a millisecond epoch timestamp for display.
   * @param {number|null} value
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
  <title>GoMerch | API Keys</title>
</svelte:head>

<section class="space-y-4">
  <div class="flex flex-wrap items-center justify-start gap-2">
    <div class="w-36">
      <Select bind:value={selectedStatus} options={statusOptions} ariaLabel="Status filter" />
    </div>
    <form
      method="POST"
      action="?/create"
      use:enhance={() => {
        creating = true;
        return async ({ update }) => {
          await update();
          creating = false;
        };
      }}
    >
      <button type="submit" disabled={creating} class="gp-btn-primary">
        {creating ? 'Creating…' : 'Create API key'}
      </button>
    </form>
  </div>
  {#if form?.message}
    <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      {form.message}
    </div>
  {/if}

  {#if form?.revoked}
    <div class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">
      The API key was revoked.
    </div>
  {/if}

  {#if created}
    <div class="rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <h2 class="text-sm font-semibold text-amber-900">Your new API key</h2>
      <p class="mt-1 text-sm text-amber-800">
        Copy this value now. For security it is shown only once and cannot be retrieved again.
      </p>
      <code class="mt-3 block break-all rounded-lg bg-white px-3 py-2 font-mono text-sm text-slate-900 ring-1 ring-amber-200">
        {created.value}
      </code>
    </div>
  {/if}

  <div class="gp-card overflow-hidden">
    <div class="border-b border-slate-100 bg-white p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div class="flex items-center gap-4">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-600 ring-1 ring-inset ring-brand-200/60 shadow-sm">
          <Key class="w-5 h-5" />
        </div>
        <div>
          <h2 class="text-base font-bold text-slate-900 tracking-tight">API Keys</h2>
          <p class="mt-0.5 text-xs font-medium text-slate-500">Manage your active and revoked API keys</p>
        </div>
      </div>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full min-w-[44rem] text-left text-sm">
      <thead class="bg-slate-50 text-slate-600">
        <tr>
          <th class="px-4 py-3 font-medium">Key</th>
          <th class="px-4 py-3 font-medium">Status</th>
          <th class="px-4 py-3 font-medium">Created</th>
          <th class="px-4 py-3 font-medium">Revoked</th>
          <th class="px-4 py-3 font-medium text-right">Actions</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-100">
        {#each data.keys as key (key.id)}
          <tr class="hover:bg-slate-50">
            <td class="px-4 py-3 font-mono text-xs text-slate-900">{key.key_prefix}…</td>
            <td class="px-4 py-3">
              {#if key.status === 'active'}
                <span class="gp-status bg-emerald-100 text-emerald-700">active</span>
              {:else}
                <span class="gp-status bg-slate-200 text-slate-600">revoked</span>
              {/if}
            </td>
            <td class="px-4 py-3 text-slate-700">{formatTimestamp(key.created_at)}</td>
            <td class="px-4 py-3 text-slate-700">{formatTimestamp(key.revoked_at)}</td>
            <td class="px-4 py-3 text-right">
              {#if key.status === 'active'}
                <form method="POST" action="?/revoke" use:enhance>
                  <input type="hidden" name="id" value={key.id} />
                  <button
                    type="submit"
                    class="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 transition hover:bg-red-50"
                  >
                    Revoke
                  </button>
                </form>
              {:else}
                <span class="text-xs text-slate-400">—</span>
              {/if}
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="5" class="px-4 py-8 text-center text-sm text-slate-500">
              No API keys yet. Create one to start calling the REST API.
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  </div>

  <div class="flex w-full flex-col items-center justify-between gap-4 lg:flex-row lg:flex-wrap">
    <p class="text-sm text-slate-500 text-center mt-1 lg:mt-0 lg:text-left">
      Showing <span class="font-medium text-slate-900">{(data.page - 1) * data.pageSize + 1}</span> to <span class="font-medium text-slate-900">{Math.min(data.page * data.pageSize, data.total)}</span> of <span class="font-medium text-slate-900">{data.total}</span> keys
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
