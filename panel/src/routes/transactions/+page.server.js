import {
  SESSION_COOKIE_NAME,
  getApiBase,
  sessionCookieHeader
} from '$lib/server/backend.js';

const DEFAULT_SIZE = 20;
const ALLOWED_PERIODS = new Set(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'last_quarter', 'custom']);

function getDatesForPeriod(period) {
  const now = new Date();
  const offsetMs = 7 * 60 * 60 * 1000;
  const nowGmt7 = new Date(now.getTime() + offsetMs);
  
  const y = nowGmt7.getUTCFullYear();
  const m = nowGmt7.getUTCMonth();
  const d = nowGmt7.getUTCDate();
  const dayOfWeek = nowGmt7.getUTCDay();

  const createIso = (year, month, day, hour = 0, minute = 0, second = 0, ms = 0) => {
    const timeGmt7 = Date.UTC(year, month, day, hour, minute, second, ms);
    return new Date(timeGmt7 - offsetMs).toISOString();
  };

  let startStr, endStr;
  
  if (period === 'today') {
    startStr = createIso(y, m, d);
    endStr = createIso(y, m, d, 23, 59, 59, 999);
  } else if (period === 'yesterday') {
    startStr = createIso(y, m, d - 1);
    endStr = createIso(y, m, d - 1, 23, 59, 59, 999);
  } else if (period === 'this_week') {
    const diffToMonday = (dayOfWeek + 6) % 7;
    startStr = createIso(y, m, d - diffToMonday);
    endStr = createIso(y, m, d + (6 - diffToMonday), 23, 59, 59, 999);
  } else if (period === 'last_week') {
    const diffToMonday = (dayOfWeek + 6) % 7;
    startStr = createIso(y, m, d - diffToMonday - 7);
    endStr = createIso(y, m, d - diffToMonday - 1, 23, 59, 59, 999);
  } else if (period === 'this_month') {
    startStr = createIso(y, m, 1);
    endStr = createIso(y, m + 1, 0, 23, 59, 59, 999);
  } else if (period === 'last_month') {
    startStr = createIso(y, m - 1, 1);
    endStr = createIso(y, m, 0, 23, 59, 59, 999);
  } else if (period === 'this_quarter') {
    const qMonth = Math.floor(m / 3) * 3;
    startStr = createIso(y, qMonth, 1);
    endStr = createIso(y, qMonth + 3, 0, 23, 59, 59, 999);
  } else if (period === 'last_quarter') {
    const qMonth = Math.floor(m / 3) * 3;
    startStr = createIso(y, qMonth - 3, 1);
    endStr = createIso(y, qMonth, 0, 23, 59, 59, 999);
  } else {
    // fallback
    startStr = createIso(y, m, d);
    endStr = createIso(y, m, d, 23, 59, 59, 999);
  }
  
  return { start: startStr, end: endStr };
}

export async function load({ url, cookies, fetch }) {
  const token = cookies.get(SESSION_COOKIE_NAME);

  const rawPeriod = url.searchParams.get('period') || 'today';
  const period = ALLOWED_PERIODS.has(rawPeriod) ? rawPeriod : 'today';
  
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const offset = (page - 1) * DEFAULT_SIZE;

  let start = url.searchParams.get('start');
  let end = url.searchParams.get('end');
  let order_id = url.searchParams.get('order_id') || '';

  if (period !== 'custom' || !start || !end) {
    const dates = getDatesForPeriod(period === 'custom' ? 'today' : period);
    start = dates.start;
    end = dates.end;
  } else {
    // For custom, ensure they are valid ISO strings. 
    // HTML5 date inputs send YYYY-MM-DD. Convert them to ISO for backend.
    try {
      if (start.length === 10) start = new Date(`${start}T00:00:00`).toISOString();
      if (end.length === 10) end = new Date(`${end}T23:59:59`).toISOString();
    } catch {
       const dates = getDatesForPeriod('today');
       start = dates.start;
       end = dates.end;
    }
  }

  const query = new URLSearchParams({
    size: String(DEFAULT_SIZE),
    offset: String(offset),
    start,
    end
  });
  if (order_id) {
    query.set('order_id', order_id);
  }

  let response;
  try {
    response = await fetch(`${getApiBase()}/admin/transactions?${query.toString()}`, {
      headers: sessionCookieHeader(token)
    });
  } catch {
    return { transactions: [], period, start, end, order_id, page, total: 0, pageSize: DEFAULT_SIZE, hasNext: false, loadError: 'Unable to reach the server.' };
  }

  if (!response.ok) {
    return { transactions: [], period, start, end, order_id, page, total: 0, pageSize: DEFAULT_SIZE, hasNext: false, loadError: 'Unable to load transactions.' };
  }

  try {
    const data = await response.json();
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    
    return {
      transactions,
      period,
      start,
      end,
      order_id,
      page,
      total: data.total ?? 0,
      pageSize: DEFAULT_SIZE,
      hasNext: transactions.length === DEFAULT_SIZE,
      loadError: null
    };
  } catch {
    return { transactions: [], period, start, end, order_id, page, total: 0, pageSize: DEFAULT_SIZE, hasNext: false, loadError: null };
  }
}
