// Component test for the API Documentation page.
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import DocsPage from '../routes/docs/+page.svelte';

describe('API Documentation page', () => {
  it('documents the main endpoints and the webhook', () => {
    render(DocsPage);
    expect(screen.getByRole('heading', { name: /create payment/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^8\. webhook/i })).toBeInTheDocument();
    // The webhook payload sample and signature header are present.
    expect(screen.getAllByText(/"payment_id"/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/X-Signature/).length).toBeGreaterThan(0);
    // The event signal is documented (header + signed body field).
    expect(screen.getAllByText(/X-Event/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/"payment_status"/).length).toBeGreaterThan(0);
  });
});
