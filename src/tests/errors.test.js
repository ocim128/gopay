import { describe, it, expect } from 'vitest';
import {
  ERROR_DEFINITIONS,
  getErrorDefinition,
  buildErrorResponse,
  buildHttpError,
} from '../errors.js';

// Central error map.

const EXPECTED_HTTP = {
  IDEMPOTENCY_CONFLICT: 409,
  PROVIDER_UNAVAILABLE: 503,
  INVALID_REQUEST: 400,
  INVALID_AMOUNT: 400,
  INVALID_BASE_AMOUNT: 400,
  AMOUNT_IN_USE: 409,
  NO_AVAILABLE_AMOUNT: 409,
  QRIS_INVALID: 500,
  PAYMENT_NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  INVALID_WEBHOOK_URL: 400,
};

describe('ERROR_DEFINITIONS', () => {
  it('defines every required error code with the correct HTTP status', () => {
    for (const [code, http] of Object.entries(EXPECTED_HTTP)) {
      expect(ERROR_DEFINITIONS[code], `missing code ${code}`).toBeDefined();
      expect(ERROR_DEFINITIONS[code].http).toBe(http);
    }
  });

  it('contains exactly the required set of codes (no extras)', () => {
    expect(Object.keys(ERROR_DEFINITIONS).sort()).toEqual(
      Object.keys(EXPECTED_HTTP).sort(),
    );
  });

  it('has a non-empty English message for every code', () => {
    for (const def of Object.values(ERROR_DEFINITIONS)) {
      expect(typeof def.message).toBe('string');
      expect(def.message.trim().length).toBeGreaterThan(0);
      // ASCII-only is a cheap proxy for English-only messages.
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(def.message)).toBe(true);
    }
  });

  it('is frozen to prevent accidental mutation', () => {
    expect(Object.isFrozen(ERROR_DEFINITIONS)).toBe(true);
  });
});

describe('getErrorDefinition', () => {
  it('returns the matching definition', () => {
    expect(getErrorDefinition('PAYMENT_NOT_FOUND')).toEqual({
      http: 404,
      message: ERROR_DEFINITIONS.PAYMENT_NOT_FOUND.message,
    });
  });

  it('throws for an unknown error code', () => {
    expect(() => getErrorDefinition('NOPE')).toThrow(/Unknown error code/);
  });
});

describe('buildErrorResponse', () => {
  it('produces the consistent { error_code, message } shape', () => {
    const body = buildErrorResponse('UNAUTHORIZED');
    expect(body).toEqual({
      error_code: 'UNAUTHORIZED',
      message: ERROR_DEFINITIONS.UNAUTHORIZED.message,
    });
    expect(Object.keys(body).sort()).toEqual(['error_code', 'message']);
  });

  it('honors a message override', () => {
    const body = buildErrorResponse('INVALID_REQUEST', 'Amount is required.');
    expect(body).toEqual({
      error_code: 'INVALID_REQUEST',
      message: 'Amount is required.',
    });
  });

  it('throws for an unknown error code', () => {
    expect(() => buildErrorResponse('NOPE')).toThrow(/Unknown error code/);
  });
});

describe('buildHttpError', () => {
  it('returns the http status and response body together', () => {
    const result = buildHttpError('AMOUNT_IN_USE');
    expect(result.http).toBe(409);
    expect(result.body).toEqual({
      error_code: 'AMOUNT_IN_USE',
      message: ERROR_DEFINITIONS.AMOUNT_IN_USE.message,
    });
  });

  it('applies a message override to the body only', () => {
    const result = buildHttpError('QRIS_INVALID', 'Static QRIS not set.');
    expect(result.http).toBe(500);
    expect(result.body.message).toBe('Static QRIS not set.');
  });
});
