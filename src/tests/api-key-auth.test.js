// Tests for the API Key authentication preHandler.
//
// These exercise the real preHandler against a minimal Fastify instance using
// `app.inject`, backed by an in-memory fake of the DAL apiKeys store. No real
// network or database is involved; the fake stores keys exactly as the SQLite
// store does (by hash, active vs revoked) so the auth logic is tested for real.

import { describe, it, expect, beforeEach } from 'vitest';
import fastify from 'fastify';

import {
  createApiKeyAuthPreHandler,
  extractCredential,
  resolveApiKey,
} from '../auth/api-key-auth.js';
import { hashApiKey } from '../auth/hashing.js';

/**
 * Build an in-memory storage whose apiKeys.getActiveByHash mirrors the SQLite
 * contract: it returns the record only when it exists and is active.
 *
 * @param {Array<{ id: string, key: string, status?: 'active'|'revoked' }>} keys
 */
function makeStorage(keys = []) {
  const records = keys.map((k) => ({
    id: k.id,
    key_hash: hashApiKey(k.key),
    key_prefix: k.key.slice(0, 6),
    status: k.status ?? 'active',
    created_at: 1_000,
    revoked_at: k.status === 'revoked' ? 2_000 : null,
  }));

  return {
    apiKeys: {
      getActiveByHash(keyHash) {
        const found = records.find(
          (r) => r.key_hash === keyHash && r.status === 'active',
        );
        return found ?? null;
      },
    },
  };
}

/**
 * Build a Fastify app with the auth preHandler guarding a single route that
 * echoes the authenticated key id.
 *
 * @param {ReturnType<typeof makeStorage>} storage
 */
async function makeApp(storage) {
  const app = fastify();
  const preHandler = createApiKeyAuthPreHandler({ storage });
  app.get('/payment', { preHandler }, async (request) => ({
    ok: true,
    keyId: request.apiKey?.id ?? null,
  }));
  await app.ready();
  return app;
}

const ACTIVE_KEY = 'sk_live_active_key_0001';
const REVOKED_KEY = 'sk_live_revoked_key_0002';

describe('extractCredential', () => {
  it('prefers Authorization: Bearer over X-API-Key', () => {
    const result = extractCredential({
      authorization: 'Bearer from-auth',
      'x-api-key': 'from-x-header',
    });
    expect(result).toEqual({ kind: 'key', value: 'from-auth' });
  });

  it('matches the Bearer scheme case-insensitively', () => {
    expect(extractCredential({ authorization: 'bearer abc' })).toEqual({
      kind: 'key',
      value: 'abc',
    });
  });

  it('falls back to X-API-Key when Authorization is absent', () => {
    expect(extractCredential({ 'x-api-key': 'xyz' })).toEqual({
      kind: 'key',
      value: 'xyz',
    });
  });

  it('reports wrong-scheme for a non-Bearer Authorization header', () => {
    expect(extractCredential({ authorization: 'Basic dXNlcjpwdw==' })).toEqual({
      kind: 'wrong-scheme',
    });
  });

  it('does not fall back to X-API-Key when Authorization uses the wrong scheme', () => {
    expect(
      extractCredential({ authorization: 'Token foo', 'x-api-key': 'xyz' }),
    ).toEqual({ kind: 'wrong-scheme' });
  });

  it('reports none when no credential header is present', () => {
    expect(extractCredential({})).toEqual({ kind: 'none' });
  });

  it('treats a blank Authorization header as absent and uses X-API-Key', () => {
    expect(
      extractCredential({ authorization: '   ', 'x-api-key': 'xyz' }),
    ).toEqual({ kind: 'key', value: 'xyz' });
  });

  it('returns an empty value for a Bearer header with no token', () => {
    expect(extractCredential({ authorization: 'Bearer' })).toEqual({
      kind: 'key',
      value: '',
    });
  });
});

describe('resolveApiKey', () => {
  it('returns the record for an active key', async () => {
    const storage = makeStorage([{ id: 'k1', key: ACTIVE_KEY }]);
    const record = await resolveApiKey(ACTIVE_KEY, storage);
    expect(record?.id).toBe('k1');
  });

  it('returns null for an unknown key', async () => {
    const storage = makeStorage([{ id: 'k1', key: ACTIVE_KEY }]);
    expect(await resolveApiKey('not-a-real-key', storage)).toBeNull();
  });

  it('returns null for a revoked key', async () => {
    const storage = makeStorage([
      { id: 'k2', key: REVOKED_KEY, status: 'revoked' },
    ]);
    expect(await resolveApiKey(REVOKED_KEY, storage)).toBeNull();
  });
});

describe('createApiKeyAuthPreHandler', () => {
  let storage;

  beforeEach(() => {
    storage = makeStorage([
      { id: 'k1', key: ACTIVE_KEY },
      { id: 'k2', key: REVOKED_KEY, status: 'revoked' },
    ]);
  });

  it('throws when constructed without a storage', () => {
    expect(() => createApiKeyAuthPreHandler({})).toThrow(TypeError);
  });

  it('accepts a request with an active key via Authorization: Bearer', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: { authorization: `Bearer ${ACTIVE_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, keyId: 'k1' });
    await app.close();
  });

  it('accepts a request with an active key via X-API-Key', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: { 'x-api-key': ACTIVE_KEY },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().keyId).toBe('k1');
    await app.close();
  });

  it('validates Authorization: Bearer and ignores X-API-Key when both present', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: {
        authorization: `Bearer ${ACTIVE_KEY}`,
        'x-api-key': 'garbage-value',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().keyId).toBe('k1');
    await app.close();
  });

  it('rejects when Authorization: Bearer is wrong but X-API-Key would be valid (/10.3)', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: {
        authorization: 'Bearer wrong-key',
        'x-api-key': ACTIVE_KEY,
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a request with no credential', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({ method: 'GET', url: '/payment' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects an empty Bearer token', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: { authorization: 'Bearer ' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a whitespace-only X-API-Key', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: { 'x-api-key': '   ' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a wrong-scheme Authorization header', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: { authorization: 'Basic dXNlcjpwdw==' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a key that matches no active key', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: { authorization: 'Bearer totally-unknown-key' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
    await app.close();
  });

  it('rejects a revoked key', async () => {
    const app = await makeApp(storage);
    const res = await app.inject({
      method: 'GET',
      url: '/payment',
      headers: { authorization: `Bearer ${REVOKED_KEY}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error_code).toBe('UNAUTHORIZED');
    await app.close();
  });
});
