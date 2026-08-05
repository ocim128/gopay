// Property-based test for the webhook HMAC signing/verification utility.
//
// For any payload and signing key,
//   (a) verify(payload, sign(payload, key), key) is true (round trip),
//   (b) the signature is a 64-character lowercase hex string,
//   (c) verifying with a different key or a mutated payload is false, and
//   (d) changing any field of the payload changes the signature (sensitivity).

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { sign, verify, serializeBody } from '../webhook/hmac.js';

// JSON-serializable leaf values that can appear in a webhook payload object.
const jsonValue = fc.oneof(
  fc.string(),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
);

// A payload is either a raw string body or an object body (JSON-serialized).
const payloadArb = fc.oneof(fc.string(), fc.dictionary(fc.string(), jsonValue));

// The signing key is any non-empty string (resolveKey rejects empty keys).
const keyArb = fc.string({ minLength: 1 });

describe('Property 22: HMAC signature is verifiable & sensitive to changes', () => {
  it('round-trips and produces a 64-char lowercase hex signature', () => {
    fc.assert(
      fc.property(payloadArb, keyArb, (payload, key) => {
        const signature = sign(payload, key);
        // (b) lowercase hex, exactly 64 chars (HMAC-SHA256 = 32 bytes).
        expect(signature).toMatch(/^[0-9a-f]{64}$/);
        // (a) a freshly produced signature verifies against the same payload+key.
        expect(verify(payload, signature, key)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects verification made with a different key', () => {
    fc.assert(
      fc.property(payloadArb, keyArb, keyArb, (payload, keyA, keyB) => {
        const signatureA = sign(payload, keyA);
        // Only meaningful when the two keys yield distinct signatures; a key
        // collision (astronomically improbable) would make the check vacuous.
        fc.pre(signatureA !== sign(payload, keyB));
        // (c) the signature minted with keyA must not verify under keyB.
        expect(verify(payload, signatureA, keyB)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects a mutated payload and changes the signature for every field', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), jsonValue, { minKeys: 1 }),
        keyArb,
        (payload, key) => {
          const baselineSignature = sign(payload, key);
          const baselineBody = serializeBody(payload);

          for (const field of Object.keys(payload)) {
            // Replace one field with a value whose serialization differs.
            const mutated = { ...payload, [field]: { __kiro_mutation__: field } };
            // Skip the rare case where the mutation does not alter the bytes
            // actually signed (e.g. the field already held this exact object).
            if (serializeBody(mutated) === baselineBody) {
              continue;
            }
            // (d) sensitivity: changing the field changes the signature.
            expect(sign(mutated, key)).not.toBe(baselineSignature);
            // (c) the original signature must not verify the mutated payload.
            expect(verify(mutated, baselineSignature, key)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
