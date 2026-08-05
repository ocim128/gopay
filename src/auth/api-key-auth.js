// API Key authentication for the REST_API.
//
// This module turns an incoming HTTP request into an authentication decision:
//
//   - The credential is taken from `Authorization: Bearer <api_key>` when that
//     header is present (it has priority), otherwise from `X-API-Key`.
//     When both are present the `X-API-Key` value is ignored.
//   - A request is rejected with HTTP 401 / `error_code` "UNAUTHORIZED" when it
//     carries no credential, an empty or whitespace-only credential, an
//     `Authorization` header that does not use the `Bearer` scheme, a key that
//     matches no active key, or a key whose stored record is revoked.
//   - The presented key is never compared in plaintext: it is hashed (SHA-256)
//     and looked up by hash through the DAL, then confirmed with a
//     constant-time comparison so the check leaks no timing information.
//
// `fastify-plugin` is not a project dependency, so this module exports a
// preHandler *factory*: `createApiKeyAuthPreHandler({ storage })` returns an
// async Fastify preHandler that can be attached to the machine routes
// (`/payment*`). On success it decorates the request with the matched API-key
// record (`request.apiKey`) and lets the handler run; on failure it sends the
// 401 response itself and short-circuits the lifecycle.

import { hashApiKey, constantTimeEqual } from './hashing.js';
import { buildHttpError } from '../errors.js';

/**
 * The HTTP authentication scheme expected on the `Authorization` header. The
 * scheme token itself is matched case-insensitively (per RFC 7235) while the
 * credential that follows is treated verbatim.
 */
const BEARER_SCHEME = 'bearer';

/**
 * Outcome of locating a credential on the request headers.
 *
 * - `{ kind: 'key', value }`     a candidate credential was found.
 * - `{ kind: 'none' }`           no credential header was present.
 * - `{ kind: 'wrong-scheme' }`   an `Authorization` header was present but did
 *                                not use the `Bearer` scheme.
 *
 * @typedef {{kind: 'key', value: string} | {kind: 'none'} | {kind: 'wrong-scheme'}} CredentialLookup
 */

/**
 * Normalize a possibly array-valued / undefined header into a single string.
 * Node lowercases header names and may join duplicate headers with ", "; here
 * we only need the raw textual value (or an empty string when absent).
 *
 * @param {string|string[]|undefined} raw
 * @returns {string}
 */
function headerToString(raw) {
  if (Array.isArray(raw)) {
    return raw.length > 0 ? String(raw[0]) : '';
  }
  return typeof raw === 'string' ? raw : '';
}

/**
 * Determine whether a string is empty or contains only whitespace.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isBlank(value) {
  return value.trim().length === 0;
}

/**
 * Extract the candidate API key from the request headers, honoring the
 * precedence of `Authorization: Bearer` over `X-API-Key`.
 *
 * The `Authorization` header takes priority whenever it carries content: if it
 * is present but does not use the `Bearer` scheme the result is
 * `wrong-scheme` (a rejection reason) and `X-API-Key` is *not*
 * consulted. Only when `Authorization` is absent or blank does `X-API-Key`
 * supply the credential.
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @returns {CredentialLookup}
 */
export function extractCredential(headers) {
  const authHeader = headerToString(headers.authorization);

  // The Authorization header has priority whenever it carries any non-blank
  // content. A blank Authorization header is treated as absent so the request
  // can still authenticate via X-API-Key.
  if (!isBlank(authHeader)) {
    const trimmedStart = authHeader.replace(/^\s+/, '');
    const spaceIndex = trimmedStart.indexOf(' ');
    const scheme = spaceIndex === -1 ? trimmedStart : trimmedStart.slice(0, spaceIndex);

    if (scheme.toLowerCase() !== BEARER_SCHEME) {
      return { kind: 'wrong-scheme' };
    }

    // Everything after the scheme token is the credential. It may be empty or
    // whitespace-only, which the caller rejects as a blank credential.
    const value = spaceIndex === -1 ? '' : trimmedStart.slice(spaceIndex + 1);
    return { kind: 'key', value };
  }

  const apiKeyHeader = headerToString(headers['x-api-key']);
  if (apiKeyHeader.length > 0) {
    return { kind: 'key', value: apiKeyHeader };
  }

  return { kind: 'none' };
}

/**
 * Resolve a presented credential against the DAL, returning the matching active
 * API-key record or `null` when authentication must be rejected.
 *
 * The key is hashed and looked up by hash (the plaintext is never stored), and
 * the stored hash is re-confirmed with a constant-time comparison so the final
 * decision does not short-circuit on the first differing byte.
 *
 * @param {string} apiKey - The presented (non-blank) API key.
 * @param {import('../dal/storage-interface.js').Storage} storage
 * @returns {import('../dal/storage-interface.js').ApiKeyRecord|null}
 */
export function resolveApiKey(apiKey, storage) {
  let computedHash;
  try {
    computedHash = hashApiKey(apiKey);
  } catch {
    return null;
  }

  // getActiveByHash returns the record only when it exists AND is active;
  // missing or revoked keys resolve to null.
  const record = storage.apiKeys.getActiveByHash(computedHash);
  if (record === null || record === undefined) {
    return null;
  }

  // Constant-time confirmation of the stored hash (defense in depth on top of
  // the hash-equality lookup the DAL already performed).
  if (!constantTimeEqual(computedHash, record.key_hash)) {
    return null;
  }

  return record;
}

/**
 * Create a Fastify preHandler that authenticates requests with an API key.
 *
 * On success the matched record is attached to `request.apiKey` and the
 * lifecycle continues. On any failure the preHandler sends HTTP 401 with the
 * `UNAUTHORIZED` error body and short-circuits, so the endpoint logic never
 * runs.
 *
 * @param {{ storage: import('../dal/storage-interface.js').Storage }} options
 * @returns {(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => Promise<void>}
 */
export function createApiKeyAuthPreHandler({ storage } = {}) {
  if (!storage || typeof storage !== 'object' || !storage.apiKeys) {
    throw new TypeError('createApiKeyAuthPreHandler requires a storage with an apiKeys store.');
  }

  const { http, body } = buildHttpError('UNAUTHORIZED');

  /**
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   */
  return async function apiKeyAuthPreHandler(request, reply) {
    const credential = extractCredential(request.headers ?? {});

    // No credential at all, or an Authorization header with the wrong scheme.
    if (credential.kind !== 'key') {
      return reply.code(http).send(body);
    }

    // Empty or whitespace-only credential.
    if (isBlank(credential.value)) {
      return reply.code(http).send(body);
    }

    const record = resolveApiKey(credential.value, storage);
    if (record === null) {
      // No active key matched, or the matched key is revoked.
      return reply.code(http).send(body);
    }

    // Authenticated: expose the record to downstream handlers.
    request.apiKey = record;
  };
}

/**
 * A Fastify plugin convenience wrapper. Registering it decorates the instance
 * with `authenticateApiKey`, a preHandler that route definitions can reference
 * directly. The plugin is intentionally not wrapped with `fastify-plugin`
 * (which is not a dependency); when broad scope sharing is needed, prefer
 * attaching {@link createApiKeyAuthPreHandler} per route.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {{ storage: import('../dal/storage-interface.js').Storage }} options
 * @returns {Promise<void>}
 */
export async function apiKeyAuthPlugin(fastify, options) {
  const preHandler = createApiKeyAuthPreHandler(options);
  fastify.decorate('authenticateApiKey', preHandler);
}

export default apiKeyAuthPlugin;
