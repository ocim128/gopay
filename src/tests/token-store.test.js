// Unit tests for the secure TokenStore.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

import { TokenStore, createTokenStore } from '../gobiz/token-store.js';

/** Create an isolated temp file path for each test. */
function tempTokenFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-'));
  return path.join(dir, '.gopay_token.enc');
}

/** A logger stub that records warnings. */
function makeLogger() {
  return { warn: vi.fn() };
}

describe('TokenStore (encrypted, MASTER_KEY set)', () => {
  let filePath;
  let logger;

  beforeEach(() => {
    filePath = tempTokenFile();
    logger = makeLogger();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it('round-trips a token through save() and load()', () => {
    const store = new TokenStore({ filePath, masterKey: 'super-secret-key', logger });
    store.save('access-token-123');
    expect(store.load()).toBe('access-token-123');
    expect(store.isEncrypted).toBe(true);
  });

  it('writes ciphertext to disk, not the plaintext token', () => {
    const store = new TokenStore({ filePath, masterKey: 'super-secret-key', logger });
    store.save('plaintext-token-value');
    const onDisk = fs.readFileSync(filePath, 'utf8');
    expect(onDisk).not.toContain('plaintext-token-value');
    const payload = JSON.parse(onDisk);
    expect(payload.alg).toBe('aes-256-gcm');
    expect(payload.iv).toBeTypeOf('string');
    expect(payload.tag).toBeTypeOf('string');
    expect(payload.data).toBeTypeOf('string');
  });

  it.skipIf(process.platform === 'win32')('writes the token file with 0600 permissions', () => {
    const store = new TokenStore({ filePath, masterKey: 'super-secret-key', logger });
    store.save('access-token-123');
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns null and warns when MASTER_KEY does not match', () => {
    const writer = new TokenStore({ filePath, masterKey: 'key-A', logger });
    writer.save('access-token-123');

    const readerLogger = makeLogger();
    const reader = new TokenStore({ filePath, masterKey: 'key-B', logger: readerLogger });
    expect(reader.load()).toBeNull();
    expect(readerLogger.warn).toHaveBeenCalled();
  });

  it('returns null and warns when the ciphertext is tampered with', () => {
    const store = new TokenStore({ filePath, masterKey: 'super-secret-key', logger });
    store.save('access-token-123');

    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const data = Buffer.from(payload.data, 'base64');
    data[0] ^= 0xff; // flip a bit
    payload.data = data.toString('base64');
    fs.writeFileSync(filePath, JSON.stringify(payload));

    expect(store.load()).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('clear() removes the token file', () => {
    const store = new TokenStore({ filePath, masterKey: 'super-secret-key', logger });
    store.save('access-token-123');
    expect(fs.existsSync(filePath)).toBe(true);
    store.clear();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.load()).toBeNull();
  });
});

describe('TokenStore (plaintext fallback, no MASTER_KEY)', () => {
  let filePath;
  let logger;

  beforeEach(() => {
    filePath = tempTokenFile();
    logger = makeLogger();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it('stores plaintext and warns once when MASTER_KEY is absent', () => {
    const store = new TokenStore({ filePath, masterKey: null, logger });
    store.save('access-token-123');
    store.save('access-token-456');

    expect(store.isEncrypted).toBe(false);
    expect(store.load()).toBe('access-token-456');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(payload.alg).toBe('plain');
    expect(payload.data).toBe('access-token-456');
  });

  it.skipIf(process.platform === 'win32')('writes the plaintext file with 0600 permissions', () => {
    const store = new TokenStore({ filePath, masterKey: null, logger });
    store.save('access-token-123');
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('treats an empty-string master key as no key', () => {
    const store = new TokenStore({ filePath, masterKey: '', logger });
    expect(store.isEncrypted).toBe(false);
  });

  it('cannot decrypt an encrypted file without a key', () => {
    const writer = new TokenStore({ filePath, masterKey: 'super-secret-key', logger: makeLogger() });
    writer.save('access-token-123');

    const reader = new TokenStore({ filePath, masterKey: null, logger });
    expect(reader.load()).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('TokenStore edge cases', () => {
  let filePath;

  beforeEach(() => {
    filePath = tempTokenFile();
  });

  afterEach(() => {
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it('load() returns null when the file does not exist', () => {
    const store = new TokenStore({ filePath, masterKey: 'k' });
    expect(store.load()).toBeNull();
  });

  it('load() returns null and warns for a corrupt file', () => {
    const logger = makeLogger();
    fs.writeFileSync(filePath, 'not-json{');
    const store = new TokenStore({ filePath, masterKey: 'k', logger });
    expect(store.load()).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('save() rejects empty or non-string tokens', () => {
    const store = new TokenStore({ filePath, masterKey: 'k' });
    expect(() => store.save('')).toThrow(TypeError);
    expect(() => store.save(undefined)).toThrow(TypeError);
    expect(() => store.save(123)).toThrow(TypeError);
  });

  it('clear() is a no-op when the file does not exist', () => {
    const store = new TokenStore({ filePath, masterKey: 'k' });
    expect(() => store.clear()).not.toThrow();
  });

  it('createTokenStore() builds a TokenStore instance', () => {
    const store = createTokenStore({ filePath, masterKey: 'k' });
    expect(store).toBeInstanceOf(TokenStore);
  });

  it('different IVs produce different ciphertext for the same token', () => {
    const store = new TokenStore({ filePath, masterKey: 'k' });
    store.save('same-token');
    const first = fs.readFileSync(filePath, 'utf8');
    store.save('same-token');
    const second = fs.readFileSync(filePath, 'utf8');
    expect(first).not.toBe(second);
    expect(store.load()).toBe('same-token');
  });
});
