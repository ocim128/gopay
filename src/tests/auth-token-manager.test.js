// Unit tests for the AuthTokenManager.

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { AuthTokenManager, createAuthTokenManager } from '../gobiz/auth-token-manager.js';
import { GOBIZ } from '../gobiz/endpoints.config.js';

/**
 * Build a fake TransportResponse with a given status and JSON body.
 * @param {number} status
 * @param {any} body
 */
function transportResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * A fake transport whose request() is a vi.fn returning queued responses by
 * matching the request URL against the GoBiz endpoint table.
 */
function makeTransport(handlers = {}) {
  const request = vi.fn(async (req) => {
    if (req.url === GOBIZ.resolveUrl('loginRequest') && handlers.loginRequest) {
      return handlers.loginRequest(req);
    }
    if (req.url === GOBIZ.resolveUrl('token') && handlers.token) {
      return handlers.token(req);
    }
    if (req.url === GOBIZ.resolveUrl('merchants') && handlers.merchants) {
      return handlers.merchants(req);
    }
    return transportResponse(200, {});
  });
  return { request };
}

/** An in-memory token store stub mirroring the TokenStore contract. */
function makeTokenStore(initial = null) {
  let value = initial;
  return {
    load: vi.fn(() => value),
    save: vi.fn((token) => {
      value = token;
    }),
    clear: vi.fn(() => {
      value = null;
    }),
    // helper for assertions in tests
    _peek: () => value,
  };
}

/** A logger stub that records log/warn calls. */
function makeLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

const CREDENTIALS = { email: 'merchant@example.com', password: 'correct-horse' };

describe('AuthTokenManager constructor', () => {
  it('throws when the transport has no request() method', () => {
    expect(() => new AuthTokenManager({}, makeTokenStore(), CREDENTIALS)).toThrow(
      /HttpTransport/,
    );
  });

  it('throws when the token store has no load() method', () => {
    expect(() => new AuthTokenManager(makeTransport(), {}, CREDENTIALS)).toThrow(
      /TokenStore/,
    );
  });
});

describe('AuthTokenManager.login', () => {
  let transport;
  let store;
  let logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('POSTs loginRequest then token and returns the access_token', async () => {
    transport = makeTransport({
      loginRequest: () => transportResponse(200, {}),
      token: () => transportResponse(200, { access_token: 'fresh-token' }),
    });
    store = makeTokenStore();
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    const token = await manager.login();

    expect(token).toBe('fresh-token');

    // Two calls: loginRequest (email validation) then token (grant).
    const urls = transport.request.mock.calls.map(([req]) => req.url);
    expect(urls).toEqual([GOBIZ.resolveUrl('loginRequest'), GOBIZ.resolveUrl('token')]);

    // The token grant body carries the password grant payload.
    const tokenReq = transport.request.mock.calls[1][0];
    expect(tokenReq.method).toBe('POST');
    expect(tokenReq.body).toMatchObject({
      client_id: GOBIZ.clientId,
      grant_type: 'password',
      data: { email: CREDENTIALS.email, password: CREDENTIALS.password },
    });
  });

  it('persists the token to the store on success', async () => {
    transport = makeTransport({
      token: () => transportResponse(200, { access_token: 'persisted-token' }),
    });
    store = makeTokenStore();
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    await manager.login();

    expect(store.save).toHaveBeenCalledWith('persisted-token');
    expect(store._peek()).toBe('persisted-token');
  });

  it('does not use curl / execFile (relies solely on the transport)', async () => {
    transport = makeTransport({
      token: () => transportResponse(200, { access_token: 't' }),
    });
    store = makeTokenStore();
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    await manager.login();

    // All network egress goes through the injected transport.
    expect(transport.request).toHaveBeenCalled();
  });

  it('throws when credentials are missing', async () => {
    transport = makeTransport();
    store = makeTokenStore();
    const manager = new AuthTokenManager(transport, store, {}, { logger });

    await expect(manager.login()).rejects.toThrow(/Missing credentials/);
    expect(transport.request).not.toHaveBeenCalled();
  });

  it('throws when the token response contains errors', async () => {
    transport = makeTransport({
      token: () =>
        transportResponse(200, { errors: [{ message: 'Wrong password' }] }),
    });
    store = makeTokenStore();
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    await expect(manager.login()).rejects.toThrow(/Login failed: Wrong password/);
    expect(store.save).not.toHaveBeenCalled();
  });

  it('throws when the token response lacks an access_token', async () => {
    transport = makeTransport({
      token: () => transportResponse(200, { refresh_token: 'r' }),
    });
    store = makeTokenStore();
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    await expect(manager.login()).rejects.toThrow(/did not contain an access_token/);
  });

  it('treats loginRequest validation errors as warnings, not failures', async () => {
    transport = makeTransport({
      loginRequest: () =>
        transportResponse(200, { errors: [{ message: 'minor email warning' }] }),
      token: () => transportResponse(200, { access_token: 'ok-token' }),
    });
    store = makeTokenStore();
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    const token = await manager.login();

    expect(token).toBe('ok-token');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('minor email warning'),
    );
  });
});

