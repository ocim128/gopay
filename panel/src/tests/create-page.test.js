// Component tests for the Create Payment page.
//
// Verifies the page exposes the required inputs: an amount mode choice
// (Client_Managed_Mode / Server_Managed_Mode), an amount / base amount field,
// the optional `timeout` and `tolerance` fields, and a submit control.
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import CreatePage from '../routes/create/+page.svelte';

/**
 * The Create Payment page reads a `form` prop supplied by its action; a null
 * value matches the initial (pre-submit) render produced by the load/action.
 * @param {object} [form]
 */
function renderCreatePage(form = null) {
  return render(CreatePage, { props: { form } });
}

describe('Create Payment page', () => {
  it('renders the payment creation form', () => {
    renderCreatePage();
    expect(screen.getByRole('form')).toBeInTheDocument();
  });

  it('offers both amount mode choices as radios', () => {
    renderCreatePage();
    const clientMode = screen.getByRole('radio', { name: /client-managed/i });
    const serverMode = screen.getByRole('radio', { name: /server-managed/i });
    expect(clientMode).toBeInTheDocument();
    expect(serverMode).toBeInTheDocument();
    // Both radios share the same `mode` group so the choice is mutually exclusive.
    expect(clientMode).toHaveAttribute('name', 'mode');
    expect(serverMode).toHaveAttribute('name', 'mode');
  });

  it('shows the amount input in the default client-managed mode', () => {
    renderCreatePage();
    const amount = document.querySelector('input[name="amount"]');
    expect(amount).not.toBeNull();
    expect(amount).toHaveAttribute('type', 'hidden');
  });

  it('shows the base_amount input when server-managed mode is selected', () => {
    // The action echoes prior values; selecting server-managed swaps the field.
    renderCreatePage({ values: { mode: 'server_managed' } });
    const baseAmount = document.querySelector('input[name="base_amount"]');
    expect(baseAmount).not.toBeNull();
    expect(baseAmount).toHaveAttribute('type', 'hidden');
  });

  it('exposes the optional timeout and tolerance inputs', () => {
    renderCreatePage();
    const timeout = document.querySelector('input[name="timeout"]');
    const tolerance = document.querySelector('input[name="tolerance"]');
    expect(timeout).not.toBeNull();
    expect(tolerance).not.toBeNull();
    expect(timeout).toHaveAttribute('type', 'number');
    expect(tolerance).toHaveAttribute('type', 'number');
  });

  it('exposes the optional webhook_url input', () => {
    renderCreatePage();
    const webhookUrl = document.querySelector('input[name="webhook_url"]');
    expect(webhookUrl).not.toBeNull();
    expect(webhookUrl).toHaveAttribute('type', 'url');
  });

  it('provides a submit button to create the payment', () => {
    renderCreatePage();
    const submit = screen.getByRole('button', { name: /create payment/i });
    expect(submit).toBeInTheDocument();
    expect(submit).toHaveAttribute('type', 'submit');
  });
});
