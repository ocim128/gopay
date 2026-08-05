<script>
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  /**
   * A right-side detail drawer (GoBiz-merchant style): a gradient dim overlay
   * and a full-height panel that slides in/out from the right. No extra
   * dependency — built on Svelte transitions.
   *
   * @type {{
   *   open?: boolean,
   *   title?: string,
   *   size?: 'md'|'lg'|'xl',
   *   onClose?: () => void,
   *   children: import('svelte').Snippet
   * }}
   */
  let { open = false, title = '', size = 'lg', onClose = () => {}, children } = $props();

  const maxWidth = { md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-2xl' };

  /** @param {KeyboardEvent} event */
  function handleKeydown(event) {
    if (open && event.key === 'Escape') {
      onClose();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
  <div class="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
    <!-- Gradient black overlay (no blur), GoBiz-merchant style -->
    <button
      type="button"
      aria-label="Close"
      class="absolute inset-0 bg-gradient-to-l from-black/55 via-black/40 to-black/25"
      onclick={onClose}
      transition:fade={{ duration: 200 }}
    ></button>

    <!-- Sliding panel -->
    <aside
      class="relative flex h-full w-full {maxWidth[size] ?? maxWidth.lg} flex-col bg-white shadow-2xl"
      transition:fly={{ x: 480, duration: 280, easing: cubicOut, opacity: 1 }}
    >
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <h2 class="text-base font-semibold text-slate-900">{title}</h2>
        <button
          type="button"
          class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          aria-label="Close"
          onclick={onClose}
        >
          <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      <div class="flex-1 overflow-y-auto p-5">
        {@render children()}
      </div>
    </aside>
  </div>
{/if}
