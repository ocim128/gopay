// Component tests for the Transactions page.
//
// Verifies the page renders rows with the financial columns (time, order id,
// gross, net, fee, status) and that clicking a row opens a detail drawer that
// shows the structured GoBiz sections plus the full raw JSON dump, alongside
// the days selector and a refresh control.
import { render, screen, within, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import TransactionsPage from '../routes/transactions/+page.svelte';

/**
 * @param {object} [overrides]
 */
function renderTransactionsPage(overrides = {}) {
  const data = {
    transactions: [],
    days: 7,
    loadError: null,
    ...overrides
  };
  return render(TransactionsPage, { props: { data } });
}

// A canonical transaction whose `raw` mirrors the rich GoBiz analytics shape.
// Money fields in `raw` are in sen (Rupiah * 100); the canonical `amount` is
// already in Rupiah (gross_amount / 100).
const sampleTx = {
  txId: 'TX-12345',
  amount: 25000,
  type: 'payin',
  time: 1700000000000,
  raw: {
    id: 'TX-12345',
    order_id: 'QRIS-TX-12345',
    transaction_status: 'SETTLEMENT',
    payment_type: 'QRIS',
    service_type: 'QRIS',
    channel_type: 'STATIC_QR',
    transaction_source: 'GOPAY_INSTORE',
    currency: 'IDR',
    gross_amount: 2500000,
    real_gross_amount: 2500000,
    qris_on_us: true,
    qris_provider_aspi_issuer: 'GOPAY',
    qris_provider_aspi_acquirer: 'gopay',
    customer_first_name: 'Test',
    customer_last_name: 'Customer',
    customer_phone: '+628000000000',
    shares: [
      {
        merchant_share: 2492500,
        platform_total_fee: 7500,
        provider_share: 7500,
        gojek_share: 0,
        merchant_percentage_fee: 0.003,
        merchant_fixed_fee: 0
      }
    ],
    promo_details: { promo_code: '', promo_original_amount: 0 },
    transaction_history: [
      {
        action_time: '2026-06-29T06:20:46Z',
        action_name: 'Settlement Transaction',
        amount: 2500000,
        action_status: 'SETTLEMENT'
      }
    ]
  }
};

describe('Transactions page', () => {
  it('renders the financial column headers (time, order id, gross, net, fee, status)', () => {
    renderTransactionsPage();
    expect(screen.getByRole('columnheader', { name: /^transaction time$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /order id/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^gross$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^net$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^fee$/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /^status$/i })).toBeInTheDocument();
  });

  it('exposes the days selector and a refresh control', () => {
    renderTransactionsPage();
    expect(screen.getByRole('button', { name: /Period filter/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
  });

  it('renders a transaction row exposing the order id, amounts and status', () => {
    renderTransactionsPage({ transactions: [sampleTx] });
    const row = screen.getByText('QRIS-TX-12345').closest('tr');
    expect(row).not.toBeNull();
    const rowScope = within(/** @type {HTMLElement} */ (row));
    // Gross 2.500.000 sen => Rp 25.000; net 2.492.500 sen => Rp 24.925.
    expect(rowScope.getByText(/25\.000/)).toBeInTheDocument();
    expect(rowScope.getByText(/24\.925/)).toBeInTheDocument();
    expect(rowScope.getByText('SETTLEMENT')).toBeInTheDocument();
  });

  it('opens a detail drawer with structured sections and the full raw JSON', async () => {
    renderTransactionsPage({ transactions: [sampleTx] });

    const row = screen.getByText('QRIS-TX-12345').closest('tr');
    const detailButton = within(row).getByRole('button', { name: /detail/i });
    await fireEvent.click(detailButton);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /transaction detail/i })).toBeInTheDocument();
    });
    // Structured sections.
    expect(screen.getByRole('heading', { name: /settlement & fees/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^customer$/i })).toBeInTheDocument();
    expect(screen.getByText('Test Customer')).toBeInTheDocument();
    // Raw JSON dump still available for full transparency.
    expect(screen.getByText(/"payment_type": "QRIS"/)).toBeInTheDocument();
    expect(screen.getByText(/raw data/i)).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no transactions', () => {
    renderTransactionsPage({ transactions: [] });
    screen.debug();
    expect(screen.getByText(/no transactions in this window/i)).toBeInTheDocument();
  });
});
