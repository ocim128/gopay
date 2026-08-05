// HMAC-SHA256 signing/verification utility for outgoing webhook payloads.
//
// The signature is computed over the *entire* serialized payload body and
// returned as a lowercase hex string. It is placed in the `X-Signature` header
// by the Webhook_Dispatcher.
//
// The signing key is resolved from Config/env: an explicit key argument takes
// priority, otherwise the `WEBHOOK_HMAC_KEY` environment variable is used.

import { createHmac, timingSafeEqual } from 'node:crypto';

const HMAC_ALGORITHM = 'sha256';
const SIGNATURE_ENCODING = 'hex';

/**
 * Resolve the HMAC key from an explicit argument or the environment.
 *
 * @param {string|Buffer} [key] - Explicit key; falls back to WEBHOOK_HMAC_KEY.
 * @returns {string|Buffer} The resolved key.
 * @throws {Error} When no key is available from any source.
 */
export function resolveKey(key) {
  const resolved = key != null && key !== '' ? key : process.env.WEBHOOK_HMAC_KEY;
  if (resolved == null || resolved === '') {
    throw new Error(
      'Missing HMAC key: pass a key explicitly or set the WEBHOOK_HMAC_KEY environment variable.'
    );
  }
  return resolved;
}

/**
 * Serialize a payload into the canonical byte string that is signed and sent.
 *
 * Strings and Buffers are used verbatim so the signature covers the exact bytes
 * transmitted over the wire; any other value is JSON-serialized.
 *
 * @param {unknown} payload - The webhook payload.
 * @returns {string} The serialized body.
 */
export function serializeBody(payload) {
  if (typeof payload === 'string') {
    return payload;
  }
  if (Buffer.isBuffer(payload)) {
    return payload.toString('utf8');
  }
  return JSON.stringify(payload);
}

/**
 * Compute the HMAC-SHA256 signature (lowercase hex) over the serialized payload.
 *
 * @param {unknown} payload - The webhook payload (object, string, or Buffer).
 * @param {string|Buffer} [key] - The signing key; defaults to WEBHOOK_HMAC_KEY.
 * @returns {string} The lowercase hex signature.
 */
export function sign(payload, key) {
  const resolvedKey = resolveKey(key);
  const body = serializeBody(payload);
  return createHmac(HMAC_ALGORITHM, resolvedKey).update(body, 'utf8').digest(SIGNATURE_ENCODING);
}

/**
 * Verify a signature against a payload using a constant-time comparison.
 *
 * @param {unknown} payload - The webhook payload that was signed.
 * @param {string} signature - The signature to verify (lowercase hex).
 * @param {string|Buffer} [key] - The signing key; defaults to WEBHOOK_HMAC_KEY.
 * @returns {boolean} True when the signature is valid, false otherwise.
 */
export function verify(payload, signature, key) {
  if (typeof signature !== 'string' || signature.length === 0) {
    return false;
  }
  const expected = sign(payload, key);
  const expectedBuffer = Buffer.from(expected, SIGNATURE_ENCODING);
  let actualBuffer;
  try {
    actualBuffer = Buffer.from(signature, SIGNATURE_ENCODING);
  } catch {
    return false;
  }
  // timingSafeEqual requires equal-length buffers; differing lengths => invalid.
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}
