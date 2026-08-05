<script>
  import '../app.css';
  import { page } from '$app/stores';

  import { afterNavigate } from '$app/navigation';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  import { LayoutDashboard, CirclePlus, CreditCard, ArrowRightLeft, Store, Settings, Key, BookOpen, LogOut, Wallet, Menu, X } from '@lucide/svelte';

  /** @type {{ data: { authenticated: boolean, summary?: { poll_interval: number|null, display_timezone: string|null, merchant_id: string|null, merchant_name: string|null } }, children: import('svelte').Snippet }} */
  let { data, children } = $props();

  let isMobileMenuOpen = $state(false);

  afterNavigate(() => {
    isMobileMenuOpen = false;
  });

  // Navigation model using Lucide icons.
  const nav = [
    {
      href: '/',
      label: 'Dashboard',
      exact: true,
      icon: LayoutDashboard
    },
    {
      href: '/create',
      label: 'Create Payment',
      icon: CirclePlus
    },
    {
      href: '/payments',
      label: 'Payments',
      icon: CreditCard
    },
    {
      href: '/transactions',
      label: 'Transactions',
      icon: ArrowRightLeft
    },
    {
      href: '/api-keys',
      label: 'API Keys',
      icon: Key
    },
    {
      href: '/docs',
      label: 'API Docs',
      icon: BookOpen
    },
    {
      href: '/config',
      label: 'Configuration',
      icon: Settings
    },
    {
      href: '/merchant',
      label: 'Merchant Profile',
      icon: Store
    }
  ];

  /**
   * Whether a nav item is active for the current path.
   * @param {{ href: string, exact?: boolean }} item
   * @param {string} pathname
   * @returns {boolean}
   */
  function isActive(item, pathname) {
    return item.exact ? pathname === item.href : pathname.startsWith(item.href);
  }

  const pathname = $derived($page.url.pathname);
  const currentLabel = $derived(
    nav.find((item) => isActive(item, pathname))?.label ?? 'GoPay Payment Panel'
  );

  const summary = $derived(data.summary ?? {});
  // Show the resolved merchant ID (e.g. G497056675), not the merchant name.
  const merchantLabel = $derived(summary.merchant_id || 'Merchant');
  // The merchant's short name: the first comma-separated segment, e.g.
  // "Scalify Panel, Digital & Kreatif" -> "Scalify Panel".
  const merchantShortName = $derived((summary.merchant_name || '').split(',')[0].trim() || 'Panel');
  const pollSeconds = $derived(
    typeof summary.poll_interval === 'number' ? `${summary.poll_interval / 1000}s` : null
  );
  
  const tzAbbr = $derived.by(() => {
    const tz = summary.display_timezone;
    if (!tz) return '';
    const map = {
      'Asia/Jakarta': 'WIB',
      'Asia/Makassar': 'WITA',
      'Asia/Jayapura': 'WIT',
      'UTC': 'UTC'
    };
    return map[tz] || tz.split('/').pop() || tz;
  });
</script>

