<script>
  import { enhance } from '$app/forms';
  import { untrack } from 'svelte';
  import { Settings } from '@lucide/svelte';
  import Select from '$lib/Select.svelte';

  /**
   * @type {{
   *   data: { config: { poll_interval: number|null, webhook_url: string|null, display_timezone: string|null }, loadError: string|null },
   *   form: { message?: string, success?: boolean, values?: Record<string, string> } | null
   * }}
   */
  let { data, form } = $props();

  let saving = $state(false);

  /**
   * Resolve the value to show in a field: a just-submitted value (so an invalid
   * submission is retained for correction) takes precedence
   * over the currently stored value.
   * @param {string} field
   * @param {number|string|null} stored
   * @returns {string}
   */
  function fieldValue(field, stored) {
    if (form?.values && typeof form.values[field] === 'string' && form.values[field].length > 0) {
      return form.values[field];
    }
    return stored === null || stored === undefined ? '' : String(stored);
  }

  // Display timezone is chosen through the custom Select below (submitted via a
  // hidden input). Seeded once from the stored/just-submitted value.
  let displayTimezone = $state(
    untrack(() => fieldValue('display_timezone', data.config.display_timezone))
  );

  // The common Indonesian zones plus UTC. If the stored value is some other
  // valid IANA zone, it is added on top so it still displays and can be kept.
  const TIMEZONE_OPTIONS = [
    { value: 'Asia/Jakarta', label: 'Asia/Jakarta — WIB (+07:00)' },
    { value: 'Asia/Makassar', label: 'Asia/Makassar — WITA (+08:00)' },
    { value: 'Asia/Jayapura', label: 'Asia/Jayapura — WIT (+09:00)' },
    { value: 'UTC', label: 'UTC (+00:00)' }
  ];

  const timezoneOptions = $derived.by(() => {
    const list = [...TIMEZONE_OPTIONS];
    if (displayTimezone && !list.some((o) => o.value === displayTimezone)) {
      list.unshift({ value: displayTimezone, label: displayTimezone });
    }
    return list;
  });


</script>

<svelte:head>
  <title>GoMerch | Configuration</title>
</svelte:head>

<section class="space-y-6">

  {#if data.loadError}
    <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      {data.loadError}
    </div>
  {/if}

  {#if form?.message}
    <div class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">
      {form.message}
    </div>
  {/if}

  {#if form?.success}
    <div class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700" role="status">
      Configuration saved.
    </div>
  {/if}

  <form
    method="POST"
    class="gp-card"
    use:enhance={() => {
      saving = true;
      return async ({ update }) => {
        // Do NOT reset the form: a native reset clears the controlled inputs,
        // and because the underlying values are unchanged Svelte won't rewrite
        // them, so the fields would look empty until a manual refresh. Keeping
        // the values (and re-running load via the default invalidation) shows
        // the saved configuration immediately.
        await update({ reset: false });
        saving = false;
      };
    }}
  >
    <div class="flex items-center gap-4 border-b border-slate-100 p-5">
      <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-600 ring-1 ring-inset ring-brand-200/60 shadow-sm">
        <Settings class="w-5 h-5" />
      </div>
      <div>
        <h3 class="text-base font-bold text-slate-900 tracking-tight">Configuration</h3>
        <p class="mt-0.5 text-xs font-medium text-slate-500">Global settings for your payment gateway</p>
      </div>
    </div>

    <div class="p-5 space-y-5">
      <div class="grid gap-5 sm:grid-cols-2">
      <div class="space-y-1">
        <label for="poll_interval" class="gp-label">Poll Interval (ms)</label>
        <input
          id="poll_interval"
          name="poll_interval"
          type="text"
          inputmode="numeric"
          value={fieldValue('poll_interval', data.config.poll_interval)}
          class="gp-input"
          placeholder="e.g. 5000"
        />
        <p class="gp-hint">Must be a whole number between 1000 and 60000 milliseconds.</p>
      </div>

      <div class="space-y-1">
        <label for="webhook_url" class="gp-label">Default Webhook URL</label>
        <input
          id="webhook_url"
          name="webhook_url"
          type="text"
          value={fieldValue('webhook_url', data.config.webhook_url)}
          class="gp-input"
          placeholder="https://example.com/webhook"
        />
        <p class="gp-hint">Absolute http or https URL, used when a payment has no webhook of its own.</p>
      </div>

      <div class="space-y-1 sm:col-span-2">
        <label for="display_timezone" class="gp-label">Display Timezone</label>
        <Select
          id="display_timezone"
          name="display_timezone"
          bind:value={displayTimezone}
          options={timezoneOptions}
          placeholder="Select a timezone"
          ariaLabel="Display timezone"
        />
        <p class="gp-hint">
          IANA timezone used to render the ISO timestamp fields in API responses. Default
          applied to payments that do not specify their own tz. Stored timestamps stay
          absolute (epoch milliseconds); this only changes how they are displayed.
        </p>
      </div>

    </div>

      <div class="flex justify-end">
        <button type="submit" disabled={saving} class="gp-btn-primary w-full sm:w-auto">
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
      </div>
    </div>
  </form>
</section>
