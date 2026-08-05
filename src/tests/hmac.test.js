// Unit tests for the webhook HMAC signing/verification utility.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { sign, verify, serializeBody, resolveKey } from '../webhook/hmac.js';

const KEY = 'test-secret-key';

describe('serializeBody', () => {
  it('returns strings verbatim', () => {
    expect(serializeBody('{"a":1}')).toBe('{"a":1}');
  });

  it('uses Buffer contents as utf8', () => {
    expect(serializeBody(Buffer.from('hello'))).toBe('hello');
  });

  it('JSON-serializes objects', () => {
    expect(serializeBody({ payment_id: 'p1', amount: 1000 })).toBe(
      '{"payment_id":"p1","amount":1000}'
    );
  });
});

describe('sign', () => {
  it('produces a lowercase hex HMAC-SHA256 over the serialized body', () => {
    const payload = { payment_id: 'p1', amount: 1000 };
    const body = JSON.stringify(payload);
    const expected = createHmac('sha256', KEY).update(body, 'utf8').digest('hex');
    expect(sign(payload, KEY)).toBe(expected);
    expect(sign(payload, KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same payload and key', () => {
    const payload = { a: 1, b: 'x' };
    expect(sign(payload, KEY)).toBe(sign(payload, KEY));
  });

  it('signs string and equivalent Buffer bodies identically', () => {
    const body = '{"a":1}';
    expect(sign(body, KEY)).toBe(sign(Buffer.from(body), KEY));
  });

  it('is sensitive to payload changes', () => {
    const a = sign({ amount: 1000 }, KEY);
    const b = sign({ amount: 1001 }, KEY);
    expect(a).not.toBe(b);
  });

  it('is sensitive to key changes', () => {
    const payload = { amount: 1000 };
    expect(sign(payload, 'key-one')).not.toBe(sign(payload, 'key-two'));
  });
});

describe('verify', () => {
  it('accepts a valid signature', () => {
    const payload = { payment_id: 'p1', amount: 1000 };
    const signature = sign(payload, KEY);
    expect(verify(payload, signature, KEY)).toBe(true);
  });

  it('rejects a signature made with a different key', () => {
    const payload = { amount: 1000 };
    const signature = sign(payload, 'other-key');
    expect(verify(payload, signature, KEY)).toBe(false);
  });

  it('rejects a tampered payload', () => {
    const signature = sign({ amount: 1000 }, KEY);
    expect(verify({ amount: 9999 }, signature, KEY)).toBe(false);
  });

  it('rejects an empty or non-string signature', () => {
    const payload = { amount: 1000 };
    expect(verify(payload, '', KEY)).toBe(false);
    expect(verify(payload, undefined, KEY)).toBe(false);
    expect(verify(payload, null, KEY)).toBe(false);
  });

  it('rejects a malformed hex signature without throwing', () => {
    const payload = { amount: 1000 };
    expect(verify(payload, 'not-hex-zz', KEY)).toBe(false);
  });

  it('rejects a signature of the wrong length', () => {
    const payload = { amount: 1000 };
    expect(verify(payload, 'abcd', KEY)).toBe(false);
  });
});

describe('resolveKey (Config/env fallback)', () => {
  const ORIGINAL = process.env.WEBHOOK_HMAC_KEY;

  beforeEach(() => {
    delete process.env.WEBHOOK_HMAC_KEY;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env.WEBHOOK_HMAC_KEY;
    } else {
      process.env.WEBHOOK_HMAC_KEY = ORIGINAL;
    }
  });

  it('prefers an explicit key', () => {
    process.env.WEBHOOK_HMAC_KEY = 'env-key';
    expect(resolveKey('explicit-key')).toBe('explicit-key');
  });

  it('falls back to WEBHOOK_HMAC_KEY when no explicit key is given', () => {
    process.env.WEBHOOK_HMAC_KEY = 'env-key';
    expect(resolveKey()).toBe('env-key');
    expect(sign('body', undefined)).toBe(sign('body', 'env-key'));
  });

  it('throws when no key is available from any source', () => {
    expect(() => resolveKey()).toThrow(/Missing HMAC key/);
  });
});
