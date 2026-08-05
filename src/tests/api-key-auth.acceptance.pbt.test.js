// Property-based test for API Key authentication acceptance & precedence.
//
// A request that carries an active API_Key in the
// `Authorization: Bearer <api_key>` header OR the `X-API-Key` header is
// accepted; when both headers are present the `Authorization: Bearer` value is
// validated and the `X-API-Key` value is ignored.
//
// Strategy: generate random non-blank API keys, hash each with the production
// `hashApiKey`, and back the auth preHandler with a fake `storage.apiKeys`
// store that returns an active record only for the valid hash (mirroring the
// SQLite `getActiveByHash` contract). For every generated key we drive the real
// `createApiKeyAuthPreHandler` preHandler through a lightweight fake reply that
// records `code()`/`send()` calls, and assert the four precedence cases:
//   1. valid key in `Authorization: Bearer`            -> accepted
//   2. same valid key in `X-API-Key`                   -> accepted
//   3. valid Bearer + garbage `X-API-Key` (Bearer wins) -> accepted
//   4. garbage Bearer + valid `X-API-Key` (Bearer wins) -> rejected (401)

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { createApiKeyAuthPreHandler } from '../auth/api-key-auth.js';
import { hashApiKey } from '../auth/hashing.js';

/**
 * Build an in-memory storage whose apiKeys.getActiveByHash mirrors the SQLite
 * contract: it returns an active record only for the hash of `validKey`.
 *
 * @param {string} validKey - The single active API key recognized by the store.
 */
function makeStorage(validKey) {
  const record = {
    id: 'k1',
    key_hash: hashApiKey(validKey),
    key_prefix: validKey.slice(0, 6),
    status: 'active',
    created_at: 1_000,
    revoked_at: null,
  };

  return {
    apiKeys: {
      getActiveByHash(keyHash) {
        return keyHash === record.key_hash ? record : null;
      },
    },
  };
}

/**
 * Drive the real preHandler with a set of headers through a fake reply that
 * records whether the request was rejected (code()/send() were called).
 *
 * @param {(request: object, reply: object) => Promise<void>} preHandler
 * @param {Record<string, string>} headers
 * @returns {Promise<{accepted: boolean, statusCode: number|null, apiKey: object|undefined}>}
 */
async function runAuth(preHandler, headers) {
  const request = { headers };
  let statusCode = null;
  let sentBody = null;
  const reply = {
    code(value) {
      statusCode = value;
      return reply;
    },
    send(body) {
      sentBody = body;
      return reply;
    },
  };

  await preHandler(request, reply);

  // The preHandler accepts by decorating request.apiKey and never touching the
  // reply; it rejects by calling reply.code(401).send(...).
  const accepted = statusCode === null && sentBody === null;
  return { accepted, statusCode, apiKey: request.apiKey };
}

describe('Property 26: API Key authentication acceptance & precedence', () => {
  // Non-blank keys built from a safe character set so they survive the
  // blank-credential check and never collide with the "garbage" sentinel.
  const keyArb = fc
    .string({ minLength: 1, maxLength: 40 })
    .map((s) => s.replace(/[\s]/g, ''))
    .filter((s) => s.length > 0);

  it('accepts an active key via Bearer or X-API-Key and lets Bearer take precedence', async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, keyArb, async (validKey, garbageSeed) => {
        // Ensure the "garbage" credential is genuinely not the valid key, so it
        // never accidentally authenticates.
        const garbage =
          garbageSeed === validKey ? `${garbageSeed}-x` : garbageSeed;

        const storage = makeStorage(validKey);
        const preHandler = createApiKeyAuthPreHandler({ storage });

        // Case 1: valid key in Authorization: Bearer -> accepted.
        const viaBearer = await runAuth(preHandler, {
          authorization: `Bearer ${validKey}`,
        });
        expect(viaBearer.accepted).toBe(true);
        expect(viaBearer.apiKey?.id).toBe('k1');

        // Case 2: valid key in X-API-Key -> accepted.
        const viaXHeader = await runAuth(preHandler, {
          'x-api-key': validKey,
        });
        expect(viaXHeader.accepted).toBe(true);
        expect(viaXHeader.apiKey?.id).toBe('k1');

        // Case 3: valid Bearer + garbage X-API-Key -> accepted, Bearer wins and
        // X-API-Key is ignored.
        const bearerWins = await runAuth(preHandler, {
          authorization: `Bearer ${validKey}`,
          'x-api-key': garbage,
        });
        expect(bearerWins.accepted).toBe(true);
        expect(bearerWins.apiKey?.id).toBe('k1');

        // Case 4: garbage Bearer + valid X-API-Key -> rejected, because the
        // Bearer header is validated (and is invalid) and X-API-Key is ignored.
        const bearerPrecedence = await runAuth(preHandler, {
          authorization: `Bearer ${garbage}`,
          'x-api-key': validKey,
        });
        expect(bearerPrecedence.accepted).toBe(false);
        expect(bearerPrecedence.statusCode).toBe(401);
        expect(bearerPrecedence.apiKey).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
