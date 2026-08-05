<script>
  // A lightweight custom select / dropdown that replaces the native <select>
  // (and the browser's datalist popup) with a fully styled, keyboard-navigable
  // listbox. The chosen value is mirrored into a hidden <input> so it submits
  // with a normal HTML form just like a native control.
  import { onMount } from 'svelte';

  /**
   * @type {{
   *   value?: string,
   *   options?: Array<{ value: string, label: string }>,
   *   name?: string,
   *   id?: string,
   *   placeholder?: string,
   *   ariaLabel?: string
   * }}
   */
  let {
    value = $bindable(''),
    options = [],
    name = undefined,
    id = undefined,
    placeholder = 'Select…',
    ariaLabel = undefined
  } = $props();

  let open = $state(false);
  let activeIndex = $state(-1);
  /** @type {HTMLDivElement | undefined} */
  let root;
  /** @type {HTMLButtonElement | undefined} */
  let buttonEl;

  const selected = $derived(options.find((o) => o.value === value) ?? null);

  function openMenu() {
    open = true;
    activeIndex = options.findIndex((o) => o.value === value);
  }

  function close() {
    open = false;
    activeIndex = -1;
  }

  function toggle() {
    if (open) {
      close();
    } else {
      openMenu();
    }
  }

  /** @param {string} next */
  function choose(next) {
    value = next;
    close();
    buttonEl?.focus();
  }

  /** @param {PointerEvent} event */
  function onWindowPointer(event) {
    if (open && root && !root.contains(/** @type {Node} */ (event.target))) {
      close();
    }
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenu();
        if (activeIndex < 0) {
          activeIndex = 0;
        }
        return;
      }
      const count = options.length;
      if (count === 0) {
        return;
      }
      const dir = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + dir + count) % count;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open && activeIndex >= 0 && activeIndex < options.length) {
        choose(options[activeIndex].value);
      } else {
        toggle();
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        close();
      }
    } else if (event.key === 'Tab') {
      close();
    }
  }

  onMount(() => {
    window.addEventListener('pointerdown', onWindowPointer);
    return () => window.removeEventListener('pointerdown', onWindowPointer);
  });
</script>

<div class="relative" bind:this={root}>
  {#if name}
    <input type="hidden" {name} {value} />
  {/if}

  <button
    type="button"
    {id}
    bind:this={buttonEl}
    onclick={toggle}
    onkeydown={onKeydown}
    aria-haspopup="listbox"
    aria-expanded={open}
    aria-label={ariaLabel}
    class="gp-input flex w-full items-center justify-between gap-2 text-left"
  >
    <span class={selected ? 'text-slate-900' : 'text-slate-400'}>
      {selected ? selected.label : placeholder}
    </span>
    <svg
      class={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  </button>

  {#if open}
    <ul
      role="listbox"
      class="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg"
    >
      {#each options as opt, i (opt.value)}
        <li role="option" aria-selected={opt.value === value}>
          <button
            type="button"
            onclick={() => choose(opt.value)}
            onmouseenter={() => (activeIndex = i)}
            class={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
              i === activeIndex ? 'bg-brand-50 text-brand-700' : 'text-slate-700'
            } ${opt.value === value ? 'font-semibold' : ''}`}
          >
            <span>{opt.label}</span>
            {#if opt.value === value}
              <svg class="h-4 w-4 text-brand-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
