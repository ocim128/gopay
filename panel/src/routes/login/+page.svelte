<script>
  import { enhance } from '$app/forms';

  /** @type {{ form: { username?: string, message?: string } | null }} */
  let { form } = $props();

  let submitting = $state(false);
  let username = $state('');
  $effect(() => {
    if (form?.username !== undefined) {
      username = form.username;
    }
  });
  let password = $state('');
</script>

<svelte:head>
  <title>GoMerch | Login</title>
</svelte:head>

<section class="grid min-h-screen lg:grid-cols-2">
  <!-- Brand panel -->
  <div class="relative hidden overflow-hidden bg-gradient-to-br from-brand-400 via-brand-500 to-brand-800 lg:flex lg:flex-col lg:justify-between lg:p-12 lg:text-white">
    <div class="flex items-center gap-3">
      <span class="flex h-11 w-11 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
        <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="M3 9h18M7 14h4" />
        </svg>
      </span>
      <div class="leading-tight">
        <p class="text-base font-semibold">GoMerch</p>
        <p class="text-sm text-white/70">Self-hosted PG</p>
      </div>
    </div>

    <div class="space-y-4">
      <h2 class="text-3xl font-extrabold leading-tight">Self-hosted QRIS<br />payment-gateway middleware</h2>
      <p class="max-w-md text-white/80">
        On top of a GoPay Merchant account — create dynamic QRIS, auto-detect
        settlement, and deliver signed webhooks (paid / expired).
      </p>
    </div>

    <!-- Decorative glow -->
    <div class="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl"></div>
    <div class="pointer-events-none absolute -bottom-28 -left-10 h-72 w-72 rounded-full bg-white/10 blur-2xl"></div>

    <p class="text-xs text-white/60">© GoMerch Self-hosted PG.</p>
  </div>

  <!-- Form panel -->
  <div class="flex items-center justify-center bg-slate-50 px-5 py-12">
    <div class="w-full max-w-sm">
      <div class="mb-6 flex items-center justify-center gap-3 lg:hidden">
        <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white">
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="14" rx="2" />
            <path d="M3 9h18M7 14h4" />
          </svg>
        </span>
        <div class="leading-tight text-left">
          <p class="text-base font-semibold text-slate-900">GoMerch</p>
          <p class="text-xs text-slate-500">Self-hosted PG</p>
        </div>
      </div>

      <div class="gp-card gp-card-pad">
        <h1 class="text-xl font-bold text-slate-900 text-center lg:text-left">Welcome Back</h1>
        <p class="mt-1 text-sm text-slate-500 text-center lg:text-left">Login to manage payments and configuration.</p>

        {#if form?.message}
          <p class="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {form.message}
          </p>
        {/if}

        <form
          method="POST"
          use:enhance={() => {
            submitting = true;
            return async ({ update, result }) => {
              await update();
              submitting = false;
              if (result.type === 'failure') {
                password = '';
              }
            };
          }}
          class="mt-5 space-y-4"
        >
          <div class="space-y-1">
            <label class="gp-label" for="username">Username</label>
            <input
              id="username"
              name="username"
              type="text"
              autocomplete="username"
              bind:value={username}
              disabled={submitting}
              required
              class="gp-input"
            />
          </div>

          <div class="space-y-1">
            <label class="gp-label" for="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autocomplete="current-password"
              bind:value={password}
              disabled={submitting}
              required
              class="gp-input"
            />
          </div>

          <button type="submit" disabled={submitting} class="gp-btn-primary w-full">
            {submitting ? 'Logging in…' : 'Login'}
          </button>
        </form>
      </div>
    </div>
  </div>
</section>