describe('AuthTokenManager.getValidToken', () => {
  let logger;

  beforeEach(() => {
    logger = makeLogger();
  });

  it('returns the stored token when it validates (no login)', async () => {
    const transport = makeTransport({
      merchants: () => transportResponse(200, { merchants: [] }),
    });
    const store = makeTokenStore('stored-token');
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    const token = await manager.getValidToken();

    expect(token).toBe('stored-token');
    // Only the validation probe was made; no token grant call.
    const urls = transport.request.mock.calls.map(([req]) => req.url);
    expect(urls).toEqual([GOBIZ.resolveUrl('merchants')]);
  });

  it('logs in when the stored token is rejected with 401', async () => {
    const transport = makeTransport({
      merchants: () => transportResponse(401, {}),
      token: () => transportResponse(200, { access_token: 'new-token' }),
    });
    const store = makeTokenStore('stale-token');
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    const token = await manager.getValidToken();

    expect(token).toBe('new-token');
    expect(store.save).toHaveBeenCalledWith('new-token');
  });

  it('logs in when there is no stored token', async () => {
    const transport = makeTransport({
      token: () => transportResponse(200, { access_token: 'brand-new' }),
    });
    const store = makeTokenStore(null);
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    const token = await manager.getValidToken();

    expect(token).toBe('brand-new');
    // load() was consulted but no validation probe happens without a token.
    expect(store.load).toHaveBeenCalled();
  });

  it('caches the token in memory and avoids repeat validation', async () => {
    const transport = makeTransport({
      merchants: () => transportResponse(200, {}),
    });
    const store = makeTokenStore('cached-token');
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    await manager.getValidToken();
    const callsAfterFirst = transport.request.mock.calls.length;
    await manager.getValidToken();

    // The second call uses the in-memory cache: no extra transport calls.
    expect(transport.request.mock.calls.length).toBe(callsAfterFirst);
  });

  it('forceLogin bypasses the cache and performs a fresh login', async () => {
    const transport = makeTransport({
      merchants: () => transportResponse(200, {}),
      token: () => transportResponse(200, { access_token: 'forced-token' }),
    });
    const store = makeTokenStore('cached-token');
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    await manager.getValidToken();
    const token = await manager.getValidToken({ forceLogin: true });

    expect(token).toBe('forced-token');
  });

  it('treats a network failure during validation as invalid and re-logs in', async () => {
    const transport = makeTransport({
      merchants: () => {
        throw new Error('connection refused');
      },
      token: () => transportResponse(200, { access_token: 'recovered' }),
    });
    const store = makeTokenStore('stored-token');
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    const token = await manager.getValidToken();

    expect(token).toBe('recovered');
  });
});

describe('AuthTokenManager.invalidate (single 401 re-login policy)', () => {
  it('clears the in-memory and persisted token', async () => {
    const transport = makeTransport({
      merchants: () => transportResponse(200, {}),
      token: () => transportResponse(200, { access_token: 're-login-token' }),
    });
    const store = makeTokenStore('current-token');
    const logger = makeLogger();
    const manager = new AuthTokenManager(transport, store, CREDENTIALS, { logger });

    // Prime the in-memory cache.
    await manager.getValidToken();

    await manager.invalidate();

    expect(store.clear).toHaveBeenCalled();
    expect(store._peek()).toBeNull();

    // After invalidation the next getValidToken performs a fresh login.
    const token = await manager.getValidToken();
    expect(token).toBe('re-login-token');
  });
});

describe('createAuthTokenManager factory', () => {
  it('builds an AuthTokenManager instance', () => {
    const manager = createAuthTokenManager(makeTransport(), makeTokenStore(), CREDENTIALS);
    expect(manager).toBeInstanceOf(AuthTokenManager);
  });
});
