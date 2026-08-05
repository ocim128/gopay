// Component tests for the API Keys management page.
//
// Verifies the page exposes both the create action and a revoke action, and
// that a newly created key value is surfaced once.
import { render, screen } from '@testing-library/svelte';
import { describe, it, expect } from 'vitest';
import ApiKeysPage from '../routes/api-keys/+page.svelte';

/**
 * @param {object} [data]
 * @param {object|null} [form]
 */
function renderApiKeysPage(data = { keys: [], loadError: null }, form = null) {
  return render(ApiKeysPage, { props: { data, form } });
}

describe('API Keys page', () => {
  it('provides a create API key action', () => {
    renderApiKeysPage();
    const createButton = screen.getByRole('button', { name: /create api key/i });
    expect(createButton).toBeInTheDocument();
    const createForm = createButton.closest('form');
    expect(createForm).not.toBeNull();
    expect(createForm).toHaveAttribute('action', '?/create');
  });

  it('provides a revoke action for active keys', () => {
    renderApiKeysPage({
      keys: [
        { id: 'k1', key_prefix: 'abcd', status: 'active', created_at: 1700000000000, revoked_at: null }
      ],
      loadError: null
    });
    const revokeButton = screen.getByRole('button', { name: /revoke/i });
    expect(revokeButton).toBeInTheDocument();
    const revokeForm = revokeButton.closest('form');
    expect(revokeForm).not.toBeNull();
    expect(revokeForm).toHaveAttribute('action', '?/revoke');
  });

  it('does not render a revoke action for already-revoked keys', () => {
    renderApiKeysPage({
      keys: [
        { id: 'k2', key_prefix: 'efgh', status: 'revoked', created_at: 1700000000000, revoked_at: 1700000500000 }
      ],
      loadError: null
    });
    expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull();
  });

  it('reveals a newly created key value once', () => {
    renderApiKeysPage({ keys: [], loadError: null }, { created: { value: 'sk_live_secret_value' } });
    expect(screen.getByText('sk_live_secret_value')).toBeInTheDocument();
    expect(screen.getByText(/shown only once/i)).toBeInTheDocument();
  });
});
