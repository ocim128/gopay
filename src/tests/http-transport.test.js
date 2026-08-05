import { describe, it, expect, vi } from 'vitest';
import { HttpTransport } from '../gobiz/http-transport.js';

// Tests for the pluggable HTTP transport.

/**
 * Build a fake fetch implementation returning a Response-like object.
 * @param {{ status?: number, bodyText?: string, delayMs?: number }} opts
 */
function makeFetch({ status = 200, bodyText = '', delayMs = 0 } = {}) {
  return vi.fn(async (url, init) => {
    if (delayMs > 0) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        // Honor abort so timeout tests behave like real fetch.
        if (init?.signal) {
          init.signal.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }
    return {
      status,
      ok: status >= 200 && status < 300,
      text: async () => bodyText,
    };
  });
}

describe('HttpTransport.request', () => {
  it('returns status, ok, json() and text() for a successful response', async () => {
    const fetchImpl = makeFetch({ status: 200, bodyText: '{"hello":"world"}' });
    const transport = new HttpTransport({ fetchImpl });

    const res = await transport.request({
      method: 'GET',
      url: 'https://example.com/data',
    });

    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('{"hello":"world"}');
    expect(await res.json()).toEqual({ hello: 'world' });
  });

  it('exposes ok=false for non-2xx responses', async () => {
    const fetchImpl = makeFetch({ status: 401, bodyText: 'nope' });
    const transport = new HttpTransport({ fetchImpl });

    const res = await transport.request({ url: 'https://example.com' });

    expect(res.status).toBe(401);
    expect(res.ok).toBe(false);
  });

  it('allows json() and text() to be called repeatedly and in any order', async () => {
    const fetchImpl = makeFetch({ status: 200, bodyText: '{"n":1}' });
    const transport = new HttpTransport({ fetchImpl });

    const res = await transport.request({ url: 'https://example.com' });

    expect(await res.json()).toEqual({ n: 1 });
    expect(await res.text()).toBe('{"n":1}');
    expect(await res.json()).toEqual({ n: 1 });
  });

  it('serializes a plain-object body to JSON for non-GET methods', async () => {
    const fetchImpl = makeFetch({ status: 200, bodyText: '' });
    const transport = new HttpTransport({ fetchImpl });

    await transport.request({
      method: 'POST',
      url: 'https://example.com',
      body: { client_id: 'go-biz-web-new' },
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"client_id":"go-biz-web-new"}');
  });

  it('passes a string body through unchanged', async () => {
    const fetchImpl = makeFetch({ status: 200, bodyText: '' });
    const transport = new HttpTransport({ fetchImpl });

    await transport.request({
      method: 'POST',
      url: 'https://example.com',
      body: 'raw-payload',
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.body).toBe('raw-payload');
  });

  it('does not attach a body to GET requests', async () => {
    const fetchImpl = makeFetch({ status: 200, bodyText: '' });
    const transport = new HttpTransport({ fetchImpl });

    await transport.request({ method: 'GET', url: 'https://example.com', body: { a: 1 } });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.body).toBeUndefined();
  });

  it('forwards headers to fetch', async () => {
    const fetchImpl = makeFetch({ status: 200, bodyText: '' });
    const transport = new HttpTransport({ fetchImpl });

    await transport.request({
      url: 'https://example.com',
      headers: { Authorization: 'Bearer token' },
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).toEqual({ Authorization: 'Bearer token' });
  });

  it('throws a timeout error when the request exceeds timeoutMs', async () => {
    const fetchImpl = makeFetch({ status: 200, bodyText: 'ok', delayMs: 1000 });
    const transport = new HttpTransport({ fetchImpl });

    await expect(
      transport.request({ url: 'https://example.com', timeoutMs: 20 }),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  it('wraps network-level failures with the request url', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const transport = new HttpTransport({ fetchImpl });

    await expect(
      transport.request({ url: 'https://example.com/x' }),
    ).rejects.toThrow(/failed: connection refused/);
  });

  it('rejects when url is missing', async () => {
    const transport = new HttpTransport({ fetchImpl: makeFetch() });
    await expect(transport.request({})).rejects.toThrow(/non-empty url/);
  });

  it('throws a clear error when json() receives invalid JSON', async () => {
    const fetchImpl = makeFetch({ status: 200, bodyText: 'not json' });
    const transport = new HttpTransport({ fetchImpl });

    const res = await transport.request({ url: 'https://example.com' });
    expect(await res.text()).toBe('not json');
    await expect(res.json()).rejects.toThrow(/failed to parse JSON/);
  });
});
