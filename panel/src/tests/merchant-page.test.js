// Component tests for the Merchant Profile page.
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import MerchantPage from '../routes/merchant/+page.svelte';

/**
 * @param {object} [data]
 */
function renderMerchantPage(
  data = {
    profile: {
      owner_name: 'Budi Santoso',
      id_number: '3174123456789012',
      email: 'budi@example.com',
      phone: '081234567890',
      address: 'Jl. Merdeka No.1',
      merchant_name: 'Budi Store',
      id: 'merchant-budi',
      outlet_address: 'Jl. Merdeka No.2',
      postal_code: '12345',
      category: 'UMI',
      nmid: 'NMID12345678',
      mpan: 'MPAN87654321',
      mcc: '5812',
      terminal_id: 'A01',
      qris_string: '000201010211...',
      bank_name: 'Bank Central Asia',
      account_name: 'Budi Santoso',
      account_no: '1234567890'
    },
    loadError: null
  }
) {
  return render(MerchantPage, { props: { data } });
}

describe('Merchant Profile page', () => {
  it('renders the merchant details sections', () => {
    renderMerchantPage();
    expect(screen.getByText('Merchant Details')).toBeInTheDocument();
    expect(screen.getByText('Owner Identity')).toBeInTheDocument();
    expect(screen.getByText('Settlement Account')).toBeInTheDocument();
  });

  it('displays merchant information correctly', () => {
    renderMerchantPage();
    expect(screen.getByText('Budi Store')).toBeInTheDocument();
    expect(screen.getByText('merchant-budi')).toBeInTheDocument();
    expect(screen.getByText('UMI (Usaha Mikro)')).toBeInTheDocument();
    expect(screen.getByText('NMID12345678')).toBeInTheDocument();
    expect(screen.getByText('MPAN87654321')).toBeInTheDocument();
    expect(screen.getByText('5812')).toBeInTheDocument();
  });

  it('displays owner information correctly', () => {
    renderMerchantPage();
    expect(screen.getAllByText('Budi Santoso').length).toBeGreaterThan(0);
    expect(screen.getByText('3174********9012')).toBeInTheDocument();
    expect(screen.getByText('budi@example.com')).toBeInTheDocument();
    expect(screen.getByText('081234567890')).toBeInTheDocument();
  });

  it('displays settlement bank information correctly', () => {
    renderMerchantPage();
    expect(screen.getByText('Bank Central Asia')).toBeInTheDocument();
    expect(screen.getByText('1234567890')).toBeInTheDocument();
  });

  it('renders an error message when loadError is present', () => {
    renderMerchantPage({
      profile: null,
      loadError: 'Failed to fetch profile'
    });
    expect(screen.getByText('Error Loading Profile')).toBeInTheDocument();
    expect(screen.getByText('Failed to fetch profile')).toBeInTheDocument();
  });
});
