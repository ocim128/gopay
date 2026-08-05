// Responsiveness checks for the protected Panel pages.
//
// LIMITATION: jsdom does not implement CSS layout, so it cannot measure the
// rendered width of elements or run a real 360px–1920px breakpoint sweep. A
// faithful "no horizontal scroll" check at concrete viewport widths requires a
// headless browser (e.g. Playwright) and is therefore out of scope for this
// jsdom component suite.
//
// Instead, these tests assert the structural invariants that keep the layout
// free of page-level horizontal scroll across 360px–1920px:
//   1. No element forces width with a fixed inline pixel `width`/`min-width`.
//   2. Any intentionally wide element (Tailwind `min-w-*`, such as the data
//      tables) is contained within an `overflow-x-auto` scroll wrapper, so the
//      wide content scrolls inside its own box rather than the whole page.
//   3. Pages use fluid/responsive container utilities (full-width `w-full`,
//      responsive grids, capped `max-w-*`) instead of fixed page widths.
import { render } from '@testing-library/svelte';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import CreatePage from '../routes/create/+page.svelte';
import PaymentsPage from '../routes/payments/+page.svelte';
import TransactionsPage from '../routes/transactions/+page.svelte';
import ApiKeysPage from '../routes/api-keys/+page.svelte';
import ConfigPage from '../routes/config/+page.svelte';

const paymentsData = {
  payments: [],
  total: 0,
  status: 'all',
  page: 1,
  pageSize: 50,
  hasPrev: false,
  hasNext: false,
  loadError: null
};

const pages = [
  { name: 'Create Payment', component: CreatePage, props: { form: null } },
  { name: 'Payments', component: PaymentsPage, props: { data: paymentsData } },
  { name: 'Transactions', component: TransactionsPage, props: { data: { transactions: [], days: 7, loadError: null } } },
  { name: 'API Keys', component: ApiKeysPage, props: { data: { keys: [], loadError: null }, form: null } },
  {
    name: 'Config',
    component: ConfigPage,
    props: {
      data: { config: { poll_interval: null, webhook_url: null, static_qris: null }, loadError: null },
      form: null
    }
  }
];

beforeEach(() => {
  // The Live Payments page polls on mount; keep fetch inert during render.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ payments: [] }) }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Walk up the DOM tree to determine whether any ancestor establishes a
 * horizontal scroll container (Tailwind `overflow-x-auto`/`overflow-auto`).
 * @param {Element} element
 * @param {Element} root
 * @returns {boolean}
 */
function hasScrollableAncestor(element, root) {
  let current = element.parentElement;
  while (current && current !== root.parentElement) {
    const className = current.getAttribute('class') ?? '';
    if (className.includes('overflow-x-auto') || className.includes('overflow-auto')) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

describe('Panel responsiveness invariants', () => {
  for (const page of pages) {
    describe(`${page.name} page`, () => {
      it('has no fixed inline pixel width that could force horizontal scroll', () => {
        const { container } = render(page.component, { props: page.props });
        const styled = container.querySelectorAll('[style]');
        for (const el of styled) {
          const style = el.getAttribute('style') ?? '';
          expect(style).not.toMatch(/(?:^|[^-])\bwidth\s*:\s*\d+px/i);
          expect(style).not.toMatch(/\bmin-width\s*:\s*\d+px/i);
        }
      });

      it('keeps any wide (min-w-*) element inside an overflow-x scroll wrapper', () => {
        const { container } = render(page.component, { props: page.props });
        const wideElements = container.querySelectorAll('[class*="min-w-"]');
        for (const el of wideElements) {
          expect(hasScrollableAncestor(el, container)).toBe(true);
        }
      });

      it('uses a fluid root container rather than a fixed-width one', () => {
        const { container } = render(page.component, { props: page.props });
        const root = container.querySelector('section');
        expect(root).not.toBeNull();
        // A top-level <section> should not pin itself to a fixed pixel width.
        const rootClass = root?.getAttribute('class') ?? '';
        expect(rootClass).not.toMatch(/\bw-\[\d+px\]/);
        expect(rootClass).not.toMatch(/\bmin-w-\[\d+px\]/);
      });
    });
  }
});
