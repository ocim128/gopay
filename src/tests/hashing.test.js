// Unit tests for the auth hashing utilities.

import { describe, it, expect } from 'vitest';

import {
  hashPassword,
  hashPasswordSync,
  verifyPassword,
  hashApiKey,
  verifyApiKey,
  constantTimeEqual,
} from '../auth/hashing.js';

describe('password hashing (scrypt, Req 12.7)', () => {
  it('produces a hash that differs from the plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('verifies a matching password', async () => {
    const hash = await hashPassword('s3cr3t-pass');
    expect(await verifyPassword('s3cr3t-pass', hash)).toBe(true);
  });

  it('rejects a non-matching password', async () => {
    const hash = await hashPassword('s3cr3t-pass');
    expect(await verifyPassword('wrong-pass', hash)).toBe(false);
  });

  it('uses a fresh salt so the same password yields different hashes', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');
    expect(first).not.toBe(second);
    expect(await verifyPassword('same-password', first)).toBe(true);
    expect(await verifyPassword('same-password', second)).toBe(true);
  });

  it('synchronous hashing round-trips with async verification', async () => {
    const hash = hashPasswordSync('sync-password');
    expect(hash).not.toContain('sync-password');
    expect(await verifyPassword('sync-password', hash)).toBe(true);
  });

  it('rejects empty or non-string passwords when hashing', async () => {
    await expect(hashPassword('')).rejects.toThrow(TypeError);
    await expect(hashPassword(undefined)).rejects.toThrow(TypeError);
    expect(() => hashPasswordSync('')).toThrow(TypeError);
  });

  it('returns false for an empty password or a malformed hash', async () => {
    const hash = await hashPassword('real-pass');
    expect(await verifyPassword('', hash)).toBe(false);
    expect(await verifyPassword('real-pass', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('real-pass', '')).toBe(false);
    expect(await verifyPassword('real-pass', 'scrypt$bad$format')).toBe(false);
  });

  it('handles unicode passwords', async () => {
    const password = 'pässwörd-✓-日本語';
    const hash = await hashPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('pässwörd', hash)).toBe(false);
  });
});

describe('API key hashing (SHA-256, Req 10)', () => {
  it('produces a deterministic lowercase hex digest', () => {
    const a = hashApiKey('api-key-value');
    const b = hashApiKey('api-key-value');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces different digests for different keys', () => {
    expect(hashApiKey('key-one')).not.toBe(hashApiKey('key-two'));
  });

  it('verifies a key against its stored hash', () => {
    const stored = hashApiKey('client-secret-key');
    expect(verifyApiKey('client-secret-key', stored)).toBe(true);
    expect(verifyApiKey('other-key', stored)).toBe(false);
  });

  it('rejects empty inputs gracefully', () => {
    const stored = hashApiKey('client-secret-key');
    expect(verifyApiKey('', stored)).toBe(false);
    expect(verifyApiKey('client-secret-key', '')).toBe(false);
    expect(() => hashApiKey('')).toThrow(TypeError);
    expect(() => hashApiKey(undefined)).toThrow(TypeError);
  });
});

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
  });

  it('returns false for differing strings of equal length', () => {
    expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  it('returns false for non-string inputs', () => {
    expect(constantTimeEqual('abc', undefined)).toBe(false);
    expect(constantTimeEqual(123, '123')).toBe(false);
  });
});
