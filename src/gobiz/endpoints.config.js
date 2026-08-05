// Single source of truth for the GoBiz / GoPay integration.
//
// This module centralizes everything that depends on the remote GoBiz/Gojek API:
//   - base URLs (gobiz, gojekApi)
//   - the OAuth client id
//   - the endpoint table (loginRequest, token, merchants, journalSearch, analytics)
//   - the browser-spoof header builder
//
// Goal: a change to the GoBiz API should ideally only require editing
// this file. A single `buildHeaders(uniqueId, accessToken)` produces the
// browser-spoof header set used by every GoBiz/Gojek request.

export const GOBIZ = {
  clientId: 'go-biz-web-new',

  baseUrls: {
    gobiz: 'https://api.gobiz.co.id',
    gojekApi: 'https://api.gojekapi.com',
  },

  endpoints: {
    loginRequest: { method: 'POST', base: 'gobiz', path: '/goid/login/request' },
    token: { method: 'POST', base: 'gobiz', path: '/goid/token' },
    merchants: { method: 'POST', base: 'gobiz', path: '/v1/merchants/search' },
    journalSearch: { method: 'POST', base: 'gobiz', path: '/journals/search' },
    analytics: {
      method: 'GET',
      base: 'gojekApi',
      path: '/merchant-analytics/v2/merchants/transactions',
    },
  },

  /**
   * Resolve the absolute URL for a named endpoint.
   * @param {string} name - Key from `endpoints`.
   * @returns {string} The fully-qualified URL.
   */
  resolveUrl(name) {
    const endpoint = this.endpoints[name];
    if (!endpoint) {
      throw new Error(`[GoBiz] Unknown endpoint: ${name}`);
    }
    const base = this.baseUrls[endpoint.base];
    if (!base) {
      throw new Error(`[GoBiz] Unknown base URL: ${endpoint.base}`);
    }
    return `${base}${endpoint.path}`;
  },

  /**
   * Build the consolidated browser-spoof headers for every GoBiz/Gojek request.
   *
   * A single header set is used for the login, merchant, analytics, and journal
   * calls so authentication behavior is consistent across all of them.
   *
   * @param {string} uniqueId - Per-request unique id (UUID).
   * @param {string} [accessToken] - Bearer access token; omitted for the
   *   pre-authentication login flow.
   * @returns {Record<string, string>} The request headers.
   */
  buildHeaders(uniqueId, accessToken) {
    return {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'id',
      'Authentication-Type': 'go-id',
      Authorization: accessToken ? `Bearer ${accessToken}` : 'Bearer',
      Connection: 'keep-alive',
      'Content-Type': 'application/json',
      'Gojek-Country-Code': 'ID',
      'Gojek-Timezone': 'Asia/Jakarta',
      Origin: 'https://portal.gofoodmerchant.co.id',
      Referer: 'https://portal.gofoodmerchant.co.id/',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      'X-AppVersion': 'platform-v3.107.0-94ce5d57',
      'X-PhoneMake': 'Windows 10 64-bit',
      'X-PhoneModel': 'Chrome 149.0.0.0 on Windows 10 64-bit',
      'X-Platform': 'Web',
      'X-User-Locale': 'en-US',
      'X-User-Type': 'merchant',
      'sec-ch-ua': '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'x-DeviceOS': 'Web',
      'x-appId': 'go-biz-web-dashboard',
      'x-uniqueid': uniqueId,
    };
  },
};

export default GOBIZ;