{#if data.authenticated}
  <div class="min-h-screen bg-slate-50 lg:flex">
    <!-- Sidebar (desktop) -->
    <aside
      class="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-slate-200 lg:bg-white shadow-sm z-30"
    >
      <!-- Brand -->
      <div class="bg-white px-5 py-4 text-slate-900 border-b border-slate-100">
        <div class="flex items-center gap-3">
          <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white">
            <Wallet class="h-6 w-6" strokeWidth={1.8} />
          </span>
          <div class="leading-tight">
            <p class="text-sm font-bold tracking-tight">GoMerch</p>
            <p class="max-w-[10rem] truncate text-xs text-slate-500 font-medium">{merchantShortName}</p>
          </div>
        </div>
      </div>

      <!-- Nav -->
      <nav class="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {#each nav as item (item.href)}
          {@const Icon = item.icon}
          <a
            href={item.href}
            class="gp-nav-link {isActive(item, pathname) ? 'gp-nav-link-active' : ''}"
            aria-current={isActive(item, pathname) ? 'page' : undefined}
          >
            <Icon class="h-5 w-5 shrink-0" strokeWidth={1.8} />
            <span>{item.label}</span>
          </a>
        {/each}
      </nav>

      <!-- Logout -->
      <div class="border-t border-slate-100 p-3">
        <form method="POST" action="/logout">
          <button type="submit" class="gp-nav-link w-full text-slate-600 hover:text-red-600">
            <LogOut class="h-5 w-5 shrink-0" strokeWidth={1.8} />
            <span>Logout</span>
          </button>
        </form>
      </div>
    </aside>

    <!-- Content column -->
    <div class="flex min-h-screen min-w-0 flex-1 flex-col lg:pl-64">
      <!-- Topbar -->
      <header class="sticky top-0 z-20 bg-white">
        
        <!-- ROW 1 (Mobile/Tablet only): Brand & Menu Toggle -->
        <div class="flex lg:hidden items-center justify-between gap-4 border-b border-slate-100 px-4 py-4 sm:px-6">
          <!-- Brand (same as sidebar) -->
          <div class="flex items-center gap-3 text-slate-900">
            <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white">
              <Wallet class="h-6 w-6" strokeWidth={1.8} />
            </span>
            <div class="leading-tight">
              <p class="text-sm font-bold tracking-tight">GoMerch</p>
              <p class="max-w-[10rem] truncate text-xs text-slate-500 font-medium">{merchantShortName}</p>
            </div>
          </div>
          <!-- Menu Toggle -->
          <button type="button" class="p-2 text-slate-600 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition" aria-label="Toggle menu" onclick={() => isMobileMenuOpen = true}>
            <Menu class="h-6 w-6" strokeWidth={1.8} />
          </button>
        </div>

        <!-- ROW 2 (or Desktop Row 1): Page Title & Right Chips -->
        <div class="flex items-center justify-between gap-4 border-b border-slate-100 px-4 py-4 sm:px-6 lg:py-[calc(var(--spacing)*5.25)]">
          <div class="flex items-center gap-2">
            <h1 class="text-base font-semibold text-slate-900 sm:text-lg">{currentLabel}</h1>
          </div>
          <div class="flex items-center gap-2">
            <!-- Config summary chips -->
            {#if pollSeconds}
              <span class="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-1.5 sm:px-3 text-[11px] sm:text-xs font-medium text-slate-600">
                <svg class="h-3.5 w-3.5 text-brand-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                <span class="hidden sm:inline">Poll {pollSeconds}</span>
                <span class="sm:hidden">{pollSeconds}</span>
              </span>
            {/if}
            {#if summary.display_timezone}
              <span class="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-1.5 sm:px-3 text-[11px] sm:text-xs font-medium text-slate-600">
                <svg class="h-3.5 w-3.5 text-brand-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a15 15 0 010 18 15 15 0 010-18z" /></svg>
                <span class="hidden sm:inline">{summary.display_timezone}</span>
                <span class="sm:hidden">{tzAbbr}</span>
              </span>
            {/if}
            <!-- Version Info -->
            <span class="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2 py-1.5 sm:px-3 text-[11px] sm:text-xs font-medium text-slate-600">
              <svg class="h-3.5 w-3.5 text-brand-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              <span>v2.0.0</span>
            </span>
          </div>
        </div>
      </header>

      <main class="mx-auto w-full min-w-0 max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
        {@render children()}
      </main>
    </div>
  </div>

  <!-- Mobile Drawer Overlay -->
  {#if isMobileMenuOpen}
    <div class="fixed inset-0 z-50 lg:hidden">
      <!-- Backdrop -->
      <div 
        transition:fade={{ duration: 200, easing: cubicOut }}
        class="fixed inset-0 bg-slate-900/50 backdrop-blur-sm" 
        aria-hidden="true" 
        onclick={() => isMobileMenuOpen = false}>
      </div>
      
      <!-- Drawer Panel -->
      <div 
        transition:fly={{ x: 320, duration: 250, easing: cubicOut }}
        class="fixed inset-y-0 right-0 w-full max-w-xs bg-white shadow-2xl flex flex-col">
        <div class="flex items-center justify-between px-4 py-4 border-b border-slate-100">
          <span class="font-bold text-slate-900 tracking-tight">Menu</span>
          <button type="button" class="p-2 text-slate-500 hover:text-slate-900 rounded-lg transition hover:bg-slate-100" aria-label="Close menu" onclick={() => isMobileMenuOpen = false}>
            <X class="h-6 w-6" strokeWidth={1.8} />
          </button>
        </div>
        
        <nav class="flex-1 space-y-1 overflow-y-auto px-4 py-4">
          {#each nav as item (item.href)}
            {@const Icon = item.icon}
            <a
              href={item.href}
              class="gp-nav-link {isActive(item, pathname) ? 'gp-nav-link-active' : ''}"
              aria-current={isActive(item, pathname) ? 'page' : undefined}
            >
              <Icon class="h-5 w-5 shrink-0" strokeWidth={1.8} />
              <span>{item.label}</span>
            </a>
          {/each}
        </nav>

        <div class="border-t border-slate-100 p-3">
          <form method="POST" action="/logout">
            <button type="submit" class="gp-nav-link w-full text-slate-600 hover:text-red-600">
              <LogOut class="h-5 w-5 shrink-0" strokeWidth={1.8} />
              <span>Logout</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  {/if}
{:else}
  {@render children()}
{/if}
