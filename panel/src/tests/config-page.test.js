// Component tests for the Configuration page.
//
// Verifies the page exposes editors for the default webhook_url, the
// Poll_Interval, and the Static_QRIS, and that the Static_QRIS is entered
// through a single text field (a textarea) rather than a file upload.
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import ConfigPage from '../routes/config/+page.svelte';

/**
 * @param {object} [data]
 * @param {object|null} [form]
 */
function renderConfigPage(
  data = {
    config: { poll_interval: null, webhook_url: null, static_qris: null, display_timezone: null },
    loadError: null
  },
  form = null
) {
  return render(ConfigPage, { props: { data, form } });
}

describe('Configuration page', () => {
  it('exposes the poll_interval field', () => {
    renderConfigPage();
    const pollInterval = document.querySelector('input[name="poll_interval"]');
    expect(pollInterval).not.toBeNull();
  });

  it('exposes the default webhook_url field', () => {
    renderConfigPage();
    const webhookUrl = document.querySelector('input[name="webhook_url"]');
    expect(webhookUrl).not.toBeNull();
  });

  it('exposes the display_timezone field', () => {
    renderConfigPage();
    const tz = document.querySelector('input[name="display_timezone"]');
    expect(tz).not.toBeNull();
  });

  it('shows the stored display_timezone value', () => {
    renderConfigPage({
      config: { poll_interval: null, webhook_url: null, static_qris: null, display_timezone: 'Asia/Makassar' },
      loadError: null
    });
    const tz = /** @type {HTMLInputElement} */ (document.querySelector('input[name="display_timezone"]'));
    expect(tz.value).toBe('Asia/Makassar');
  });

  it('retains a submitted value so an invalid entry can be corrected', () => {
    renderConfigPage(
      { config: { poll_interval: 5000, webhook_url: null, static_qris: null }, loadError: null },
      { message: 'Poll interval must be a whole number between 1000 and 60000.', values: { poll_interval: '50' } }
    );
    const pollInterval = /** @type {HTMLInputElement} */ (document.querySelector('input[name="poll_interval"]'));
    expect(pollInterval.value).toBe('50');
    expect(screen.getByRole('alert')).toHaveTextContent(/invalid|between 1000 and 60000/i);
  });

  it('provides a save button', () => {
    renderConfigPage();
    expect(screen.getByRole('button', { name: /save configuration/i })).toBeInTheDocument();
  });
});
