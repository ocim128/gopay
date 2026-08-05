<script>
  import { AlertCircle, Store, Landmark, Clock, QrCode, Check, User, ShieldCheck } from '@lucide/svelte';

  /** @type {import('./$types').PageData} */
  let { data } = $props();

  function formatCriteria(criteria) {
    if (!criteria) return 'N/A';
    if (criteria.includes('UMI')) return `${criteria} (Usaha Mikro)`;
    if (criteria.includes('UKE')) return `${criteria} (Usaha Kecil)`;
    if (criteria.includes('UME')) return `${criteria} (Usaha Menengah)`;
    if (criteria.includes('UBE')) return `${criteria} (Usaha Besar)`;
    return criteria;
  }
</script>

<svelte:head>
  <title>GoMerch | Merchant</title>
</svelte:head>


{#if data.loadError}
  <div class="rounded-xl border-l-4 border-red-500 bg-red-50 p-4 shadow-sm mb-6">
    <div class="flex items-center gap-3">
      <AlertCircle class="h-5 w-5 text-red-600" />
      <h3 class="text-sm font-semibold text-red-800">Error Loading Profile</h3>
    </div>
    <div class="mt-2 pl-8">
      <p class="text-sm text-red-700">{data.loadError}</p>
    </div>
  </div>
{:else if data.profile}
  <div class="space-y-5">
    <!-- Merchant Details -->
    <div class="gp-card">
      <div class="flex items-center gap-4 border-b border-slate-100 p-5">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-50 to-brand-100 text-brand-600 ring-1 ring-inset ring-brand-200/60 shadow-sm">
          <Store class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-base font-bold text-slate-900 tracking-tight">Merchant Details</h3>
          <p class="mt-0.5 text-xs font-medium text-slate-500">Primary information of your registered outlet</p>
        </div>
      </div>
      
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-6 p-5">
        <div>
          <p class="text-xs font-medium text-slate-500">Merchant Name</p>
          <p class="mt-1 text-sm font-semibold text-slate-900">{data.profile.merchant_name || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">Merchant ID</p>
          <p class="mt-1 text-sm text-slate-700 font-mono tracking-wide">{data.profile.id || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">Merchant Criteria</p>
          <p class="mt-1 text-sm text-slate-700 font-mono tracking-wide">{formatCriteria(data.profile.category)}</p>
        </div>
        <div class="md:col-span-2 lg:col-span-1">
          <p class="text-xs font-medium text-slate-500">Postal Code</p>
          <p class="mt-1 text-sm text-slate-700">{data.profile.postal_code || 'N/A'}</p>
        </div>
        <div class="md:col-span-2 lg:col-span-4">
          <p class="text-xs font-medium text-slate-500">Merchant Address</p>
          <p class="mt-1 text-sm text-slate-700 leading-relaxed">{data.profile.outlet_address || 'N/A'}</p>
        </div>
        
        <div>
          <p class="text-xs font-medium text-slate-500">NMID</p>
          <div class="mt-1 flex items-center gap-2">
            <p class="text-sm text-slate-900 font-mono tracking-wide">{data.profile.nmid || 'N/A'}</p>
            {#if data.profile.nmid}
              <span class="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20"><ShieldCheck class="w-3 h-3 mr-1 inline"/>Verified</span>
            {/if}
          </div>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">MPAN</p>
          <p class="mt-1 text-sm text-slate-900 font-mono tracking-wide">{data.profile.mpan || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">Terminal ID</p>
          <p class="mt-1 text-sm text-slate-900 font-mono tracking-wide">{data.profile.terminal_id || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">MCC</p>
          <p class="mt-1 text-sm text-slate-900 font-mono tracking-wide">{data.profile.mcc || 'N/A'}</p>
        </div>
        <div class="md:col-span-2 lg:col-span-4">
          <p class="text-xs font-medium text-slate-500 mb-2">Static QRIS Payload</p>
          <div class="rounded-lg border border-slate-200 bg-slate-50 p-4 shadow-inner">
            <p class="text-xs text-slate-600 font-mono break-all leading-relaxed">
              {data.profile.qris_string || 'N/A'}
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- Settlement Account -->
    <div class="gp-card">
      <div class="flex items-center gap-4 border-b border-slate-100 p-5">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-600 ring-1 ring-inset ring-emerald-200/60 shadow-sm">
          <Landmark class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-base font-bold text-slate-900 tracking-tight">Settlement Account</h3>
          <p class="mt-0.5 text-xs font-medium text-slate-500">Bank account information for daily payouts</p>
        </div>
      </div>
      
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-6 p-5">
        <div>
          <p class="text-xs font-medium text-slate-500">Bank / E-Wallet</p>
          <p class="mt-1 text-sm font-semibold text-slate-900">{data.profile.bank_name || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">Account Name</p>
          <p class="mt-1 text-sm text-slate-700">{data.profile.account_name || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">Account Number</p>
          <p class="mt-1 text-sm text-slate-700 font-mono tracking-wide">{data.profile.account_no || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">Daily Settlement Time</p>
          <div class="mt-1 flex items-center gap-2 text-sm text-slate-700">
            <Clock class="h-4 w-4 text-slate-400" />
            {data.profile.settlement_time || 'N/A'} (WIB)
          </div>
        </div>
      </div>
    </div>

    <!-- Owner Identity -->
    <div class="gp-card">
      <div class="flex items-center gap-4 border-b border-slate-100 p-5">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-50 to-blue-100 text-blue-600 ring-1 ring-inset ring-blue-200/60 shadow-sm">
          <User class="w-5 h-5" />
        </div>
        <div>
          <h3 class="text-base font-bold text-slate-900 tracking-tight">Owner Identity</h3>
          <p class="mt-0.5 text-xs font-medium text-slate-500">Registered personal identity of the business owner</p>
        </div>
      </div>
      
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-6 p-5">
        <div>
          <p class="text-xs font-medium text-slate-500">Owner Name</p>
          <p class="mt-1 text-sm font-semibold text-slate-900">{data.profile.owner_name || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">ID Number (KTP/Passport)</p>
          <p class="mt-1 text-sm text-slate-700 font-mono tracking-wide">{data.profile.id_number ? data.profile.id_number.slice(0, 4) + '*'.repeat(data.profile.id_number.length - 8) + data.profile.id_number.slice(-4) : 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">Phone</p>
          <p class="mt-1 text-sm text-slate-700">{data.profile.phone || 'N/A'}</p>
        </div>
        <div>
          <p class="text-xs font-medium text-slate-500">Email</p>
          <p class="mt-1 text-sm text-slate-700 break-all">{data.profile.email || 'N/A'}</p>
        </div>
        <div class="md:col-span-2 lg:col-span-4">
          <p class="text-xs font-medium text-slate-500">Residential Address</p>
          <p class="mt-1 text-sm text-slate-700 leading-relaxed">{data.profile.address || 'N/A'}</p>
        </div>
      </div>
    </div>
  </div>
{/if}
