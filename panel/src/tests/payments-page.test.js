// Component tests for the unified Payments page.
//
// Verifies the page renders the status filter controls, a table exposing the
// required columns (id, amount, status, created_at, expires_at), colored status
// badges for paid/expired rows, and that clicking a row id triggers the detail
// drawer (which fetches the full payment from the session-guarded proxy).
import { render, screen, within, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import PaymentsPage from '../routes/payments/+page.svelte';

// The page polls `/api/payments` on mount for live views and fetches
// `/api/payments/:id` for the detail drawer. Stub fetch so both resolve
// predictably without a real network request.
beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      if (typeof url === 'string' && /\/api\/payments\/[^/]+$/.test(url)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'pay_001',
            amount: 10042,
            status: 'pending',
            created_at: 1700000000000,
            expires_at: 1700000300000,
            timeout: 300000,
            tolerance: 0,
            webhook_url: null,
            tx_id: null,
            paid_amount: null,
            paid_at: null,
            qris_string: '00020101',
            webhook_logs: []
          })
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ payments: [], total: 0, limit: 50, offset: 0 })
      };
    })
  );
});

/**
 * @param {object} [overrides]
 */
function renderPaymentsPage(overrides = {}) {
  const data = {
    payments: [],
    total: 0,
    status: 'all',
    page: 1,
    pageSize: 50,
    hasPrev: false,
    hasNext: false,
    loadError: null,
    ...overrides
  };
  return render(PaymentsPage, { props: { data } });
}

describe('Unified Payments page', () => {
  it('renders the status filter controls (Select component)', () => {
    renderPaymentsPage();
    expect(screen.getByRole('button', { name: /status filter/i })).toBeInTheDocument();
  });

  it('renders column headers for id, amount, status, created_at, and expires_at', () => {
    renderPaymentsPage();
    expect(screen.getByRole('columnheader', { name: /^id$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^amount$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^status$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /created at/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /expires at/i })).toBeInTheDocument();
  });

  it('renders a colored badge for a paid and an expired row', () => {
    renderPaymentsPage({
      status: 'all',
      payments: [
        { id: 'pay_paid', amount: 5000, status: 'paid', created_at: 1700000000000, expires_at: 1700000500000 },
        { id: 'pay_exp', amount: 6000, status: 'expired', created_at: 1700000000000, expires_at: 1700000900000 }
      ]
    });

    const paidRow = screen.getByText(/pay_paid/).closest('tr');
    const expiredRow = screen.getByText(/pay_exp/).closest('tr');
    expect(paidRow).not.toBeNull();
    expect(expiredRow).not.toBeNull();
    const paidBadge = within(/** @type {HTMLElement} */ (paidRow)).getByText('paid');
    const expiredBadge = within(/** @type {HTMLElement} */ (expiredRow)).getByText('expired');
    expect(paidBadge.className).toMatch(/emerald/);
    expect(expiredBadge.className).toMatch(/red/);
  });

  it('exposes Payment Detail and Transaction Detail actions (Transaction enabled only for paid)', () => {
    renderPaymentsPage({
      status: 'all',
      payments: [
        { id: 'pay_paid', amount: 5000, status: 'paid', created_at: 1700000000000, expires_at: 1700000500000 },
        { id: 'pay_exp', amount: 6000, status: 'expired', created_at: 1700000000000, expires_at: 1700000900000 }
      ]
    });

    const paidRow = within(/** @type {HTMLElement} */ (screen.getByText(/pay_paid/).closest('tr')));
    const expiredRow = within(/** @type {HTMLElement} */ (screen.getByText(/pay_exp/).closest('tr')));

    // Both rows can open the payment detail.
    expect(paidRow.getByRole('button', { name: /payment detail/i })).toBeInTheDocument();
    expect(expiredRow.getByRole('button', { name: /payment detail/i })).toBeInTheDocument();

    // Transaction detail is a real button only for paid; expired has no such button.
    expect(paidRow.getByRole('button', { name: /transaction detail/i })).toBeInTheDocument();
    expect(expiredRow.queryByRole('button', { name: /transaction detail/i })).toBeNull();
  });

  it('shows an empty-state message when there are no payments', () => {
    renderPaymentsPage({ payments: [] });
    expect(screen.getByText(/no payments to show/i)).toBeInTheDocument();
  });

  it('opens the detail drawer when a row id is clicked', async () => {
    renderPaymentsPage({
      payments: [
        { id: 'pay_001', amount: 10042, status: 'pending', created_at: 1700000000000, expires_at: 1700000300000 }
      ]
    });

    const detailButton = screen.getByRole('button', { name: /^payment detail$/i });
    await fireEvent.click(detailButton);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /payment detail/i })).toBeInTheDocument();
    });
    // The drawer fetched the full payment and renders the webhook section.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /webhook deliveries/i })).toBeInTheDocument();
    });
  });
});
