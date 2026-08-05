<script>
  import { CirclePlus, CreditCard, ArrowRightLeft, Key, BookOpen, Settings, ChevronRight, Store } from '@lucide/svelte';

  /** @type {{ data: { authenticated: boolean } }} */
  let { data } = $props();

  // Quick-action tiles, echoing the GoPay "Layanan utama" grid.
  const actions = [
    {
      href: '/create',
      title: 'Create Payment',
      desc: 'Generate a dynamic QRIS',
      icon: CirclePlus,
      tint: 'from-brand-400 to-brand-600'
    },
    {
      href: '/payments',
      title: 'Payments',
      desc: 'Track pending & settled',
      icon: CreditCard,
      tint: 'from-emerald-400 to-emerald-600'
    },
    {
      href: '/transactions',
      title: 'Transactions',
      desc: 'Recent provider mutations',
      icon: ArrowRightLeft,
      tint: 'from-violet-400 to-violet-600'
    },
    {
      href: '/api-keys',
      title: 'API Keys',
      desc: 'Issue & revoke keys',
      icon: Key,
      tint: 'from-amber-400 to-amber-600'
    },
    {
      href: '/docs',
      title: 'API Docs',
      desc: 'Integrate the REST API',
      icon: BookOpen,
      tint: 'from-slate-500 to-slate-700'
    },
    {
      href: '/config',
      title: 'Configuration',
      desc: 'QRIS, webhook, polling',
      icon: Settings,
      tint: 'from-rose-400 to-rose-600'
    }
  ];
</script>

<svelte:head>
  <title>GoMerch | Dashboard</title>
</svelte:head>

<section class="space-y-6">
  <!-- Welcome hero -->
  <div class="relative overflow-hidden rounded-3xl bg-gradient-to-br from-brand-400 via-brand-500 to-brand-700 px-6 py-8 text-white shadow-brand sm:px-8">
    <div class="relative z-10 max-w-xl">
      <p class="text-sm font-medium text-white/80">Welcome Back</p>
      <h2 class="mt-1 text-2xl font-extrabold sm:text-3xl">Your Merchant Dashboard</h2>
      <p class="mt-2 text-sm text-white/80">
        Create dynamic QRIS, auto-detect settlement, and deliver signed webhooks
        (paid / expired) — all on top of your GoPay Merchant account.
      </p>
      <div class="mt-5 flex flex-wrap gap-3">
        <a href="/merchant" class="gp-btn bg-white text-brand-700 hover:bg-white/90">
          <Store class="h-4 w-4" strokeWidth={2} />
          Merchant Profile
        </a>
      </div>
    </div>
    <div class="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-white/10 blur-2xl"></div>
    <div class="pointer-events-none absolute -bottom-20 right-24 h-56 w-56 rounded-full bg-white/10 blur-2xl"></div>
  </div>

  <!-- Quick actions -->
  <div>
    <h3 class="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Quick actions</h3>
    <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {#each actions as action (action.href)}
        {@const Icon = action.icon}
        <a
          href={action.href}
          class="group gp-card gp-card-pad flex items-center gap-4 transition hover:-translate-y-0.5 hover:shadow-card-hover"
        >
          <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br {action.tint} text-white shadow-sm">
            <Icon class="h-5 w-5" strokeWidth={1.8} />
          </span>
          <span class="min-w-0">
            <span class="flex items-center gap-1 font-semibold text-slate-900">
              <span class="truncate">{action.title}</span>
              <ChevronRight class="h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-500" strokeWidth={2} />
            </span>
            <span class="mt-0.5 block text-sm text-slate-500 truncate">{action.desc}</span>
          </span>
        </a>
      {/each}
    </div>
  </div>
</section>
