// Property-based test for API Key authentication rejection.
//
// The API-key preHandler MUST reject a request with
// HTTP 401 / `error_code` "UNAUTHORIZED" when ANY of the following holds:
//   * no credential is presented at all;
//   * the credential is empty or whitespace-only;
//   * an `Authorization` header is present but does not use the `Bearer` scheme;
//   * the presented key matches no active key;
//   * the presented key matches a record that has been revoked.
//
// In every rejection case the endpoint logic must never run, which the
// preHandler signals by short-circuiting (sending the 401 itself) and by NOT
// decorating the request with `request.apiKey`.
//
// This drives the real `createApiKeyAuthPreHandler` against an in-memory fake
// of the DAL apiKeys store and a fake Fastify reply that records `code`/`send`.

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createApiKeyAuthPreHandler } from '../auth/api-key-auth.js';
import { hashApiKey } from '../auth/hashing.js';
import { buildHttpError } from '../errors.js';

// Active keys known to the storage. Any presented key NOT in this set (and not
// the revoked key below) must be rejected as "no active key matched".
const ACTIVE_KEYS = ['sk_live_active_0001', 'sk_live_active_0002'];
// A key whose stored record exists but is revoked: getActiveByHash returns null.
const REVOKED_KEY = 'sk_live_revoked_0003';

/**
 * Build an in-memory storage whose apiKeys.getActiveByHash mirrors the SQLite
 * contract: it returns the record only when it exists AND is active. Revoked
 * records are stored but never returned, exactly like the real store.
 */
function makeStorage() {
  const records = [
    ...ACTIVE_KEYS.map((key, i) => ({
      id: `active-${i}`,
      key_hash: hashApiKey(key),
      status: 'active',
    })),
    {
      id: 'revoked-0',
      key_hash: hashApiKey(REVOKED_KEY),
      status: 'revoked',
    },
  ];

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
 * A minimal stand-in for a Fastify reply that records the status code and body
 * passed to `reply.code(...).send(...)`. `code` and `send` are chainable just
 * like the real reply so the preHandler's `reply.code(http).send(body)` works.
 */
function makeFakeReply() {
  const calls = { codeCalled: false, statusCode: null, sendCalled: false, body: undefined };
  const reply = {
    code(status) {
      calls.codeCalled = true;
      calls.statusCode = status;
      return this;
    },
    send(payload) {
      calls.sendCalled = true;
      calls.body = payload;
      return this;
    },
  };
  return { reply, calls };
}

// The canonical 401 body the preHandler emits, used to assert exact shape.
const { http: UNAUTHORIZED_HTTP, body: UNAUTHORIZED_BODY } = buildHttpError('UNAUTHORIZED');

describe('Property 27: API Key authentication rejection', () => {
  it('rejects every invalid credential with 401 UNAUTHORIZED and never runs the endpoint', async () => {
    const storage = makeStorage();
    const preHandler = createApiKeyAuthPreHandler({ storage });

    // A whitespace-only string generator for blank-credential cases.
    const whitespace = fc
      .array(fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'), { minLength: 0, maxLength: 8 })
      .map((chars) => chars.join(''));

    // A random key that is guaranteed NOT to be one of the known plaintexts.
    const unknownKey = fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((s) => s.trim().length > 0)
      .map((s) => `xx-${s}`) // prefix keeps it clear of the known key plaintexts
      .filter((s) => !ACTIVE_KEYS.includes(s) && s !== REVOKED_KEY);

    // Each generated case yields a headers object plus the reason it must be
    // rejected (used only for clearer failure diagnostics).
    const rejectionCase = fc.oneof(
      // 1) No credential header at all.
      fc.record({ reason: fc.constant('none'), headers: fc.constant({}) }),

      // 2) Empty / whitespace-only Bearer token.
      whitespace.map((ws) => ({
        reason: 'blank-bearer',
        headers: { authorization: `Bearer ${ws}` },
      })),

      // 2b) Empty / whitespace-only X-API-Key.
      whitespace
        .filter((ws) => ws.length > 0)
        .map((ws) => ({ reason: 'blank-x-api-key', headers: { 'x-api-key': ws } })),

      // 3) Authorization present but with a non-Bearer scheme.
      fc
        .tuple(
          fc.constantFrom('Basic', 'Token', 'Digest', 'ApiKey', 'OAuth', 'NTLM'),
          fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !s.includes(' ')),
        )
        .map(([scheme, value]) => ({
          reason: 'wrong-scheme',
          headers: { authorization: `${scheme} ${value}` },
        })),

      // 4) A key that matches no active key (presented via Bearer or X-API-Key).
      fc.tuple(unknownKey, fc.boolean()).map(([key, viaBearer]) => ({
        reason: 'no-match',
        headers: viaBearer ? { authorization: `Bearer ${key}` } : { 'x-api-key': key },
      })),

      // 5) A key whose record exists but is revoked.
      fc.boolean().map((viaBearer) => ({
        reason: 'revoked',
        headers: viaBearer
          ? { authorization: `Bearer ${REVOKED_KEY}` }
          : { 'x-api-key': REVOKED_KEY },
      })),
    );

    await fc.assert(
      fc.asyncProperty(rejectionCase, async ({ headers }) => {
        const request = { headers };
        const { reply, calls } = makeFakeReply();

        await preHandler(request, reply);

        // The preHandler short-circuited with the canonical 401 response.
        expect(calls.codeCalled).toBe(true);
        expect(calls.statusCode).toBe(401);
        expect(calls.statusCode).toBe(UNAUTHORIZED_HTTP);
        expect(calls.sendCalled).toBe(true);
        expect(calls.body).toEqual(UNAUTHORIZED_BODY);
        expect(calls.body.error_code).toBe('UNAUTHORIZED');

        // The endpoint logic never runs: the request was not authenticated.
        expect(request.apiKey).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});
