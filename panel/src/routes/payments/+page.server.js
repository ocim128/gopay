import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader
} from '$lib/server/backend.js';

/**
 * Page size for the unified Payments page. The Panel shows at most 20 payments
 * per page.
 *
 * @type {number}
 */
const PAGE_SIZE = 20;

/**
 * Valid status filters for the unified Payments list. Any other value is
 * normalized to "all" (no status filter).
 *
 * @type {ReadonlySet<string>}
 */
const ALLOWED_STATUSES = new Set(['all', 'pending', 'paid', 'expired']);

/**
 * Server load for the unified Payments page. Reads the admin-session-guarded
 * backend endpoint (`GET /admin/payments?status=&limit=&offset=`), forwarding
 * the httpOnly Admin session cookie so the call is authorized (the BFF pattern).
 * Returns the page of full payment rows plus the metadata
 * needed to render the status filter and pagination controls.
 *
 * @type {import('./$types').PageServerLoad}
 */
export async function load({ url, cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);

  const rawStatus = url.searchParams.get('status') ?? 'all';
  const status = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : 'all';

  const rawPage = Number(url.searchParams.get('page'));
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const id = url.searchParams.get('id') || '';
  const date = url.searchParams.get('date') || '';

  const query = new URLSearchParams({
    status,
    limit: String(PAGE_SIZE),
    offset: String(offset)
  });
  if (id) query.set('id', id);
  if (date) query.set('date', date);

  const emptyState = {
    payments: [],
    total: 0,
    status,
    id,
    date,
    page,
    pageSize: PAGE_SIZE,
    hasPrev: page > 1,
    hasNext: false
  };

  let response;
  try {
    response = await fetch(`${getApiBase()}/admin/payments?${query.toString()}`, {
      headers: sessionCookieHeader(token)
    });
  } catch {
    return { ...emptyState, loadError: 'Unable to reach the server.' };
  }

  if (!response.ok) {
    return { ...emptyState, loadError: 'Unable to load payments.' };
  }

  let payments = [];
  let total = 0;
  try {
    const body = await response.json();
    payments = Array.isArray(body.payments) ? body.payments : [];
    total = Number.isInteger(body.total) ? body.total : payments.length;
  } catch {
    return { ...emptyState, loadError: null };
  }

  const hasNext = offset + payments.length < total;

  return {
    payments,
    total,
    status,
    id,
    date,
    page,
    pageSize: PAGE_SIZE,
    hasPrev: page > 1,
    hasNext,
    loadError: null
  };
}
